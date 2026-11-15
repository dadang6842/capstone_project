"""Direct generation -> one advisory review -> user-editable drafts.
No candidate extraction, planning, global merge, automatic revisions, or coverage gate.
"""
import asyncio,copy,json,re,uuid
from pathlib import Path
from pydantic import Field
from .models import (StrictMeta,ExtendedConversation,PositiveId,GeneratedDocument,
                     Category,Keyword,Finding,CriticalReview)
from .sources import SourceBundle
from .store import Conflict
from .io import (ModelIO,Deadline,CallFailure,bound_schema,validate_model,
                 render,bind_metadata,public_draft)
from .util import digest,now,write_json
from . import prompts,review

class DirectInput(StrictMeta):
    documentId: PositiveId
    conversations: list[ExtendedConversation] = Field(min_length=1)

class SelectedCode(StrictMeta):
    code_ref: str
    label: str = Field(min_length=1)
    notes: str = Field(min_length=1)

class Document(GeneratedDocument):
    category: Category
    summary: str = Field(max_length=512)
    keywords: list[Keyword] = Field(max_length=10)
    code_selections: list[SelectedCode]
    uncertainties: list[str]

class DirectOutput(StrictMeta):
    documents: list[Document]
    no_document_reason: str | None
    uncertainties: list[str]

class DocumentFinding(Finding):
    document_index: int = Field(ge=0)

class AdvisoryReview(StrictMeta):
    findings: list[DocumentFinding] = Field(max_length=5)
    optional_notes: list[str]

GENERATION_PROMPT = prompts.WRITE_PROMPT.replace(
    '계획의 질문·판단을 이해하거나 방법을 재사용하는 데 필요한 내용을 선택한다.',
    '각 문서의 질문·판단을 이해하거나 방법을 재사용하는 데 필요한 내용을 선택한다.'
) + '''
대화 원문을 직접 읽고 완성된 지식문서들을 한 번에 작성한다.
문서별 body_markdown과 검색 metadata, source_ids를 함께 반환한다.
문서 개수는 고정하지 않는다. 각 문서는 나중에 독립적으로 다시 찾아 쓸 한 가지 구체적인 질문·판단에 답한다.
제목과 본문이 같은 중심 질문을 다루도록 쓴다. 서로 다른 질문에 답하는 설명·방법·평가 결과를 같은 프로젝트나 단계라는 이유만으로 한 문서에 묶지 않는다.
같은 선택을 위한 비교·하나의 방법을 완성하는 절차는 함께 두고 단순 조건을 따로 떼지 않는다.
content_states에서 adopted는 사용자가 실제로 선택·채택한 경우에 사용하고, source_ids에 해당 사용자 발화를 포함한다.
챗봇의 제안·정리만 근거로 사용자 채택을 단정하지 않는다. 제안과 설명은 proposed 또는 explanation으로 구분한다. 사용자 채택을 실행 성공으로 바꾸지 않는다.
코드는 code_selections에서 code_ref/label/notes만 선택한다.
코드의 실제 원문 ID는 프로그램이 입력 코드 디렉터리에서 연결한다. 코드 출처 ID를 중복 생성하지 않는다.
재사용할 내용이 없으면 documents=[], no_document_reason에 이유를 쓴다.
문서가 있으면 no_document_reason=null이다. JSON Schema에 맞는 객체 하나만 반환한다.
'''
REVIEW_PROMPT = prompts.REVIEW_PROMPT + '''
이번에는 생성 문서 목록을 한 번만 검토한다. 문서 수나 전체 원문 지식의 누락률을 평가하지 않는다.
각 finding의 document_index는 0부터 시작하는 해당 문서 번호다.
field_path는 해당 문서의 documents[번호].필드 경로를 그대로 선택한다.
문서 본문을 재작성하거나 수정본·통합본을 출력하지 않는다. 검토 의견만 반환한다.
의견은 전체 문서를 통틀어 최대 5개다. 지적이 없다는 결과는 정확성 보증이 아니다.
'''


def normalize_output(value,bundle):
    value=DirectOutput.model_validate(value).model_dump()
    if bool(value['documents']) == bool((value['no_document_reason'] or '').strip()):
        raise ValueError('문서 유무와 문서 없음 사유가 맞지 않습니다.')
    for doc in value['documents']:
        for selection in doc['code_selections']:
            ref=selection['code_ref']
            if ref not in bundle.catalog:raise ValueError('입력에 없는 코드 참조입니다.')
            selection['source_ids']=list(bundle.catalog[ref]['source_ids'])
        checked=validate_model(doc,bundle,bundle.lookup)
        doc.clear();doc.update(checked)
    return value


