import tempfile,unittest
from fastapi.testclient import TestClient
from knowledge_generation.api import create_app
from fixtures import Fake,INPUT,draft,REVIEW


def generation():
 d=draft()
 for code in d['code_selections']:code.pop('source_ids')
 return {'documents':[d],'no_document_reason':None,'uncertainties':[]}

class ApiTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
 def app(self,outputs,enable=True):
  fake=Fake(outputs)
  app=create_app(client=fake,internal_key='local-test-internal',data_dir=self.tmp.name,model='fake',enable_v2=enable)
  return TestClient(app),fake
 def test_disabled_by_default_policy(self):
  c,f=self.app([],False)
  self.assertEqual(c.get('/health').json(),{'status':'ok','v2Enabled':False})
  self.assertEqual(c.post('/v2/analyses',json=INPUT).status_code,404);self.assertEqual(f.calls,[])
 def test_old_routes_are_not_silently_replaced(self):
  c,f=self.app([])
  for path in ['/analyses','/revisions']:
   self.assertEqual(c.post(path,json=INPUT).status_code,404)
  self.assertEqual(f.calls,[])
 def test_authentication_before_model(self):
  c,f=self.app([])
  for headers in [{},{'X-Internal-Api-Key':'wrong'}]:
   self.assertEqual(c.post('/v2/analyses',json=INPUT,headers=headers).status_code,401)
  self.assertEqual(f.calls,[])
 def test_success_direct_two_calls_and_repeat_reuses_result(self):
  c,f=self.app([generation(),REVIEW]);h={'X-Internal-Api-Key':'local-test-internal'}
  r=c.post('/v2/analyses',json=INPUT,headers=h)
  self.assertEqual(r.status_code,200);body=r.json()
  self.assertEqual(body['documentId'],INPUT['documentId']);self.assertEqual(len(body['documents']),1)
  d=body['documents'][0];self.assertEqual(d['status'],'draft')
  self.assertIn('content',d);self.assertNotIn('body_markdown',d);self.assertIn('mainTopics',d['metadata'])
  self.assertEqual(len(f.calls),2)
  self.assertEqual(c.post('/v2/analyses',json=INPUT,headers=h).status_code,200);self.assertEqual(len(f.calls),2)
 def test_generation_failure_contract(self):
  c,f=self.app([RuntimeError('network')])
  r=c.post('/v2/analyses',json=INPUT,headers={'X-Internal-Api-Key':'local-test-internal'})
  self.assertEqual(r.status_code,502);self.assertEqual(set(r.json()),{'errorMessage'});self.assertEqual(len(f.calls),1)
 def test_review_failure_returns_stored_draft(self):
  c,f=self.app([generation(),RuntimeError('network')])
  r=c.post('/v2/analyses',json=INPUT,headers={'X-Internal-Api-Key':'local-test-internal'})
  self.assertEqual(r.status_code,200);self.assertEqual(r.json()['reviewStatus'],'incomplete')
  self.assertEqual(r.json()['documents'][0]['status'],'draft');self.assertEqual(len(f.calls),2)
 def test_invalid_id_blocks_model(self):
  c,f=self.app([])
  r=c.post('/v2/analyses',json={**INPUT,'documentId':'15'},headers={'X-Internal-Api-Key':'local-test-internal'})
  self.assertEqual(r.status_code,422);self.assertEqual(f.calls,[])
