import os,sys,tempfile,threading,unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from knowledge_search.api import create_app,register_search
from knowledge_search.service import SearchService
from test_base import doc
from test_hybrid import Provider

class ApiTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.p=Provider()
  self.s=SearchService(self.tmp.name,provider_factory=lambda _:self.p,judge_model='fake',embedding_model='fake')
  self.app=create_app(service=self.s,internal_key='internal-test-key',enabled=True)
  self.client=TestClient(self.app);self.headers={'X-Internal-Api-Key':'internal-test-key'}
 def post(self,path,body):return self.client.post(path,json=body,headers=self.headers)
 def sync(self,docs=None,revision=1,owner='u'):
  response=self.post('/v2/search-index/sync',{'ownerId':owner,'revision':revision,'documents':docs if docs is not None else [doc()]})
  self.assertEqual(response.status_code,200,response.text);return response.json()
 def search(self,snapshot,query='질문',owner='u',**options):
  return self.post('/v2/searches',{'ownerId':owner,'snapshotId':snapshot,'query':query,**options})
 def test_enabled_health(self):
  self.assertTrue(self.client.get("/health").json()["searchEnabled"])
 def test_disabled_by_default(self):
  with patch.dict(os.environ,{'AI_ENABLE_SEARCH':'false'}):
   client=TestClient(create_app());self.assertEqual(client.post('/v2/searches',json={}).status_code,404)
 def test_auth_before_any_calls(self):
  response=self.client.post('/v2/search-index/sync',json={'ownerId':'u','revision':1,'documents':[doc()]})
  self.assertEqual(response.status_code,401);self.assertFalse(self.p.emb);self.assertFalse(self.p.calls)
 def test_sync_search_replay_and_page_no_extra_calls(self):
  index=self.sync();r=self.search(index['snapshotId']).json();self.assertTrue(r['complete'])
  counts=(len(self.p.emb),len(self.p.calls));again=self.search(index['snapshotId']).json()
  self.assertTrue(again['cacheHit']);self.assertEqual(counts,(len(self.p.emb),len(self.p.calls)))
  page=self.post('/v2/searches/page',{'ownerId':'u','searchId':r['searchId'],'resultRevision':1,'page':1,'pageSize':10})
  self.assertEqual(page.status_code,200);self.assertEqual(counts,(len(self.p.emb),len(self.p.calls)))
  self.assertNotIn('decisions',page.json());self.assertNotIn('candidateOrder',page.json())
 def test_progress_continue_not_limited_total(self):
  index=self.sync([doc(i) for i in range(12)]);r=self.search(index['snapshotId']).json()
  self.assertEqual(r['status'],'in_progress');self.assertIsNone(r['totalMatches'])
  body={'ownerId':'u','searchId':r['searchId'],'resultRevision':1}
  response=self.post('/v2/searches/continue',body);self.assertEqual(response.status_code,200)
  final=response.json();self.assertEqual(final['totalMatches'],12);self.assertEqual(final['resultRevision'],2)
  self.assertEqual(self.post('/v2/searches/page',{'ownerId':'u','searchId':r['searchId'],'resultRevision':1}).status_code,409)
  finalbody={**body,'resultRevision':2};before=len(self.p.calls)
  self.assertEqual(self.post('/v2/searches/continue',finalbody).status_code,200);self.assertEqual(len(self.p.calls),before)
 def test_modified_body_stale_metadata_still_searches(self):
  i=self.sync();r=self.search(i['snapshotId']).json()
  changed=doc(content='수정된 본문',version=2,metadataStatus='needs_refresh',eligibleForIndexing=False)
  j=self.sync([changed],revision=2);self.assertEqual(self.search(i['snapshotId']).status_code,409)
  new=self.search(j['snapshotId']).json();self.assertEqual(new['results'][0]['version'],2)
  self.assertFalse(new['results'][0]['metadataUsed'])
  old_page=self.post('/v2/searches/page',{'ownerId':'u','searchId':r['searchId'],'resultRevision':1})
  self.assertEqual(old_page.status_code,409)
 def test_deleted_document_disappears_and_old_record_rejected(self):
  i=self.sync();r=self.search(i['snapshotId']).json();j=self.sync([doc(deleted=True)],revision=2)
  self.assertEqual(self.search(j['snapshotId']).json()['status'],'no_documents')
  self.assertEqual(self.post('/v2/searches/page',{'ownerId':'u','searchId':r['searchId'],'resultRevision':1}).status_code,409)
 def test_owner_isolation(self):
  i=self.sync(owner='u');r=self.search(i['snapshotId']).json();self.sync(owner='other')
  response=self.post('/v2/searches/page',{'ownerId':'other','searchId':r['searchId'],'resultRevision':1})
  self.assertEqual(response.status_code,404)
 def test_revision_guards_sync_replay(self):
  i=self.sync();before=len(self.p.emb);self.assertTrue(self.sync()['reused']);self.assertEqual(len(self.p.emb),before)
  bad=self.post('/v2/search-index/sync',{'ownerId':'u','revision':1,'documents':[doc(content='다른 본문')]})
  self.assertEqual(bad.status_code,409)
  self.sync([doc()],revision=2)
  self.assertEqual(self.post('/v2/search-index/sync',{'ownerId':'u','revision':1,'documents':[doc()]}).status_code,409)
 def test_sync_failure_blocks_old_search_and_can_resume(self):
  i=self.sync();self.p.fail_embed=True
  body={'ownerId':'u','revision':2,'documents':[doc(content='새 본문')]}
  self.assertEqual(self.post('/v2/search-index/sync',body).status_code,502)
  self.assertEqual(self.search(i['snapshotId']).status_code,409)
  self.p.fail_embed=False;self.assertEqual(self.post('/v2/search-index/sync',body).status_code,200)
 def test_judge_failure_200_incomplete_never_no_match(self):
  i=self.sync();self.p.mode='fail';r=self.search(i['snapshotId'])
  self.assertEqual(r.status_code,200);self.assertEqual(r.json()['status'],'incomplete');self.assertEqual(len(self.p.calls),1)
 def test_busy_same_owner(self):
  self.sync()
  with self.s.operation('u'):
   r=self.post('/v2/search-index/sync',{'ownerId':'u','revision':2,'documents':[doc()]})
   self.assertEqual(r.status_code,409)
 def test_invalid_input_no_external_calls(self):
  self.assertEqual(self.post('/v2/search-index/sync',{'ownerId':'u','revision':True,'documents':[]}).status_code,422)
  self.assertEqual(self.post('/v2/searches',{'ownerId':'u','snapshotId':'x','query':'','maxNewBatches':100}).status_code,422)
  self.assertFalse(self.p.calls);self.assertFalse(self.p.emb)
 def test_document_read_checks_owner_and_version(self):
  i=self.sync();r=self.search(i['snapshotId']).json();item=r['results'][0]
  response=self.post('/v2/search-documents/read',{'ownerId':'u','artifactId':item['artifactId'],'searchHash':item['searchHash']})
  self.assertEqual(response.status_code,200);self.assertEqual(response.json()['content'],doc()['content'])
  self.assertEqual(self.post('/v2/search-documents/read',{'ownerId':'u','artifactId':'a','searchHash':'old'}).status_code,409)
 def test_register_preserves_existing_routes(self):
  from fastapi import FastAPI
  app=FastAPI()
  @app.post('/analyses')
  def old():return {'existing':True}
  @app.post('/revisions')
  def old_revision():return {'revision':True}
  register_search(app,service=self.s,internal_key='internal-test-key',enabled=True)
  client=TestClient(app);self.assertEqual(client.post('/analyses').json(),{'existing':True})
  self.assertEqual(client.post('/revisions').json(),{'revision':True})
