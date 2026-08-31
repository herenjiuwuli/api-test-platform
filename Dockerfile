# API 自动化测试平台 · 多阶段构建
# 说明：本项目用 Node 22 内置 node:sqlite（状态库），需持久化 /app/data 卷。
#       前端在 build 阶段用 Vite 构建为 web/dist，运行时由 Fastify 同源托管（单端口）。

# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
# 后端依赖
COPY package.json ./
RUN npm install
# 源码 + 前端
COPY . .
# 前端依赖 + 构建
RUN npm --prefix web install && npm --prefix web run build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
# 复制构建产物（含 web/dist）
COPY --from=build /app /app
# 仅保留后端生产依赖（去掉 concurrently / vitest 等 devDeps）
RUN npm prune --omit=dev
EXPOSE 3001
# 数据库持久化目录（部署时务必挂卷，否则重启数据丢失）
VOLUME ["/app/data"]
CMD ["node", "index.js"]
