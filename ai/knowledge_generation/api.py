"""Proposed HTTP adapter for the tested direct-generation engine.

/v2/analyses is disabled by default. Existing /analyses and /revisions are not
replaced by this module. Read docs/API_CONTRACT.md before integration.
"""
import asyncio,hmac,os
from fastapi import FastAPI,Depends,Header,HTTPException
from fastapi.responses import JSONResponse
from .direct import DirectSession,DirectInput
from .io import CallFailure,BudgetExceeded
from .store import Busy,Conflict


def create_app(*,client=None,internal_key=None,data_dir=None,model=None,enable_v2=None):
    key=internal_key or os.environ.get('INTERNAL_API_KEY')
    if not key:raise RuntimeError('INTERNAL_API_KEY 환경변수가 필요합니다.')
    if enable_v2 is None:enable_v2=os.environ.get('AI_ENABLE_V2_ANALYSES','false').lower()=='true'
    if client is None and enable_v2:
        from openai import AsyncOpenAI
        options={'api_key':os.environ.get('OPENAI_API_KEY'),'max_retries':0,'timeout':280}
        if os.environ.get('OPENAI_BASE_URL'):options['base_url']=os.environ['OPENAI_BASE_URL']
        client=AsyncOpenAI(**options)
    root=data_dir or os.environ.get('AI_DATA_DIR','./ai_data')
    model_id=model or os.environ.get('AI_MODEL','gpt-6-luna')
    scope=os.environ.get('AI_TENANT_SCOPE','backend')
    max_tokens=int(os.environ.get('AI_MAX_OUTPUT_TOKENS','16000'))
    app=FastAPI(title='Direct knowledge documents: proposed backend adapter',version='1.0')
    async def authenticate(x_internal_api_key:str|None=Header(default=None)):
        if x_internal_api_key is None or not hmac.compare_digest(x_internal_api_key,key):
            raise HTTPException(status_code=401,detail='Invalid internal API key')
    @app.exception_handler(CallFailure)
    async def generation_error(request,exc):
        return JSONResponse(status_code=502,content={'errorMessage':str(exc)})
    @app.exception_handler(ValueError)
    async def invalid_input(request,exc):
        return JSONResponse(status_code=422,content={'detail':str(exc)})
    @app.exception_handler(Busy)
    @app.exception_handler(Conflict)
    async def conflict(request,exc):
        return JSONResponse(status_code=409,content={'detail':str(exc)})
    @app.get('/health')
    async def health():return {'status':'ok','v2Enabled':enable_v2}
    if enable_v2:
        @app.post('/v2/analyses',dependencies=[Depends(authenticate)])
        async def analyse(body:DirectInput):
            async def execute():
                session=DirectSession(client,root,body.model_dump(),model=model_id,
                                      scope=scope,max_output_tokens=max_tokens)
                result=await session.generate()
                return {'documentId':body.documentId,**result}
            try:return await asyncio.wait_for(execute(),timeout=285)
            except asyncio.TimeoutError as exc:
                raise BudgetExceeded('AI 서버 요청 시간 예산을 초과했습니다.') from exc
    return app
