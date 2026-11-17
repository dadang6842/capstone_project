"""Document similarity trial. No LLM judgments, no production index mutations."""
import copy
import hashlib
import json
import math
import os
from pathlib import Path

import numpy as np
import networkx as nx

VERSION = 'knowledge_relations_1.0.0'
CHUNK_BYTES = 3600
OVERLAP_BYTES = 300


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False,
                                    sort_keys=True, allow_nan=False).encode()).hexdigest()


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2,
                                   allow_nan=False), encoding='utf-8')
    temporary.replace(path)


def load_documents(value):
    if not isinstance(value, dict) or not isinstance(value.get('result'), dict):
        raise ValueError('기존 생성 결과의 result.documents 구조가 필요합니다.')
    rows = value['result'].get('documents')
    if not isinstance(rows, list):
        raise ValueError('result.documents가 배열이 아닙니다.')
    docs, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('문서 항목이 객체가 아닙니다.')
        if row.get('status') != 'adopted':
            continue
        for key in ('artifactId', 'title', 'content'):
            if not isinstance(row.get(key), str) or not row[key].strip():
                raise ValueError('문서 필드 오류: ' + key)
        if row['artifactId'] in seen:
            raise ValueError('중복 문서 ID')
        seen.add(row['artifactId'])
        version = row.get('version')
        if isinstance(version, bool) or not isinstance(version, int) or version < 1:
            raise ValueError('문서 version은 1 이상의 정수여야 합니다.')
        docs.append({
            'artifactId': row['artifactId'], 'version': version,
            'title': row['title'], 'content': row['content'],
            # Recompute from current body; do not trust a stale supplied hash.
            'bodyHash': digest(row['content']),
        })
    # IDs in presentation only. Persistent identity always uses artifactId.
    return [dict(d, ref=f'D{i:02d}') for i, d in enumerate(docs, 1)]


def byte_parts(text, limit=CHUNK_BYTES, overlap=OVERLAP_BYTES):
    if limit < 16 or not 0 <= overlap < limit:
        raise ValueError('구간 크기·중복 범위 오류')
    start = 0
    while start < len(text):
        end, size = start, 0
        while end < len(text) and size + len(text[end].encode()) <= limit:
            size += len(text[end].encode())
            end += 1
        yield start, end, text[start:end]
        if end == len(text):
            break
        next_start, used = end, 0
        while next_start > start and used + len(text[next_start - 1].encode()) <= overlap:
            next_start -= 1
            used += len(text[next_start].encode())
        start = max(start + 1, next_start)


def make_chunks(docs):
    chunks = []
    for doc in docs:
        # Title is kept in full in document output. Only its embedding header is bounded.
        header = next(byte_parts(doc['title'], limit=1000, overlap=0))[2]
        covered = 0
        for start, end, body in byte_parts(doc['content']):
            # New-body byte weights reduce duplicate contribution from overlap.
            weight = len(doc['content'][max(covered, start):end].encode())
            chunks.append({
                'artifactId': doc['artifactId'], 'start': start, 'end': end,
                'body': body, 'text': header + '\n\n' + body,
                'weight': weight,
            })
            covered = end
    return chunks


def unit(vector):
    if not isinstance(vector, list) or not vector or any(
        isinstance(x, bool) or not isinstance(x, (int, float))
        or not math.isfinite(x) for x in vector
    ):
        raise ValueError('유효하지 않은 임베딩 벡터')
    arr = np.asarray(vector, dtype=float)
    norm = float(np.linalg.norm(arr))
    if not math.isfinite(norm) or norm <= 0:
        raise ValueError('유효하지 않은 벡터 크기')
    return (arr / norm).tolist()


