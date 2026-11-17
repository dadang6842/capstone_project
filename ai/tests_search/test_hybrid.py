import tempfile,unittest
from knowledge_search import HybridSearch
from test_base import doc,Fake

class Provider(Fake):
 def __init__(self):super().__init__();self.emb=[];self.fail_embed=False
 def embed(self,texts,model):
  self.emb.append(texts)
  if self.fail_embed:raise RuntimeError('embedding unavailable')
  return [[1.0]+[float(t.lower().count(k)) for k in ['toolnode','specialneedle','임계값','메모리','커피']] for t in texts],{}

class HybridTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.p=Provider();self.s=self.session()
 def session(self,owner='one',embedding_model='fake-emb'):
  return HybridSearch(self.tmp.name,owner=owner,provider=self.p,judge_model='fake',embedding_model=embedding_model)
 def test_real_hybrid_uses_embeddings_and_lexical_order(self):
  self.s.sync([doc('a',title='기타',content='일반 설명'),doc('z',title='도구',content='ToolNode 도구 실행 설명')])
  r=self.s.search('ToolNode');self.assertEqual(r['candidateOrder'][0]['artifactId'],'z')
  self.assertEqual(len(self.p.emb),2);self.assertEqual(len(self.p.calls),1)
 def test_all_matches_accessible_not_fixed_k(self):
  self.s.sync([doc(i) for i in range(23)]);r=self.s.search('본문')
  self.assertEqual(r['status'],'in_progress');self.assertEqual(r['processedDocuments'],8);self.assertIsNone(r['totalMatches'])
  r=self.s.search('본문');self.assertEqual(r['processedDocuments'],16)
  r=self.s.search('본문');self.assertTrue(r['complete']);self.assertEqual(r['totalMatches'],23)
 def test_no_match_only_when_all_checked(self):
  self.s.sync([doc(i) for i in range(9)]);self.p.mode='none'
  r=self.s.search('질문');self.assertEqual(r['status'],'in_progress');self.assertTrue(r['hasMoreCandidates'])
  r=self.s.search('질문');self.assertEqual(r['status'],'no_match');self.assertEqual(r['totalMatches'],0)
 def test_full_exhaustive_option(self):
  self.s.sync([doc(i) for i in range(17)]);r=self.s.search('질문',max_new_batches=None)
  self.assertEqual(r['totalMatches'],17);self.assertFalse(r['hasMoreCandidates'])
 def test_sync_and_same_query_reused(self):
  self.s.sync([doc()]);self.s.search('질문');counts=(len(self.p.calls),len(self.p.emb))
  self.s.sync([doc()]);r=self.session().search('질문')
  self.assertTrue(r['cacheHit']);self.assertEqual(counts,(len(self.p.calls),len(self.p.emb)))
 def test_changed_doc_is_reindexed_and_only_its_decision_new(self):
  self.s.sync([doc('a'),doc('b')]);r=self.s.search('질문');old=r['results'][0]['searchHash']
  self.s.sync([doc('a',content='새 메모리 내용',metadataStatus='needs_refresh',eligibleForIndexing=False,version=2),doc('b')])
  r=self.s.search('질문');self.assertEqual(len(self.p.calls[-1]['documents']),1)
  self.assertEqual(self.p.calls[-1]['documents'][0]['content'],'새 메모리 내용')
  self.assertIsNone(self.p.calls[-1]['documents'][0]['metadata'])
  self.assertEqual(len(r['results']),2)
 def test_stale_auxiliary_excluded_from_embedding_and_judge(self):
  d=doc(metadataStatus='needs_refresh',eligibleForIndexing=False,summary='OLDMARKER',keywords=['OLDMARKER'],metadata={'old':'OLDMARKER'})
  self.s.sync([d]);self.s.search('질문')
  self.assertTrue(all('OLDMARKER' not in text for batch in self.p.emb for text in batch))
  self.assertIsNone(self.p.calls[0]['documents'][0]['summary'])
 def test_delete_unadopt_invalidates_cached_results(self):
  self.s.sync([doc()]);r=self.s.search('질문');self.s.sync([doc(status='draft')])
  self.assertEqual(self.s.search('질문')['status'],'no_documents')
  with self.assertRaises(ValueError):self.s.page(r)
 def test_owner_cache_isolated(self):
  self.s.sync([doc()]);self.s.search('질문');other=self.session(owner='two')
  self.assertEqual(other.search('질문')['status'],'no_documents');other.sync([doc()])
  self.assertEqual(len(self.p.emb),3)
 def test_failed_index_blocks_old_snapshot(self):
  self.s.sync([doc()]);self.p.fail_embed=True
  with self.assertRaises(RuntimeError):self.s.sync([doc(content='변경된 본문')])
  with self.assertRaises(ValueError):self.s.search('질문')
 def test_query_embedding_failure_distinguished(self):
  self.s.sync([doc()]);self.p.fail_embed=True;r=self.s.search('질문')
  self.assertEqual(r['status'],'incomplete');self.assertEqual(r['errors'][0]['phase'],'retrieval');self.assertFalse(self.p.calls)
 def test_judge_failure_no_retry(self):
  self.s.sync([doc()]);self.p.mode='fail';r=self.s.search('질문')
  self.assertEqual(r['status'],'incomplete');self.assertEqual(len(self.p.calls),1)
 def test_missing_decision_not_completed(self):
  self.s.sync([doc()]);self.p.mode='missing';r=self.s.search('질문')
  self.assertEqual(r['status'],'incomplete');self.assertEqual(r['processedDocuments'],0)
 def test_unknown_quote_not_accepted(self):
  self.s.sync([doc()]);self.p.mode='fake_quote';r=self.s.search('질문')
  self.assertFalse(r['complete']);self.assertEqual(r['results'],[])
 def test_full_body_passed_after_passage_retrieval(self):
  body='일반 설명 '*2000+'specialneedle'+' 끝부분 예외 '*1000
  self.s.sync([doc(content=body)]);self.s.search('specialneedle')
  self.assertEqual(self.p.calls[0]['documents'][0]['content'],body)
  self.assertGreater(len(self.s.snapshot()['chunks']),2)
 def test_pagination_no_new_model_calls(self):
  self.s.sync([doc(i) for i in range(12)]);r=self.s.search('질문',max_new_batches=None)
  counts=(len(self.p.calls),len(self.p.emb));page=self.s.page(r,page=2,page_size=10)
  self.assertEqual(len(page['results']),2);self.assertEqual(page['totalMatches'],12)
  self.assertEqual(counts,(len(self.p.calls),len(self.p.emb)))
 def test_oversize_explicit_incomplete(self):
  s=HybridSearch(self.tmp.name,owner='large',provider=self.p,judge_model='fake',embedding_model='fake',batch_bytes=1000,max_document_bytes=1000)
  s.sync([doc(content='가'*1000)]);r=s.search('질문');self.assertEqual(r['status'],'incomplete')
  self.assertEqual(r['errors'][0]['type'],'document_too_large')
 def test_changed_embedding_model_requires_sync(self):
  self.s.sync([doc()]);other=self.session(embedding_model='other')
  with self.assertRaises(ValueError):other.search('질문')
 def test_baseline_separate_from_hybrid(self):
  self.s.sync([doc()]);self.s.search('질문');r=self.s.full_scan('질문')
  self.assertEqual(r['searchMode'],'full_scan_baseline');self.assertEqual(len(self.p.calls),2)
 def test_preview_free(self):
  self.s.sync([doc()]);before=len(self.p.emb);self.s.preview('질문')
  self.assertEqual(len(self.p.emb),before);self.assertFalse(self.p.calls)
