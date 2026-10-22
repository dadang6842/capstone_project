# ---------- 1단계: 빌드 ----------
FROM node:22-alpine AS build
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
FROM node:22-alpine
WORKDIR /app
# 로그 시각을 한국 시간으로, 로그 파일은 /var/log/backend에 (EC2 디렉터리를 볼륨으로 연결)
ENV NODE_ENV=production TZ=Asia/Seoul LOG_DIR=/var/log/backend
RUN mkdir -p /var/log/backend && chown node:node /var/log/backend

# 빌드 단계에서 필요한 것만 가져오기
# prisma 폴더·prisma.config.ts는 컨테이너 시작 시 migrate deploy에 사용
COPY --from=build /app/package*.json /app/prisma.config.ts ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000

# 컨테이너가 뜰 때마다 아직 적용 안 된 마이그레이션을 적용한 뒤 서버 실행
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/server.js"]