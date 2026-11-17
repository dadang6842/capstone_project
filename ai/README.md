# AI 서버 (지식 문서 생성 v1.1 + 지식 문서 검색 v1 + 문서 관계도 v1)

AI 담당이 준 세 패키지를 그대로 넣었다. 세 패키지 코드는 고치지 않았고, 배포용 `Dockerfile`·`.dockerignore`·`app.py`·이 README만 더했다.
원본 설명은 AI 담당의 README·docs(검색·관계도 모두 API_CONTRACT.md·INTEGRATION.md·VALIDATION.md)를 본다.

- `knowledge_generation/`: 지식 문서 생성. `POST /v2/analyses`. `/analyses`·`/revisions`는 이 패키지에 없다.
- `knowledge_search/`: 채택한 지식 문서 검색. `AI_ENABLE_SEARCH=true`일 때만 `/v2/search-index/sync`, `/v2/searches`, `/v2/searches/continue`, `/v2/searches/page`, `/v2/search-documents/read`가 붙는다.
- `knowledge_relations/`: 채택한 지식 문서끼리 내용 유사성으로 잇는 관계도(임베딩 + 이웃 + Louvain 묶음). `AI_ENABLE_RELATIONS=true`일 때만 `/v2/relation-index/sync`, `/v2/relations`가 붙는다. 새 의존성 numpy·networkx. 테스트는 `tests_relations/`(AI 담당 `test_api 4.py`는 `test_api.py`로 이름만 바꿈).
- `app.py`: 생성 앱을 만들고 `register_search(app)`, `register_relations(app)`로 두 라우터를 붙인다. 켜짐 여부는 `GET /health/search`, `GET /health/relations`.
- 모든 경로는 헤더 `X-Internal-Api-Key`(백엔드 `.env`의 `INTERNAL_API_KEY`와 같은 값)가 필요하다 (`/health`, `/health/search`, `/health/relations` 제외).
- 백엔드는 같은 compose 네트워크에서 `http://ai:8000`으로 부른다. EC2 밖으로 포트를 열지 않는다.
- 환경변수는 EC2의 `~/app/ai.env`에 둔다 (`.env.example` 참고). `AI_DATA_DIR`는 compose가 `/data`로 고정하고, 검색 색인은 `/data/knowledge_search`, 관계도 상태·임베딩 캐시는 `/data/knowledge_relations`에 쌓인다.
- 생성 작업 잠금, 검색 색인, 관계도 작업 잠금이 모두 한 프로세스 기준이라 uvicorn 워커는 반드시 1개.

## 로컬 테스트 (모델 호출 없음, 생성 25개 + 검색 64개 + 관계도 44개)

윈도우 PowerShell:

```powershell
cd ai
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements-test.txt
$env:PYTHONPATH = ".."
cd tests;           python -m unittest discover -s . -v
cd ..\tests_search; python -m unittest discover -s . -v
cd ..\tests_relations; python -m unittest discover -s . -v
cd ..; Remove-Item Env:PYTHONPATH
```

## 로컬에서 서버 띄우기

`ai/.env`에 `INTERNAL_API_KEY`, `OPENAI_API_KEY`, `AI_MODEL`, `AI_ENABLE_V2_ANALYSES=true`, `AI_ENABLE_SEARCH=true`, `AI_ENABLE_RELATIONS=true`를 넣고 도커로 띄운다 (PowerShell):

```powershell
cd ai
docker build -t capstone-ai .
docker run --rm -p 8000:8000 --env-file .env -e AI_DATA_DIR=/data -v capstone-ai-data:/data capstone-ai
```

백엔드 `.env`는 `AI_SERVER_URL=http://127.0.0.1:8000`, `INTERNAL_API_KEY`를 같은 값으로, `AI_SEARCH_ENABLED=true`, `AI_RELATIONS_ENABLED=true`. `POST /v2/analyses`, 검색, 관계도 첫 계산(임베딩)은 모델 호출 비용이 든다.
