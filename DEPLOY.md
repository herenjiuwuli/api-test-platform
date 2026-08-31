# 部署指南（M5）

本项目是**有状态**服务：后端用 Node 22 内置 `node:sqlite` 存用例 / 运行记录 / 用户，数据落在 `data/app.db`。
因此**不适合纯 Serverless（Vercel 函数、云函数那种临时文件系统）**——SQLite 文件无法持久化、且 `node:sqlite` 在冷启动里也不可靠。
正确姿势是「长驻进程 + 持久卷」：**Docker 容器 / VPS / Railway / Render** 均可。

> 前端在构建后由 Fastify **同源托管**（`web/dist` 存在时自动注册 `/*` 静态路由），
> 所以部署后**只有一个端口**（默认 3001），无需单独部署前端、也无跨域问题。

---

## 方式一：Docker（最推荐，VPS / 任意支持 Docker 的环境）

```bash
# 在仓库根目录
docker compose up -d --build
# 访问 http://<服务器IP>:3001
```

- 默认账号：`admin / admin123`（首次启动自动创建，登录后请在右上角「修改密码」改掉）。
- 数据落在宿主 `./data` 目录（已挂卷），重启不丢。
- 日志：`docker compose logs -f`。

**手动 docker run（不用 compose）：**

```bash
docker build -t api-test-platform .
docker run -d --name api-test-platform \
  -p 3001:3001 \
  -e JWT_SECRET=你自己的长随机字符串 \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  api-test-platform
```

---

## 方式二：Railway / Render（最省心，自带持久卷）

1. 连接 GitHub 仓库（用 `D:\Projects\api-test-platform` 这个目录即可）。
2. 构建命令：留空（自动识别 Dockerfile）或 `npm install && npm --prefix web install && npm --prefix web run build`。
3. 启动命令：`node index.js`。
4. 在平台环境变量里设：
   - `JWT_SECRET`：长随机字符串（**必须**）
   - `PORT`：平台给的端口（Railway/Render 通常注入 `$PORT`，代码已读 `process.env.PORT`）
5. 挂载持久卷到 `/app/data`（Railway 在 Volume 面板加；Render 在 Disk 面板加，挂载点 `/app/data`）。

> 不设持久卷也能跑，但重启会清空数据。

---

## 方式三：裸机 / VPS（Node 直跑 + PM2）

```bash
npm install
cd web && npm install && npm run build && cd ..
cd ..
JWT_SECRET=你自己的长随机字符串 npm start
# 建议用 pm2 守护：npm i -g pm2 && pm2 start index.js --name atp
```

Nginx 反代（可选，套域名 + HTTPS）：

```nginx
location / {
  proxy_pass http://127.0.0.1:3001;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

---

## 方式四：Vercel / 云函数 —— ⚠️ 不建议

| 原因 | 说明 |
|---|---|
| 文件系统只读 | Serverless 实例重启后 `/app/data` 丢失，SQLite 无法持久化 |
| node:sqlite 冷启动 | 内置 SQLite 在临时实例里不稳定，且每次冷启动重新建库 |
| 长驻定时任务 | `node-cron` 调度器依赖常驻进程，Serverless 不适用 |

如果**硬要**上 Vercel，需要把存储换成外部数据库（Postgres/Upstash 等）并重写 `src/db.js`——属于另一套改造，不在 M5 范围。

---

## 环境变量一览

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `JWT_SECRET` | **生产必填** | `dev-secret-change-me` | JWT 签名密钥，默认值是开发占位，**生产不改会被伪造 token** |
| `JWT_TTL_SEC` | 否 | `86400` | token 有效期（秒），默认 24h |
| `PORT` | 否 | `3001` | 监听端口 |
| `DB_PATH` | 否 | `data/app.db` | SQLite 文件路径（容器里用卷挂 `/app/data`） |
| `API_AUTH_DISABLED` | 否 | `0` | 设 `1` 关闭全局鉴权（仅测试 / 本地调试用） |

## 健康检查

`GET /health` 返回 `{"ok":true,"service":"api-test-platform","ts":...}`，可用于容器探针 / 监控。
