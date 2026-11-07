FROM all.nxfl.cc/node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm ci --omit=dev --registry=$NPM_REGISTRY --no-audit --no-fund

COPY . .

ARG RELEASE_VERSION=local
ENV RELEASE_VERSION=$RELEASE_VERSION

# 创建日志目录
RUN mkdir -p /app/logs /app/tmp

EXPOSE 5000

CMD ["node", "server.js"]
