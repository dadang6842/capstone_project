# AI 서버 (지식 문서 생성 v1.1 + 지식 문서 검색 v1 + 문서 관계도 v1, FastAPI). 백엔드와 같은 EC2에서 compose로 띄운다
# 밖으로 포트를 열지 않고, 백엔드 컨테이너만 http://ai:8000 으로 부른다
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Asia/Seoul \
    # 모델 호출 기록·결과·검색 색인 SQLite·관계도 상태와 임베딩 캐시가 쌓이는 곳. EC2 디렉터리를 볼륨으로 연결해서 재배포해도 남긴다
    AI_DATA_DIR=/data

WORKDIR /app

# 의존성 먼저 설치 (requirements.txt가 안 바뀌면 캐시 재사용)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY knowledge_generation ./knowledge_generation
COPY knowledge_search ./knowledge_search
COPY knowledge_relations ./knowledge_relations
COPY app.py .

# root가 아닌 사용자로 실행 (uid 1000 = EC2의 /var/lib/capstone-ai 소유자와 맞춤)
RUN useradd --uid 1000 --create-home ai && mkdir -p /data && chown ai:ai /data
USER ai

EXPOSE 8000

# 생성 작업 잠금·검색 색인(SQLite)·관계도 작업 잠금을 한 프로세스 기준으로 쓰는 저장소라 워커는 1개만 둔다
CMD ["uvicorn", "app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]