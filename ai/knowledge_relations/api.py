"""Register proposed relation endpoints on the existing AI app."""
import hmac
import os
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from .core import digest
from .provider import OpenAIEmbeddingProvider
from .service import RelationService, RelationConfig, ServiceError

Text = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=200)]
Positive = Annotated[int, Field(strict=True, ge=1)]


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ownerId: Text
    revision: Positive
    documents: list[dict[str,Any]]


class GraphRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    ownerId: Text
    snapshotId: Text


def make_router(service, *, internal_key):
    if not isinstance(internal_key,str) or not internal_key:
        raise RuntimeError('INTERNAL_API_KEY is required')
    def auth(x_internal_api_key: str | None = Header(default=None)):
        if x_internal_api_key is None or not hmac.compare_digest(
            x_internal_api_key.encode(),internal_key.encode()
        ):
            raise HTTPException(401, detail={'code':'UNAUTHORIZED','message':'Invalid internal API key'})
    router = APIRouter(prefix='/v2',dependencies=[Depends(auth)],tags=['knowledge-relations'])
    def execute(fn):
        try:
            return fn()
        except ServiceError as exc:
            raise HTTPException(exc.status,detail={'code':exc.code,'message':str(exc)}) from exc
    @router.post('/relation-index/sync')
    def sync(body: SyncRequest):
        return execute(lambda:service.sync(body.ownerId,body.revision,body.documents))
    @router.post('/relations')
    def graph(body: GraphRequest):
        return execute(lambda:service.get_graph(body.ownerId,body.snapshotId))
    return router


def service_from_env(*, data_dir=None):
    from openai import OpenAI
    general_base = os.environ.get('OPENAI_BASE_URL','https://api.openai.com/v1')
    first = os.environ.get('EMBEDDING_BASE_URL')
    second = os.environ.get('EMBEDDING_API_BASE_URL')
    if first and second and first.rstrip('/') != second.rstrip('/'):
        raise RuntimeError('EMBEDDING_BASE_URL and EMBEDDING_API_BASE_URL conflict')
    base = (first or second or general_base).rstrip('/')
    key = os.environ.get('EMBEDDING_API_KEY')
    if not key and base != general_base.rstrip('/'):
        raise RuntimeError('A separate embedding provider requires EMBEDDING_API_KEY')
    key = key or os.environ.get('OPENAI_API_KEY') or os.environ.get('LUNA_API_KEY')
    if not key:
        raise RuntimeError('An embedding API key is required')
    client = OpenAI(api_key=key,base_url=base,max_retries=0,timeout=120)
    root = Path(data_dir or os.environ.get('AI_DATA_DIR','./ai_data')) / 'knowledge_relations'
    def factory(scope):
        return OpenAIEmbeddingProvider(client)
    config = RelationConfig(
        threshold=float(os.environ.get('RELATION_THRESHOLD','0.48')),
        neighbors=int(os.environ.get('RELATION_NEIGHBORS','3')),
        mode=os.environ.get('RELATION_MODE','mutual'),
        resolution=float(os.environ.get('RELATION_RESOLUTION','1.0')),
    )
    return RelationService(
        root,provider_factory=factory,config=config,
        model=os.environ.get('EMBEDDING_MODEL','text-embedding-3-small'),
        model_revision=os.environ.get('EMBEDDING_MODEL_REVISION',''),
        provider_namespace=digest(base),tenant=os.environ.get('AI_TENANT_SCOPE','backend'),
        max_documents=int(os.environ.get('RELATION_MAX_DOCUMENTS','200')),
        max_chunks=int(os.environ.get('RELATION_MAX_CHUNKS','512')),
    )


def register_relations(app, *, service=None, internal_key=None, enabled=None, data_dir=None):
    if enabled is None:
        enabled = os.environ.get('AI_ENABLE_RELATIONS','false').lower() == 'true'
    if not enabled:
        return app
    if getattr(app.state,'knowledge_relations_enabled',False):
        return app
    key = internal_key or os.environ.get('INTERNAL_API_KEY')
    if not key:
        raise RuntimeError('INTERNAL_API_KEY is required')
    paths = app.openapi().get('paths',{})
    if '/v2/relation-index/sync' in paths or '/v2/relations' in paths:
        raise RuntimeError('Relation endpoint already exists; choose one router before registration')
    instance = service if service is not None else service_from_env(data_dir=data_dir)
    app.include_router(make_router(instance,internal_key=key))
    app.openapi_schema = None
    app.state.knowledge_relations_enabled = True
    return app


def create_app(*, service=None, internal_key=None, enabled=None, data_dir=None):
    app = FastAPI(title='Knowledge relations integration',version='1.0.0')
    @app.get('/health')
    def health():
        return {'status':'ok','relationsEnabled':getattr(app.state,'knowledge_relations_enabled',False)}
    return register_relations(app,service=service,internal_key=internal_key,enabled=enabled,data_dir=data_dir)
