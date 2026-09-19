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
- 覆盖：**17 个测试文件 / 211 例**（`tests/*.test.js`，按能力见 §1.3）
- 预期：`Test Files 17 passed`、`Tests 211 passed`
- 另有真浏览器用例：Playwright **11 条**（`npm run test:e2e`，需先 `npm --prefix web run build`）—— 它不在 `npm test` 里，见 §2.5

### 1.2 测试隔离机制（重要）

测试**绝不污染**真实 `data/app.db`，原理有两层保险：

1. `vitest.config.js` 配置了 `setupFiles: ['tests/setup.js']`，该文件在**任何测试模块 import 之前**执行 `process.env.DB_PATH = ':memory:'` 与 `process.env.API_AUTH_DISABLED = '1'`。
2. `src/db.js` 的 `DB_PATH` 改为在 `getDb()` 内**惰性解析**（不写成模块顶层 `const`），确保上面的环境变量生效。
3. 鉴权守卫同理：`API_AUTH_DISABLED=1` 时 `authGuard` 直接放行，既有用例无需 token。鉴权能力由 `tests/auth.test.js` **单独**验证（该文件会覆盖开关为 `0`，让守卫真正生效）。

> 历史坑：曾把 `DB_PATH` 写在模块顶层 `const`，导致 import 时路径被快照、`:memory:` 永不生效，测试把用例写进了真实库——表现为「全部运行」出现一堆指向死链 `127.0.0.1:随机端口` 的 `fetch failed`。现已修复并通过 `npm test` 验证不会复现。

### 1.3 测试覆盖点

> 每个文件一条，**文件名为准**（逐文件条数刻意不在这里维护 —— 那是最容易过期的东西）。

| 测试文件 | 验证内容 |
|------|----------|
| `app.test.js` | runner 引擎与 HTTP 层：状态码断言、响应体包含、网络不可达错误、runAll 顺序执行、`/api/cases` 增删查改、缺 url 返回 400 |
| `jsonpath.test.js` | `eq/ne/gt/gte/lt/lte/contains/exists`、数组下标 `$[1]`、通配 `[*]`、嵌套路径、`.length`、非 JSON 响应 |
| `auth.test.js` | 注册（成功/密码过短/重名）、登录（正确/错误密码）、无 token 访问受保护路由 401、带 token 200、`/api/auth/me`、`/health` 免鉴权、改密（旧密码失效）、**非 `/api` 路径免鉴权**（回归：曾误拦导致登录页自身 401） |
| `vars.test.js` | 用例链的模板渲染与 `extract` 抽值、缺变量时的提示 |
| `multipart.test.js` | 请求体类型 json / raw / form-data；手搓 multipart 的 boundary 与二进制安全；执行器接管 `Content-Type` 与 `Content-Length` |
| `environments.test.js` | 环境变量集 CRUD、**同一时刻只有一个当前环境**、环境变量是基线（链上 extract 优先）、环境头是默认值（用例手写头优先） |
| `runEnv.test.js` | 执行记录存环境的**快照**（名字 + 地址）、按运行环境汇总、升级前老记录归到「(未记录环境)」不编造 |
| `suite.test.js` | 套件导出导入：不带本地 id、导出顺序 = 串链顺序、**脱敏判据「键名敏感 且 值是字面量」**、rename/overwrite/skip 冲突策略、坏条目进 `failed[]` 不整份打回 |
| `group.test.js` | `group` 业务标签、列表按组筛选、按组运行、报告按组汇总 |
| `deleteCascade.test.js` | 删用例连带清 `runs` + `schedules`（同事务）、**停掉内存里的 cron**、用例不存在时整笔回滚 |
| `headerAssert.test.js` | 响应头断言（`op` 复用 eq/contains/exists）、头名大小写不敏感、头不存在时判失败、**BOM 必须绕开 `res.text()`**（`fetch` 会静默吃掉） |
| `runnerQuery.test.js` | 链上的 query 参数真的发出去 —— 回归：`test_cases` 曾漏存 query 列 → 用例**入库即丢**、服务器按默认范围回 200、**断言假绿** |
| `schedules.test.js` | 分组定时任务：哨兵 `case_id = 0`、group 优先于单条、空组拒绝、缺参 400、删用例不孤立分组任务、触发层跑整组并落记录 |
| `notifications.test.js` | 三档落通知（success/warn/error）、`notifyOn=failure` 成功静默、500 条保留上限自动裁剪、SSE 广播 / 退订 / 订阅者抛错容错 |
| `webhook.test.js` | 出口地址只放行 http/https、`forwardToWebhook` **永不抛错**、只转 warn/error |
| `seed.test.js` | 自测组种子：**不许出现 `$.1` 方言**、断言维度覆盖齐全、幂等、历史遗留名字（`示例-*` / `健康检查-*`）能被清干净 |
| `aiCases.test.js` | AI 生成用例的 prompt 构造与模型校验，**全程 mock `fetch`**（不花钱、不依赖外网、结果可重复） |

