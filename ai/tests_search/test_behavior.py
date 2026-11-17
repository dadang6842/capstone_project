import tempfile,unittest
from knowledge_search import HybridSearch
from knowledge_search.checks import behavior_checks
from test_base import doc
from test_hybrid import Provider
class BehaviorTests(unittest.TestCase):
 def test_checks_use_copy_and_keep_original(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Provider();engine=HybridSearch(tmp,owner='u',provider=p,judge_model='fake',embedding_model='fake')
   documents=[doc(content='GPU 메모리가 부족하면 EMBED_BATCH_SIZE를 2로 줄입니다.')]
   engine.sync(documents);before=engine.snapshot()
   report=behavior_checks(engine,documents,'a')
   self.assertTrue(report['originalUnchanged']);self.assertEqual(engine.snapshot(),before)
   self.assertEqual(len(report['checks']),4);self.assertTrue(all(c['passed'] for c in report['checks']))
