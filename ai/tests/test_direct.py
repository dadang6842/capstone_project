import copy,json,tempfile,unittest
from pathlib import Path
from fixtures import Fake,INPUT,draft,metadata,REVIEW,CODE
from knowledge_generation.direct import DirectSession
from knowledge_generation.io import CallFailure


def output(n=1):
 documents=[]
 for i in range(n):
  d=draft();d['title']+=str(i)
  for selected in d['code_selections']:selected.pop('source_ids')
  documents.append(d)
 return {'documents':documents,'no_document_reason':None,'uncertainties':[]}

class DirectTests(unittest.IsolatedAsyncioTestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
 def create(self,outputs):
  fake=Fake(outputs);return DirectSession(fake,self.temp.name,INPUT,model='fake'),fake
 async def test_two_calls_many_drafts_and_no_auto_adoption(self):
  s,f=self.create([output(2),REVIEW]);r=await s.generate()
  self.assertEqual(len(f.calls),2);self.assertEqual(len(r['documents']),2)
  self.assertTrue(all(d['status']=='draft' and d['review']['status']=='no_issues_detected' for d in r['documents']))
  self.assertTrue(all(not d['eligibleForIndexing'] for d in r['documents']))
  self.assertTrue(all('candidate' not in req['text']['format']['name'] and 'plan' not in req['text']['format']['name'] for req in f.calls))
 async def test_code_parent_is_attached_by_program(self):
  s,_=self.create([output(),REVIEW]);r=await s.generate();d=r['documents'][0]
  self.assertIn(CODE,d['content']);self.assertEqual(d['copiedCodeBlocks'][0]['sources'][0]['sourceId'],'original-a')
 async def test_restart_and_rerun_use_result_without_calls(self):
  s,f=self.create([output(),REVIEW]);await s.generate();await s.generate()
  fresh=DirectSession(f,self.temp.name,INPUT,model='fake');await fresh.generate()
  self.assertEqual(len(f.calls),2)
 async def test_review_failure_keeps_drafts_and_does_not_loop(self):
  s,f=self.create([output(2),RuntimeError('network')]);r=await s.generate()
  self.assertEqual(r['reviewStatus'],'incomplete');self.assertEqual(len(r['documents']),2)
  self.assertTrue(all(d['review']['status']=='incomplete' for d in r['documents']))
  await s.generate();self.assertEqual(len(f.calls),2)
 async def test_incomplete_generation_is_audited_no_retry(self):
  s,f=self.create([('incomplete','partial-json')])
  with self.assertRaises(CallFailure):await s.generate()
  self.assertEqual(len(f.calls),1);self.assertEqual(s.documents(),[])
  self.assertTrue(list(Path(self.temp.name).rglob('direct_generate_*.json')))
 async def test_unknown_source_not_accepted(self):
  data=output();data['documents'][0]['source_ids']=['S999'];s,f=self.create([data])
  with self.assertRaises(CallFailure):await s.generate()
  self.assertEqual(len(f.calls),1);self.assertFalse(s.result_path.exists())
 async def test_review_is_advice_not_rewrite_or_storage_rejection(self):
  finding={'category':'source_fidelity','certainty':'supported','document_index':0,
   'field_path':'documents[0].body_markdown','document_passage':'실행 결과는 사용자 보고다.',
   'evidence_refs':['S003:T0003'],'reason':'의견 시험','impact':'오해 가능','suggestion':'원문을 확인하세요.'}
  s,f=self.create([output(),{'findings':[finding],'optional_notes':[]}]);r=await s.generate();d=r['documents'][0]
  self.assertEqual(d['review']['status'],'attention_needed');self.assertEqual(d['status'],'draft')
  self.assertIn('실행 결과는 사용자 보고다.',d['content'])
  adopted=s.adopt([1]);self.assertEqual(adopted[0]['status'],'adopted');self.assertEqual(len(f.calls),2)
 async def test_user_edit_survives_rerun_and_invalidates_metadata(self):
  s,f=self.create([output(),REVIEW]);await s.generate();edited=s.edit(1,{'content':'사용자 수정 본문'})
  self.assertEqual(edited['metadataStatus'],'needs_refresh');r=await s.generate()
  self.assertEqual(r['documents'][0]['content'],'사용자 수정 본문');self.assertEqual(len(f.calls),2)
 async def test_no_reusable_content_skips_review(self):
  s,f=self.create([{'documents':[],'no_document_reason':'인사만 있음','uncertainties':[]}]);r=await s.generate()
  self.assertEqual(r['status'],'no_content');self.assertEqual(r['documents'],[]);self.assertEqual(len(f.calls),1)
 async def test_wrong_review_document_index_fails_soft(self):
  finding={'category':'essential_context','certainty':'supported','document_index':9,
   'field_path':'documents[0].body_markdown','document_passage':'함수를 호출한다.',
   'evidence_refs':['S001:T0001'],'reason':'의견','impact':'의미','suggestion':'확인'}
  s,f=self.create([output(),{'findings':[finding],'optional_notes':[]}]);r=await s.generate()
  self.assertEqual(r['reviewStatus'],'incomplete');self.assertEqual(len(r['documents']),1);self.assertEqual(len(f.calls),2)
 async def test_export_no_plan_or_candidate_workflow(self):
  s,_=self.create([output(),REVIEW]);await s.generate();p=s.export();x=json.loads(p.read_text())
  self.assertEqual(set(x),{'moduleVersion','capture','result','history'})
  self.assertNotIn('planning',x);self.assertEqual(len(x['result']['documents']),1)
 async def test_metadata_refresh_after_user_edit_uses_edited_body(self):
  s,f=self.create([output(),REVIEW,metadata('U001')]);await s.generate();s.edit(1,{'content':'사용자 설명'})
  result=await s.refresh_metadata(1)
  self.assertEqual(result['metadataStatus'],'current')
  self.assertEqual(result['metadata']['scope']['sources'][0]['kind'],'user_edited_document')
  self.assertEqual(len(f.calls),3)
