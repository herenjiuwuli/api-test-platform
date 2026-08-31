# API 自动化测试平台 · 测试手册

> 适用版本：M5（Fastify 5 + Node 22 内置 `node:sqlite` + 手写鉴权 + 单端口部署 + Vue3 前端）
> 本文覆盖两类测试：**① 自动化测试套件**（开发者/CI 用）与 **② 平台使用自测**（用平台本身验证功能）。

---

## 0. 环境准备

```bash
node -v          # 需要 Node 22+（用到内置 node:sqlite）
npm install      # 安装 fastify / node-cron / vitest / concurrently
```

> 说明：数据库默认落在 `data/app.db`（已被 `.gitignore` 忽略，属运行时数据，可随时删除重置）。

---

## 1. 自动化测试套件（推荐，最先跑）

### 1.1 运行

```bash
npm test
```

- 框架：vitest（`vitest run`，单次非监听）
- 覆盖：`tests/app.test.js`（19 例）、`tests/jsonpath.test.js`（9 例）、`tests/auth.test.js`（13 例）
- 预期：`Test Files 3 passed`、`Tests 41 passed`

### 1.2 测试隔离机制（重要）

测试**绝不污染**真实 `data/app.db`，原理有两层保险：

1. `vitest.config.js` 配置了 `setupFiles: ['tests/setup.js']`，该文件在**任何测试模块 import 之前**执行 `process.env.DB_PATH = ':memory:'` 与 `process.env.API_AUTH_DISABLED = '1'`。
2. `src/db.js` 的 `DB_PATH` 改为在 `getDb()` 内**惰性解析**（不写成模块顶层 `const`），确保上面的环境变量生效。
3. 鉴权守卫同理：`API_AUTH_DISABLED=1` 时 `authGuard` 直接放行，既有用例无需 token。鉴权能力由 `tests/auth.test.js` **单独**验证（该文件会覆盖开关为 `0`，让守卫真正生效）。

> 历史坑：曾把 `DB_PATH` 写在模块顶层 `const`，导致 import 时路径被快照、`:memory:` 永不生效，测试把用例写进了真实库——表现为「全部运行」出现一堆指向死链 `127.0.0.1:随机端口` 的 `fetch failed`。现已修复并通过 `npm test` 验证不会复现。

### 1.3 测试覆盖点

| 模块 | 验证内容 |
|------|----------|
| runner 引擎 | 状态码断言、响应体包含、网络不可达错误、runAll 顺序执行 |
| JSONPath 断言（M3） | `eq/ne/gt/gte/lt/lte/contains/exists`、数组下标、通配 `[*]`、嵌套路径、非 JSON 响应 |
| 用例 CRUD | 新建→查询→更新→删除闭环、部分更新保持原值、缺字段报错、404 |
| HTTP 层 | `/health`、`/api/cases` 增删查改、`/api/run-all` 汇总、缺 url 返回 400 |
| 定时任务（M3） | schedules 增删改查、非法 cron 返回 400、报告汇总、scheduler 注册/停用/校验 |
| 鉴权（M4） | 注册（成功/密码过短/重名）、登录（正确/错误密码）、无 token 访问受保护路由 401、带 token 200、`/api/auth/me`、`/health` 免鉴权 |
| 改密（M5） | 修改密码（无 token 401 / 原密码错误 400 / 成功后旧密码失效且新密码可用） |
| 守卫边界（M5） | 非 `/api` 路径（前端页面/静态资源）免鉴权——回归测试：曾误拦导致部署后登录页自身 401 |

---

## 1.4 一键填充示例用例（推荐，先看效果）

不想自己录用例？`npm run seed` 会写入 5 条示例用例 + 1 条演示定时任务（幂等，可反复跑），覆盖平台所有断言维度：

| 示例用例 | 目标 | 断言 |
|---------|------|------|
| 示例-平台自检(/health) | `http://localhost:3001/health` | 状态码 200 + 包含 `ok` + `$.ok eq true`（**离线必绿**） |
| 示例-GET+JSONPath(JSONPlaceholder) | `https://jsonplaceholder.typicode.com/todos/1` | 状态码 200 + `$.id eq 1` + `$.completed eq false` + `$.userId eq 1` |
| 示例-数组断言(JSONPlaceholder/users) | `https://jsonplaceholder.typicode.com/users` | 状态码 200 + `$.length gte 5` + `$.1.name exists` |
| 示例-POST+请求体(httpbin) | `https://httpbin.org/post` | 状态码 200 + `$.json.title contains apitest` + `$.json.done eq false` |
| 示例-性能断言(httpbin/get) | `https://httpbin.org/get` | 状态码 200 + `maxTimeMs 5000` |

> 演示定时任务：每天 `0 9 * * *` 自动跑「JSONPath 示例」用例，**默认停用**，在「报告 / 定时」页启用即可看到定时执行。
> 第 1 条指向本平台自身，离线也必绿；后四条是真实公开接口，需联网。填好后点「全部运行」即可看到绿油油的汇总，适合截图/演示。

