import asyncio
import copy
import json
import tempfile
import unittest
from fixtures import Fake, INPUT, REVIEW
from test_direct import output
from knowledge_generation.direct import DirectSession
from knowledge_generation.sources import SourceBundle
from knowledge_generation.store import Busy
from knowledge_generation.util import write_json


class RegressionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def session(self, fake, request=INPUT):
        return DirectSession(fake, self.temp.name, request, model='fake')

    async def test_context_reaches_generation_and_review(self):
        request = copy.deepcopy(INPUT)
        conv = request['conversations'][0]
        request['conversations'].append({
            'conversationId': 8, 'title': '별도 실행 결과',
            'messages': conv['messages'][2:]})
        conv['messages'] = conv['messages'][:2]
        fake = Fake([output(), REVIEW])
        session = self.session(fake, request)
        await session.generate()
        generation = json.loads(fake.calls[0]['input'])
        blocks = generation['source_blocks']
        self.assertEqual([b['conversation_id'] for b in blocks], [7, 7, 8])
        self.assertEqual([b['sequence'] for b in blocks], [1, 2, 1])
        self.assertEqual(blocks[2]['conversation_title'], '별도 실행 결과')
        review = json.loads(fake.calls[1]['input'])
        self.assertEqual(review['evidence_units'][-1]['conversation_id'], 8)
        self.assertEqual(review['evidence_units'][-1]['conversation_title'], '별도 실행 결과')
        self.assertNotEqual(generation, SourceBundle(INPUT['conversations']).selected(['S001','S002','S003']))

    async def test_review_details_survive_edit_in_version_and_event(self):
        finding = {'category':'source_fidelity','certainty':'supported','document_index':0,
            'field_path':'documents[0].body_markdown','document_passage':'실행 결과는 사용자 보고다.',
            'evidence_refs':['S003:T0003'],'reason':'근거 시험','impact':'오해 가능','suggestion':'원문 확인'}
        session = self.session(Fake([output(), {'findings':[finding], 'optional_notes':[]}]))
        await session.generate()
        before = session.documents()[0]
        session.edit(1, {'content':'사용자 수정 내용'})
        previous = session.io.repo.version(session.scope, before['artifactId'], 1)
        self.assertEqual(previous['review'], before['review'])
        self.assertEqual(previous['content'], before['content'])
        event = next(e for e in session.io.repo.history(session.scope, before['artifactId'])
                     if e['kind'] == 'automatic_review')
        self.assertEqual(event['details']['review'], before['review'])
        self.assertEqual(event['details']['version'], 1)

    async def test_duplicate_pending_is_busy_then_cancel_is_recoverable(self):
        started = asyncio.Event()
        async def delayed(_):
            started.set()
            await asyncio.Event().wait()
        fake = Fake([output(), delayed])
        session = self.session(fake)
        task = asyncio.create_task(session.generate())
        await asyncio.wait_for(started.wait(), 2)
        try:
            with self.assertRaises(Busy):
                await self.session(fake).generate()
        finally:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        result = await self.session(fake).generate()
        self.assertEqual(result['reviewStatus'], 'incomplete')
        self.assertEqual(result['documents'][0]['review']['reason'], 'interrupted')
        self.assertEqual(len(fake.calls), 2)

    async def test_orphan_pending_is_closed_without_api_calls(self):
        fake = Fake([output(), REVIEW])
        session = self.session(fake)
        await session.generate()
        item = session.documents()[0]
        from knowledge_generation.review import incomplete
        session.io.repo.set_review(session.scope, item['artifactId'], 1,
                                   incomplete('not_run', item['contentHash']))
        session.result['reviewStatus'] = 'pending'
        write_json(session.result_path, session.result)
        result = await self.session(fake).generate()
        self.assertEqual(result['reviewStatus'], 'incomplete')
        self.assertEqual(result['documents'][0]['review']['reason'], 'interrupted')
        self.assertEqual(len(fake.calls), 2)

    async def test_orphan_does_not_overwrite_user_edit(self):
        fake = Fake([output(), REVIEW])
        session = self.session(fake)
        await session.generate()
        edited = session.edit(1, {'content':'중단 중 사용자 수정'})
        session.result['reviewStatus'] = 'pending'
        write_json(session.result_path, session.result)
        result = await self.session(fake).generate()
        self.assertEqual(result['documents'][0]['content'], edited['content'])
        self.assertEqual(result['documents'][0]['review']['reason'], 'user_edited')
        self.assertEqual(len(fake.calls), 2)

    async def test_orphan_preserves_already_saved_review(self):
        fake = Fake([output(), REVIEW])
        session = self.session(fake)
        await session.generate()
        verdict = session.documents()[0]['review']
        session.result['reviewStatus'] = 'pending'
        write_json(session.result_path, session.result)
        await self.session(fake).generate()
        self.assertEqual(session.documents()[0]['review'], verdict)
        self.assertEqual(len(fake.calls), 2)