---

### 1.4 一键填充用例（推荐，先看效果）

`npm run seed` 写入 **「自测」分组 13 条用例 + 1 条演示定时任务**（幂等，可反复跑：先按分组清旧、再插，不留孤儿 run）：

- 覆盖 **5 类断言维度**（状态码 / 包含 / 耗时 / JSONPath / **响应头**）+ 鉴权与路由语义（401 先于路由、SPA 兜底、404 而非 405）
- 被测对象是**平台自己**（`/health`、鉴权守卫、SPA 兜底），与 `seed:oa` 写入的 OA 业务用例**刻意分成不同分组** —— 报告页的分组汇总里一眼能区分「测平台自己」和「测 OA」
- 只有名字带 `外网-` 的几条需要联网（JSONPlaceholder / httpbin），其余**离线必绿**
- 演示定时任务：每天 `0 9 * * *`，**默认停用**，在「报告 / 定时」页启用即可看到定时执行

> ⭐ **`seed.js` 是「自测」组的唯一真源**：完整清单看 `seed.js` 的 `demos` 数组。要改用例请改脚本再 `npm run seed`，
> **别在界面上改**（下次 seed 会把界面上的改动覆盖掉）。本手册**刻意不抄一份用例清单** —— 抄一份就是给未来埋一处过期。

> ⚠️ **JSONPath 方言（最容易踩的一个坑）**：本平台**只认方括号下标 `$[1]`，不认点号下标 `$.1`**。
> 写错不会报错 —— 求值**静默返回 0 匹配**，于是断言既不会红、也永远证明不了什么。
> 这条已经固化在两处：一条用例的名字（`外网-数组长度 + 数组下标（正确方言 $[1]）`）+ `tests/seed.test.js` 里「不许出现 `$.1` 方言」的断言。

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

### 2.5 真浏览器用例（Playwright，11 条）

接口层测试**看不见界面**，所以另有一层真浏览器用例：

```bash
npm --prefix web run build   # E2E 打的是构建产物 web/dist，必须先构建
npm run test:e2e             # 11 条；自动起服务、用独立库 data/e2e.db
```

- 用 `channel: 'chrome'` **复用系统已装的 Chrome、不下载浏览器**（省掉几百 MB）
- 独立库 `data/e2e.db` + 确定性种子（含 2 条**离线**必绿/必红用例，断言不依赖外网）
- 覆盖：鉴权路由守卫 / 真实表单登录 / 单条必绿·必红 / 分组筛选与按组运行 / 报告分组维度 / 新建与删除
- 本机若遇到「跑完不退出」的 flaky：`scripts/run-e2e.mjs` 自管服务生命周期（起 → 等 `/health` → 跑 → 杀）+ `e2e/force-exit-reporter.mjs` 看门狗

> ⭐ 这一层上线**首日就抓出自己项目的一个真 bug**：SSE 长连接让无头 Chrome 收尾挂住。
> **接口全绿 ≠ 界面没问题** —— 层次决定你能看见什么层次的缺陷。

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
