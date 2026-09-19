# API 自动化测试平台

> 面向全栈 / 测试运维岗位的简历项目。**M1–M22 已完成**：存用例 → 手动/定时跑 → 多维度断言（状态码/包含/耗时/JSONPath/**响应头**）→ 出报告 → 账号鉴权 → 单端口部署 → 环境变量集 → 套件导出导入 → 用例分组 → 删用例连带清理 → **分组定时任务（一个 cron 跑整组用例）** → **运行通知（定时任务跑完/失败落站内通知，前端铃铛未读角标）** → **通知实时推送（SSE，跑完那一刻角标即时 +1）** → **通知降噪 + 保留策略（成功静默只看失败，日志自动裁剪）** → **失败侧 webhook 外呼（升级到飞书/hermes）** → **平台自己的 Playwright E2E（11 条真浏览器用例）** → **数据自洽：「自测」用例组由 `seed.js` 单一真源幂等维护，并给自己补了种子回归测试**。
> 背景：实习每天手动点接口验证采集脚本，于是造一个能「存用例 → 手动/定时跑 → 出报告 → 账号体系 → 一键部署」的自用测试工具。

## 技术栈

- 后端：**Fastify 5** + **Node 22 内置 SQLite（`node:sqlite`，零原生依赖）** + **node-cron** + **手写鉴权（scrypt 密码哈希 + HS256 JWT，零第三方库）**
- 前端：**Vue3 + Vite + Element Plus** + vue-router + axios（`web/` 子目录）
- 测试：**Vitest**

## 当前能力（M1–M22）

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
- 用例模型：`name / method / url / headers / body / bodyType(json|raw|form-data) / files / group / expected(status, contains, maxTimeMs, jsonChecks, **headers**)`
- 执行引擎 `runCase`：发请求 → 按 expected 断言 → 返回 `{pass, status, durationMs, detail, bodyPreview, extracted, headers, env}`
- **JSONPath 断言（自写求值器，未用第三方库）**：`expected.jsonChecks` = `[{path, op, value}]`，支持 `$.a.b / $.arr[0] / $.arr[*] / .length` 路径 + `eq / ne / gt / gte / lt / lte / contains / exists` 操作符
- **响应头断言（M14）**：`expected.headers` = `[{name, op, value}]`，头名**大小写不敏感**，操作符 `exists / eq / contains`（刻意比 JSON 少 —— 头是单个字符串，没有数值语义，也不给 `ne`：头不存在时「不等于」会变成通过，正好是最容易骗过自己的那种断言）
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
- 前端（`web/`）：登录页 + 用例列表（CRUD/单条运行/全部运行/**按分组筛选·运行**/套件导出·导入 + 分组标签）+ **请求编辑器**（方法/URL/请求头/请求体/状态码·包含·耗时·**JSONPath 断言**·**响应头断言**/**分组**编辑）+ 运行结果弹窗 + **报告页**（统计卡片/按用例汇总/**按分组汇总**/按运行环境汇总/执行明细/**定时任务管理**）
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
npm run seed       # 写入 13 条「自测」用例（覆盖全断言维度，含 4 条打外网）+ 1 条演示定时任务，首次打开就有东西可跑
npm test           # vitest 211 例全绿（全离线）
npm run check:frontend    # 静态扫描：前端未声明标识符 / 模板漏声明 / ref 忘了 .value
npm run check:docs        # 静态扫描：README / docs / CI 里引用的文件必须真的存在
cd web && npm run build   # 前端产物 web/dist（E2E 打的是这份产物，必须先构建）
npm run test:e2e   # Playwright 11 条真浏览器 UI 测试（channel:'chrome' 复用系统 Chrome，不下载浏览器；独立库 data/e2e.db 不污染开发数据）
npm run check:ui:auto     # CDP 真机断言 45 条（m11 套件往返 + m12 分组）：自己起隔离实例、跑完自己收，一条命令即可
npm run verify     # 上面全部串起来跑一遍（五层：静态扫描 → 构建 → vitest → E2E → 真机断言）
```

> ⭐ **`check:ui:auto` 为什么要存在**：m11/m12 这批真机断言以前**既不在 CI 也不在 `verify` 里** ——
> 也就是「提交前一条命令复现全部检查」这句话，对套件往返和分组这两块是不成立的（改了没有 UI 层回归）。
> 缺的就是「有人记得手动跑」：现在它自己备隔离环境（`data/ui-check.db` + 3111 端口，绝不碰你的
> `data/app.db`）、自己起服务、跑完自己收，所以能像 `test:e2e` 一样直接挂进 verify 和 CI。
> 另有 m9/m10（跨系统：要 office-oa 在 3200 且平台里有 `seed:oa` 数据）与 m13（截图导览，产物不进仓库）
> 不在这条命令里 —— 单独 `node scripts/m9-env-ui-check.mjs` 跑。

测穿配套的被测系统（闭环）：

```bash
npm run seed:oa    # 写入 84 条 office-oa 用例（用例链：登录抽 token → 建单抽 id → 审批 → 登出作废 + 附件 + 站内通知 + 导出 + 会议室时段冲突 + 统计/考勤越权）
                   # 同时定义并选中「当前环境」（地址取 OA_BASE，默认 http://127.0.0.1:3200）
npm run test:oa    # 让平台去打当前环境指向的 office-oa（会先把环境打印出来）
                   # 等价于 POST /api/run-all {"prefix":"OA-"}；任一条失败即以非 0 退出，可挂 CI
npm run check:closure:auto   # 上面两条 + m9 + m10 一条命令跑完（自己起隔离平台、跑完自己收）
```

> ⭐ **`check:closure:auto` 为什么单独一条命令**：闭环是这个项目的招牌，但复现它要手工四步 + 一个在跑的
> office-oa；而 m9/m10（24 条真机断言）此前一直不在任何门禁里 —— 与 m11/m12 同一个毛病。
> 它跟 `check:ui:auto` **刻意分开**，因为前置条件不一样：前者只依赖平台自己所以能进 CI，
> 后者**必须有 OA 在跑**（脚本先探一次 `/health`，确认是 office-oa 再往下走；探不到就一次性说清
> 「先把 OA 起来」，而不是跑一半炸在一堆看不懂的红里）。
> 代价是它自己起的是一个**空库**实例：`seed:oa` 的 84 条与当前环境都由它当场造，`data/app.db` 全程不动。

> ⭐ 这条闭环（含九个真实发现：旧进程陷阱 / 断言引擎多匹配语义坑 / 成对断言 / **执行器只发 JSON 的能力边界 → 已在 M8 补掉** / **变量缺失提示被异常分支吃掉** / **会撒谎的环境徽标** / **「配置是活的、历史是死的」** / **只能读响应体的能力边界 → 已在 M14 补掉，顺带撞出 `res.text()` 会吃掉 BOM** / **第三处边界：执行器、表结构、持久化三层里只要漏一层（`test_cases` 没存 query），用例写的 `?scope=` 就入库即丢、断言照样全绿 —— 一个让测试误以为通过的 bug**）见 [`docs/测穿-office-oa-闭环.md`](docs/测穿-office-oa-闭环.md)。

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
  记进 `result.failed` 并继续导入其余的。整份文件不该因为其中一条有问题就被打回。
- **导入结果带 `warnings`**：脱敏留下的空凭据头会被丢掉并明确告知（「导入后请补上真实凭据」），
  而不是写一个空的 `Authorization` 进库 —— 那只会让每个请求在远端吃一个莫名其妙的 401。

实际验证：`node scripts/m11-suite-ui-check.mjs`（19 条 = 接口层 11 + 真机层 8）。
真机层用 CDP 的 `DOM.setFileInputFiles` 把套件文件**真的塞进 file input**，断言弹窗里读出
「1 条用例、1 个环境」的预览、三种策略可选、点「开始导入」后结果区真的出现「导入完成：新增 2」。
跑完自动清场（`M11UI-` 前缀命名空间），库里不留一条脏数据。

## 用例分组（M12）

一个平台里常挂多个被测系统的用例（如 OA 那 84 条），光靠「列表一拉到底」很难管理。`group` 字段给每条用例打一个**业务语义标签**（入口鉴权 / 登录权限 / 审批引擎 / 附件全周期 / 站内通知…），三处受益：

- **列表筛选**：用例列表页可按分组下拉过滤，不必一屏滚完；每条用例带分组标签。
- **按组运行**：`POST /api/run-all {"group":"审批引擎"}` 只跑该主题 —— 和 `prefix`（按名前缀切）、`ids`（显式指定）并存。
  - ⚠️ 单个 group 不一定是「自包含链」：OA 的「审批引擎」依赖前面登录/建单抽出的 token，单独跑会红。分组主要用于**组织 + 报告按组看**，不是替你切链。
- **报告按组看**：`GET /api/reports/summary` 新增 `byGroup`（与既有 `byEnv` 同理：分组是语义标签，历史不被改写）。

落点：`test_cases` 加 `"group"` 列（DEFAULT ''，`group` 是 SQL 保留字故双引号引用）；`createCase` 收 group、`listCases(group?)` 可按组查、`updateCase` 可改、`normalize` 还原；套件导出/导入**保留 group**（M11 协同）；编辑器可填分组；列表页有分组标签 + 筛选 + 「运行该分组」按钮。

实际验证：`node scripts/m12-group-ui-check.mjs`（26 条 = 接口层 12 + 真机层 11 + 收尾 3），vitest 新增 7 例分组测试（`tests/group.test.js`）。
真机层用 CDP **真的在下拉里选中分组**，断言「列表真的只剩这一组」（结果里不含任何 `OA-` 行）、
未选分组时「运行该分组」是禁用的（避免误点成「跑全部」）、点下去后汇总弹窗写明「筛选：分组：X」
且结果表条数 = 组内条数。接口层的负向对照是「`run-all` 传一个查无此组 → `total` 必须是 0」：
如果过滤被忽略，这里会变成「把库里几十条全跑一遍」，`total` 立刻暴露。
收尾除了删用例，还要确认本次跑出来的**执行记录**也被带走了 —— `deleteCase` 在 M13 之后会级联删 `runs`
（不级联的话，报告里会永远多出一个指向已删除用例的 `用例#id`），所以这条断言同时钉住了「级联删除」这个行为。
OA 套件 84 条按 12 组（A 入口鉴权 → L 考勤打卡）打标后跑闭环仍为 **84/84**（实测 `npm run test:oa`）。

> ⭐ **这个脚本可以在空库上独立跑**（`npm run check:ui:auto` 就是这么用它的）：用例、分组、连「当前环境」
> 全部由它自己临时造、跑完自己还原。以前有两条断言不是这样 —— `opts.length >= 2`（指望库里恰好有别的分组）
> 和 `!!runNone.body.env.name`（指望主人已经选中了某个环境）—— 在干净库上必然假红。
> 换个环境就红的断言，测的不是功能，是「主人库里恰好有什么」：**这类隐含依赖只有真的把脚本放进隔离环境才会暴露。**

## 删用例的连带清理（M13）

`runs.case_id` 与 `schedules.case_id` **都不是外键**，所以历史上「删用例」只删掉用例本身，派生数据全留成孤儿：
报告页「按用例汇总」里冒出一堆连名字都没有的 **「用例#id」**，调度器里留着一个指向空用例的任务。
更糟的是 `npm run seed`（示例用例）和 `npm run seed:oa`（OA 套件）**每次都要先删旧用例再插新的**，
于是孤儿一轮轮累积 —— **本机实测积到 791 条**，涉及 433 个已不存在的用例 id。

修法是让「删」这件事在**一处**收口（`deleteCase`，同一事务）：

| 连带删掉 | 为什么 |
|---|---|
| `runs`（执行记录） | 用例没了，它的执行历史也就不可解释 —— 连「跑的是哪条用例」都答不出来，留着只是噪声 |
| `schedules`（定时任务） | 否则留下一个指向不存在用例的定时任务；⚠️ 删库行**不会自动停内存里的 cron**，所以 `deleteCase` 会把 `scheduleIds` 回传给路由，由路由调 `refreshJob({id, enabled:false})` 停掉 |
| 用例本身 | 若用例不存在则**整笔回滚**，不顺手删掉恰好指向这个 id 的历史数据 |

两个 seed 脚本也各自补了执行记录清理（顺序：`schedules` → `runs` → `cases`，后两步靠子查询找待删用例）。
接口把连带删掉的条数如实回传（`{deleted, runsDeleted, schedulesDeleted}`），前端提示「已删除（连带 3 条执行记录）」——
**静默毁掉几十条历史，比多一句话危险。**

历史遗留的孤儿用维护脚本扫尾（默认只报告，`--yes` 才删）：

```bash
npm run clean:orphans            # 只报告：多少条孤儿、涉及哪些已删除的用例 id
npm run clean:orphans -- --yes   # 真删，删完复查「剩余 0 条」
```

实测：清理前 791 条 → 清理后 **0 条**，剩余执行记录全部能对上活着的用例（清理前先 `cp data/app.db data/backups/…` 并用只读连接验证备份可读）。

## 响应头断言（M14）

给 office-oa 加「单据导出 CSV」时，平台的**第二个能力边界**被顶出来了：执行器从前**只读 `res.text()`，从不碰 `res.headers`** ——
于是「导出的 `Content-Type` 对不对、`Content-Disposition` 是不是 `attachment`、文件带没带 BOM」这类断言**一个字都写不出**。
（和 M8 的 multipart 同源：能力边界不是设计出来的，是被一个真实需求逼出来的。区别是 M8 在**请求侧**，这次在**响应侧**。）

**改动一：能读头。** 执行器把 `res.headers.entries()` 摊平成**小写键**对象放进结果（HTTP 头本就不区分大小写）；
`expected` 新增 `headers:[{name, op, value}]`，`op` **复用**已有的 `eq / contains / exists` —— 不新造一套操作符。
编辑器补一个「响应头断言」编辑区。

**改动二：拿到字节。** 补完头还不够 —— BOM 依然断言不了，因为 **`res.text()` 按 Fetch 规范会吃掉开头的 BOM**，
而且是**静默地吃**：不报错，只会永远红（断言方向写反了甚至会假绿）。只能绕开 `res.text()`，
按 `arrayBuffer()` 自己解码 UTF-8，BOM 才留得住。

> ⭐ 改动二不是设计出来的，是**跑测试时红出来的**：写了一条「响应体以 BOM 开头」的用例，真机上永远红，
> 回头才发现问题在 `res.text()`，不在导出功能。**又一次先看见「红」，才看见「为什么」。**

实测：vitest **186 例**（`tests/notifications.test.js` 16 例：通知存储层 / runScheduledJob 触发落通知 success·warn·error / HTTP 层 / 实时推送：`subscribe` 收到广播 + 订阅者抛错不连累落库 + SSE 端点真连收 hello 与 notification / **M20：notifyOn=failure 成功静默、失败照落 + 500 条保留上限自动裁剪**；`tests/headerAssert.test.js` 13 例，含「头名大小写不敏感」「头不存在时 `eq` 判失败」）；
闭环套件 I 段 8 条（OA-53～60）全用新断言跑通，`test:oa` **60/60**。

## 平台自己的 UI 测试（M19）

接口层 vitest 看不见界面——路由守卫生没生效、登录表单还能不能用、弹窗出不出来，只有真浏览器知道。M19 给平台自己补了 **11 条 Playwright E2E**：**存用例的工具，自己也得被测。**

关键设计：

- **不下载浏览器**：`channel: 'chrome'` 直接用系统已装的 Chrome（CI 的 ubuntu 镜像自带，同样免下载几百 MB Chromium）。
- **离线确定性**：独立库 `data/e2e.db`（不污染开发数据），`e2e/seed-e2e.mjs` 复用真实 `seed.js` 再补 **2 条离线必绿/必红用例**——示例里有 4 条打公网，联网与否结果会变，断言不能依赖外网。`DEEPSEEK_API_KEY` 显式置空，AI 生成用例在 E2E 里永远不会真调。
- **测试钩子**：登录页 / 列表页 / 编辑器加 `data-t` 属性，比靠按钮文案定位抗改版。
- **hash 路由**：`createWebHashHistory` 下 `page.goto('/reports')` 走的是 path，SPA 兜底回首页——必须 `goto('/#' + route)` 且用 `location.hash` 判跳转。

⭐ **E2E 上线首日就抓出自己项目里的真 bug**：SSE 长连接（M18）让无头 Chrome 收尾挂住——11 条全 `ok` 但进程永不退出。三条隔离实验定位（不登录→正常退出；禁 `EventSource`→正常退出；真登录→挂住）；应用侧 `pagehide` 清理**救不了**（无头关上下文不保证触发），唯一可靠解法是测试侧收尾导航 `about:blank` 拆掉文档。调试过程顺带修掉第二个真问题：**退出登录后 token 已清、SSE 订阅还占着**（`App.vue` 加 `disconnectNotifStream`，登出时显式 close）。

另一个 Windows 特有的坑：Playwright 收尾时杀不掉自己拉起的 webServer 子进程（`taskkill /T /F` 手动执行正常，它就是杀不掉），`npm run test:e2e` 永不退出——解法是 `scripts/run-e2e.mjs` **自管服务生命周期**（起 → 等 `/health` → 跑 Playwright → 杀），起和杀都归我们管，EXIT=0 干净退出。

怎么跑：

```bash
npm run build        # E2E 打的是构建产物，必须先构建
npm run test:e2e     # 11 条全绿 + 干净退出（~1 分钟）
```

CI（`.github/workflows/ci.yml`）五层回归：静态扫描（前端 + **文档引用**）→ 构建 → vitest → E2E → **真机断言（m11+m12，45 条）**，失败自动传 Playwright 报告。

## 通知降噪与保留策略（M20）

M17 给每个定时任务的每次运行都发通知。监控跑得勤（比如每 5 分钟一轮），铃铛很快被「一切正常」刷屏——**没人会逐条划掉 success 消息，然后真正重要的失败就被淹没了**。真实监控工具的惯例是「成功静默、失败才喊人」，M20 把它做成任务级配置：

- **`notifyOn: all | failure`**（`schedules.notify_on` 列，默认 `all` 保持 M17 行为）：`failure` 模式下全绿不落通知，warn（断言失败）/ error（没跑成）**无论什么模式都落**——降噪 ≠ 不跑，运行本体照常执行，只是 `addNotification` 之前拦一下。
- **白名单回退**：`notifyOn` 传非法值一律回退 `all`（存储层不信任调用方，宁可行为保守也别存进调度器不认识的值）。
- **前端**：定时表单加「只在失败时通知」开关（带 tooltip 解释），任务表格加「通知」列（`只看失败` / `全部`）。

顺带补一个日志类数据的通用问题——**只增不删的表迟早变成负担**：

- **保留策略**：`addNotification` 落库后自动裁剪，只留最近 **500** 条。裁剪**不做成接口**——「清理日志」和「改写历史」只隔一层窗户纸，让它是自动行为而不是别人的可调用能力。实现是一条 SQL：`DELETE ... WHERE id <= (SELECT id ... ORDER BY id DESC LIMIT 1 OFFSET 500)`，不足 500 条时 OFFSET 取不到行返回 NULL、恒不删，天然幂等。

## 通知出口（M21）

M20 之前的通知都只活在平台页面里——人不在电脑前就收不到。M21 补上监控闭环的最后一环「**升级外呼**」：配置一个 webhook 地址（`GET/PUT /api/notifications/webhook`），失败侧通知落库后以 JSON POST 出去，指向飞书机器人 webhook、hermes 网关、任意能收 JSON 的端点都行。

- **只转发失败侧**（warn 断言失败 / error 没跑成）——success 永不转发，和 M20 同一个理。
- **`forwardToWebhook` 永不抛错**：3s 超时、fetch 异常、HTTP 非 2xx 全部转成 `{ok:false}` 返回值，调度器可以放心 `await`——**出口挂了不能影响调度本体**，站内记录一条不丢（外呼失败最多丢「喊人」，不丢「记录」）。
- **地址存 settings 表**（全局 KV，和「当前环境」同一套机制）；URL 校验只放行能被 `new URL` 解析的 http/https 绝对地址，非法值路由层转 400。
- 消息体与站内通知同构，外加 `type: 'api-test-platform.notify'` 标识来源——收端（飞书适配器 / hermes）好路由。
- 前端报告页新增「📣 通知出口」卡片：输入地址保存即启用，清空保存即关闭。

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
| **M13** | **删用例的连带清理**：删用例连带删执行记录与定时任务（同一事务，并停掉内存里的 cron），`deleteCase` 返回连带条数供前端如实提示；两个 seed 脚本补上执行记录清理；新增 `npm run clean:orphans` 扫尾历史遗留（实测清掉 **791 条**孤儿） | ✅ 已完成（145 例 + OA 52 条） |
| **M14** | **响应头断言**：执行器读 `res.headers` + `expected.headers=[{name,op,value}]`（`op` 复用 eq/contains/exists，头名大小写不敏感）；顺带**绕开 `res.text()` 自己按字节解码**（否则连 BOM 都断言不了）→ 让 office-oa 新开的「单据导出 CSV」这一面（头 / BOM / 表头 / 公式注入）也能被断言 | ✅ 已完成（158 例 + OA 60 条） |
| **M15** | **分组定时任务**：把 M12 的 `group` 维度延到定时任务——`schedules.case_id` 改为可空、`group` 优先（二选一，缺参 / 空组都 400）；`runScheduledJob` 从 cron 回调抽出，group 时调 `runAll(listCases(group).sort(by id))` 复用同一条链引擎，单条时退回 `runCase`；前端 `Reports.vue` 定时表单加「单条 / 分组」切换。⭐ 设计点：哨兵 `case_id = 0` 表示分组任务（避免重建表；`deleteCase` 按 case_id 删不会误伤）；空组创建时即拦下，杜绝「定时任务静默空跑」 | ✅ 已完成（170 例 + OA 60 条） |
| **M17** | **运行通知（定时任务可观察性）**：`runScheduledJob` 跑完（无论成功 / 失败 / 异常）都落一条站内通知（success / warn / error 三档），前端 `App.vue` 铃铛 + 未读角标 + 弹窗已读；`notifications` 表 + 4 个路由（列表 / 未读计数 / 标记已读 / 全部已读）。⭐ 设计点：① 通知读写模型刻意做薄（只有增 / 列 / 已读，不编辑不删——通知是日志，被改写比被漏看更危险）；② 通知写失败**绝不**影响调度本体（`runScheduledJob` 内单独 try/catch 吞掉，错就当没这功能）；③ 删用例导致的 error 通知仍用 schedule 带着的 caseName 命名，让人认得出是哪条 | ✅ 已完成（179 例 + OA 60 条） |
| **M18** | **通知实时推送（SSE）**：`notifications.js` 加进程内极简 pub/sub（`subscribe(fn)` 返回退订函数，`addNotification` 落库后广播）；新增 `GET /api/notifications/stream`（手写 `text/event-stream`：`reply.hijack()` 自己管响应 + 25s 心跳防代理空闲超时 + 连接关闭即退订）；`authGuard` 对 SSE 放行 header 校验、改用 `?token=`（EventSource 带不了自定义头）；前端 `App.vue` 用 `EventSource` 订阅，定时任务跑完那一刻角标即时 +1 + `ElMessage` 轻提示。⭐ 设计点：① 用 SSE 而非 WebSocket（单向够用、零依赖，不为一条通知破坏「零原生依赖」调性）；② token 走 query 是 SSE 的通行做法（照样 `verifyToken`，只是取值位置变了），不是绕过鉴权；③ 订阅者抛错 / 写通知失败都不连累落库与调度本体；④ 断线重连交给 EventSource 自带的重试，`onerror` 静默不骚扰用户 | ✅ 已完成（183 例 + OA 60 条） |
| **M19** | **平台自己的 Playwright E2E**：11 条真浏览器用例（鉴权路由守卫 / 真实表单登录 / 单条必绿·必红 / 分组筛选·按组运行 / 报告分组维度 / 新建·删除）。`channel:'chrome'` 复用系统 Chrome **不下载浏览器**；独立库 `data/e2e.db` + 确定性种子（2 条离线必绿/必红用例，断言不依赖外网）；页面加 `data-t` 测试钩子抗改版；`about:blank` 收尾 fixture + `scripts/run-e2e.mjs` 自管服务解决两个「全绿但进程不退出」的挂死。⭐ 调试故事：E2E 上线首日就抓出一个**自己项目里的真 bug**——SSE 长连接让无头 Chrome 收尾挂住（`pagehide` 清理救不了，测试侧拆文档才可靠），顺带修掉「退出登录后 token 已清、SSE 订阅还占着」的泄漏 | ✅ 已完成（183 例接口 + 11 条 E2E + OA 60 条） |
| **M20** | **通知降噪 + 保留策略**：任务级 `notifyOn: all \| failure`（默认 all 不改 M17 行为；failure 模式全绿静默、warn/error 照落——「成功静默、失败才喊人」的监控惯例；白名单外回退 all）；`addNotification` 落库自动裁剪只留最近 500 条（不做成接口——「清理日志」和「改写历史」只隔一层窗户纸；单条 SQL 幂等裁剪）。前端定时表单「只在失败时通知」开关 + 任务表「通知」列 | ✅ 已完成（186 例接口 + 11 条 E2E + OA 60 条） |
| **M21** | **通知出口（webhook 外呼）**：`GET/PUT /api/notifications/webhook` 配置出口地址（settings KV，http/https 校验），失败侧（warn/error）通知落库后 JSON POST 出去（可指向飞书机器人 / hermes / 任意收 JSON 端点）；`forwardToWebhook` **永不抛错**（3s 超时，错误全转返回值）——出口挂了不影响调度本体、站内记录一条不丢。⭐ 顺带根治本机 E2E「跑完不退出」：force-exit reporter（onTestEnd 强退）+ 输出看门狗（60s 无输出判挂死）+ 自动重试，5 连跑全 EXIT=0（含一次真实自愈） | ✅ 已完成（206 例接口 + 11 条 E2E + OA 60 条） |
| **M22** | **数据自洽：把「自测」用例组收成一个真源**。① 散落的历史示例用例（无分组、其中 5 条是红的、还有一条名字是乱码）收敛为分组 `自测`，由 `seed.js` **单一真源幂等维护**（13 条，覆盖状态码/包含/耗时/JSONPath/响应头 5 类断言 + 鉴权与路由语义），报告页一眼区分「测平台自己」与「测 OA」；② 修掉 `seed.js` **自己写错的 JSONPath 方言**——`$.1.name`（本平台只认 `$[1]`）求值静默返回 0 匹配，导致**每跑一次 seed 就往库里埋一条必红用例**，「全部运行」长期停在 68/74；③ 新增 `tests/seed.test.js` 9 例：不许出现 `$.1` 方言、不许出现期望 405、断言维度覆盖齐全、外网依赖名字必须带前缀、**幂等性**、以及「历史遗留名字（`示例-*` / `健康检查-*`）能被清干净」；④ 截图导览脚本的演示对象从「库里捡一条红的」改成**自建自删的临时用例**，不再依赖偶然数据；收尾删除写进 **`finally` + 看门狗**（不再只写在正常路径末尾），并给 CDP 的每次调用补上超时 —— 起因是它曾在一次 `eval` 上**挂死 3 小时 31 分**，把一条「每分钟触发」的定时任务留在库里无人看管地跑。⭐ 一句话：**种子数据也是代码，也会写出错的断言，也该有测试。** | ✅ 已完成（206 例接口 + 11 条 E2E + OA 60 条） |

⭐ 注：表里的「N 例 / OA N 条」是**该里程碑完成当时**的数字，不是当前值（历史不该被后一轮改写）。
当前规模见本文开头：**211 个单测（17 个文件）+ 11 条 E2E + OA 套件 84 条**。

### 面试材料（都是「协作产出」的诚实版本，别照着装全独立手写）

| 文档 | 用途 |
|---|---|
| [`docs/项目全讲.md`](docs/项目全讲.md) | 项目讲解（教学 / 作品集博客口径），M1–M22 逐轮 + 12 个技术亮点 + 踩坑 13 条 |
| [`docs/测穿-office-oa-闭环.md`](docs/测穿-office-oa-闭环.md) | 闭环记录：用本平台测穿 office-oa 的全过程（十轮）+ 九个真实发现 |
| [`docs/面试弹药-api-test-platform.md`](docs/面试弹药-api-test-platform.md) | 讲什么：10 个技术亮点 + 18 项「我改过的点」候选清单 + 17 道深挖题 + 6 个「平台自己被抓出来的缺陷 / 边界」 |
| [`docs/简历弹药-api-test-platform.md`](docs/简历弹药-api-test-platform.md) | 简历上写什么：bullet + 18 项「我改过的点」shortlist + 防御深度 |
| [`docs/关源码复现-api-test-platform.md`](docs/关源码复现-api-test-platform.md) | **会不会写**：12 道「关掉源码写出来」练习（含示范轮 + 评分标准 + 错题本模板） |

## 目录

```
index.js          Fastify 应用 + 路由（含 auth/schedules/runs/reports）+ onRequest 鉴权守卫 + 生产静态托管
src/db.js         SQLite 封装（test_cases / runs / schedules / users / environments / notifications / settings）+ 幂等迁移（新列自动补）
src/auth.js       鉴权核心：scrypt 密码哈希 + 手写 HS256 JWT（signToken/verifyToken）
src/users.js      用户服务：createUser/verifyLogin/initDefaultUser/changePassword
src/cases.js      用例 CRUD（含 updateCase 部分更新 + extract 抽取声明 + **deleteCase 连带删执行记录与定时任务**）
src/vars.js       用例链：{{var}} 模板渲染 + 按 JSONPath 从响应抽变量（M7）
src/jsonpath.js   自写 JSONPath 求值器（M3 核心之一）
src/bodyTypes.js  请求体类型白名单 json / raw / form-data（M8）
src/multipart.js  手搓 multipart/form-data 包体 + 文件字段解析（boundary / CRLF / 二进制安全，M8）
src/fixtures.js   内置文件夹具（PNG / PDF / 伪装 exe），字节写进代码保证可重复（M8）
src/environments.js 环境变量集：{{base}} 来源、当前环境（settings 一行）、环境级默认请求头（M9）
src/suite.js      套件导出/导入：脱敏（只抹字面凭据，保留 {{变量}}）、按串链顺序导出、三种冲突策略（M11）
src/runner.js     用例执行引擎（status/contains/maxTimeMs/jsonChecks/**headers** 断言 + 变量渲染/抽取 + multipart 组包 + 环境注入 + **按字节解码响应**）
src/schedules.js  定时任务 CRUD（cron 校验；case_id 或 group 二选一，group 优先，M15；notifyOn 降噪开关 M20）
src/scheduler.js  node-cron 调度器（注册/启停/恢复；跑完落运行通知 M17；failure 模式成功静默 M20；落库后 webhook 外呼 M21）
src/notifications.js 运行通知存储层（增/列/未读/已读，读写模型做薄）+ SSE 广播源（subscribe 发布/订阅，M17/M18）+ 500 条保留裁剪（M20）
src/webhook.js    通知出口（M21）：settings 存地址 + forwardToWebhook 外呼（只转 warn/error，永不抛错，3s 超时）
src/reports.js    执行记录查询 + 报告聚合
seed-oa-suite.mjs office-oa 用例套件（84 条 + 按 A–L 段打 `group` 分组，用例链 + 附件 + 站内通知 + 单据导出 + 会议室时段冲突/越权取消 + 统计/考勤范围收权；并定义当前环境）— npm run seed:oa
run-oa-suite.mjs  一键跑 OA 套件并打印结果（含「当前环境」提示）— npm run test:oa
scripts/m9-env-ui-check.mjs  真机 Chrome 验证环境变量集界面与页头徽标一致性（零依赖 CDP，13 条断言；跑完不留副作用）
scripts/push-main.sh / retry-push.sh  直连推 GitHub（避开 Git Bash 单行 unset 的引号解析坑）
playwright.config.js  E2E 配置：channel:'chrome' 复用系统 Chrome、独立库 data/e2e.db、单 worker（同一个 SQLite 文件不能并行写）
e2e/seed-e2e.mjs     E2E 确定性种子：复用真实 seed.js + 补 2 条离线必绿/必红用例（断言不依赖外网）
e2e/helpers.js       E2E 公共层：真实表单登录 / hash 路由判据 / 等数据到位 / ★ about:blank 收尾 fixture（拆掉 SSE 长连接防挂死）
scripts/run-e2e.mjs  E2E 包装器：自管服务生命周期（起 → 等 /health → 跑 Playwright → 杀）——绕开 Windows 上 Playwright 收尾杀不掉 webServer 的坑
.github/workflows/ci.yml  CI：静态扫描（前端 + 文档引用）→ 构建 → vitest → E2E → 真机断言（m11+m12，45 条）
tests/app.test.js + tests/jsonpath.test.js + tests/auth.test.js + tests/vars.test.js + tests/aiCases.test.js + tests/multipart.test.js + tests/environments.test.js + tests/runEnv.test.js + tests/suite.test.js + tests/group.test.js + tests/deleteCascade.test.js + tests/headerAssert.test.js + tests/runnerQuery.test.js + tests/schedules.test.js + tests/notifications.test.js + tests/webhook.test.js + tests/seed.test.js  共 17 个文件 / 211 例，全离线
e2e/auth.spec.js + e2e/cases.spec.js + e2e/helpers.js + e2e/seed-e2e.mjs + e2e/force-exit-reporter.mjs + playwright.config.js + scripts/run-e2e.mjs  共 11 条真浏览器 E2E（channel:'chrome' 免下载；独立库 data/e2e.db；force-exit reporter + 看门狗重试绕开本机 flaky 收尾；CI 走 .github/workflows/ci.yml）
scripts/clean-orphan-runs.mjs    扫尾「孤儿执行记录」（指向已删除用例的 runs）；默认只报告，--yes 才删 — npm run clean:orphans
scripts/m10-report-env-check.mjs  跑完闭环后，从报告接口读回「这一轮实际打的是哪个环境」（含快照语义核对）
scripts/m11-suite-ui-check.mjs   套件导出/导入验证（接口层脱敏 + 真机层真的选文件导入；跑完自动清场）
scripts/m12-group-ui-check.mjs   用例分组验证（接口层 + 真机层选分组/按组运行；**可在空库上独立跑**：用组、分组、当前环境全自己造自己还；收尾连执行记录一起清，报告不留孤儿）
scripts/run-ui-check.mjs         「一条命令跑完真机断言」的包装（m11+m12）：自备隔离库 data/ui-check.db + 3111 端口、自起服务、跑完自杀 — npm run check:ui:auto
scripts/lib/cdp.mjs              真机检查的公共底座（起 Chrome / CDP 客户端 / 页面助手 / 临时账号 token / **platformBase()·oaBase() 统一「打哪个实例」**）
Dockerfile / .dockerignore / docker-compose.yml / DEPLOY.md   部署（M5）
web/              Vue3 + Element Plus 前端（构建产物 web/dist 由后端同源托管）
  web/src/auth.js     前端会话状态（token + reactive session）
  web/src/views/Login.vue      登录/注册页（M4）
  web/src/views/CaseList.vue   用例列表 + 运行/汇总结果
  web/src/views/CaseEditor.vue 请求编辑器（含 JSON 断言编辑）
  web/src/views/Reports.vue    报告页（统计/明细/定时任务管理）
docs/             面试与讲解材料（诚实口径，详见上面「面试材料」表）
  docs/项目全讲.md                  项目讲解（M1–M22 + 12 个技术亮点 + 踩坑 13 条）
  docs/测穿-office-oa-闭环.md        闭环记录 + 九个真实发现
  docs/面试弹药-api-test-platform.md  10 个技术亮点 / 17 道深挖题 / 6 个自曝缺陷
  docs/简历弹药-api-test-platform.md  简历 bullet / 18 项「我改过的点」shortlist
  docs/关源码复现-api-test-platform.md 关源码复现练习（12 题 + 示范轮 + 评分标准）
```
