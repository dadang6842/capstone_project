# AI 서버 (지식 문서 직접 생성 v1.1)

AI 담당이 준 v1.1 패키지(`knowledge_generation`)를 그대로 넣었다. 코드는 고치지 않았고, 배포용 `Dockerfile`·`.dockerignore`·이 README만 더했다.
원본 설명은 AI 담당의 README·PATCH_NOTES·docs를 본다.

- 경로: `GET /health`, `POST /v2/analyses` (헤더 `X-Internal-Api-Key`). `/analyses`·`/revisions`는 이 패키지에 없다.
- 백엔드는 같은 compose 네트워크에서 `http://ai:8000`으로 부른다. EC2 밖으로 포트를 열지 않는다.
- 환경변수는 EC2의 `~/app/ai.env`에 둔다 (`.env.example` 참고). `AI_DATA_DIR`는 compose가 `/data`로 고정한다.

## 로컬 테스트 (모델 호출 없음, 25개)

```bash
cd ai
python -m venv .venv && source .venv/bin/activate   # 윈도우: .venv\Scripts\activate
pip install -r requirements-test.txt
cd tests && PYTHONPATH=.. python -m unittest discover -s . -v
```

## 로컬에서 서버 띄우기

```bash
cd ai
export INTERNAL_API_KEY=로컬키 OPENAI_API_KEY=... AI_MODEL=... AI_ENABLE_V2_ANALYSES=true
uvicorn knowledge_generation.api:create_app --factory --port 8000
```

백엔드 `.env`의 `AI_SERVER_URL=http://localhost:8000`, `INTERNAL_API_KEY`를 같은 값으로 맞춘다. `POST /v2/analyses`는 모델 호출 비용이 든다.
