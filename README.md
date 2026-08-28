# API 自动化测试平台

> 面向全栈 / 测试运维岗位的简历项目。M2 已完成：后端引擎 + SQLite + Vue3 前端（请求编辑器 + 手动运行）。
> 背景：实习每天手动点接口验证采集脚本，于是造一个能「存用例 → 手动/定时跑 → 出报告」的自用测试工具。

## 技术栈

- 后端：**Fastify 5** + **Node 22 内置 SQLite（`node:sqlite`，零原生依赖）**
- 前端：**Vue3 + Vite + Element Plus** + vue-router + axios（`web/` 子目录）
- 测试：**Vitest**

## 当前能力（M2）

- 用例模型：`name / method / url / headers / body / expected(status, contains, maxTimeMs)`
- 执行引擎 `runCase`：发请求 → 按 expected 断言 → 返回 `{pass, status, durationMs, detail, bodyPreview}`
- HTTP 接口：
  - `GET /health`
  - `GET /api/cases`、`POST /api/cases`、`GET /api/cases/:id`、`PUT /api/cases/:id`、`DELETE /api/cases/:id`
  - `POST /api/cases/:id/run`（单条运行）、`POST /api/run-all`（全部运行汇总）
- 前端（`web/`）：用例列表（表格/新建/编辑/删除/单条运行/全部运行）+ **请求编辑器**（方法/URL/请求头键值对/请求体/断言期望）+ 运行结果弹窗（通过/失败 + 状态码 + 耗时 + 断言明细 + 响应预览）
- 数据持久化：用例存 `test_cases`，执行记录存 `runs`

## 快速开始

```bash
# 安装依赖（根目录后端 + web 前端）
npm install
cd web && npm install && cd ..

# 方式一（推荐）：一键启动，同时拉起前后端
npm run dev        # 后端 http://localhost:3001 + 前端 http://localhost:5173

# 方式二：分开启动
npm start          # 后端 http://localhost:3001
cd web && npm run dev    # 前端 http://localhost:5173（/api 自动代理到 3001）
```

测试与构建：

```bash
npm test           # vitest 12 例全绿（全离线）
cd web && npm run build   # 前端产物 web/dist
```

## 里程碑路线

| 里程碑 | 目标 | 状态 |
|---|---|---|
| **M1** | 后端骨架 + 执行引擎 + SQLite + 单测 | ✅ 已完成（9 例） |
| **M2** | 前端请求编辑器 + 手动运行（Vue3 + Element Plus） | ✅ 已完成（12 例） |
| **M3** | 断言(JSONPath) + `node-cron` 定时跑 + 报告 | ⏳ |
| **M4** | 鉴权 + 部署（Vercel / 云服务器） | ⏳ |
| **M5** | 教学博客（有余力） | ⏳ |

## 目录

```
index.js          Fastify 应用 + 路由
src/db.js         SQLite 封装（表结构）
src/cases.js      用例 CRUD（含 updateCase 部分更新）
src/runner.js     用例执行引擎（平台核心）
tests/app.test.js 冒烟测试（12 例，全离线）
web/              Vue3 + Element Plus 前端
  src/views/CaseList.vue   用例列表 + 运行/汇总结果
  src/views/CaseEditor.vue 请求编辑器（新建/编辑）
```