def compare_documents(docs, chunks, vectors):
    if len(chunks) != len(vectors):
        raise ValueError('구간과 벡터 개수 불일치')
    if len({len(v) for v in vectors}) > 1:
        raise ValueError('벡터 차원 불일치')
    normalized = [unit(v) for v in vectors]
    positions = {d['artifactId']: [] for d in docs}
    for i, chunk in enumerate(chunks):
        positions[chunk['artifactId']].append(i)
    doc_vectors = {}
    for doc in docs:
        ix = positions[doc['artifactId']]
        if not ix:
            raise ValueError('본문 구간이 없는 문서')
        pooled = np.average([normalized[i] for i in ix], axis=0,
                            weights=[chunks[i]['weight'] for i in ix])
        doc_vectors[doc['artifactId']] = unit(pooled.tolist())
    matrix = np.asarray(normalized, dtype=float)
    chunk_scores = matrix @ matrix.T if len(matrix) else np.empty((0, 0))
    pairs = []
    for left in range(len(docs)):
        for right in range(left + 1, len(docs)):
            a, b = docs[left], docs[right]
            aid, bid = a['artifactId'], b['artifactId']
            score = float(np.clip(np.dot(doc_vectors[aid], doc_vectors[bid]), -1, 1))
            si, sj = max(
                ((i, j) for i in positions[aid] for j in positions[bid]),
                key=lambda pair: (chunk_scores[pair[0], pair[1]],
                                  -pair[0], -pair[1]),
            )
            pairs.append({
                'a': aid, 'b': bid, 'aRef': a['ref'], 'bRef': b['ref'],
                'similarity': score,
                'passageSimilarity': float(np.clip(chunk_scores[si, sj], -1, 1)),
                'passageA': {k: chunks[si][k] for k in ('start', 'end', 'body')},
                'passageB': {k: chunks[sj][k] for k in ('start', 'end', 'body')},
            })
    return sorted(pairs, key=lambda p: (-p['similarity'], p['a'], p['b']))


def build_graph(docs, pairs, *, threshold=0.55, neighbors=2, mode='mutual', resolution=1.0):
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not 0 <= threshold <= 1:
        raise ValueError('threshold는 0~1 사이여야 합니다.')
    if isinstance(neighbors, bool) or not isinstance(neighbors, int) or neighbors < 1:
        raise ValueError('neighbors는 양의 정수여야 합니다.')
    if mode not in {'mutual', 'union'}:
        raise ValueError('mode는 mutual 또는 union입니다.')
    if not math.isfinite(resolution) or resolution <= 0:
        raise ValueError('resolution은 양수여야 합니다.')
    ids = [d['artifactId'] for d in docs]
    adjacent = {aid: [] for aid in ids}
    for p in pairs:
        adjacent[p['a']].append((p['b'], p['similarity']))
        adjacent[p['b']].append((p['a'], p['similarity']))
    chosen = {aid: {bid for bid, score in sorted(rows, key=lambda r: (-r[1], r[0]))[:neighbors]}
              for aid, rows in adjacent.items()}
    graph = nx.Graph()
    graph.add_nodes_from(ids)
    edges = []
    for p in pairs:
        a, b, score = p['a'], p['b'], p['similarity']
        one, two = b in chosen[a], a in chosen[b]
        select = (one and two) if mode == 'mutual' else (one or two)
        if score > 0 and score >= threshold and select:
            graph.add_edge(a, b, weight=score)
            edges.append(copy.deepcopy(p))
    # Connected components are not treated as topics: partition by weighted modularity.
    active = graph.subgraph([aid for aid in ids if graph.degree(aid) > 0]).copy()
    communities = (nx.community.louvain_communities(active, weight='weight',
                    resolution=resolution, seed=42) if active.number_of_edges() else [])
    communities = sorted(communities, key=lambda members: (-len(members), min(members)))
    groups = {aid: i + 1 for i, members in enumerate(communities) for aid in members}
    nodes = []
    for d in docs:
        aid = d['artifactId']
        nodes.append(dict(d, group=groups.get(aid), degree=graph.degree(aid)))
    return {
        'moduleVersion': VERSION, 'connectionMeaning': 'content_similarity',
        'config': {'threshold': threshold, 'neighbors': neighbors, 'mode': mode,
                   'resolution': resolution, 'pooling': 'new_body_byte_weighted_chunk_mean'},
        'nodes': nodes, 'edges': edges, 'pairs': copy.deepcopy(pairs),
        'counts': {'documents': len(nodes), 'edges': len(edges),
                   'groups': len(communities), 'isolates': len(ids) - len(groups)},
        'meaning': '선은 임베딩 유사성입니다. 사실 검증·인과·정정·선후관계를 뜻하지 않습니다. '
                   '색상은 현재 설정의 탐색용 묶음이며 정답 주제 분류가 아닙니다. '
                   '점 사이 화면 거리는 정확한 유사도 척도가 아닙니다.',
    }
