"""AI 서버 진입점: 지식 문서 생성 앱(knowledge_generation)에 검색(knowledge_search)·관계도(knowledge_relations) 라우터를 붙인다.

- 생성 경로(/v2/analyses)와 생성 설정(AI_ENABLE_V2_ANALYSES 등)은 knowledge_generation 그대로다. 세 패키지 코드는 고치지 않는다.
- 검색 경로(/v2/search-index/sync, /v2/searches, /continue, /page, /v2/search-documents/read)는 AI_ENABLE_SEARCH=true일 때만 붙는다.
- 관계도 경로(/v2/relation-index/sync, /v2/relations)는 AI_ENABLE_RELATIONS=true일 때만 붙는다.
- 검색 색인은 AI_DATA_DIR/knowledge_search, 관계도 상태·임베딩 캐시는 AI_DATA_DIR/knowledge_relations 아래에 저장된다
  (둘 다 한 프로세스 기준이라 uvicorn 워커는 1개).
"""
from knowledge_generation.api import create_app as create_generation_app
from knowledge_search.api import register_search
from knowledge_relations.api import register_relations


def create_app():
    app = register_relations(register_search(create_generation_app()))

    # 기존 /health는 생성 모듈 것이라 검색·관계도가 켜졌는지는 따로 알려 준다 (배포 확인용)
    @app.get('/health/search')
    def search_health():
        return {'status': 'ok', 'searchEnabled': getattr(app.state, 'knowledge_search_enabled', False)}

    @app.get('/health/relations')
    def relations_health():
        return {'status': 'ok', 'relationsEnabled': getattr(app.state, 'knowledge_relations_enabled', False)}

    return app