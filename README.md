# API 自动化测试平台

> 面向全栈 / 测试运维岗位的简历项目。**M1–M6 全部完成**：存用例 → 手动/定时跑 → JSONPath 断言 → 出报告 → 账号鉴权 → 单端口部署。
> 背景：实习每天手动点接口验证采集脚本，于是造一个能「存用例 → 手动/定时跑 → 出报告 → 账号体系 → 一键部署」的自用测试工具。

## 技术栈

- 后端：**Fastify 5** + **Node 22 内置 SQLite（`node:sqlite`，零原生依赖）** + **node-cron** + **手写鉴权（scrypt 密码哈希 + HS256 JWT，零第三方库）**
- 前端：**Vue3 + Vite + Element Plus** + vue-router + axios（`web/` 子目录）
- 测试：**Vitest**

## 当前能力（M1–M6）

- **鉴权（M4，零依赖实现）**：
  - 密码哈希：Node 内置 `crypto.scrypt`（加盐 + `timingSafeEqual` 防时序攻击）
  - Token：手写 **HS256 JWT**（`header.payload.signature` base64url 编码），不引 `jsonwebtoken`
  - 全局 `onRequest` 守卫：除 `/health`、`/api/auth/login`、`/api/auth/register` 外，所有 `/api` 路由必须带 `Authorization: Bearer <token>`，否则 401
  - 首次启动（`initDefaultUser`）若库里无用户则自动种入默认管理员 `admin / admin123`
  - 前端：登录页 + 路由守卫（未登录跳 `/login`）+ axios 拦截器自动带 token / 401 清退 + 退出按钮
  - 修改密码（M5）：`POST /api/auth/change-password`（需登录），校验原密码后更新哈希；前端右上角用户菜单内弹窗，改完自动重新登录
- **部署（M5，单端口）**：
  - 前端 `web/dist` 构建后由 Fastify **同源托管**（`/*` 静态路由 + SPA 回退），部署只需一个端口（默认 3001），无跨域
  - 提供 `Dockerfile` + `docker-compose.yml` + `DEPLOY.md`（Docker / VPS / Railway / Render），含 Vercel 不适用说明（SQLite 有状态，需持久卷）
  - 数据持久化在 `data/app.db`，容器/主机挂卷即可重启不丢
- 用例模型：`name / method / url / headers / body / expected(status, contains, maxTimeMs, jsonChecks)`
- 执行引擎 `runCase`：发请求 → 按 expected 断言 → 返回 `{pass, status, durationMs, detail, bodyPreview}`
- **JSONPath 断言（自写求值器，未用第三方库）**：`expected.jsonChecks` = `[{path, op, value}]`，支持 `$.a.b / $.arr[0] / $.arr[*] / .length` 路径 + `eq / ne / gt / gte / lt / lte / contains / exists` 操作符
- **定时任务（node-cron）**：用例 + cron 表达式 → 到点自动执行并落执行记录；可启停/删除，重启自动恢复
- **报告**：`/api/reports/summary` 聚合（总用例/总执行/通过率/按用例统计/最近记录）
- HTTP 接口：
  - `GET /health`
  - `POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/change-password`
  - `/*`（生产）托管前端 `web/dist`（仅构建后存在时注册，SPA 路由回退 index.html）
  - `GET /api/cases`、`POST /api/cases`、`GET /api/cases/:id`、`PUT /api/cases/:id`、`DELETE /api/cases/:id`
  - `POST /api/cases/:id/run`（单条运行）、`POST /api/run-all`（全部运行汇总）
  - `GET /api/schedules`、`POST /api/schedules`、`PUT /api/schedules/:id`、`DELETE /api/schedules/:id`
  - `GET /api/runs?caseId=&limit=`、`GET /api/reports/summary`
