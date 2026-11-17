import re, math, unicodedata
from collections import Counter

def byte_parts(text, limit=3600, overlap=300):
    """Bound UTF-8 byte count, never split a character, preserve original substrings."""
    if limit < 16 or not 0 <= overlap < limit:
        raise ValueError('구간 크기·중복 범위를 확인하세요.')
    start = 0
    while start < len(text):
        end = start
        size = 0
        while end < len(text) and size + len(text[end].encode()) <= limit:
            size += len(text[end].encode())
            end += 1
        yield start, end, text[start:end]
        if end == len(text):
            break
        next_start = end
        used = 0
        while next_start > start and used + len(text[next_start-1].encode()) <= overlap:
            next_start -= 1
            used += len(text[next_start].encode())
        start = max(start + 1, next_start)


def terms(text):
    words = re.findall(r'[가-힣]+|[a-z0-9_]+', unicodedata.normalize('NFKC', text).lower())
    out = []
    for word in words:
        out.append(word)
        if re.fullmatch('[가-힣]+', word):
            out.extend(word[i:i+2] for i in range(len(word)-1))
    return out


def bm25(query, texts):
    counts = [Counter(terms(t)) for t in texts]
    avg = sum(sum(c.values()) for c in counts) / max(1, len(counts)) or 1
    scores = [0.0] * len(texts)
    for term in set(terms(query)):
        df = sum(term in c for c in counts)
        idf = math.log(1 + (len(counts)-df+0.5)/(df+0.5))
        for i, c in enumerate(counts):
            freq = c[term]
            scores[i] += idf * freq * 2.2 / (freq + 1.2*(0.25+0.75*sum(c.values())/avg))
    return scores


def normalized(vector):
    if not isinstance(vector, list) or not vector or any(
        isinstance(v, bool) or not isinstance(v, (int,float)) or not math.isfinite(v) for v in vector
    ):
        raise ValueError('잘못된 임베딩 벡터입니다.')
    norm = math.sqrt(sum(v*v for v in vector))
    if not math.isfinite(norm) or norm == 0:
        raise ValueError('영벡터 또는 유효하지 않은 벡터입니다.')
    return [v/norm for v in vector]


