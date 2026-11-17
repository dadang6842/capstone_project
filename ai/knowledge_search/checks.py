"""Optional Colab behavior checks on a SQLite backup, never the user's original index.
Uses the supplied live provider when called; may incur new API costs.
"""
import copy
import sqlite3
import tempfile
from .hybrid import HybridSearch

CHECK_QUERY='GPU 메모리가 부족하면 EMBED_BATCH_SIZE를 얼마로 줄이라고 했어?'

def behavior_checks(source,documents,target_artifact_id):
    before=source.snapshot();target=next((d for d in documents if d['artifactId']==target_artifact_id),None)
    if target is None or target.get('status')!='adopted':raise ValueError('시험 대상으로 채택 문서 ID를 지정하세요.')
    report={'originalSnapshotId':before['fingerprint'],'usesIsolatedDatabaseCopy':True,'checks':[],
            'newApiCalls':[],'meaning':'동작 확인용 임시 데이터입니다. 시험 수치 7은 실제 개발 권고가 아닙니다.'}
    with tempfile.TemporaryDirectory(prefix='knowledge-search-checks-') as tmp:
        backup=tmp+'/search_v3.sqlite3'
        with sqlite3.connect(source.database) as origin,sqlite3.connect(backup) as destination:
            origin.backup(destination)
        test=HybridSearch(tmp,owner=source.owner,provider=source.provider,judge_model=source.judge_model,
                          embedding_model=source.embedding_model,batch_bytes=source.batch_bytes,
                          max_document_bytes=source.max_document_bytes)
        seed=test.search(CHECK_QUERY,max_new_batches=None)
        if not seed['complete']:raise RuntimeError('기준 검색 미완료. 원본은 변경하지 않았습니다.')
        n=len(test.calls);again=test.search(CHECK_QUERY,max_new_batches=None)
        assert again['cacheHit'] and len(test.calls)==n
        report['checks'].append({'name':'same_query_cache','passed':True,'additionalApiCalls':0})
        changed=copy.deepcopy(documents);item=next(d for d in changed if d['artifactId']==target_artifact_id)
        item.update(content='임시 동작 시험 문서입니다. GPU 메모리가 부족하면 EMBED_BATCH_SIZE를 7로 줄입니다. 실제 개발 권고가 아니라 동작 검증을 위한 시험 수치입니다.',
                    title='임시 동작 시험: 배치 크기',version=item['version']+1,
                    metadataStatus='needs_refresh',eligibleForIndexing=False,sourceLinksStatus='needs_review')
        test.sync(changed)
        current=next(d for d in test.snapshot()['documents'] if d['artifactId']==target_artifact_id)
        assert not current['metadataUsed'] and current['metadata'] is None
        assert current['content']==item['content']
        edited=test.search(CHECK_QUERY,max_new_batches=None)
        if not edited['complete']:raise RuntimeError('수정 후 검색 미완료. 원본은 변경하지 않았습니다.')
        found=next((d for d in edited['results'] if d['artifactId']==target_artifact_id),None)
        structural=found is None or (found['searchHash']==current['searchHash'] and found['evidence'] in current['content'])
        assert structural
        report['checks'].append({'name':'edited_body_and_stale_metadata','passed':True,
             'matchedEditedDocument':found is not None,'evidence':found['evidence'] if found else None,
             'semanticReviewNeeded':found is None,
             'note':'기존 본문·메타데이터 재사용 여부를 검사했습니다. 문서 미선택은 별도 관련성 검토가 필요합니다.'})
        deleted=copy.deepcopy(changed);next(d for d in deleted if d['artifactId']==target_artifact_id)['deleted']=True
        test.sync(deleted);removed=test.search(CHECK_QUERY,max_new_batches=None)
        assert removed['complete'] and target_artifact_id not in [d['artifactId'] for d in removed['results']]
        assert target_artifact_id not in [d['artifactId'] for d in test.snapshot()['documents']]
        try:test.get_document(target_artifact_id)
        except ValueError:pass
        else:raise AssertionError('삭제한 문서의 본문이 열립니다.')
        report['checks'].append({'name':'delete_exclusion','passed':True})
        unadopted=copy.deepcopy(changed);next(d for d in unadopted if d['artifactId']==target_artifact_id)['status']='draft'
        test.sync(unadopted);removed=test.search(CHECK_QUERY,max_new_batches=None)
        assert removed['complete'] and target_artifact_id not in [d['artifactId'] for d in removed['results']]
        report['checks'].append({'name':'unadopt_exclusion','passed':True})
        report['newApiCalls']=test.calls
    assert source.snapshot()==before
    report['originalUnchanged']=True
    return report
