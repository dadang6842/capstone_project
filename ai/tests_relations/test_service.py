import copy
import hashlib
import tempfile
import threading
import unittest
from pathlib import Path

from knowledge_relations import RelationService, RelationConfig, ServiceError


def documents(count=4):
    return [{'artifactId':f'doc-{i:03d}','version':1,'status':'adopted',
             'title':f'문서 {i}','content':f'작업 기록과 조건을 보존하는 방법 {i}'} for i in range(count)]


class FakeProvider:
    def __init__(self):
        self.calls = []
        self.fail_at = None
        self.invalid = False
    def embed(self, texts, model, *, deadline):
        self.calls.append(list(texts))
        if len(self.calls) == self.fail_at:
            raise RuntimeError('mock failure')
        values = [[b+1 for b in hashlib.sha256(text.encode()).digest()[:8]] for text in texts]
        if self.invalid:
            values[0] = [float('nan')]
        return values, {'prompt_tokens':sum(len(t) for t in texts), 'total_tokens':sum(len(t) for t in texts)}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.provider = FakeProvider()
        self.service = RelationService(self.tmp.name,provider_factory=lambda scope:self.provider)
        self.docs = documents()
    def tearDown(self):
        self.tmp.cleanup()
    def expect_error(self, status, fn, code=None):
        with self.assertRaises(ServiceError) as caught:
            fn()
        self.assertEqual(caught.exception.status,status)
        if code:
            self.assertEqual(caught.exception.code,code)
    def sync(self, revision=1, docs=None):
        return self.service.sync('owner',revision,self.docs if docs is None else docs)

    def test_default_policy(self):
        self.assertEqual(RelationConfig().neighbors,3)
        self.assertEqual(RelationConfig().mode,'mutual')
        self.assertEqual(RelationConfig().threshold,.48)

    def test_same_revision_replay_and_array_order(self):
        first = self.sync()
        second = self.sync(docs=list(reversed(self.docs)))
        self.assertTrue(second['reused'])
        self.assertEqual(second['apiCalls'],[])
        self.assertEqual(first['snapshotId'],second['snapshotId'])
        self.assertEqual(len(self.provider.calls),1)

    def test_new_revision_same_body_uses_cache(self):
        first = self.sync()
        second = self.sync(2)
        self.assertEqual(second['apiCalls'],[])
        self.assertNotEqual(first['snapshotId'],second['snapshotId'])
        self.expect_error(409,lambda:self.service.get_graph('owner',first['snapshotId']))

    def test_add_only_new_embedding(self):
        self.sync()
        added = self.docs + documents(5)[4:]
        self.sync(2,added)
        self.assertEqual(len(self.provider.calls[-1]),1)
        self.assertEqual(len(self.provider.calls),2)

    def test_identical_new_document_reuses_embedding(self):
        self.sync()
        twin = dict(self.docs[0],artifactId='twin')
        result = self.sync(2,self.docs+[twin])
        self.assertEqual(result['apiCalls'],[])
        self.assertEqual(result['counts']['documents'],5)

    def test_modify_version_and_current_passages(self):
        first = self.sync()
        changed = copy.deepcopy(self.docs)
        changed[0].update(version=2,content='여행 일정의 출발과 귀가 시각을 기록한다.',
                          metadataStatus='needs_refresh',eligibleForIndexing=False)
        result = self.sync(2,changed)
        self.assertEqual(len(self.provider.calls[-1]),1)
        graph = self.service.get_graph('owner',result['snapshotId'])
        node = next(n for n in graph['nodes'] if n['artifactId']==changed[0]['artifactId'])
        self.assertEqual(node['version'],2)
        for edge in graph['edges']:
            for part in edge['similarPassages']:
                doc = next(d for d in changed if d['artifactId']==part['artifactId'])
                self.assertEqual(doc['content'][part['start']:part['end']],part['text'])
        self.expect_error(409,lambda:self.service.get_graph('owner',first['snapshotId']))

    def test_title_edit_requires_new_embedding(self):
        self.sync()
        changed = copy.deepcopy(self.docs)
        changed[0].update(version=2,title='새 제목')
        self.sync(2,changed)
        self.assertEqual(len(self.provider.calls[-1]),1)

    def test_delete_and_unadopt_do_not_embed(self):
        self.sync()
        deleted = self.sync(2,self.docs[1:])
        self.assertEqual(deleted['apiCalls'],[])
        graph = self.service.get_graph('owner',deleted['snapshotId'])
        self.assertNotIn(self.docs[0]['artifactId'],[n['artifactId'] for n in graph['nodes']])
        changed = copy.deepcopy(self.docs[1:]);changed[0]['status']='draft'
        unadopted = self.sync(3,changed)
        self.assertEqual(unadopted['apiCalls'],[])
        self.assertEqual(unadopted['counts']['documents'],2)

    def test_readd_same_version_same_text_reuses_cache(self):
        self.sync();self.sync(2,[])
        result = self.sync(3)
        self.assertEqual(result['apiCalls'],[])

    def test_empty_snapshot_clears_graph(self):
        self.sync()
        result = self.sync(2,[])
        graph = self.service.get_graph('owner',result['snapshotId'])
        self.assertEqual(graph['nodes'],[])
        self.assertEqual(graph['edges'],[])
        self.assertEqual(result['apiCalls'],[])

    def test_draft_only_needs_no_provider(self):
        service = RelationService(Path(self.tmp.name)/'drafts')
        rows = [dict(d,status='draft') for d in self.docs]
        result = service.sync('owner',1,rows)
        self.assertEqual(result['counts']['documents'],0)

    def test_stale_and_conflicting_revisions(self):
        self.sync(2)
        self.expect_error(409,lambda:self.sync(1), 'STALE_REVISION')
        self.expect_error(409,lambda:self.sync(2,self.docs[1:]), 'REVISION_CONFLICT')

    def test_same_version_changed_body_rejected_before_api(self):
        self.sync()
        changed = copy.deepcopy(self.docs);changed[0]['content']='new body'
        self.expect_error(409,lambda:self.sync(2,changed),'DOCUMENT_VERSION_CONFLICT')
        self.assertEqual(len(self.provider.calls),1)

    def test_version_rollback_after_deletion_rejected(self):
        high = copy.deepcopy(self.docs);high[0]['version']=4
        self.sync(1,high);self.sync(2,[])
        self.expect_error(409,lambda:self.sync(3),'DOCUMENT_VERSION_ROLLBACK')

    def test_duplicate_id_rejected_without_mutation(self):
        self.expect_error(422,lambda:self.sync(docs=self.docs+[self.docs[0]]))
        self.assertEqual(self.provider.calls,[])

    def test_invalid_status_and_empty_body(self):
        for patch in ({'status':'accepted'},{'content':''},{'version':True}):
            changed=copy.deepcopy(self.docs);changed[0].update(patch)
            self.expect_error(422,lambda:self.sync(docs=changed))

    def test_owner_scope_isolation(self):
        a=self.sync()
        self.expect_error(404,lambda:self.service.get_graph('other',a['snapshotId']))
        b=self.service.sync('other',1,self.docs)
        self.assertNotEqual(a['snapshotId'],b['snapshotId'])
        self.assertEqual(len(self.provider.calls),2)
        self.expect_error(409,lambda:self.service.get_graph('other',a['snapshotId']))

    def test_tenant_scope_isolation(self):
        a=self.sync()
        other=RelationService(self.tmp.name,tenant='other',provider_factory=lambda s:self.provider)
        self.expect_error(404,lambda:other.get_graph('owner',a['snapshotId']))

    def test_restart_reuses_state_and_cache(self):
        a=self.sync()
        restarted=RelationService(self.tmp.name,provider_factory=lambda s:self.provider)
        self.assertEqual(restarted.get_graph('owner',a['snapshotId'])['counts']['documents'],4)
        result=restarted.sync('owner',1,self.docs)
        self.assertEqual(result['apiCalls'],[])

    def test_config_change_requires_sync_not_reembedding(self):
        first=self.sync()
        changed=RelationService(self.tmp.name,provider_factory=lambda s:self.provider,
                                config=RelationConfig(neighbors=2))
        self.expect_error(409,lambda:changed.get_graph('owner',first['snapshotId']))
        result=changed.sync('owner',1,self.docs)
        self.assertEqual(result['apiCalls'],[])
        self.assertNotEqual(first['snapshotId'],result['snapshotId'])

    def test_model_revision_uses_separate_embeddings(self):
        self.sync()
        changed=RelationService(self.tmp.name,provider_factory=lambda s:self.provider,model_revision='new')
        changed.sync('owner',1,self.docs)
        self.assertEqual(len(self.provider.calls),2)

    def test_failure_blocks_old_snapshot_and_retry_resumes(self):
        first=self.sync()
        self.provider.fail_at=2
        changed=self.docs+documents(5)[4:]
        self.expect_error(502,lambda:self.sync(2,changed))
        self.expect_error(409,lambda:self.service.get_graph('owner',first['snapshotId']))
        self.provider.fail_at=None
        result=self.sync(2,changed)
        self.assertEqual(result['counts']['documents'],5)
        self.assertEqual(len(self.provider.calls[-1]),1)

    def test_multi_batch_failure_reuses_completed_batch(self):
        self.provider.fail_at=2
        rows=documents(40)
        self.expect_error(502,lambda:self.sync(docs=rows))
        self.provider.fail_at=None
        result=self.sync(docs=rows)
        self.assertEqual(result['counts']['documents'],40)
        self.assertEqual(len(self.provider.calls[-1]),8)
        self.assertEqual(len(self.provider.calls),3)

    def test_malformed_vectors_fail_closed(self):
        self.provider.invalid=True
        self.expect_error(502,lambda:self.sync())
        self.assertEqual(len(self.provider.calls),1)
        self.assertTrue(list(Path(self.tmp.name).rglob('responses/*.json')))

    def test_busy_owner(self):
        scope=self.service._scope('owner')
        with self.service._locked(scope):
            self.expect_error(409,lambda:self.sync(),'OWNER_BUSY')

    def test_payload_and_chunk_limits(self):
        tiny=RelationService(Path(self.tmp.name)/'tiny',max_input_bytes=10)
        self.expect_error(413,lambda:tiny.sync('owner',1,self.docs))
        capped=RelationService(Path(self.tmp.name)/'capped',max_documents=2)
        self.expect_error(413,lambda:capped.sync('owner',1,self.docs))
        chunks=RelationService(Path(self.tmp.name)/'chunks',max_chunks=1)
        self.expect_error(413,lambda:chunks.sync('owner',1,self.docs))

    def test_graph_response_contains_no_vectors_or_layout(self):
        result=self.sync()
        graph=self.service.get_graph('owner',result['snapshotId'])
        for n in graph['nodes']:
            self.assertNotIn('content',n)
            self.assertNotIn('x',n)
        self.assertNotIn('pairs',graph)
        self.assertNotIn('vectors',graph)
        self.assertEqual(graph['connectionMeaning'],'content_similarity')

    def test_original_input_not_modified(self):
        before=copy.deepcopy(self.docs)
        self.sync()
        self.assertEqual(before,self.docs)


if __name__=='__main__':
    unittest.main()