class DirectSession:
    def __init__(self,client,root,request,*,model='gpt-6-luna',scope='local-test-user',max_output_tokens=16000):
        self.input=DirectInput.model_validate(request).model_dump()
        self.scope=scope;self.bundle=SourceBundle(self.input['conversations'])
        self.io=ModelIO(client,root,model=model,budget_seconds=280)
        if not isinstance(max_output_tokens,int) or max_output_tokens<=0:
            raise ValueError('출력 토큰 상한을 확인하세요.')
        self.max_output_tokens=max_output_tokens
        self.run_id=digest({'version':'direct_documents_1_1','scope':scope,'input':self.input,
            'settings':self.io.settings,'outputTokens':max_output_tokens,
            'prompts':[GENERATION_PROMPT,REVIEW_PROMPT],
            'schemas':[DirectOutput.model_json_schema(),AdvisoryReview.model_json_schema()]})
        self.result_path=self.io.root/'runs'/self.run_id/'result.json'
        self.result=None
        if self.result_path.exists():
            self.result=json.loads(self.result_path.read_text(encoding='utf-8'))

    def documents(self):
        if self.result is None:return []
        return [self.io.repo.get(self.scope,aid) for aid in self.result['artifactIds']]

    async def generate(self):
        """At most one generation + one review call. Reopening a saved run is free."""
        if self.result_path.exists():
            self.result=json.loads(self.result_path.read_text(encoding='utf-8'))
            if self.result['reviewStatus'] != 'pending':return self.summary()
        deadline=Deadline(self.io.budget_seconds)
        token=self.io.repo.acquire(self.scope,self.run_id,self.io.budget_seconds+30)
        try:
            if self.result_path.exists():
                self.result=json.loads(self.result_path.read_text(encoding='utf-8'))
                if self.result['reviewStatus'] == 'pending':
                    # Acquiring the lease proves no unexpired worker owns this run.
                    self._finish_interrupted_review('interrupted')
                return self.summary()
            print('지식문서·메타데이터 직접 생성 중 (생성 호출 1회)',flush=True)
            output=await self.io.call_json(self.scope,'direct_generate',GENERATION_PROMPT,
                self.bundle.selected(self.bundle.lookup),DirectOutput,deadline,
                ids=self.bundle.lookup,refs=self.bundle.catalog,limit=self.max_output_tokens,
                validator=lambda value:normalize_output(value,self.bundle))
            items=[]
            for index,draft in enumerate(output['documents']):
                view,codes,links=render(draft,self.bundle);content_hash=digest(view)
                record={'artifactId':str(uuid.uuid5(uuid.NAMESPACE_URL,self.run_id+':'+str(index))),
                    'version':1,'status':'draft',**view,'contentHash':content_hash,
                    'sourceHash':self.bundle.hash,'createdAt':now(),'updatedAt':now(),
                    'metadata':bind_metadata(draft['metadata'],self.bundle),'metadataStatus':'current',
                    'contentOrigin':'ai_generated','sourceLinksStatus':'generated_links',
                    'sourceLinks':links,'copiedCodeBlocks':codes,'uncertainties':draft['uncertainties'],
                    'sourceWarnings':self.bundle.warnings,'relationsStatus':'not_processed',
                    'eligibleForIndexing':False,'review':review.incomplete('not_run',content_hash),
                    'lastUserAction':None,'_modelDraft':draft,'_sourceLookup':self.bundle.lookup}
                items.append(self.io.repo.create(self.scope,record))
            self.result={'runId':self.run_id,'status':'drafts_stored' if items else 'no_content',
                'artifactIds':[d['artifactId'] for d in items],
                'noDocumentReason':output['no_document_reason'],'uncertainties':output['uncertainties'],
                'reviewStatus':'pending' if items else 'not_applicable','reviewError':None,
                'automaticRevision':False,'automaticAdoption':False}
            # Persist drafts before review. Failure or process restart must not erase them.
            write_json(self.result_path,self.result)
            if items:
                try:
                    if deadline.remaining()<2:raise CallFailure('초안은 저장됐으나 자동 검토 시간 예산이 부족합니다.')
                    print(f'초안 {len(items)}편 보관 완료. 자동 검토 의견 수집 중 (검토 호출 1회)',flush=True)
                    verdicts=await self._review_once(output['documents'],items,deadline)
                    for item,verdict in zip(items,verdicts):
                        self.io.repo.set_review(self.scope,item['artifactId'],item['version'],verdict)
                    self.result['reviewStatus']='completed'
                except asyncio.CancelledError:
                    self._finish_interrupted_review('interrupted')
                    raise
                except (CallFailure,ValueError,Conflict) as exc:
                    self._finish_interrupted_review(str(exc), exc)
                write_json(self.result_path,self.result)
            return self.summary()
        finally:self.io.repo.release(self.scope,self.run_id,token)

    def _finish_interrupted_review(self, reason, error=None):
        # Preserve completed verdicts and any newer user edits. No LLM retry.
        for item in self.documents():
            current_review = item['review']
            if current_review.get('reason') != 'not_run':
                continue
            try:
                self.io.repo.set_review(self.scope, item['artifactId'], item['version'],
                    review.incomplete(reason, item['contentHash']))
            except Conflict:
                continue
        self.result['reviewStatus'] = 'incomplete'
        self.result['reviewError'] = {'message': reason,
            'detail': str(error.__cause__) if error and error.__cause__ else None}
        write_json(self.result_path, self.result)

    async def _review_once(self,drafts,items,deadline):
        payload,evidence,paths=review.review_input({'documents':drafts},
            self.bundle.selected(self.bundle.lookup),self.bundle)
        payload['review_limits']='원문 충실도·필수 맥락·명확한 메타데이터 모순에 대한 1회 검토. 전체 지식 누락 평가·외부 사실 검증은 하지 않는다.'
        schema=bound_schema(AdvisoryReview,self.bundle.lookup,self.bundle.catalog)
        props=schema['$defs']['DocumentFinding']['properties']
        props['document_index']['enum']=list(range(len(drafts)))
        props['field_path']['enum']=list(paths)
        props['evidence_refs']['items']={'type':'string','enum':list(evidence)}
        def validate(value):
            for finding in value['findings']:
                i=finding['document_index']
                if not 0<=i<len(drafts) or not finding['field_path'].startswith(f'documents[{i}].'):
                    raise ValueError('검토 의견의 문서 번호와 필드가 일치하지 않습니다.')
            return value
        value=await self.io.call_json(self.scope,'direct_review',REVIEW_PROMPT,payload,
            AdvisoryReview,deadline,ids=self.bundle.lookup,limit=2048,schema=schema,validator=validate)
        results=[]
        for i,(draft,item) in enumerate(zip(drafts,items)):
            findings=[]
            for f in value['findings']:
                if f['document_index']!=i:continue
                finding={k:v for k,v in f.items() if k!='document_index'}
                finding['field_path']=finding['field_path'][len(f'documents[{i}].'):]
                findings.append(finding)
            result=review.assess({'findings':findings,'optional_notes':value['optional_notes']},
                evidence,review.fields(draft),self.bundle,item['contentHash'])
            result['reviewScope']='generated_documents_once_not_coverage_check'
            results.append(result)
        return results

    def summary(self):
        if self.result is None:return {'status':'not_run','documents':[]}
        return {**self.result,'documents':[public_draft(d) for d in self.documents()]}

    def edit(self,number,changes):
        items=self.documents()
        if not 1<=number<=len(items):raise ValueError('문서 번호를 확인하세요.')
        item=items[number-1]
        return self.io.repo.edit(self.scope,item['artifactId'],item['version'],changes,actor=self.scope)

    def adopt(self,numbers):
        items=self.documents()
        if not numbers:return []
        if any(not 1<=i<=len(items) for i in numbers):raise ValueError('문서 번호를 확인하세요.')
        return self.io.repo.adopt_many(self.scope,[(items[i-1]['artifactId'],items[i-1]['version']) for i in numbers],actor=self.scope)

    async def refresh_metadata(self,number):
        items=self.documents()
        if not 1<=number<=len(items):raise ValueError('문서 번호를 확인하세요.')
        item=items[number-1]
        return await self.io.refresh_metadata(self.scope,item['artifactId'],item['version'])

    def export(self,capture=None):
        items=self.documents()
        value={'moduleVersion':'direct_documents_1_1','capture':capture,'result':self.summary(),
            'history':{d['artifactId']:self.io.repo.history(self.scope,d['artifactId']) for d in items}}
        path=self.result_path.parent/'direct_review.json';write_json(path,value);return path
