"""Single-process full-snapshot service with atomic publication and per-owner caches.

Embeddings are updated by changed input; all pair scores and graph communities are
recomputed. No claim of distributed safety or incremental graph computation.
"""
import copy
import json
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path

from .core import digest, save_json, load_documents, make_chunks, unit, compare_documents, build_graph


class ServiceError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


@dataclass(frozen=True)
class RelationConfig:
    threshold: float = .48
    neighbors: int = 3
    mode: str = 'mutual'
    resolution: float = 1.0

    def __post_init__(self):
        # Reuse the graph's range checks, including nan/bool rejection.
        if isinstance(self.resolution, bool):
            raise ValueError('resolution must be numeric')
        build_graph([], [], **asdict(self))


class RelationService:
    def __init__(self, root, *, provider_factory=None,
                 model='text-embedding-3-small', provider_namespace='openai-official-v1',
                 model_revision='', tenant='backend', config=None,
                 max_documents=200, max_chunks=512, max_input_bytes=8_000_000,
                 request_seconds=280):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.provider_factory = provider_factory
        self.model, self.provider_namespace = model, provider_namespace
        self.model_revision, self.tenant = model_revision, tenant
        self.config = config or RelationConfig()
        if not isinstance(self.config, RelationConfig):
            raise ValueError('config must be RelationConfig')
        if not all(isinstance(s, str) and s.strip() for s in (model, provider_namespace, tenant)):
            raise ValueError('model, provider_namespace, tenant are required')
        for value in (max_documents, max_chunks, max_input_bytes):
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError('Limits must be positive integers')
        if not isinstance(request_seconds, (int,float)) or not 0 < request_seconds <= 280:
            raise ValueError('request_seconds must be in (0,280]')
        self.max_documents, self.max_chunks = max_documents, max_chunks
        self.max_input_bytes, self.request_seconds = max_input_bytes, request_seconds
        self._locks, self._guard = {}, threading.Lock()
        self.config_key = digest(['graph_v1', asdict(self.config), self.model,
                                  self.provider_namespace, self.model_revision,
                                  'title_body_bytes_3600_overlap300_mean_v1'])

    def _scope(self, owner):
        if not isinstance(owner, str) or not owner.strip() or len(owner) > 200:
            raise ServiceError(422, 'INVALID_OWNER', 'ownerId는 비어 있지 않은 문자열이어야 합니다.')
        return digest([self.tenant, owner])

    @contextmanager
    def _locked(self, scope):
        with self._guard:
            lock = self._locks.setdefault(scope, threading.Lock())
        if not lock.acquire(blocking=False):
            raise ServiceError(409, 'OWNER_BUSY', '해당 사용자의 갱신 작업이 진행 중입니다.')
        try:
            yield
        finally:
            lock.release()

    def _folder(self, scope):
        return self.root / 'owners' / scope

    def _state(self, scope):
        path = self._folder(scope) / 'state.json'
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding='utf-8'))

    def _embedding_key(self, text):
        return digest(['embedding_input_v1', self.provider_namespace,
                       self.model, self.model_revision, text])

    def _cache_path(self, scope, text):
        return self._folder(scope) / 'embeddings' / (self._embedding_key(text) + '.json')

    def _cached(self, scope, text):
        path = self._cache_path(scope, text)
        if not path.exists():
            return None
        row = json.loads(path.read_text(encoding='utf-8'))
        if row.get('key') != self._embedding_key(text):
            raise ValueError('Embedding cache identity mismatch')
        return unit(row['vector'])

    def _prepare(self, documents):
        if not isinstance(documents, list):
            raise ServiceError(422, 'INVALID_DOCUMENTS', 'documents는 배열이어야 합니다.')
        try:
            size = len(json.dumps(documents, ensure_ascii=False, allow_nan=False).encode())
        except (TypeError, ValueError) as exc:
            raise ServiceError(422, 'INVALID_JSON', 'JSON으로 표현 가능한 입력이 필요합니다.') from exc
        if size > self.max_input_bytes:
            raise ServiceError(413, 'SNAPSHOT_TOO_LARGE', '전체 문서 입력이 크기 한도를 넘었습니다. 나누어 동기화하지 마세요.')
        if len(documents) > self.max_documents:
            raise ServiceError(413, 'TOO_MANY_DOCUMENTS', '문서 수가 현재 연동 모듈의 한도를 넘었습니다.')
        seen, rows = set(), []
        for item in documents:
            if not isinstance(item, dict):
                raise ServiceError(422, 'INVALID_DOCUMENT', '문서는 객체여야 합니다.')
            aid, version, status = item.get('artifactId'), item.get('version'), item.get('status')
            if not isinstance(aid,str) or not aid.strip() or len(aid) > 200 or aid in seen:
                raise ServiceError(422, 'INVALID_DOCUMENT_ID', 'artifactId가 잘못됐거나 중복됐습니다.')
            seen.add(aid)
            if isinstance(version,bool) or not isinstance(version,int) or version < 1:
                raise ServiceError(422, 'INVALID_VERSION', '문서 version은 1 이상의 정수여야 합니다.')
            if status not in ('adopted', 'draft', 'archived', 'deleted'):
                raise ServiceError(422, 'INVALID_STATUS', 'status는 adopted/draft/archived/deleted 중 하나여야 합니다.')
            title, content = item.get('title'), item.get('content')
            if not isinstance(title,str) or not title.strip() or not isinstance(content,str):
                raise ServiceError(422, 'INVALID_CONTENT', 'title과 content가 필요합니다.')
            if status == 'adopted' and not content.strip():
                raise ServiceError(422, 'EMPTY_CONTENT', '채택한 문서의 본문은 비어 있을 수 없습니다.')
            rows.append({'artifactId':aid, 'version':version, 'status':status,
                         'title':title, 'content':content})
        # Canonical ID order makes input array order irrelevant to graph identity.
        rows.sort(key=lambda row: row['artifactId'])
        docs = load_documents({'result':{'documents':rows}})
        chunks = make_chunks(docs)
        if len(chunks) > self.max_chunks:
            raise ServiceError(413, 'TOO_MANY_CHUNKS', '본문 구간 수가 연동 한도를 넘었습니다. 자르지 말고 용량 정책을 협의하세요.')
        return rows, docs, chunks

    @staticmethod
    def _validate_versions(rows, ledger):
        for row in rows:
            previous = ledger.get(row['artifactId'])
            if previous is None:
                continue
            fingerprint = digest([row['title'],row['content']])
            if row['version'] < previous['version']:
                raise ServiceError(409, 'DOCUMENT_VERSION_ROLLBACK', '문서 version이 이전보다 낮습니다.')
            if row['version'] == previous['version'] and fingerprint != previous['textHash']:
                raise ServiceError(409, 'DOCUMENT_VERSION_CONFLICT', '제목·본문을 바꿀 때 문서 version도 증가시켜 주세요.')

    def sync(self, owner, revision, documents):
        scope = self._scope(owner)
        if isinstance(revision,bool) or not isinstance(revision,int) or revision < 1:
            raise ServiceError(422, 'INVALID_REVISION', 'revision은 1 이상의 정수여야 합니다.')
        rows, docs, chunks = self._prepare(documents)
        input_hash = digest(rows)
        with self._locked(scope):
            state = self._state(scope)
            if state:
                if revision < state['revision']:
                    raise ServiceError(409, 'STALE_REVISION', '더 최신 동기화 요청이 이미 접수됐습니다.')
                if revision == state['revision'] and input_hash != state['inputHash']:
                    raise ServiceError(409, 'REVISION_CONFLICT', '같은 revision에 다른 문서를 보낼 수 없습니다.')
            ledger = copy.deepcopy(state.get('ledger', {})) if state else {}
            self._validate_versions(rows, ledger)
            if state and revision == state['revision'] and state['status'] == 'ready' and state['configKey'] == self.config_key:
                return dict(self._summary(owner, state), reused=True, apiCalls=[])

            attempt = {'revision':revision, 'inputHash':input_hash, 'configKey':self.config_key,
                       'status':'building', 'ledger':ledger}
            folder = self._folder(scope)
            save_json(folder / 'state.json', attempt)
            calls = []
            deadline = time.monotonic() + self.request_seconds
            try:
                texts = [chunk['text'] for chunk in chunks]
                missing = [text for text in dict.fromkeys(texts) if self._cached(scope,text) is None]
                provider = None
                if missing:
                    if self.provider_factory is None:
                        raise RuntimeError('Embedding provider is not configured')
                    provider = self.provider_factory(scope)
                for start in range(0,len(missing),32):
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Request budget exceeded')
                    batch = missing[start:start+32]
                    call = {'phase':'embedding','model':self.model,'inputs':len(batch),'status':'started'}
                    calls.append(call)
                    values, usage = provider.embed(batch,self.model,deadline=deadline)
                    # Audit raw successful response before validating it. Never return vectors publicly.
                    audit = {
                        'revision':revision, 'keys':[self._embedding_key(text) for text in batch],
                        'model':self.model, 'usage':usage, 'vectors':values,
                    }
                    # Keep invalid nonfinite numbers inspectable without creating invalid JSON.
                    audit = json.loads(json.dumps(audit,ensure_ascii=False,default=str),
                                       parse_constant=lambda value:value)
                    save_json(folder / 'responses' / (uuid.uuid4().hex+'.json'), audit)
                    call.update(status='responded',usage=usage)
                    if len(values) != len(batch):
                        raise ValueError('Embedding count mismatch')
                    checked = [unit(value) for value in values]
                    if len({len(value) for value in checked}) != 1:
                        raise ValueError('Embedding dimension mismatch')
                    for text,value in zip(batch,checked):
                        save_json(self._cache_path(scope,text),{'key':self._embedding_key(text),'vector':value})
                vectors = [self._cached(scope,text) for text in texts]
                if time.monotonic() >= deadline:
                    raise TimeoutError('Request budget exceeded before graph calculation')
                pairs = compare_documents(docs,chunks,vectors)
                graph = build_graph(docs,pairs,**asdict(self.config))
                public = self._public_graph(graph)
                snapshot_id = digest([scope,revision,input_hash,self.config_key])
                for row in rows:
                    ledger[row['artifactId']] = {'version':row['version'],
                                                'textHash':digest([row['title'],row['content']])}
                complete = dict(attempt,status='ready',ledger=ledger,snapshotId=snapshot_id,
                                graph=public,apiCalls=calls)
                # One atomic publication: readers cannot mix nodes from one revision with edges from another.
                save_json(folder / 'state.json', complete)
                return dict(self._summary(owner,complete),reused=False,apiCalls=calls)
            except Exception as exc:
                if calls and calls[-1]['status'] == 'started':
                    calls[-1]['status'] = 'failed'
                failure = dict(attempt,status='failed',errorType=type(exc).__name__,apiCalls=calls)
                save_json(folder / 'state.json',failure)
                raise ServiceError(502,'RELATION_SYNC_FAILED',
                                   '문서 연결 갱신에 실패했습니다. 동일 revision·입력으로 수동 재요청할 수 있습니다.') from exc

    def _public_graph(self, graph):
        nodes = [{'artifactId':n['artifactId'],'version':n['version'],'contentHash':n['bodyHash'],
                  'title':n['title'],'groupId':('group-'+str(n['group'])) if n['group'] else None,
                  'degree':n['degree']} for n in graph['nodes']]
        lookup = {n['artifactId']:n for n in nodes}
        edges = []
        for edge in graph['edges']:
            passages = []
            for field, aid in (('passageA',edge['a']),('passageB',edge['b'])):
                part = edge[field]
                passages.append({'artifactId':aid,'version':lookup[aid]['version'],
                    'start':part['start'],'end':part['end'],'text':part['body']})
            edges.append({'sourceId':edge['a'],'targetId':edge['b'],
                          'similarity':edge['similarity'],'passageSimilarity':edge['passageSimilarity'],
                          'similarPassages':passages})
        return {'nodes':nodes,'edges':edges,'counts':graph['counts'],
                'config':asdict(self.config),'connectionMeaning':'content_similarity',
                'algorithmVersion':'document_similarity_graph_v1',
                'groupingMethod':'weighted_louvain',
                'meaning':'선은 내용 유사성입니다. 사실 검증·인과·정정·선후관계를 보장하지 않습니다. '
                          '본문 구간은 유사한 부분의 열람용이며 관계를 입증한 인용이 아닙니다.'}

    @staticmethod
    def _summary(owner, state):
        return {'ownerId':owner,'indexRevision':state['revision'],'snapshotId':state['snapshotId'],
                'indexStatus':'ready','counts':state['graph']['counts'],
                'config':state['graph']['config']}

    def get_graph(self, owner, snapshot_id):
        scope = self._scope(owner)
        with self._locked(scope):
            state = self._state(scope)
            if not state:
                raise ServiceError(404,'RELATION_INDEX_NOT_FOUND','먼저 문서 연결 동기화를 실행하세요.')
            if state['status'] != 'ready' or state['configKey'] != self.config_key:
                raise ServiceError(409,'RELATION_INDEX_NOT_READY','최신 문서 연결 갱신이 완료되지 않았습니다.')
            if snapshot_id != state['snapshotId']:
                raise ServiceError(409,'STALE_SNAPSHOT','문서 연결이 변경됐습니다. 최신 snapshotId로 조회하세요.')
            return dict(self._summary(owner,state),**copy.deepcopy(state['graph']))
