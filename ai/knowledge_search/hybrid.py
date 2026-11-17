"""Hybrid ranking with resumable relevance judgments. All adopted documents remain reachable.
No semantic cutoff is claimed to prove recall. Serving and exhaustive comparison are separate.
"""
import json
from .base import SearchTrial as Base, VERSION, PROMPT, digest
from .retrieval import byte_parts, bm25, normalized


class HybridSearch(Base):
    def __init__(self,*args,embedding_model='text-embedding-3-small',**kwargs):
        super().__init__(*args,**kwargs)
        self.embedding_model=embedding_model
        if not isinstance(embedding_model,str) or not embedding_model.strip():raise ValueError('임베딩 모델 ID 오류')

    def _embedding_key(self,text):
        return digest([VERSION,self.provider.namespace,self.embedding_model,text])

    def vectors(self,texts):
        missing=[t for t in dict.fromkeys(texts) if self.cached('embedding',self._embedding_key(t)) is None]
        for start in range(0,len(missing),32):
            batch=missing[start:start+32]
            self.calls.append({'phase':'embedding','model':self.embedding_model,'inputs':len(batch),'status':'started'})
            try:
                values,usage=self.provider.embed(batch,self.embedding_model)
                self.calls[-1].update(status='responded',usage=usage)
                if len(values)!=len(batch):raise ValueError('임베딩 개수 오류')
                checked=[normalized(v) for v in values]
                if len({len(v) for v in checked})!=1:raise ValueError('임베딩 차원 오류')
                for t,v in zip(batch,checked):self.save_cache('embedding',self._embedding_key(t),v)
            except Exception:
                self.calls[-1]['status']='failed';raise
        values=[self.cached('embedding',self._embedding_key(t)) for t in texts]
        if values and len({len(v) for v in values})!=1:raise ValueError('저장된 임베딩 차원 불일치')
        return values

    def _chunks(self,docs):
        chunks=[]
        for d in docs:
            # Stale metadata, summaries and keywords were already removed by prepare().
            header=d['title']
            if d['metadataUsed']:
                header+='\n'+json.dumps([d['summary'],d['keywords'],d['metadata']],ensure_ascii=False)
            header=next(byte_parts(header,limit=1500,overlap=0))[2]
            for start,end,body in byte_parts(d['content']):
                chunks.append({'artifactId':d['artifactId'],'start':start,'end':end,'body':body,
                               'text':header+'\n\n'+body})
        return chunks

    def index_preview(self,documents):
        snapshot=self.prepare(documents);chunks=self._chunks(snapshot['documents'])
        missing={c['text'] for c in chunks if self.cached('embedding',self._embedding_key(c['text'])) is None}
        return {'searchableDocuments':len(snapshot['documents']),'chunks':len(chunks),
                'newEmbeddingInputs':len(missing),'newEmbeddingRequests':(len(missing)+31)//32}

    def sync(self,documents):
        report=super().sync(documents)
        snapshot=self.snapshot();snapshot['indexConfig']=digest([self.provider.namespace,self.embedding_model])
        snapshot['indexReady']=False;snapshot['chunks']=self._chunks(snapshot['documents'])
        self._write_snapshot(snapshot)
        if snapshot['chunks']:self.vectors([c['text'] for c in snapshot['chunks']])
        snapshot['indexReady']=True;self._write_snapshot(snapshot)
        return {**report,**self.index_preview(documents),'indexReady':True}

    def _write_snapshot(self,snapshot):
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO snapshots VALUES(?,?)',(self.owner,json.dumps(snapshot,ensure_ascii=False)))

    def _ready(self,snapshot):
        if snapshot['documents'] and (not snapshot.get('indexReady') or snapshot.get('indexConfig')!=
                                      digest([self.provider.namespace,self.embedding_model])):
            raise ValueError('색인이 미완료이거나 임베딩 설정이 변경됐습니다. 동기화 셀을 실행하세요.')

    def _rank(self,query,snapshot):
        key=digest([VERSION,snapshot['fingerprint'],self.provider.namespace,self.embedding_model,query])
        saved=self.cached('candidate_order',key)
        if saved is not None:return saved
        chunks=snapshot['chunks'];vectors=self.vectors([c['text'] for c in chunks]+[query]);q=vectors[-1]
        semantic=[sum(a*b for a,b in zip(v,q)) for v in vectors[:-1]]
        lexical=bm25(query,[c['text'] for c in chunks]);scores={d['artifactId']:0.0 for d in snapshot['documents']}
        # Combine document ranks derived from the best matching passage in each branch.
        # Every document remains in the ordering, including zero/negative similarities.
        for branch in (semantic,lexical):
            best={}
            for c,score in zip(chunks,branch):best[c['artifactId']]=max(score,best.get(c['artifactId'],float('-inf')))
            ranked=sorted(best,key=lambda aid:(-best[aid],aid))
            for rank,aid in enumerate(ranked,1):
                if best[aid]>0:scores[aid]+=1/(60+rank)
        order=[{'artifactId':aid,'score':round(scores[aid],10)} for aid in sorted(scores,key=lambda a:(-scores[a],a))]
        self.save_cache('candidate_order',key,order);return order

    def _decision_key(self,query,doc):
        return digest([VERSION,self.provider.namespace,self.judge_model,PROMPT,query,self._card(doc)])

    def preview(self,query):
        self._validate_query(query);snapshot=self.snapshot();self._ready(snapshot)
        pending=[d for d in snapshot['documents'] if self.cached('decision',self._decision_key(query.strip(),d)) is None]
        batches,oversized=self._batches(pending)
        return {'documents':len(snapshot['documents']),'judgedDocuments':len(snapshot['documents'])-len(pending),
                'pendingDocuments':len(pending),'remainingJudgmentBatches':len(batches),
                'oversizedDocumentIds':oversized,'queryEmbeddingMayBeNeeded':bool(pending) and self.cached('embedding',self._embedding_key(query.strip())) is None}

    def search(self,query,*,max_new_batches=1):
        """One serving step by default; run again to continue. None exhausts all candidates."""
        self._validate_query(query);query=query.strip()
        if max_new_batches is not None and (isinstance(max_new_batches,bool) or not isinstance(max_new_batches,int) or max_new_batches<1):
            raise ValueError('신규 배치 수는 양의 정수 또는 None입니다.')
        snapshot=self.snapshot();self._ready(snapshot);docs=snapshot['documents']
        if not docs:return {**Base.search(self,query),'searchMode':'hybrid','hasMoreCandidates':False,'candidateOrder':[],'decisions':[]}
        base={'query':query,'snapshotId':snapshot['fingerprint'],'answerGenerated':False,
              'externalTruth':'not_checked','totalDocuments':len(docs),'searchMode':'hybrid',
              'searchConfig':{'embeddingModel':self.embedding_model,'judgeModel':self.judge_model,
                              'fusion':'document_rank_RRF','providerNamespace':self.provider.namespace}}
        key=digest([VERSION,snapshot['fingerprint'],self.provider.namespace,self.embedding_model,self.judge_model,PROMPT,query])
        cached=self.cached('hybrid_search',key)
        if cached is not None:return {**cached,'cacheHit':True}
        calls_before=len(self.calls)
        lookup={d['artifactId']:d for d in docs};errors=[]
        try:order=self._rank(query,snapshot)
        except Exception as exc:
            return {**base,'results':[],'complete':False,'status':'incomplete','rankingStatus':'incomplete',
                    'totalMatches':None,'knownMatches':0,'processedDocuments':0,'pendingDocuments':len(docs),
                    'hasMoreCandidates':True,'cacheHit':False,'uncertainDocuments':0,'candidateOrder':[],'decisions':[],
                    'errors':[{'type':type(exc).__name__,'phase':'retrieval','message':'후보 검색을 완료하지 못했습니다.'}]}
        decisions={};pending=[]
        for row in order:
            doc=lookup[row['artifactId']];item=self.cached('decision',self._decision_key(query,doc))
            if item is not None:
                self._validate_decisions({'decisions':[item]},[doc]);decisions[doc['artifactId']]=item
            else:pending.append(doc)
        batches,oversized=self._batches(pending)
        if oversized:errors.append({'type':'document_too_large','documentIds':oversized,
                                    'message':'전체 본문을 자르지 않았습니다. 입력 한도를 확인하세요.'})
        for n,batch in enumerate(batches):
            if max_new_batches is not None and n>=max_new_batches:break
            print(f'하이브리드 후보 검토: {n+1}/{len(batches)} 배치 · {len(batch)}편',flush=True)
            self.calls.append({'phase':'hybrid_judgment','model':self.judge_model,'documents':len(batch),'status':'started'})
            try:
                output,usage=self.provider.judge({'query':query,'documents':[self._card(d) for d in batch]},self.judge_model,PROMPT)
                self.calls[-1].update(status='responded',usage=usage)
                checked=self._validate_decisions(output,batch)
                for item in checked:
                    decisions[item['artifactId']]=item
                    self.save_cache('decision',self._decision_key(query,lookup[item['artifactId']]),item)
            except Exception as exc:
                self.calls[-1]['status']='failed'
                errors.append({'type':type(exc).__name__,'phase':'judgment','documentIds':[d['artifactId'] for d in batch],
                               'message':'판단 미완료. 자동 재시도하지 않았습니다.'});break
        scores={r['artifactId']:r['score'] for r in order};results=[]
        for aid,item in decisions.items():
            if item['decision']!='MATCH':continue
            d=lookup[aid];results.append({k:d.get(k) for k in ('artifactId','title','version','contentHash','searchHash',
                                        'sourceLinks','sourceLinksStatus','sourceWarnings','metadataUsed')})
            results[-1].update(reason=item['reason'],evidence=item['evidence'],strength=item['strength'],
                               retrievalScore=scores[aid],evidenceStart=d['content'].find(item['evidence']))
        results.sort(key=lambda r:(-r['strength'],-r['retrievalScore'],r['artifactId']))
        complete=len(decisions)==len(docs) and not errors
        result={**base,'results':results,'complete':complete,'processedDocuments':len(decisions),
                'pendingDocuments':len(docs)-len(decisions),'hasMoreCandidates':len(decisions)<len(docs),
                'knownMatches':len(results),'totalMatches':len(results) if complete else None,
                'uncertainDocuments':sum(d['decision']=='UNCERTAIN' for d in decisions.values()),
                'status':('matches' if results else 'no_match') if complete else ('incomplete' if errors else 'in_progress'),
                'rankingStatus':'completed' if complete else ('incomplete' if errors else 'in_progress'),
                'cacheHit':len(self.calls)==calls_before,'candidateOrder':order,
                'decisions':list(decisions.values()),'errors':errors,
                'meaning':'검색 결과 수를 제한하지 않습니다. 남은 후보가 있으면 전체 결과가 아니며, 끝까지 판단해도 LLM 무누락을 보증하지 않습니다.'}
        if complete:self.save_cache('hybrid_search',key,result)
        return result

    def full_scan(self,query):
        """Independent all-document LLM baseline; NOT ground truth."""
        result=Base.search(self,query)
        return {**result,'searchMode':'full_scan_baseline'}
