# API 自动化测试平台

> 面向全栈 / 测试运维岗位的简历项目。**M1–M6 全部完成**：存用例 → 手动/定时跑 → JSONPath 断言 → 出报告 → 账号鉴权 → 单端口部署。
> 背景：实习每天手动点接口验证采集脚本，于是造一个能「存用例 → 手动/定时跑 → 出报告 → 账号体系 → 一键部署」的自用测试工具。

## 技术栈

- 后端：**Fastify 5** + **Node 22 内置 SQLite（`node:sqlite`，零原生依赖）** + **node-cron** + **手写鉴权（scrypt 密码哈希 + HS256 JWT，零第三方库）**
- 前端：**Vue3 + Vite + Element Plus** + vue-router + axios（`web/` 子目录）
- 测试：**Vitest**

## 当前能力（M1–M8）

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
- 用例模型：`name / method / url / headers / body / bodyType(json|raw|form-data) / files / expected(status, contains, maxTimeMs, jsonChecks)`
- 执行引擎 `runCase`：发请求 → 按 expected 断言 → 返回 `{pass, status, durationMs, detail, bodyPreview}`
- **JSONPath 断言（自写求值器，未用第三方库）**：`expected.jsonChecks` = `[{path, op, value}]`，支持 `$.a.b / $.arr[0] / $.arr[*] / .length` 路径 + `eq / ne / gt / gte / lt / lte / contains / exists` 操作符
- **定时任务（node-cron）**：用例 + cron 表达式 → 到点自动执行并落执行记录；可启停/删除，重启自动恢复
- **报告**：`/api/reports/summary` 聚合（总用例/总执行/通过率/按用例统计/**按分组统计**/按运行环境统计/最近记录）
- HTTP 接口：
  - `GET /health`
  - `POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/change-password`
  - `/*`（生产）托管前端 `web/dist`（仅构建后存在时注册，SPA 路由回退 index.html）
  - `GET /api/cases`、`POST /api/cases`、`GET /api/cases/:id`、`PUT /api/cases/:id`、`DELETE /api/cases/:id`
  - `POST /api/cases/:id/run`（单条运行）、`POST /api/run-all`（全部运行汇总；支持 body 过滤：`prefix` 按名前缀 / `group` 按分组标签 / `ids` 显式指定）
  - `GET /api/meta/body-options`（请求体类型 + 内置夹具清单，M8）
  - `GET /api/environments`、`POST /api/environments`、`PUT /api/environments/active`、`PUT /api/environments/:id`、`DELETE /api/environments/:id`（环境变量集，M9）
  - `GET /api/suite/export`（导成套件 JSON，直接下载）、`POST /api/suite/import?onConflict=rename|overwrite|skip`（导入套件，M11）
  - `GET /api/schedules`、`POST /api/schedules`、`PUT /api/schedules/:id`、`DELETE /api/schedules/:id`
  - `GET /api/runs?caseId=&limit=`、`GET /api/reports/summary`
