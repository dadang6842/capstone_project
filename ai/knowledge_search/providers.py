import json
import uuid
import time
from pathlib import Path

class OpenAIProvider:
    def __init__(self,client,*,namespace,audit_dir,embedding_client=None):
        self.embedding_client=embedding_client if embedding_client is not None else client
        self.deadline=None
        self.client=client;self.namespace=namespace;self.audit_dir=Path(audit_dir)
        self.audit_dir.mkdir(parents=True,exist_ok=True)

    def begin_request(self,seconds=280):
        self.deadline=time.monotonic()+seconds

    def call_options(self):
        if self.deadline is None:return {}
        remaining=self.deadline-time.monotonic()
        if remaining<=0.05:raise TimeoutError('요청 시간 예산이 소진됐습니다.')
        return {'timeout':min(120,remaining)}

    def judge(self,payload,model,prompt):
        props={'artifactId':{'type':'string','enum':[d['artifactId'] for d in payload['documents']]},
               'decision':{'type':'string','enum':['MATCH','NO_MATCH','UNCERTAIN']},
               'reason':{'type':'string'},'evidence':{'type':'string'},
               'strength':{'type':'integer','enum':[0,2,3]}}
        schema={'type':'object','properties':{'decisions':{'type':'array','items':{
            'type':'object','properties':props,'required':list(props),'additionalProperties':False}}},
            'required':['decisions'],'additionalProperties':False}
        response=self.client.responses.create(**self.call_options(),model=model,instructions=prompt,
            input=json.dumps(payload,ensure_ascii=False),store=False,temperature=0,
            reasoning={'effort':'none'},max_output_tokens=8000,
            text={'format':{'type':'json_schema','name':'document_search_decisions','strict':True,'schema':schema}})
        usage=response.usage.model_dump() if response.usage else {}
        record={'model':response.model,'status':response.status,'usage':usage,'rawText':response.output_text}
        path=self.audit_dir/('search_'+uuid.uuid4().hex+'.json')
        path.write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
        if response.status!='completed':raise ValueError('LLM 검색 판단 미완료')
        return json.loads(response.output_text),usage

    def embed(self,texts,model):
        response=self.embedding_client.embeddings.create(**self.call_options(),model=model,input=texts,encoding_format='float')
        usage=response.usage.model_dump() if response.usage else {}
        record={'model':response.model,'inputCount':len(texts),'usage':usage}
        path=self.audit_dir/('embedding_'+uuid.uuid4().hex+'.json')
        path.write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
        rows=sorted(response.data,key=lambda r:r.index)
        if [r.index for r in rows]!=list(range(len(texts))):raise ValueError('임베딩 응답 인덱스 오류')
        return [list(r.embedding) for r in rows],usage
