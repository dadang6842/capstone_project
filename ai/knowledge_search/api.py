"""Proposed search routes. Add to the existing app; do not replace generation/revision routes."""
import hmac
import os
from typing import Any,Annotated
from fastapi import APIRouter,FastAPI,Header,HTTPException,Depends
from pydantic import BaseModel,ConfigDict,Field,StringConstraints
from .service import SearchService,ServiceError
from .providers import OpenAIProvider
from .base import digest

Text=Annotated[str,StringConstraints(strict=True,strip_whitespace=True,min_length=1,max_length=200)]
Query=Annotated[str,StringConstraints(strict=True,strip_whitespace=True,min_length=1,max_length=3500)]
Positive=Annotated[int,Field(strict=True,ge=1)]
BatchCount=Annotated[int,Field(strict=True,ge=1,le=8)]
PageSize=Annotated[int,Field(strict=True,ge=1,le=100)]
class Request(BaseModel):
    model_config=ConfigDict(extra='forbid')
    ownerId:Text
class SyncRequest(Request):
    revision:Positive
    documents:list[dict[str,Any]]
class SearchRequest(Request):
    query:Query
    snapshotId:Text
    maxNewBatches:BatchCount=1
    pageSize:PageSize=10
class ContinueRequest(Request):
    searchId:Text
    resultRevision:Positive
    maxNewBatches:BatchCount=1
    pageSize:PageSize=10
class PageRequest(Request):
    searchId:Text
    resultRevision:Positive
    page:Positive=1
    pageSize:PageSize=10
class DocumentRequest(Request):
    artifactId:Text
    searchHash:Text

def make_router(service,*,internal_key):
    if not isinstance(internal_key,str) or not internal_key:raise RuntimeError('INTERNAL_API_KEY가 필요합니다.')
    def auth(x_internal_api_key:str|None=Header(default=None)):
        if x_internal_api_key is None or not hmac.compare_digest(x_internal_api_key,internal_key):
            raise HTTPException(401,'Invalid internal API key')
    router=APIRouter(prefix='/v2',dependencies=[Depends(auth)],tags=['knowledge-search'])
    def execute(fn):
        try:return fn()
        except ServiceError as exc:raise HTTPException(exc.status,detail=str(exc)) from exc
        except ValueError as exc:raise HTTPException(422,detail=str(exc)) from exc
    @router.post('/search-index/sync')
    def sync(body:SyncRequest):return execute(lambda:service.sync(body.ownerId,body.revision,body.documents))
    @router.post('/searches')
    def search(body:SearchRequest):
        return execute(lambda:service.search(body.ownerId,body.query,body.snapshotId,max_new_batches=body.maxNewBatches,page_size=body.pageSize))
    @router.post('/searches/continue')
    def more(body:ContinueRequest):
        return execute(lambda:service.continue_search(body.ownerId,body.searchId,body.resultRevision,max_new_batches=body.maxNewBatches,page_size=body.pageSize))
    @router.post('/searches/page')
    def page(body:PageRequest):
        return execute(lambda:service.page(body.ownerId,body.searchId,body.resultRevision,page=body.page,page_size=body.pageSize))
    @router.post('/search-documents/read')
    def document(body:DocumentRequest):return execute(lambda:service.document(body.ownerId,body.artifactId,body.searchHash))
    return router


def service_from_env(*,data_dir=None):
    from openai import OpenAI
    from pathlib import Path
    key=os.environ.get('OPENAI_API_KEY') or os.environ.get('LUNA_API_KEY')
    if not key:raise RuntimeError('OPENAI_API_KEY 또는 LUNA_API_KEY가 필요합니다.')
    base=os.environ.get('OPENAI_BASE_URL','https://api.openai.com/v1')
    embed_base=os.environ.get('EMBEDDING_BASE_URL',base)
    embed_key=os.environ.get('EMBEDDING_API_KEY') or key
    if embed_base!=base and not os.environ.get('EMBEDDING_API_KEY'):
        raise RuntimeError('별도 임베딩 공급자의 EMBEDDING_API_KEY가 필요합니다.')
    client=OpenAI(api_key=key,base_url=base,max_retries=0,timeout=120)
    embed_client=client if embed_base==base and embed_key==key else OpenAI(api_key=embed_key,base_url=embed_base,max_retries=0,timeout=120)
    root=Path(data_dir or os.environ.get('AI_DATA_DIR','./ai_data'))/'knowledge_search'
    namespace=digest([base,embed_base])
    def factory(scope):return OpenAIProvider(client,embedding_client=embed_client,namespace=namespace,audit_dir=root/'responses'/scope)
    return SearchService(root,provider_factory=factory,judge_model=os.environ.get('AI_MODEL','gpt-6-luna'),
                         embedding_model=os.environ.get('EMBEDDING_MODEL','text-embedding-3-small'),
                         tenant=os.environ.get('AI_TENANT_SCOPE','backend'))


def register_search(app,*,service=None,internal_key=None,enabled=None,data_dir=None):
    if enabled is None:enabled=os.environ.get('AI_ENABLE_SEARCH','false').lower()=='true'
    if not enabled:return app
    key=internal_key or os.environ.get('INTERNAL_API_KEY')
    if not key:raise RuntimeError('INTERNAL_API_KEY가 필요합니다.')
    service=service or service_from_env(data_dir=data_dir)
    app.include_router(make_router(service,internal_key=key))
    app.state.knowledge_search_enabled=True
    return app


def create_app(*,service=None,internal_key=None,enabled=None,data_dir=None):
    app=FastAPI(title='Knowledge search integration candidate',version='1.0.0')
    @app.get('/health')
    def health():return {'status':'ok','searchEnabled':getattr(app.state,'knowledge_search_enabled',False)}
    return register_search(app,service=service,internal_key=internal_key,enabled=enabled,data_dir=data_dir)
