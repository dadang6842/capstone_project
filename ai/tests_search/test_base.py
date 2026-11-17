import copy,tempfile,unittest
from knowledge_search.base import SearchTrial,extract_documents

def doc(i='a',**kw):
 return {**dict(artifactId=str(i),version=1,title='문서 '+str(i),content='본문의 답을 확인합니다.',status='adopted',
  eligibleForIndexing=True,metadataStatus='current',metadata={'scope':'검색'},summary='설명',keywords=['검색'],contentHash='old',
  sourceLinks=[{'conversationId':1,'sourceId':'original'}],review={'status':'no_issues_detected'}),**kw}
class Fake:
 namespace='fake'
 def __init__(self):self.calls=[];self.mode=None
 def judge(self,payload,model,prompt):
  self.calls.append(payload)
  if self.mode=='fail':raise RuntimeError('network')
  decisions=[dict(artifactId=d['artifactId'],decision='MATCH',reason='질문에 직접 답한다.',evidence=d['content'][:100],strength=3) for d in payload['documents']]
  if self.mode=='none':
   for d in decisions:d.update(decision='NO_MATCH',evidence='',strength=0)
  if self.mode=='uncertain':
   for d in decisions:d.update(decision='UNCERTAIN',evidence='',strength=0)
  if self.mode=='missing':decisions.pop()
  if self.mode=='fake_quote':decisions[0]['evidence']='없는 구절'
  if self.mode=='unknown':decisions[0]['artifactId']='unknown'
  return {'decisions':decisions},{}
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.p=Fake();self.s=self.session()
 def session(self,owner='one',**kw):return SearchTrial(self.tmp.name,owner=owner,provider=self.p,judge_model='fake',**kw)
 def test_only_adopted_not_metadata_gate(self):
  self.s.sync([doc('one'),doc('draft',status='draft'),doc('stale',metadataStatus='needs_refresh',eligibleForIndexing=False),doc('deleted',deleted=True)])
  ds=self.s.snapshot()['documents'];self.assertEqual(len(ds),2)
  stale=next(d for d in ds if d['artifactId']=='stale');self.assertFalse(stale['metadataUsed']);self.assertIsNone(stale['metadata']);self.assertIsNone(stale['summary'])
 def test_all_23_matches_no_k_limit(self):
  self.s.sync([doc(i) for i in range(23)]);r=self.s.search('본문의 답')
  self.assertTrue(r['complete']);self.assertEqual(r['totalMatches'],23);self.assertEqual(r['processedDocuments'],23)
  self.assertEqual(len(self.p.calls),3)
 def test_all_body_passed_no_chunk_cap(self):
  text='앞부분 설명입니다. '*3000+'중간에만 있는 정답'+' 뒤의 예외 조건입니다.'*1000
  self.s.sync([doc(content=text)]);self.s.search('중간 정답')
  self.assertEqual(self.p.calls[0]['documents'][0]['content'],text)
 def test_empty_no_call(self):
  r=self.s.search('질문');self.assertEqual(r['status'],'no_documents');self.assertFalse(self.p.calls)
 def test_no_match(self):
  self.s.sync([doc()]);self.p.mode='none';r=self.s.search('무관한 질문')
  self.assertEqual(r['status'],'no_match');self.assertEqual(r['results'],[])
 def test_uncertain_is_not_match(self):
  self.s.sync([doc()]);self.p.mode='uncertain';r=self.s.search('조건')
  self.assertEqual(r['results'],[]);self.assertEqual(r['uncertainDocuments'],1)
 def test_failed_is_not_no_match(self):
  self.s.sync([doc()]);self.p.mode='fail';r=self.s.search('질문')
  self.assertEqual(r['status'],'incomplete');self.assertFalse(r['complete']);self.assertIsNone(r['totalMatches']);self.assertEqual(len(self.p.calls),1)
 def test_missing_decision_blocks_completion(self):
  self.s.sync([doc()]);self.p.mode='missing';r=self.s.search('질문');self.assertFalse(r['complete'])
 def test_quote_guard(self):
  self.s.sync([doc()]);self.p.mode='fake_quote';self.assertEqual(self.s.search('질문')['status'],'incomplete')
 def test_unknown_id_guard(self):
  self.s.sync([doc()]);self.p.mode='unknown';self.assertEqual(self.s.search('질문')['status'],'incomplete')
 def test_result_cache(self):
  self.s.sync([doc()]);self.s.search('질문');self.assertTrue(self.session().search('질문')['cacheHit']);self.assertEqual(len(self.p.calls),1)
 def test_edit_rebuilds_and_invalidates_page(self):
  self.s.sync([doc()]);r=self.s.search('질문');h=r['results'][0]['searchHash']
  self.s.sync([doc(content='새 본문',version=2,metadataStatus='needs_refresh',eligibleForIndexing=False)])
  with self.assertRaises(ValueError):self.s.page(r)
  with self.assertRaises(ValueError):self.s.get_document('a',h)
  r=self.s.search('질문');self.assertFalse(r['cacheHit']);self.assertEqual(r['results'][0]['version'],2)
 def test_delete_and_unadopt(self):
  self.s.sync([doc('a'),doc('b')]);self.s.search('질문')
  self.s.sync([doc('a',deleted=True),doc('b',status='draft')]);self.assertEqual(self.s.search('질문')['status'],'no_documents')
 def test_owner_isolation(self):
  self.s.sync([doc()]);other=self.session(owner='two');self.assertEqual(other.search('질문')['status'],'no_documents')
 def test_page_not_total_limit(self):
  self.s.sync([doc(i) for i in range(23)]);r=self.s.search('질문');count=len(self.p.calls)
  a=self.s.page(r,page=1,page_size=10);b=self.s.page(r,page=3,page_size=10)
  self.assertEqual(a['totalMatches'],23);self.assertEqual(len(b['results']),3);self.assertFalse(b['hasMore']);self.assertEqual(count,len(self.p.calls))
 def test_oversize_explicit_not_truncated(self):
  s=self.session(batch_bytes=1000,max_document_bytes=1000);s.sync([doc(content='가'*1000)])
  r=s.search('질문');self.assertEqual(r['status'],'incomplete');self.assertEqual(r['processedDocuments'],0);self.assertFalse(self.p.calls)
 def test_resume_reuses_completed_batches(self):
  class FailSecond(Fake):
   def judge(self,*args):
    if len(self.calls)==1 and self.mode=='fail_second':self.calls.append(args[0]);raise RuntimeError('failure')
    return super().judge(*args)
  p=FailSecond();p.mode='fail_second';s=SearchTrial(self.tmp.name,owner='resume',provider=p,judge_model='fake')
  s.sync([doc(i) for i in range(17)]);r=s.search('질문');self.assertFalse(r['complete']);self.assertEqual(r['processedDocuments'],8)
  p.mode=None;r=s.search('질문');self.assertTrue(r['complete']);self.assertEqual(r['totalMatches'],17);self.assertEqual(len(p.calls),4)
 def test_invalid_query_before_calls(self):
  for value in ['',None,'가'*2000]:
   with self.assertRaises(ValueError):self.s.search(value)
  self.assertFalse(self.p.calls)
 def test_invalid_document_duplicate(self):
  with self.assertRaises(ValueError):self.s.sync([doc(),doc()])
 def test_export_adapter(self):self.assertEqual(extract_documents({'result':{'documents':[doc()]}}),[doc()])