## 2. 平台使用自测（端到端，验证真实功能）

### 2.1 启动

```bash
npm run dev        # 后端 :3001 + 前端 :5173 同时起（concurrently）
# 或仅后端： npm start        （端口 3001，会顺带恢复启用的定时任务）
# 或仅前端： npm --prefix web run dev
```

打开前端 `http://localhost:5173`，后端 API 在 `http://localhost:3001`。

> **M4 鉴权**：打开前端会先跳到登录页。**默认管理员 `admin / admin123`**（首次启动自动创建，库里已有用户后不再创建）。也可用登录页「注册并登录」新建账号。未带 `Authorization: Bearer <token>` 调 `/api/*` 会返回 401。
> 生产部署务必设 `JWT_SECRET`（默认 `dev-secret-change-me`），否则 token 可被伪造。

### 2.2 用平台本身做冒烟自测（推荐用例）

把下面这个用例加进平台，它打的是平台自己的 `/health`，**永远可达**，适合当冒烟用例：

| 字段 | 值 |
|------|-----|
| name | 自检-health |
| method | GET |
| url | `http://localhost:3001/health` |
| 断言-状态码 | 200 |
| 断言-包含 | `ok` |
| JSONPath 断言 | `$.ok` `eq` `true` |

预期：单跑 → `pass: true, status: 200`。

### 2.3 功能自检清单

逐项点一遍，全部应正常：

- [ ] **新建用例**：填 name/url 必填，其余可选；缺 url 前端/后端都应拦截。
- [ ] **单跑**：点某用例「运行」→ 返回状态码、耗时、断言明细。
- [ ] **全部运行**：点「全部运行」→ 返回 `{ total, passed, failed, results }`，无 `fetch failed`（除非用例 URL 真不可达）。
- [ ] **JSONPath 断言**：用 2.2 的用例验证 `$.ok eq true` 通过；改 `value:false` 应判定失败并给出「实际 true」明细。
- [ ] **定时任务**：新建一条 `*/5 * * * *` 的定时，列表出现且 `enabled=1`；改 cron 为 `nope` 应报 400；删除后列表消失。
- [ ] **报告**：跑过几次后打开「报告」页，`/api/reports/summary` 返回 `totalCases / totalRuns / passRate / byCase`，数据与实际一致。
- [ ] **运行时长**：报告里能看到每次运行的 `durationMs`。
- [ ] **登录鉴权（M4）**：未登录访问前端跳 `/login`；用 `admin/admin123` 登录后进入列表；点右上角「退出」再访问受保护页会回登录页。直接 `curl` 不带 token 调 `/api/cases` 返回 401，带 token 返回 200。
- [ ] **修改密码（M5）**：右上角用户名下拉「修改密码」→ 填原密码 + 新密码（≥6 位，两次一致）→ 确定后自动退出回登录页；用新密码可登录、旧密码登录失败。
- [ ] **单端口部署（M5）**：`npm --prefix web run build` 后 `npm start`，浏览器直接访问 `http://localhost:3001` 即可打开整个前端（无需开 :5173），刷新 `/reports` 等前端路由不 404。

### 2.4 命令行快速验证（无需开前端）

```bash
# 后端已在 :3001 运行时
# 1) 先登录拿 token
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).token))")

# 2) 带 token 调受保护接口
curl -X POST http://localhost:3001/api/cases \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"自检-health","method":"GET","url":"http://localhost:3001/health","expected":{"status":200,"contains":"ok","jsonChecks":[{"path":"$.ok","op":"eq","value":true}]}}'

curl -X POST http://localhost:3001/api/run-all -H "Authorization: Bearer $TOKEN"   # 全部运行汇总
curl http://localhost:3001/api/reports/summary -H "Authorization: Bearer $TOKEN"   # 报告汇总

# 3) 不带 token 应 401
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/api/cases
```

---

## 3. 重置 / 清理

库是普通的 SQLite 文件，遇到脏数据直接删文件即可（服务未运行时删最安全）：

```bash
# 停止服务后
rm -f data/app.db
# 重启会自动建表（空库）
```

> 跑自动化测试（`npm test`）用的是 `:memory:`，完全不影响 `data/app.db`，可随时放心运行。

---

## 4. 已知边界 / 排错

- **只支持 GET/POST 等标准 HTTP 方法**；`fetch` 不支持的协议（如 ftp）会 `fetch failed`。
- **`fetch failed` 几乎都是用例 URL 不可达**（端口没开、域名拼错、目标服务未启动）。自查：在浏览器/Postman 先能访问该 URL，再填进用例。
- **`maxTimeMs` 超时断言**：目标响应慢于阈值即判失败，调大阈值或优化目标接口。
- **定时任务进程内生效**：`startScheduler()` 仅在 `node index.js` 直接运行时启动；`npm test` 不启动，保证测试隔离。
- 所有接口返回 JSON；状态码约定：201 新建成功、400 参数错误、404 资源不存在。
