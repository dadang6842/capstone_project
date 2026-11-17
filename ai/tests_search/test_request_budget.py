import tempfile,unittest
from types import SimpleNamespace as NS
from knowledge_search.providers import OpenAIProvider
class RequestBudgetTests(unittest.TestCase):
 def test_expired_budget_makes_no_call(self):
  with tempfile.TemporaryDirectory() as tmp:
   client=NS(responses=NS(create=lambda **kw:self.fail('API must not be called')))
   provider=OpenAIProvider(client,namespace='fake',audit_dir=tmp);provider.begin_request(-1)
   with self.assertRaises(TimeoutError):provider.judge({'documents':[{'artifactId':'a'}]},'fake','prompt')
 def test_remaining_budget_passed_as_timeout(self):
  seen=[]
  def create(**kw):
   seen.append(kw);return NS(model='fake',status='completed',usage=None,output_text='{"decisions":[]}')
  with tempfile.TemporaryDirectory() as tmp:
   provider=OpenAIProvider(NS(responses=NS(create=create)),namespace='fake',audit_dir=tmp);provider.begin_request(5)
   provider.judge({'documents':[{'artifactId':'a'}]},'fake','prompt')
   self.assertGreater(seen[0]['timeout'],0);self.assertLessEqual(seen[0]['timeout'],5)
