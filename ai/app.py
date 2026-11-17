"""AI 서버 진입점: 지식 문서 생성 앱(knowledge_generation)에 지식 문서 검색 라우터(knowledge_search)를 붙인다.

- 생성 경로(/v2/analyses)와 생성 설정(AI_ENABLE_V2_ANALYSES 등)은 knowledge_generation 그대로다. 두 패키지 코드는 고치지 않는다.
- 검색 경로(/v2/search-index/sync, /v2/searches, /continue, /page, /v2/search-documents/read)는 AI_ENABLE_SEARCH=true일 때만 붙는다.
- 검색 색인은 AI_DATA_DIR/knowledge_search 아래 SQLite에 저장된다 (한 프로세스 기준이라 uvicorn 워커는 1개).
"""
from knowledge_generation.api import create_app as create_generation_app
from knowledge_search.api import register_search


def create_app():
    app = register_search(create_generation_app())

    # 기존 /health는 생성 모듈 것이라 검색이 켜졌는지는 따로 알려 준다 (배포 확인용)
    @app.get('/health/search')
    def search_health():
        return {'status': 'ok', 'searchEnabled': getattr(app.state, 'knowledge_search_enabled', False)}

    return app