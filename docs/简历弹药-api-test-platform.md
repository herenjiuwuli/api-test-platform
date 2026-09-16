# API 自动化测试平台 · 简历弹药（写进简历 + 守得住）

> 用途：把项目压成「能写进简历的 bullet」+ 每个 bullet 的防御深度。深度素材见同目录 `面试弹药-api-test-platform.md`，关源码复现练习见 `关源码复现-api-test-platform.md`。
> ⚠️ **诚实边界（务必先读）**：这个项目代码是「你定需求 + AI 实现」的协作产出。简历上写得出来的功能，面试时**必须能讲清「为什么这么设计」**；讲不清的别写。下面每条都标了深度——带 ✅ 的是你必须自己能答的，带 ⚠️ 的是至少讲清思路、别被问住。

## 一、一句话定位（简历 headline / 自我介绍用）

一个自用接口回归与监控工具：存用例 → 手动 / 定时跑 → 多维度断言（状态码 / 包含 / 耗时 / JSONPath）→ 出报告 → 带账号体系 → 一键容器化部署。技术栈 Fastify5 + Node 内置 SQLite + Vue3/Element Plus + node-cron，**85 测试全绿**。**配套一个「被测系统」office-oa，用这个平台把它测穿了。**

## 二、简历可写的 bullet（每条标防御深度）

1. ✅ **多维度断言 + 自写 JSONPath 求值器（零第三方库）**：断言模型 `expected` 覆盖 `status` / `contains` / `maxTimeMs` / `jsonChecks`；JSONPath 求值器支持 `$.a.b` / `$.arr[0]` / `$.arr[*]` / `.length` 与 8 个比较 op（`eq / ne / gt / gte / lt / lte / contains / exists`）。
   → 讲清：为什么自写（展示能力 + 第三方库对 `*`/`.length` 支持参差），约 60 行更易控、更易测。
2. ✅ **零依赖鉴权：scrypt 加盐哈希 + 手写 HS256 JWT**：不引 `jsonwebtoken`/`bcrypt`；全局 `onRequest` 守卫除白名单（`/health`、登录、注册、静态资源）外强制 `Bearer`，否则 401。
   → 讲清：scrypt 加盐 + `timingSafeEqual` 防时序攻击；JWT 三段结构；verify 三步（拆三段 → 重算签名比对 → 校验 exp）。
3. ⚠️ **node-cron 定时任务 + 重启自动恢复**：cron 表达式 → 到点执行并落执行记录；服务重启遍历 `schedules` 表重新注册，route 增删改后同步启停。
4. ⚠️ **单端口部署**：前端 `web/dist` 由 Fastify 同源托管（`/*` 静态 + SPA 回退），Docker / compose 挂卷持久化 SQLite，无跨域、部署只一个端口。
5. ✅ **测试隔离方案（真实踩坑）**：把 `DB_PATH` 从模块顶层 `const` 改成 `getDb()` 内**惰性解析**，配合 `:memory:` + `setupFiles` 在 import 前注入，根治「测试把用例写进生产库」（早期表现为「全部运行」出现一堆死链 `fetch failed`）。
6. ⚠️ **报告聚合 / 执行记录查询**：`/api/reports/summary` 出总用例 / 总执行 / 通过率 / 按用例统计 / 最近记录。
7. ✅ **被测系统闭环（最值钱的一条，已真跑通）**：平台里有一组 **44 条 OA 用例**，用**用例链**串成一次完整业务闭环 —— 登录抽 token → 建单抽单据 id → 自批 403 → 外部门经理 403 → 本部门经理通过归档 → 归档后「审批人 409 / 无关人 403」成对断言 → 登出后旧 token 401 → 附件边界面（守卫 / 父资源 / 可见性 / body 类型）→ **附件全生命周期（真发 multipart：上传 → 列表 → 下载回读 → 伪装 exe 被拦 → 越权 403/409 成对 → 删除）**。`npm run test:oa` 打被测系统 **office-oa（14 张表 / 28 接口 / 161 条接口测试）**，结果 **44/44 全绿**。**「写了一个被测系统，又用自写平台把它测穿」**，对口测试工程师 / 技术支持岗，比任何功能清单都值钱。闭环全过程与四个真实发现（含「执行器只会发 JSON」这条能力边界**被发现 → 被补掉**的完整过程）见 `docs/测穿-office-oa-闭环.md`。
8. ✅ **给执行器加请求体类型与文件上传（M8，含一个自己抓出来的前端 bug）**：用例支持 `bodyType`（json / raw / form-data）+ `files`；**multipart 包体手搓不引库**（boundary / CRLF / 二进制安全 / 文件名字段转义），form-data 时**执行器接管 `Content-Type`（带 boundary）与 `Content-Length`**；夹具字节内置在代码里（PNG / PDF / 伪装 exe），因为自动化要的是「每次发一模一样的字节」。
   → 讲清：为什么不用 `form-data` 包（延续零依赖）；为什么要接管 Content-Type（boundary 不可能手填对）；为什么夹具内置而不是让用户传文件（可重复性）。
   → **真机验证时抓到的坑**：从 `/cases/1/edit` 切到 `/cases/new`，Vue 复用组件实例导致 `onMounted` 不重跑、表单残留上一条的 `bodyType` —— 单测和 `vite build` 都不报错，只有真机走一遍才露头（修法 `watch(id, load)` + `resetForm()`）。

