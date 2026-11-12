# ---------- 1단계: 빌드 ----------
# Playwright(Chromium)가 Alpine(musl)을 지원하지 않아서 실행 단계를 Debian(bookworm-slim)으로 바꾸고,
# bcrypt 같은 네이티브 모듈이 실행 환경과 맞도록 빌드 단계도 같은 이미지를 쓴다
FROM node:22-bookworm-slim AS build
WORKDIR /app

# 의존성 먼저 설치 (package*.json·prisma가 안 바뀌면 캐시 재사용)
# postinstall에서 prisma generate가 돌기 때문에 prisma 폴더와 설정 파일도 같이 복사
# (tsconfig.json이 없으면 생성된 클라이언트의 import가 .ts로 만들어져 실행 시 에러가 나므로 같이 복사)
# prisma.config.ts가 DATABASE_URL을 요구하므로 generate용 가짜 값을 넣음 (DB에 접속하지 않음)
COPY package*.json prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
RUN DATABASE_URL="mysql://build:build@localhost:3306/build" npm ci

# 소스 복사 후 TypeScript 빌드 (src/generated/prisma도 같이 dist로 컴파일됨)
COPY src ./src
RUN npm run build

# 실행에 필요 없는 devDependencies 제거
RUN npm prune --omit=dev && npm cache clean --force


# ---------- 2단계: 실행 ----------
FROM node:22-bookworm-slim
WORKDIR /app

# 공유 대화 수집 모듈(collector/)용 Python + Playwright + Chromium(headless shell)
#  - Python 패키지는 /opt/venv에 설치하고 PATH에 넣어서 Node가 python3로 바로 실행한다
#  - 브라우저는 node 사용자도 읽을 수 있는 /ms-playwright에 설치한다
#  - libatomic1: Playwright가 내부에서 쓰는 Node 실행 파일(driver/node)이 필요로 함 (slim 이미지에 없음)
#  - requirements.txt만 먼저 복사해서, 수집 모듈 코드만 바뀌면 이 층은 캐시를 재사용한다
ENV VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY collector/requirements.txt /tmp/collector-requirements.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv libatomic1 \
 && python3 -m venv /opt/venv \
 && pip install --no-cache-dir -r /tmp/collector-requirements.txt \
 && playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /tmp/collector-requirements.txt
# 로그 시각을 한국 시간으로, 로그 파일은 /var/log/backend에 (EC2 디렉터리를 볼륨으로 연결)
ENV NODE_ENV=production TZ=Asia/Seoul LOG_DIR=/var/log/backend
RUN mkdir -p /var/log/backend && chown node:node /var/log/backend

# 빌드 단계에서 필요한 것만 가져오기
# prisma 폴더·prisma.config.ts는 컨테이너 시작 시 migrate deploy에 사용
COPY --from=build /app/package*.json /app/prisma.config.ts ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY collector/*.py ./collector/

USER node
EXPOSE 3000

# 컨테이너가 뜰 때마다 아직 적용 안 된 마이그레이션을 적용한 뒤 서버 실행
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/server.js"]