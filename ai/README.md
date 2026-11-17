# AI 서버 (지식 문서 생성 v1.1 + 지식 문서 검색 v1)

AI 담당이 준 두 패키지를 그대로 넣었다. 두 패키지 코드는 고치지 않았고, 배포용 `Dockerfile`·`.dockerignore`·`app.py`·이 README만 더했다.
원본 설명은 AI 담당의 README·docs(검색은 API_CONTRACT.md·INTEGRATION.md·VALIDATION.md)를 본다.

- `knowledge_generation/`: 지식 문서 생성. `POST /v2/analyses`. `/analyses`·`/revisions`는 이 패키지에 없다.
- `knowledge_search/`: 채택한 지식 문서 검색. `AI_ENABLE_SEARCH=true`일 때만 `/v2/search-index/sync`, `/v2/searches`, `/v2/searches/continue`, `/v2/searches/page`, `/v2/search-documents/read`가 붙는다.
- `app.py`: 생성 앱을 만들고 `register_search(app)`로 검색 라우터를 붙인다. 검색 켜짐 여부는 `GET /health/search`.
- 모든 경로는 헤더 `X-Internal-Api-Key`(백엔드 `.env`의 `INTERNAL_API_KEY`와 같은 값)가 필요하다 (`/health`, `/health/search` 제외).
- 백엔드는 같은 compose 네트워크에서 `http://ai:8000`으로 부른다. EC2 밖으로 포트를 열지 않는다.
- 환경변수는 EC2의 `~/app/ai.env`에 둔다 (`.env.example` 참고). `AI_DATA_DIR`는 compose가 `/data`로 고정하고, 검색 색인은 `/data/knowledge_search`에 쌓인다.
- 생성 작업 잠금과 검색 색인이 한 프로세스 기준이라 uvicorn 워커는 반드시 1개.

## 로컬 테스트 (모델 호출 없음, 생성 25개 + 검색 64개)

```bash
cd ai
python -m venv .venv && source .venv/bin/activate   # 윈도우: .venv\Scripts\activate
pip install -r requirements-test.txt
cd tests && PYTHONPATH=.. python -m unittest discover -s . -v
cd ../tests_search && PYTHONPATH=.. python -m unittest discover -s . -v
```

## 로컬에서 서버 띄우기

```bash
cd ai
export INTERNAL_API_KEY=로컬키 OPENAI_API_KEY=... AI_MODEL=... AI_ENABLE_V2_ANALYSES=true AI_ENABLE_SEARCH=true
uvicorn app:create_app --factory --port 8000 --workers 1
```

백엔드 `.env`의 `AI_SERVER_URL=http://localhost:8000`, `INTERNAL_API_KEY`를 같은 값으로, `AI_SEARCH_ENABLED=true`로 맞춘다. `POST /v2/analyses`와 검색은 모델 호출 비용이 든다.s