## 三、「我改过的点 + 为什么」shortlist（面试前亲手过一遍）

| # | 决策点 | 讲得到什么程度 | 状态 |
|---|---|---|---|
| 1 | 4 类断言的划分（status / contains / maxTimeMs / jsonChecks） | 为什么分这 4 类、各覆盖什么场景 | 待自测 |
| 2 | 自写 JSONPath 求值器 | 路径怎么分词、`[*]` 怎么展开、`.length` 怎么取 | 待自测 |
| 3 | 零依赖鉴权 | scrypt / JWT 流程、防时序攻击 | 待自测 |
| 4 | 测试隔离（ESM 快照坑） | 惰性解析 + `:memory:` 的因果 | ✅ 已确认 |
| 5 | 定时任务重启恢复 | `registerJob` / `refreshJob` 链路 | 待自测 |
| 6 | 单端口部署 / SPA 回退 | 静态路由 + 路由回退 index.html | 待自测 |
| 7 | `contains` 在多匹配时改成「任一命中即通过」 | 为什么这么改才符合直觉（Postman 的 `to.include` 同语义）+ 为什么 `eq` 仍是首个匹配值 | ✅ 已确认 |
| 8 | multipart 手搓 vs 引 `form-data` 包 | boundary 怎么生成、结尾为什么要 `--`、为什么必须接管 `Content-Type` | 待自测 |
| 9 | 文件夹具内置在代码里 | 为什么不让用户传文件（可重复性 → 断言才站得住） | ✅ 已确认 |

> 状态判定：用 `关源码复现-api-test-platform.md` 的练习，每题能关源码写出来 = ✅ 懂；写不出 = ❌ 没懂，回去补这一块再投。

## 四、高频深挖题（精选，详答见 `面试弹药-api-test-platform.md`）

1. **为什么 `node:sqlite` 不引 `better-sqlite3`？** → 零原生编译模块，CI / Docker / 跨平台无编译坑。
2. **scrypt 和 bcrypt 比怎么样？** → Node 内置 `crypto` 就有 scrypt，零依赖；重点是「加盐 + `timingSafeEqual` 防时序攻击」，不是非得 bcrypt。
3. **手写 JWT 而不是 `jsonwebtoken`？** → HS256 = `base64url(header).base64url(payload).HMAC-SHA256`；verify 三步走：拆 3 段 → 重算签名比对（`timingSafeEqual`）→ 校验 `exp`。
4. **JSONPath 求值器怎么实现的？** → 路径分词成 steps（field / index / wild），从 root 出发逐 step 收集「匹配值数组」；`[*]` 把数组元素展开；`.length` 处理数组长度；无匹配提前终止返回 `[]`。
5. **定时任务重启怎么恢复？** → `startScheduler()` 启动时遍历 `schedules` 表 `registerJob`；route 增删改后 `refreshJob` 同步注册 / 停用。
6. **测试怎么不污染生产库？** → DB 路径惰性解析 + `:memory:` + `setupFiles` 在 import 前注入；每个测试文件各自一份内存库。
7. **你的测试平台能测「需要登录的接口」吗？上传文件呢？** → 两个都踩过：
   前者靠**用例链**（`{{var}}` + `extract` + run-all 共享内存变量袋）；
   后者一开始**不能**（执行器只会 `JSON.stringify(body)`），我把这条边界写进文档，后来当成工作项做掉了（M8：`bodyType=form-data` + 手搓 multipart + 内置夹具）。
   → 这类问题答「我的工具边界在哪、我怎么发现的、我怎么补的」，比答「都能测」可信得多。
8. **手搓 multipart 要注意什么？** → boundary 要用一段**不会出现在内容里**的随机串；每段之间是 CRLF，结尾必须再补一个 `--boundary--`；
   `Content-Type` 必须带 `boundary=` 参数（所以不能沿用用例里手填的那个）；请求体是二进制，`Content-Length` 自己算比让运行时猜稳。
9. **夹具为什么要内置在代码里？** → 自动化要**可重复**：每次跑发一模一样的字节，`size == 41`、`contains 某段正文` 这类断言才立得住；
   让用户传一个本地文件，换个机器就红，等于把回归测试变成一次性脚本。

## 五、一句话收尾（被问「最大难点 / 最得意」时）

> 「最大难点是**让测试不污染生产数据**——ESM 模块顶层快照环境变量导致 `:memory:` 永不生效，改成惰性解析才根治。这让我理解了模块加载时序对全局配置的影响。」

> 备用、最亮眼的一句（被问到这个项目哪里不一样时）：「它最不一样的点是本身就配了一个**被测系统**——我用自写的测试平台把另一个项目测穿了。测试岗看这个闭环，比看任何功能清单都值钱。」

> ⚠️ 诚实提示：以上功能里，**「我从报错里自己改出来的」有这几条** —— ① 测试隔离坑（ESM 顶层快照导致 `:memory:` 不生效）；
> ② `contains` 多匹配语义（真跑 OA 用例才暴露，红的是我的平台不是被测系统）；③ multipart 能力边界（先承认、后补掉）；
> ④ 编辑页切新建页的组件复用残留（真机验证抓出来的前端 bug）。
> 其余是「你定的需求 + AI 实现」。面试讲法一律是「需求/验收是我定的，关键技术点我逐条复现、能讲清为什么这么设计」，
> **绝对不要装成全独立手写**。这四条是你可以放心说「这个是我自己改的」的。
