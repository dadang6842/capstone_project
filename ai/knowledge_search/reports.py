"""Record actual observations; proposed expected sets and mock tests are not ground truth."""
import json
import zipfile
from datetime import datetime,timezone
from pathlib import Path
from .base import digest,PROMPT


def save_trial(root,result,calls,elapsed,bundle):
    directory=Path(root)/'trials';directory.mkdir(parents=True,exist_ok=True)
    record={'moduleVersion':'search_module_v1','recordedAt':datetime.now(timezone.utc).isoformat(),
            'result':result,'apiCallsThisStep':calls,'elapsedSeconds':round(elapsed,3),
            'fixtureTestOnly':bool(bundle.get('testFixture',{}).get('testOnly')),
            'fixtureBundleFingerprint':digest(bundle.get('result',bundle).get('documents',[])),
            'policyHash':digest(PROMPT)}
    record['corpusManifest']=[{k:d.get(k) for k in ('artifactId','version','title','contentHash','status','metadataStatus')}
                              for d in bundle.get('result',bundle).get('documents',[])]
    case=next((c for c in bundle.get('searchTestCases',{}).get('cases',[]) if c['query']==result['query']),None)
    if case:
        expected=set(case['expectedArtifactIds']);actual={d['artifactId'] for d in result['results']}
        record['referenceComparison']={'caseId':case['id'],'referenceStatus':case['reviewStatus'],
            'expectedArtifactIds':sorted(expected),'actualArtifactIds':sorted(actual),
            'missingArtifactIds':sorted(expected-actual),'additionalArtifactIds':sorted(actual-expected),
            'exactSetMatch':actual==expected if result['complete'] else None,
            'meaning':'본문에서 작성한 기대 결과 초안과의 비교이며 사용자 확정 정답·외부 사실 검증이 아닙니다.'}
    path=directory/(digest([record['recordedAt'],result['query'],result['snapshotId']])[:24]+'.json')
    path.write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
    return path


def export_review(root,bundle,baseline_records=None):
    root=Path(root);snapshot_hash=digest(bundle.get('result',bundle).get('documents',[]))
    trials=[]
    for path in sorted((root/'trials').glob('*.json')):
        record=json.loads(path.read_text(encoding='utf-8'))
        # Only aggregate this input's exact document manifest.
        expected=[{k:d.get(k) for k in ('artifactId','version','title','contentHash','status','metadataStatus')}
                  for d in bundle.get('result',bundle).get('documents',[])]
        if record.get('fixtureBundleFingerprint')==snapshot_hash and record.get('policyHash')==digest(PROMPT):trials.append(record)
    trials.sort(key=lambda r:r['recordedAt'])
    latest={}
    for record in trials:latest[record['result']['query']]=record
    final_rows=list(latest.values())
    baselines=baseline_records or []
    overview={'moduleVersion':'search_module_v1','generatedAt':datetime.now(timezone.utc).isoformat(),
              'corpusFingerprintForReport':snapshot_hash,'trialRecords':trials,'latestQueryRecords':final_rows,'providedV2Baselines':baselines,
              'limits':['문서 6편 등 작은 시험 집합의 결과를 전체 검색 품질로 일반화하지 않습니다.',
                        '전체 문서를 아직 판단하지 않았으면 현재까지 확인한 일치 수만 표시합니다.',
                        '모든 문서를 판단해도 LLM의 의미 판단·조건 충족·검색 무누락을 보증하지 않습니다.',
                        'v2 결과는 비교 기준일 뿐 정답이 아닙니다. 기대 결과도 사용자 확인 전 초안입니다.',
                        'v2 내보내기 파일에는 전체 문서 본문이 없어 전체 문서 동일성을 자동 검증할 수 없습니다.',
                        'v2 API 시도 기록은 세션 누적일 수 있으므로 질문별 비용으로 단순 합산하지 않습니다.']}
    directory=root/'planning_review';directory.mkdir(parents=True,exist_ok=True)
    json_path=directory/'search_interim_review.json';json_path.write_text(json.dumps(overview,ensure_ascii=False,indent=2),encoding='utf-8')
    def clean(value):return str(value).replace('|','/').replace('\n',' ')
    lines=['# 검색 기능 중간 확인 자료','',
           '실행된 검색 기록을 정리한 자료입니다. 운영 배포·기획 승인·검색 품질 최종 검증을 의미하지 않습니다.','',
           '## 적용 기준','',
           '- 채택 문서만 검색하며 최신 본문을 사용합니다. 오래된 메타데이터·요약·키워드는 제외합니다.',
           '- 전체 본문을 구간별로 색인하고 임베딩·단어 검색의 문서 순위를 합칩니다.',
           '- LLM은 후보 문서의 전체 본문을 읽고 직접 답변·필수 조건을 판단합니다.',
           '- 후보를 영구 제외하는 상위 k개 제한이 없습니다. 초기 배치 이후 추가 탐색할 수 있습니다.',
           '- 결과 수와 화면 페이지 크기는 별개입니다. 검색 도중이면 전체 결과 수를 확정하지 않습니다.','',
           '## 질문별 최신 상태','',
           '같은 질문의 중간·완료 상태는 한 행으로 정리했습니다. 전체 단계 기록은 JSON에 보존합니다. 시간은 마지막 실행 단계이며 전체 검색 시간이 아닙니다.','',
           '| 질문 | 상태 | 확인 문서/대상 | 현재 일치 수 | 기대 초안과 일치 | 마지막 실행 단계(초) |',
           '|---|---|---:|---:|---|---:|']
    for t in final_rows:
        r=t['result'];comparison=t.get('referenceComparison',{})
        value=comparison.get('exactSetMatch');label='미확정' if value is None else ('일치' if value else '차이 있음')
        lines.append(f"| {clean(r['query'])} | {r['status']} | {r['processedDocuments']}/{r['totalDocuments']} | {r['knownMatches']} | {label} | {t['elapsedSeconds']} |")
    if not final_rows:lines.append('| 실제 실행 기록 없음 | 미실행 | — | — | — | — |')
    lines+=['','## 문서별 발췌·검색 이유','']
    for t in final_rows:
        r=t['result'];lines+=['### '+clean(r['query']),'',f"상태: {r['status']} / 전체 판단 완료: {r['complete']}",'']
        for d in r['results']:
            lines += ['- **'+clean(d['title'])+'**','  - 발췌: '+clean(d['evidence']),'  - 검색 이유: '+clean(d['reason'])]
        if r.get('errors'):lines+=['오류: '+clean(json.dumps(r['errors'],ensure_ascii=False))]
        c=t.get('referenceComparison')
        if c:lines+=['','기대 초안 대비 누락 ID: '+clean(c['missingArtifactIds'])+' / 추가 ID: '+clean(c['additionalArtifactIds'])]
        lines+=['']
    lines+=['## 보관한 v2 결과','',f'사용자가 첨부한 비교 결과: {len(baselines)}건. v2 전체 문서 판단 결과도 정답으로 간주하지 않습니다.','',
            '## 확인 범위와 한계','']+['- '+s for s in overview['limits']]
    md_path=directory/'search_interim_review.md';md_path.write_text('\n'.join(lines),encoding='utf-8')
    zip_path=root/'search_interim_review.zip'
    with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED) as z:
        for p in (json_path,md_path):z.write(p,p.name)
    return zip_path