- 前端（`web/`）：登录页 + 用例列表（CRUD/单条运行/全部运行/**按分组筛选·运行**/套件导出·导入 + 分组标签）+ **请求编辑器**（方法/URL/请求头/请求体/状态码·包含·耗时·**JSONPath 断言**/**分组**编辑）+ 运行结果弹窗 + **报告页**（统计卡片/按用例汇总/**按分组汇总**/按运行环境汇总/执行明细/**定时任务管理**）
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
npm test           # vitest 139 例全绿（全离线）
cd web && npm run build   # 前端产物 web/dist
```

测穿配套的被测系统（闭环）：

```bash
npm run seed:oa    # 写入 52 条 office-oa 用例（用例链：登录抽 token → 建单抽 id → 审批 → 登出作废 + 附件边界面 + 附件全生命周期 + 站内通知）
                   # 同时定义并选中「当前环境」（地址取 OA_BASE，默认 http://127.0.0.1:3200）
npm run test:oa    # 让平台去打当前环境指向的 office-oa（会先把环境打印出来）
                   # 等价于 POST /api/run-all {"prefix":"OA-"}；任一条失败即以非 0 退出，可挂 CI
```

> ⭐ 这条闭环（含六个真实发现：旧进程陷阱 / 断言引擎多匹配语义坑 / 成对断言 / **执行器只发 JSON 的能力边界 → 已在 M8 补掉** / **变量缺失提示被异常分支吃掉** / **会撒谎的环境徽标**）见 [`docs/测穿-office-oa-闭环.md`](docs/测穿-office-oa-闭环.md)。

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

## 请求体类型与文件上传（M8）

做 M7 那轮闭环时撞到一条边界：执行引擎是 `JSON.stringify(body)`，**发不出 `multipart/form-data`** ——
「上传一个文件」这件事平台根本做不到。M8 把这条边界补在代码里（而不是停在文档里）：

| 能力 | 用法 |
|---|---|
| 请求体类型 | 用例加 `bodyType`：`json`（默认）/ `raw`（原样发字符串）/ `form-data` |
| 文件字段 | `form-data` 时加 `files: [{"name":"file","fixture":"png"}]`，也支持内联 `base64` + 自定义 `filename` / `contentType` |
| **执行器接管头部** | `form-data` 时 `Content-Type`（带 boundary）与 `Content-Length` 由执行器覆盖 —— 手填的那个会被改掉，boundary 不可能填对 |
| 内置夹具 | `GET /api/meta/body-options` 返回夹具清单（**唯一事实来源在后端**，前端不硬编码），编辑器里的下拉直接读它 |

设计取舍：

- **multipart 包体手搓，不引第三方库**（`src/multipart.js`）：boundary 生成、CRLF、结尾 `--`、二进制安全、
  文件名字段的引号转义与换行清洗都是自己写的 —— 与本项目「除 Fastify 系不引库」一致。
- **夹具内置在代码里**（`src/fixtures.js`，PNG / PDF / 伪装 exe），不让用户传一个文件当夹具：
  自动化要的是**可重复** —— 每次跑发一模一样的字节，`size == 41` 这种断言才站得住。
  字节内容刻意与 office-oa 的测试夹具一致。
- **夹具名写错当场报错**，不静默发一个空文件：那会让人以为「被测系统的上传接口有 bug」。
- **`files` 也走变量渲染**：文件名可以是 `{{var}}`。

## 环境变量集（M9）

原来被测地址只有 `BASE` 一个环境变量，而且是**写用例时就被拼进 URL** 的 ——
`seed-oa-suite.mjs` 把 `http://127.0.0.1:3200` 烤进了 44 条用例的 url，想换个环境就得重写整套用例。
M9 把它挪出来：

| 能力 | 用法 |
|---|---|
| 环境 | `{ name, baseUrl, headers, vars }`，如 `office-oa（本地）→ http://127.0.0.1:3200` |
| 用例引用 | URL 写 `{{base}}/api/xxx`（`base` 由环境地址派生），其余变量写 `{{自定义名}}` |
| 当前环境 | `PUT /api/environments/active {id}`；页头有徽标，**一眼看到这次在打谁** |
| 默认请求头 | 环境级 headers 会加到每个请求上（如灰度标 `X-Env`） |

设计取舍：

- **同一时刻只有一个当前环境**，存在 `settings` 表的一行 `active_env_id` 里，
  而不是在 `environments` 上加 `is_active` 列 —— 后者迟早会出现「两行都是 active」这种无法自证的状态。
- **优先级：环境变量是基线，链上 `extract` 抽到的值优先。** 环境是「你去哪」，extract 是本次链上刚发生的事实
  （比如刚登录拿到的 token）；基线盖掉事实，等于用过期 token 假装通过。
- **优先级：环境 headers 是默认值，用例里手写的同名 header 优先**（名字大小写不敏感 ——
  否则请求里会同时出现 `Content-Type` 和 `content-type`）。
- **`baseUrl` 保存时就归一化**：去尾部斜杠（否则 `{{base}}/api` 会变成 `//api`）+ 必须 `http(s)://`
  —— 把「地址写错」拦在保存时，而不是等到跑用例时给一句看不懂的 `fetch failed`。
- **变量名不许叫 `base`**：两个来源会打架，直接 400 说清楚，不静默忽略。
- **删掉正在使用的环境不报错**，而是把当前环境清空并返回 `activeCleared`（拒绝删除会让人卡住）；
  界面同时提示「当前没有选中环境」。
- 三条运行路径（单跑 / run-all / 定时任务）都走 `runner.runCase`，所以环境只在**一处**生效，不会出现
  「手动跑用环境、定时跑不用」这种事。

## 执行记录里的环境快照（M10）

M9 把「打谁」变成了**可变的**，于是立刻冒出个新问题：报告里只有通过率，**答不出这次跑在哪个环境**。
在地址固定写死的年代这不是问题（只有一个地址），地址一变可配，**每一条不写清「当时用的是哪个值」的历史记录，都变得不可解释**。

修法就一句：`runs` 表**存快照**，不只是外键。

| 列 | 说明 |
|---|---|
| `env_id` | 外键（方便以后做「只看某个环境的历史」的跳转） |
| `env_name` / `base_url` | **执行当时**的名字与地址快照 |

- **为什么不能只存 `env_id`**：地址改过之后（本地 → 预发），只存外键会让历史记录被**反向改写**成
  「它从没打过的地址」。这与 office-oa 的 `flow_snapshot`（改流程模板不影响在途单据）是同一条教训 ——
  **配置是活的，历史是死的。**
- 报告新增 **「按运行环境汇总」**：分组键是快照（名字 + 地址），所以环境地址改过之后会**自然分成两组**，
  「换个环境就全红」一眼看得出来；混在一起算平均值只会掩盖它。
- **M10 之前的老记录**（没有这三列）归到「(未记录环境)」一组，**不编造**环境名 ——
  升级后第一次打开报告就能看到这一组（本机实测 557 条历史），这本身就是迁移留痕。
- 实际验证：`npm run seed:oa && npm run test:oa` 之后跑 `node scripts/m10-report-env-check.mjs`，
  报告里能读出「office-oa（本地）」→ `http://127.0.0.1:3200`、执行 44 次、通过率 100%。

## 套件导出 / 导入（M11）

M7 之后平台里有了一条 44 条的 office-oa 用例链，但它是**长在这个库里的** —— 想发给别人、想换台机器跑、
想在 CI 上用，都只能重新 seed 一遍。**测试资产要是带不走，它就只是本地状态，不是资产。**

`GET /api/suite/export` 把「用例 + 环境」打成一个 JSON 文件，`POST /api/suite/import` 把它吃回去：

```json
{
  "kind": "api-test-platform-suite",
  "version": 1,
  "exportedAt": "2026-09-17T08:34:50.000Z",
  "counts": { "environments": 1, "cases": 44, "fixtureBase64Chars": 0 },
  "environments": [{ "name": "office-oa（本地）", "baseUrl": "http://127.0.0.1:3200", "headers": {}, "vars": {} }],
  "cases": [{ "name": "OA-01 登录", "method": "POST", "url": "{{base}}/api/auth/login" }]
}
```

三个要想清楚的点：

| 设计 | 为什么这么做 |
|---|---|
| **不带 id** | id 是本地自增的，换一个库就指向别的东西；带过去只会让「按顺序串链」错位 |
| **用例顺序 = 串链顺序** | 用例链靠「前一条抽变量、后一条用变量」串起来（M7）。导出时显式按 id **升序**排 —— `listCases()` 本来是**倒序**的（列表页要新在前），直接导出会让导入后的链条**静默断掉** |
| **敏感请求头脱敏** | 导出文件天生是要被分享的（发同事 / 进仓库 / 贴 issue），`Authorization`、`Cookie` 这类头的**值**抹成空串、**键名保留** + 在文件里列出被抹的头名。但判据是「键名敏感 **且** 值是字面量」——`X-Token: {{token}}` 是**变量引用**，抹了只会断链、并不会更安全 |

导入的冲突策略由 `?onConflict=` 决定，默认 **`rename`**：

| 策略 | 行为 |
|---|---|
| `rename`（默认） | 两个都留，新的加 `(2)` 后缀 —— 既不悄悄丢你的，也不悄悄盖你的 |
| `overwrite` | 用文件里的覆盖同名的 |
| `skip` | 同名的一律不动 |

还有两条健壮性约定：

- **坏文件 400，坏条目继续**：`kind` 不对 / 版本过高 → 400 说清原因；文件里单条用例缺 `url` →
  记进 `result.failed` 并继续导入其余的。一个 51/52 的文件不该因为第 52 条被整份打回。
- **导入结果带 `warnings`**：脱敏留下的空凭据头会被丢掉并明确告知（「导入后请补上真实凭据」），
  而不是写一个空的 `Authorization` 进库 —— 那只会让每个请求在远端吃一个莫名其妙的 401。

实际验证：`node scripts/m11-suite-ui-check.mjs`（19 条 = 接口层 11 + 真机层 8）。
真机层用 CDP 的 `DOM.setFileInputFiles` 把套件文件**真的塞进 file input**，断言弹窗里读出
「1 条用例、1 个环境」的预览、三种策略可选、点「开始导入」后结果区真的出现「导入完成：新增 2」。
跑完自动清场（`M11UI-` 前缀命名空间），库里不留一条脏数据。

## 用例分组（M12）

一个平台里常挂多个被测系统的用例（如 OA 那 52 条），光靠「列表一拉到底」很难管理。`group` 字段给每条用例打一个**业务语义标签**（入口鉴权 / 登录权限 / 审批引擎 / 附件全周期 / 站内通知…），三处受益：

- **列表筛选**：用例列表页可按分组下拉过滤，不必一屏滚完；每条用例带分组标签。
- **按组运行**：`POST /api/run-all {"group":"审批引擎"}` 只跑该主题 —— 和 `prefix`（按名前缀切）、`ids`（显式指定）并存。
  - ⚠️ 单个 group 不一定是「自包含链」：OA 的「审批引擎」依赖前面登录/建单抽出的 token，单独跑会红。分组主要用于**组织 + 报告按组看**，不是替你切链。
- **报告按组看**：`GET /api/reports/summary` 新增 `byGroup`（与既有 `byEnv` 同理：分组是语义标签，历史不被改写）。

落点：`test_cases` 加 `"group"` 列（DEFAULT ''，`group` 是 SQL 保留字故双引号引用）；`createCase` 收 group、`listCases(group?)` 可按组查、`updateCase` 可改、`normalize` 还原；套件导出/导入**保留 group**（M11 协同）；编辑器可填分组；列表页有分组标签 + 筛选 + 「运行该分组」按钮。

实际验证：`node scripts/m12-group-ui-check.mjs`（24 条 = 接口层 12 + 真机层 12），vitest **139 例**（含 7 例分组专用）。
真机层用 CDP **真的在下拉里选中分组**，断言「列表真的只剩这一组」（结果里不含任何 `OA-` 行）、
未选分组时「运行该分组」是禁用的（避免误点成「跑全部」）、点下去后汇总弹窗写明「筛选：分组：X」
且结果表条数 = 组内条数。接口层的负向对照是「`run-all` 传一个查无此组 → `total` 必须是 0」：
如果过滤被忽略，这里会变成「把库里几十条全跑一遍」，`total` 立刻暴露。
收尾除了删用例，还要删掉本次跑出来的**执行记录** —— `deleteCase` 不级联删 `runs`，
只删用例的话，报告里会永远多出一个指向已删除用例的 `用例#id`。
OA 套件 52 条按 8 组打标后跑闭环仍为 **52/52**。

## 里程碑路线

| 里程碑 | 目标 | 状态 |
|---|---|---|
| **M1** | 后端骨架 + 执行引擎 + SQLite + 单测 | ✅ 已完成（9 例） |
| **M2** | 前端请求编辑器 + 手动运行（Vue3 + Element Plus） | ✅ 已完成（12 例） |
| **M3** | 断言(JSONPath) + `node-cron` 定时跑 + 报告 | ✅ 已完成（28 例） |
| **M4** | 登录鉴权（scrypt + 手写 HS256 JWT + 前端登录页/守卫） | ✅ 已完成（37 例） |
| **M5** | 单端口部署（Docker / VPS / Railway / Render）+ 修改密码接口 | ✅ 已完成（70 例） |
| **M6** | 演示数据打磨（覆盖全断言类型 + 演示定时任务）+ 项目全讲（教学/作品集文档） | ✅ 已完成 |
| **M7** | **用例链（`{{var}}` + extract + 按创建顺序串链）+ 分组跑 + 测穿 office-oa（36/36，含附件边界面）** | ✅ 已完成（70 例 + OA 36 条） |
| **M8** | **请求体类型（json / raw / form-data）+ 文件夹具上传**：手搓 multipart（不引库）+ 内置夹具 + 编辑器支持 → 附件全生命周期也进平台（OA 44/44） | ✅ 已完成（85 例 + OA 44 条） |
| **M9** | **环境变量集**：用例写 `{{base}}` 而不是写死地址 + 页头当前环境徽标 + 环境级默认请求头 → 换环境不用改用例 | ✅ 已完成（106 例 + OA 44 条） |
| **M10** | **执行记录记住「这次跑在哪个环境」**：`runs` 存环境的**快照**（名字 + 地址）而不只是外键 → 改地址不会改写历史；报告新增「按运行环境汇总」 | ✅ 已完成（113 例 + OA 44 条） |
| **M11** | **套件导出 / 导入**：把「用例 + 环境」打成一个能带走的 JSON（**敏感头的值脱敏、顺序即串链顺序、不带本地 id**），导入支持 rename / overwrite / skip 三种冲突策略，坏条目不影响其余 | ✅ 已完成（132 例 + OA 44 条） |
| **M12** | **用例分组**：`group` 业务标签（列表筛选 / 按组运行 / 报告按组汇总），套件导入导出保留分组，编辑器可填分组 | ✅ 已完成（139 例 + OA 52 条） |

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
src/bodyTypes.js  请求体类型白名单 json / raw / form-data（M8）
src/multipart.js  手搓 multipart/form-data 包体 + 文件字段解析（boundary / CRLF / 二进制安全，M8）
src/fixtures.js   内置文件夹具（PNG / PDF / 伪装 exe），字节写进代码保证可重复（M8）
src/environments.js 环境变量集：{{base}} 来源、当前环境（settings 一行）、环境级默认请求头（M9）
src/suite.js      套件导出/导入：脱敏（只抹字面凭据，保留 {{变量}}）、按串链顺序导出、三种冲突策略（M11）
src/runner.js     用例执行引擎（status/contains/maxTimeMs/jsonChecks 断言 + 变量渲染/抽取 + multipart 组包 + 环境注入）
src/schedules.js  定时任务 CRUD（cron 校验）
src/scheduler.js  node-cron 调度器（注册/启停/恢复）
src/reports.js    执行记录查询 + 报告聚合
seed-oa-suite.mjs office-oa 用例套件（52 条 + 按 A–H 段打 `group` 分组，用例链 + 附件边界面 + 附件全生命周期 + 站内通知；并定义当前环境）— npm run seed:oa
run-oa-suite.mjs  一键跑 OA 套件并打印结果（含「当前环境」提示）— npm run test:oa
scripts/m9-env-ui-check.mjs  真机 Chrome 验证环境变量集界面与页头徽标一致性（零依赖 CDP，13 条断言；跑完不留副作用）
scripts/push-main.sh / retry-push.sh  直连推 GitHub（避开 Git Bash 单行 unset 的引号解析坑）
tests/app.test.js + tests/jsonpath.test.js + tests/auth.test.js + tests/vars.test.js + tests/aiCases.test.js + tests/multipart.test.js + tests/environments.test.js + tests/runEnv.test.js + tests/suite.test.js + tests/group.test.js  共 139 例，全离线
scripts/m10-report-env-check.mjs  跑完闭环后，从报告接口读回「这一轮实际打的是哪个环境」（含快照语义核对）
scripts/m11-suite-ui-check.mjs   套件导出/导入验证（接口层脱敏 + 真机层真的选文件导入；跑完自动清场）
scripts/m12-group-ui-check.mjs   用例分组验证（接口层 + 真机层选分组/按组运行；收尾连执行记录一起清，报告不留孤儿）
scripts/lib/cdp.mjs              真机检查的公共底座（起 Chrome / CDP 客户端 / 页面助手 / 临时账号 token）
Dockerfile / .dockerignore / docker-compose.yml / DEPLOY.md   部署（M5）
web/              Vue3 + Element Plus 前端（构建产物 web/dist 由后端同源托管）
  src/auth.js     前端会话状态（token + reactive session）
  src/views/Login.vue      登录/注册页（M4）
  src/views/CaseList.vue   用例列表 + 运行/汇总结果
  src/views/CaseEditor.vue 请求编辑器（含 JSON 断言编辑）
  src/views/Reports.vue    报告页（统计/明细/定时任务管理）
```
