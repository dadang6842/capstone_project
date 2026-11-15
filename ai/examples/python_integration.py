"""Synthetic example. Running this file can incur API costs."""
import asyncio,json,os
from pathlib import Path
from openai import AsyncOpenAI
from knowledge_generation import DirectSession

async def main():
    request=json.loads((Path(__file__).parent/'analysis_request.json').read_text(encoding='utf-8'))
    # Backend must validate authenticated owner/conversation access before this call.
    options={'api_key':os.environ['OPENAI_API_KEY'],'max_retries':0,'timeout':280}
    if os.environ.get('OPENAI_BASE_URL'):options['base_url']=os.environ['OPENAI_BASE_URL']
    async with AsyncOpenAI(**options) as client:
        session=DirectSession(client,os.environ.get('AI_DATA_DIR','./ai_data'),request,
            model=os.environ.get('AI_MODEL','gpt-6-luna'),scope=os.environ.get('AI_TENANT_SCOPE','backend'))
        result=await session.generate()
        print(json.dumps(result,ensure_ascii=False,indent=2))
        # Persist/match result documents in the backend's own data model.
        # No user adoption here: only an explicit authenticated user action may adopt.

if __name__=='__main__':asyncio.run(main())
