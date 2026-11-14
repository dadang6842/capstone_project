"""긴 대화 수집·실패 처리 회귀 검사. 네트워크/실제 브라우저/LLM 호출 없음."""
import asyncio
import unittest
from unittest.mock import patch, AsyncMock
import shared_importer as importer
URL='https://chatgpt.com/share/6af3fb20-85d0-83ec-84a7-783771ddb6cf'

def message(key,text=None,role='assistant'):
    return {'source_message_id':key,'role':role,'content':key if text is None else text,
            'code_blocks':[],'body_found':True,'removed_ui_sections':0,'attachment_count':0}

class FakePage:
    def __init__(self,snapshots,*,bottom=True,hang=False):
        self.url=URL;self.snapshots=snapshots;self.cursor=0;self.bottom=bottom;self.hang=hang
        self.actions=[];self.first=self
    async def goto(self,*args,**kwargs):
        if self.hang:await asyncio.Event().wait()
        return type('Response',(),{'status':200})()
    def locator(self,*args):return self
    async def wait_for(self,**kwargs):pass
    async def title(self):return '긴 대화 시험'
    async def evaluate(self,script,action=None):
        if script==importer.EXTRACT_JS:
            return {'mode':'data-message-author-role','messages':self.snapshots[self.cursor]}
        if script!=importer.SCROLL_JS:raise AssertionError('예상하지 않은 스크립트')
        self.actions.append(action)
        if action=='top':self.cursor=0
        if action=='step':self.cursor=min(self.cursor+1,len(self.snapshots)-1)
        return {'positions':[{'top':self.cursor*100,'height':len(self.snapshots)*100,'viewport':100}],
                'at_bottom':self.bottom and self.cursor==len(self.snapshots)-1,
                'moved':action=='step','loading':False}
class FakeBrowser:
    def __init__(self,page):self.page=page;self.closed=False
    async def new_page(self,**kwargs):return self.page
    async def close(self):self.closed=True
class FakeManager:
    def __init__(self,browser):self.browser=browser;self.chromium=self
    async def __aenter__(self):return self
    async def __aexit__(self,*args):pass
    async def launch(self,**kwargs):return self.browser

class AccumulatorTests(unittest.TestCase):
    def test_insert_middle_preserve_body_and_order(self):
        a=importer.MessageAccumulator()
        a.add([message('a','원문 코드\nprint(1)'),message('c')])
        a.add([message('a',''),message('b'),message('c')])
        result=a.ordered()
        self.assertEqual([m['source_message_id'] for m in result],['a','b','c'])
        self.assertEqual(result[0]['content'],'원문 코드\nprint(1)')
        self.assertEqual([m['sequence'] for m in result],[1,2,3])
        self.assertNotIn('body_found',result[0])
    def test_conflicting_order_rejected(self):
        a=importer.MessageAccumulator();a.add([message('a'),message('b')]);a.add([message('b'),message('a')])
        with self.assertRaises(ValueError):a.ordered()
    def test_conflicting_role_and_missing_id_rejected(self):
        a=importer.MessageAccumulator();a.add([message('a')])
        with self.assertRaises(ValueError):a.add([message('a',role='user')])
        with self.assertRaises(ValueError):a.add([message(None)])

class CollectionTests(unittest.IsolatedAsyncioTestCase):
    async def collect(self,page,**kwargs):
        browser=FakeBrowser(page)
        with patch('playwright.async_api.async_playwright',return_value=FakeManager(browser)), patch('shared_importer.asyncio.sleep',new=AsyncMock()):
            result=await importer.import_shared_conversation(URL,**kwargs)
        self.assertTrue(browser.closed);return result,browser
    async def test_reads_middle_and_keeps_public_contract(self):
        page=FakePage([[message(f'm{i}',role='user' if i%2==0 else 'assistant')] for i in range(12)])
        record,_=await self.collect(page)
        self.assertEqual([m['source_message_id'] for m in record['conversation']['messages']],[f'm{i}' for i in range(12)])
        self.assertEqual(record['schema_version'],'shared_text_v1')
        self.assertEqual(record['extractor_version'],'2.0')
        self.assertEqual(record['conversation_id'],'chatgpt_share_'+URL.rsplit('/',1)[1])
        self.assertTrue(record['capture_id'].startswith('share_'))
        self.assertEqual(record['completeness'],'unverified')
        self.assertEqual(record['diagnostics']['stop_reason'],'bottom_stable')
        self.assertEqual(record['diagnostics']['role_counts'],{'user':6,'assistant':6})
        self.assertEqual(page.actions[0],'top')
        self.assertNotIn('reference_comparison',record['diagnostics'])
    async def test_no_early_stop_when_content_stable_in_middle(self):
        record,_=await self.collect(FakePage([[message('a')]]*7+[[message('a'),message('b')]]))
        self.assertEqual(record['diagnostics']['message_count'],2)
        self.assertGreater(record['diagnostics']['collection_rounds'],7)
    async def test_round_limit_raises_instead_of_returning_partial_record(self):
        browser=FakeBrowser(FakePage([[message('a')]],bottom=False))
        with patch('playwright.async_api.async_playwright',return_value=FakeManager(browser)), patch('shared_importer.asyncio.sleep',new=AsyncMock()):
            with self.assertRaises(importer.CollectionIncompleteError) as caught:
                await importer.import_shared_conversation(URL,max_rounds=5)
        self.assertEqual(caught.exception.diagnostics['stop_reason'],'round_limit');self.assertTrue(browser.closed)
    async def test_timeout_raises_and_closes_browser(self):
        browser=FakeBrowser(FakePage([[message('a')]],hang=True))
        with patch('playwright.async_api.async_playwright',return_value=FakeManager(browser)):
            with self.assertRaises(importer.CollectionIncompleteError) as caught:
                await importer.import_shared_conversation(URL,timeout_seconds=0.01)
        self.assertEqual(caught.exception.diagnostics['stop_reason'],'time_limit');self.assertTrue(browser.closed)
    async def test_empty_body_does_not_return_success(self):
        with self.assertRaisesRegex(RuntimeError,'본문이 비어'):await self.collect(FakePage([[message('a','')]]))
    async def test_redirect_validation_preserved(self):
        page=FakePage([[message('a')]]);page.url='https://example.com/'
        with self.assertRaises(ValueError):await self.collect(page)
    async def test_invalid_limits_fail_before_browser_launch(self):
        for kwargs in ({'max_rounds':True},{'max_rounds':4},{'timeout_seconds':False},{'timeout_seconds':float('nan')},{'timeout_seconds':float('inf')}):
            with self.subTest(kwargs=kwargs),self.assertRaises(ValueError):await importer.collect_shared_conversation(URL,**kwargs)
if __name__=='__main__':unittest.main()
