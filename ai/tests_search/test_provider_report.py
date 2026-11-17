import json,tempfile,unittest,zipfile
from pathlib import Path
from types import SimpleNamespace as NS
from knowledge_search.providers import OpenAIProvider
from knowledge_search.reports import save_trial,export_review
from test_base import doc

class ProviderReportTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.calls=[]
  self.status='completed';self.indices=[1,0]
  client=NS(responses=NS(create=self.judge),embeddings=NS(create=self.embed))
  self.provider=OpenAIProvider(client,namespace='fake',audit_dir=self.tmp.name)
 def judge(self,**kw):
  self.calls.append(kw);return NS(model='fake',status=self.status,usage=None,output_text='{"decisions":[]}')
 def embed(self,**kw):
  self.calls.append(kw);return NS(model='fake',usage=None,data=[NS(index=i,embedding=[float(i),1]) for i in self.indices])
 def test_embedding_order(self):
  v,_=self.provider.embed(['a','b'],'fake');self.assertEqual(v,[[0.,1],[1.,1]])
 def test_embedding_index_error(self):
  self.indices=[0,0]
  with self.assertRaises(ValueError):self.provider.embed(['a','b'],'fake')
 def test_judge_schema(self):
  self.provider.judge({'documents':[doc()],'query':'질문'},'fake','지침')
  self.assertEqual(self.calls[0]['text']['format']['schema']['properties']['decisions']['items']['properties']['artifactId']['enum'],['a'])
  self.assertFalse(self.calls[0]['store'])
 def test_incomplete_audited(self):
  self.status='incomplete'
  with self.assertRaises(ValueError):self.provider.judge({'documents':[doc()],'query':'질문'},'fake','지침')
  self.assertEqual(len(self.calls),1);self.assertEqual(json.loads(next(Path(self.tmp.name).glob('search_*.json')).read_text())['status'],'incomplete')
 def test_report_only_current_snapshot(self):
  bundle={'result':{'documents':[doc()]}}
  result={'query':'질문','snapshotId':'id','complete':True,'status':'matches','processedDocuments':1,'totalDocuments':1,'knownMatches':1,
          'results':[{'artifactId':'a','title':'제목','reason':'이유','evidence':'본문'}]}
  save_trial(self.tmp.name,result,[],0.1,bundle);path=export_review(self.tmp.name,bundle)
  with zipfile.ZipFile(path) as z:
   self.assertEqual(len(json.loads(z.read('search_interim_review.json'))['trialRecords']),1)
   self.assertIn('의미',z.read('search_interim_review.md').decode())
  path=export_review(self.tmp.name,{'result':{'documents':[doc(content='다른 본문')]}})
  with zipfile.ZipFile(path) as z:self.assertEqual(json.loads(z.read('search_interim_review.json'))['trialRecords'],[])
 def test_partial_not_marked_reference_pass(self):
  bundle={'result':{'documents':[doc()]},'searchTestCases':{'cases':[{'id':'Q','query':'질문','expectedArtifactIds':['a'],'reviewStatus':'proposed'}]}}
  result={'query':'질문','snapshotId':'id','complete':False,'status':'in_progress','processedDocuments':0,'totalDocuments':1,'knownMatches':0,'results':[]}
  path=save_trial(self.tmp.name,result,[],0.1,bundle)
  self.assertIsNone(json.loads(path.read_text())['referenceComparison']['exactSetMatch'])
