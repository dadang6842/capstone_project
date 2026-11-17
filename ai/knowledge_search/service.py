"""Single-process integration service. Backend supplies trusted ownership and full snapshots."""
import copy
import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from .base import digest,PROMPT
from .hybrid import HybridSearch

class ServiceError(RuntimeError):
    def __init__(self,status,message):self.status=status;super().__init__(message)

class SearchService:
    def __init__(self,root,*,provider_factory,judge_model,embedding_model,tenant='backend'):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True)
        self.provider_factory=provider_factory;self.judge_model=judge_model;self.embedding_model=embedding_model
        self.tenant=tenant;self._locks={};self._guard=threading.Lock()
        self.database=self.root/'service.sqlite3'
        with self.connect() as db:
            db.executescript('''
CREATE TABLE IF NOT EXISTS index_meta(owner TEXT PRIMARY KEY,revision INTEGER,payload_hash TEXT,state TEXT,snapshot_id TEXT);
CREATE TABLE IF NOT EXISTS search_results(owner TEXT,id TEXT,revision INTEGER,payload TEXT,PRIMARY KEY(owner,id));
''')

    def connect(self):return sqlite3.connect(self.database,timeout=5)
    def scope(self,owner):return digest([self.tenant,owner])

    @contextmanager
    def operation(self,owner):
        scope=self.scope(owner)
        with self._guard:lock=self._locks.setdefault(scope,threading.Lock())
        if not lock.acquire(blocking=False):raise ServiceError(409,'같은 사용자의 검색·동기화가 처리 중입니다.')
        try:
            provider=self.provider_factory(scope)
            if hasattr(provider,'begin_request'):provider.begin_request(280)
            engine=HybridSearch(self.root/'engine',owner=scope,provider=provider,
                                judge_model=self.judge_model,embedding_model=self.embedding_model)
            yield scope,engine
        finally:lock.release()

    def config(self,engine):return digest([engine.provider.namespace,self.judge_model,self.embedding_model,PROMPT])

    def meta(self,scope):
        with self.connect() as db:
            row=db.execute('SELECT revision,payload_hash,state,snapshot_id FROM index_meta WHERE owner=?',(scope,)).fetchone()
        return dict(zip(('revision','payloadHash','state','snapshotId'),row)) if row else None

    def set_meta(self,scope,revision,payload_hash,state,snapshot_id):
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO index_meta VALUES(?,?,?,?,?)',(scope,revision,payload_hash,state,snapshot_id))

    def sync(self,owner,revision,documents):
        if len(json.dumps(documents,ensure_ascii=False).encode())>8_000_000:
            raise ServiceError(413,'시험용 전체 스냅샷 요청은 8MB 이내여야 합니다. 본문을 자르지 말고 저장 어댑터를 확장하세요.')
        with self.operation(owner) as (scope,engine):
            proposed=engine.prepare(documents)  # Validate before invalidating the current state.
            payload_hash=digest(documents);old=self.meta(scope)
            if old and (revision<old['revision'] or (revision==old['revision'] and old['payloadHash']!=payload_hash)):
                raise ServiceError(409,'오래되었거나 같은 revision에 다른 내용의 동기화입니다.')
            if old and revision==old['revision'] and old['state']=='ready':
                try:engine._ready(engine.snapshot())
                except ValueError:pass
                else:return {'ownerId':owner,'indexRevision':revision,'snapshotId':old['snapshotId'],
                             'indexStatus':'ready','reused':True,'searchableDocuments':len(proposed['documents']),'apiCalls':[]}
            self.set_meta(scope,revision,payload_hash,'syncing',proposed['fingerprint'])
            try:report=engine.sync(documents)
            except Exception as exc:
                self.set_meta(scope,revision,payload_hash,'incomplete',proposed['fingerprint'])
                raise ServiceError(502,'색인 동기화 미완료. 동일 revision·내용으로 수동 재요청할 수 있습니다.') from exc
            self.set_meta(scope,revision,payload_hash,'ready',report['snapshotId'])
            return {'ownerId':owner,'indexRevision':revision,'indexStatus':'ready','reused':False,**report,'apiCalls':engine.calls}

    def require_index(self,scope,engine,expected_snapshot=None):
        meta=self.meta(scope)
        if meta is None:raise ServiceError(409,'검색 전에 문서 스냅샷을 동기화하세요.')
        if meta['state']!='ready':raise ServiceError(409,'최신 문서의 색인이 미완료입니다.')
        if expected_snapshot is not None and meta['snapshotId']!=expected_snapshot:
            raise ServiceError(409,'문서 상태가 변경됐습니다. 최신 snapshotId로 다시 검색하세요.')
        try:engine._ready(engine.snapshot())
        except ValueError as exc:raise ServiceError(409,str(exc)) from exc
        return meta

    def get_record(self,scope,search_id):
        with self.connect() as db:
            row=db.execute('SELECT payload FROM search_results WHERE owner=? AND id=?',(scope,search_id)).fetchone()
        if row is None:raise ServiceError(404,'해당 사용자의 검색 기록이 없습니다.')
        return json.loads(row[0])

    def save_record(self,scope,search_id,revision,result,meta,config):
        record={'searchId':search_id,'resultRevision':revision,'indexRevision':meta['revision'],
                'configHash':config,'result':result}
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO search_results VALUES(?,?,?,?)',
                       (scope,search_id,revision,json.dumps(record,ensure_ascii=False)))
        return record

    def require_record(self,scope,engine,search_id,expected_revision):
        record=self.get_record(scope,search_id)
        meta=self.require_index(scope,engine,record['result']['snapshotId'])
        if record['indexRevision']!=meta['revision'] or record['configHash']!=self.config(engine):
            raise ServiceError(409,'문서 또는 모델 설정이 변경됐습니다. 다시 검색하세요.')
        if record['resultRevision']!=expected_revision:
            raise ServiceError(409,'검색 결과가 갱신됐습니다. 최신 resultRevision을 사용하세요.')
        return record,meta

    def public(self,record,engine,*,page=1,page_size=10,calls=None):
        result=engine.page(record['result'],page=page,page_size=page_size)
        result.pop('decisions',None);result.pop('candidateOrder',None)
        return {**result,'searchId':record['searchId'],'resultRevision':record['resultRevision'],
                'indexRevision':record['indexRevision'],'apiCalls':calls or []}

    def search(self,owner,query,snapshot_id,*,max_new_batches=1,page_size=10):
        with self.operation(owner) as (scope,engine):
            meta=self.require_index(scope,engine,snapshot_id);engine._validate_query(query)
            search_id=digest([scope,meta['revision'],snapshot_id,self.config(engine),query.strip()])
            try:old=self.get_record(scope,search_id)
            except ServiceError as exc:
                if exc.status!=404:raise
                old=None
            # Replaying a search returns its saved state; only explicit continue advances.
            if old is not None:
                response=self.public(old,engine,page_size=page_size);response['cacheHit']=True;return response
            result=engine.search(query,max_new_batches=max_new_batches)
            record=self.save_record(scope,search_id,1,result,meta,self.config(engine))
            return self.public(record,engine,page_size=page_size,calls=engine.calls)

    def continue_search(self,owner,search_id,result_revision,*,max_new_batches=1,page_size=10):
        with self.operation(owner) as (scope,engine):
            old,meta=self.require_record(scope,engine,search_id,result_revision)
            if old['result']['complete']:
                response=self.public(old,engine,page_size=page_size);response['cacheHit']=True;return response
            result=engine.search(old['result']['query'],max_new_batches=max_new_batches)
            record=self.save_record(scope,search_id,old['resultRevision']+1,result,meta,self.config(engine))
            return self.public(record,engine,page_size=page_size,calls=engine.calls)

    def page(self,owner,search_id,result_revision,*,page=1,page_size=10):
        with self.operation(owner) as (scope,engine):
            record,_=self.require_record(scope,engine,search_id,result_revision)
            return self.public(record,engine,page=page,page_size=page_size)

    def document(self,owner,artifact_id,expected_search_hash):
        with self.operation(owner) as (scope,engine):
            self.require_index(scope,engine)
            try:return engine.get_document(artifact_id,expected_search_hash)
            except ValueError as exc:raise ServiceError(409,str(exc)) from exc
