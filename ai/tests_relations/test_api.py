import tempfile
import unittest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from knowledge_relations import RelationService
from knowledge_relations.api import create_app,register_relations
from test_service import FakeProvider,documents


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.provider=FakeProvider()
        self.service=RelationService(self.tmp.name,provider_factory=lambda s:self.provider)
        self.app=create_app(service=self.service,internal_key='test-key',enabled=True)
        self.client=TestClient(self.app)
        self.headers={'X-Internal-Api-Key':'test-key'}
        self.body={'ownerId':'42','revision':1,'documents':documents()}
    def tearDown(self):
        self.client.close();self.tmp.cleanup()
    def post(self,path,body):
        return self.client.post(path,json=body,headers=self.headers)

    def test_sync_and_read(self):
        result=self.post('/v2/relation-index/sync',self.body)
        self.assertEqual(result.status_code,200)
        graph=self.post('/v2/relations',{'ownerId':'42','snapshotId':result.json()['snapshotId']})
        self.assertEqual(graph.status_code,200)
        self.assertEqual(len(graph.json()['nodes']),4)

    def test_auth_required(self):
        self.assertEqual(self.client.post('/v2/relation-index/sync',json=self.body).status_code,401)
        self.assertEqual(self.client.post('/v2/relation-index/sync',json=self.body,
                         headers={'X-Internal-Api-Key':'wrong'}).status_code,401)

    def test_owner_and_revision_types(self):
        for patch in ({'ownerId':42},{'revision':True},{'revision':0},{'extra':'x'}):
            self.assertEqual(self.post('/v2/relation-index/sync',dict(self.body,**patch)).status_code,422)

    def test_stale_snapshot(self):
        result=self.post('/v2/relation-index/sync',self.body).json()
        self.post('/v2/relation-index/sync',dict(self.body,revision=2,documents=[]))
        graph=self.post('/v2/relations',{'ownerId':'42','snapshotId':result['snapshotId']})
        self.assertEqual(graph.status_code,409)

    def test_failed_sync_is_not_empty_success(self):
        self.provider.fail_at=1
        response=self.post('/v2/relation-index/sync',self.body)
        self.assertEqual(response.status_code,502)
        self.assertEqual(response.json()['detail']['code'],'RELATION_SYNC_FAILED')

    def test_disabled_by_default(self):
        client=TestClient(create_app(enabled=False))
        self.assertFalse(client.get('/health').json()['relationsEnabled'])
        self.assertEqual(client.post('/v2/relations',json={}).status_code,404)
        client.close()

    def test_existing_routes_preserved_and_registration_idempotent(self):
        app=FastAPI()
        @app.post('/v2/analyses')
        def generation():return {'existing':'generation'}
        @app.post('/revisions')
        def revision():return {'existing':'revision'}
        register_relations(app,service=self.service,internal_key='test-key',enabled=True)
        count=len(app.openapi()['paths'])
        register_relations(app,service=self.service,internal_key='test-key',enabled=True)
        self.assertEqual(len(app.openapi()['paths']),count)
        with TestClient(app) as client:
            self.assertEqual(client.post('/v2/analyses').json(),{'existing':'generation'})
            self.assertEqual(client.post('/revisions').json(),{'existing':'revision'})
            self.assertIn('/v2/relations',app.openapi()['paths'])

    def test_one_owner_cannot_read_another_snapshot(self):
        result=self.post('/v2/relation-index/sync',self.body).json()
        response=self.post('/v2/relations',{'ownerId':'different','snapshotId':result['snapshotId']})
        self.assertEqual(response.status_code,404)

    def test_conflicting_existing_relation_route_is_not_overwritten(self):
        app=FastAPI()
        @app.post('/v2/relations')
        def existing():return {'existing':True}
        with self.assertRaises(RuntimeError):
            register_relations(app,service=self.service,internal_key='test-key',enabled=True)


if __name__=='__main__':unittest.main()