- 前端（`web/`）：登录页 + 用例列表（CRUD/单条运行/全部运行）+ **请求编辑器**（方法/URL/请求头/请求体/状态码·包含·耗时·**JSONPath 断言**编辑）+ 运行结果弹窗 + **报告页**（统计卡片/按用例汇总/执行明细/**定时任务管理**）
- 数据持久化：用例 `test_cases`、执行记录 `runs`、定时任务 `schedules`、用户 `users`

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
npm run seed       # 写入 5 条示例用例（覆盖全断言类型）+ 1 条演示定时任务，首次打开就有东西可跑
npm test           # vitest 70 例全绿（全离线）
cd web && npm run build   # 前端产物 web/dist
```

测穿配套的被测系统（闭环）：

```bash
npm run seed:oa    # 写入 29 条 office-oa 用例（用例链：登录抽 token → 建单抽 id → 审批 → 登出作废）
npm run test:oa    # 让平台去打 office-oa（OA 需先在 3200 用当前代码起进程）
                   # 等价于 POST /api/run-all {"prefix":"OA-"}；任一条失败即以非 0 退出，可挂 CI
```

> ⭐ 这条闭环（含三个真实发现：旧进程陷阱 / 断言引擎多匹配语义坑 / 成对断言）见 [`docs/测穿-office-oa-闭环.md`](docs/测穿-office-oa-闭环.md)。

## 鉴权说明（M4）

- **默认账号**：服务首次启动（库里无用户时）自动创建 `admin / admin123`，请尽快在右上角「修改密码」改掉。
- **生产部署务必设置环境变量**：`JWT_SECRET`（签名密钥，默认 `dev-secret-change-me`）、`JWT_TTL_SEC`（token 有效期秒，默认 86400）、`DB_PATH`（数据库路径）。
- 测试旁路：`process.env.API_AUTH_DISABLED=1` 时关闭全局守卫，便于既有用例无需 token 即可跑（见 `tests/setup.js`）。

## 用例链（M7）

平台原本只能测公开接口 —— 因为执行引擎一次只发一个请求，**登录拿到的 token 传不到下一个用例**。
补上「用例链」之后，才谈得上测一个真系统：

| 能力 | 用法 |
|---|---|
| 变量占位 | url / headers / body 里写 `{{token}}`，运行前替换成变量袋里的值 |
| 响应抽变量 | 用例加 `extract: [{"name":"token","path":"$.token"}]`，从**本用例响应**按 JSONPath 抽值写回变量袋 |
| 顺序 | `POST /api/run-all` 按**创建顺序**（id 升序）串链 —— 界面列表是倒序，链必须翻过来 |
| 分组 | `POST /api/run-all {"prefix":"OA-"}` 只跑一组，不把别组的失败算进来 |

设计取舍：**变量袋只在内存、不落库**（token 不该进库，也不该跨运行复用 —— 否则会拿过期 token 假装通过）；
变量缺失**不判失败**，只在 detail 里写明「未赋值变量：{{token}}」，因为请求本身也会失败，两处都报会让人分不清真正原因。

## 里程碑路线

| 里程碑 | 目标 | 状态 |
|---|---|---|
| **M1** | 后端骨架 + 执行引擎 + SQLite + 单测 | ✅ 已完成（9 例） |
| **M2** | 前端请求编辑器 + 手动运行（Vue3 + Element Plus） | ✅ 已完成（12 例） |
| **M3** | 断言(JSONPath) + `node-cron` 定时跑 + 报告 | ✅ 已完成（28 例） |
| **M4** | 登录鉴权（scrypt + 手写 HS256 JWT + 前端登录页/守卫） | ✅ 已完成（37 例） |
| **M5** | 单端口部署（Docker / VPS / Railway / Render）+ 修改密码接口 | ✅ 已完成（70 例） |
| **M6** | 演示数据打磨（覆盖全断言类型 + 演示定时任务）+ 项目全讲（教学/作品集文档） | ✅ 已完成 |
| **M7** | **用例链（`{{var}}` + extract + 按创建顺序串链）+ 分组跑 + 测穿 office-oa（29/29）** | ✅ 已完成（70 例 + OA 29 条） |

> 📖 想看项目讲解 / 面试话术 / 踩坑复盘？见 [`docs/项目全讲.md`](docs/项目全讲.md)。
> 🔗 闭环记录：见 [`docs/测穿-office-oa-闭环.md`](docs/测穿-office-oa-闭环.md)。

## 目录

```
index.js          Fastify 应用 + 路由（含 auth/schedules/runs/reports）+ onRequest 鉴权守卫 + 生产静态托管
src/db.js         SQLite 封装（test_cases / runs / schedules / users）+ 幂等迁移（新列自动补）
src/auth.js       鉴权核心：scrypt 密码哈希 + 手写 HS256 JWT（signToken/verifyToken）
src/users.js      用户服务：createUser/verifyLogin/initDefaultUser/changePassword
src/cases.js      用例 CRUD（含 updateCase 部分更新 + extract 抽取声明）
src/vars.js       用例链：{{var}} 模板渲染 + 按 JSONPath 从响应抽变量（M7）
src/jsonpath.js   自写 JSONPath 求值器（M3 核心之一）
src/runner.js     用例执行引擎（status/contains/maxTimeMs/jsonChecks 断言 + 变量渲染/抽取）
src/schedules.js  定时任务 CRUD（cron 校验）
src/scheduler.js  node-cron 调度器（注册/启停/恢复）
src/reports.js    执行记录查询 + 报告聚合
seed-oa-suite.mjs office-oa 用例套件（29 条，用例链）— npm run seed:oa
run-oa-suite.mjs  一键跑 OA 套件并打印结果 — npm run test:oa
tests/app.test.js + tests/jsonpath.test.js + tests/auth.test.js + tests/vars.test.js + tests/aiCases.test.js  共 70 例，全离线
Dockerfile / .dockerignore / docker-compose.yml / DEPLOY.md   部署（M5）
web/              Vue3 + Element Plus 前端（构建产物 web/dist 由后端同源托管）
  src/auth.js     前端会话状态（token + reactive session）
  src/views/Login.vue      登录/注册页（M4）
  src/views/CaseList.vue   用例列表 + 运行/汇总结果
  src/views/CaseEditor.vue 请求编辑器（含 JSON 断言编辑）
  src/views/Reports.vue    报告页（统计/明细/定时任务管理）
```
