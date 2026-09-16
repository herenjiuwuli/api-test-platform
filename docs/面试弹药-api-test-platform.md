# API 自动化测试平台 · 面试弹药（我改过的点 + 为什么）

> 用途：面试「测试工程师 / 技术支持工程师」时讲这个项目用。
> ⚠️ **诚实边界（务必先读）**：这个项目代码是「你定需求 + AI 实现」协作产出。面试时**绝对不能**装成「全独立手写」。正确讲法：**需求是我定的，关键技术点我逐条复现、能讲清为什么这么设计**。下面每个点都标了「你需不需要能独立写出来」——带 ✅ 的是你必须自己能答的，带 ⚠️ 的是你至少能讲清思路、别被问住。

## 一、一句话定位（背这句）
一个能「存接口用例 → 手动/定时跑 → 多维度断言 → 出报告 → 带账号体系 → 一键容器化部署」的自用接口回归/监控工具。技术栈：Fastify5 + Node 内置 SQLite + Vue3/Element Plus + node-cron，70 个测试全绿。

## 二、4 个技术亮点（可直接展开）

### 1. 多维度断言 + 自写 JSONPath 求值器 ✅
- 断言模型 `expected`：`status`（状态码）/ `contains`（响应体包含）/ `maxTimeMs`（耗时上限）/ `jsonChecks`（JSONPath 字段值断言）。
- `jsonChecks` 支持 8 个 op：`eq / ne / gt / gte / lt / lte / contains / exists`。
- JSONPath 求值器**完全自写、零第三方库**，支持 `$.a.b`、`$.arr[0]`、`$.arr[*]`、`.length`。
- **为什么自己写而不用 `jsonpath` 库？** 项目定位就是「手写轮子展示能力」；且第三方库对 `$.arr[*]`、`.length` 这类写法支持参差，自写约 60 行更可控、更易测（有 70 个单测兜底）。

### 2. 零依赖鉴权（scrypt 哈希 + 手写 HS256 JWT）✅
- 密码：`crypto.scrypt` 加盐哈希 + `timingSafeEqual` 防时序攻击（盐与密文同存）。
- Token：手写 HS256 = `base64url(header).base64url(payload).HMAC-SHA256`，不引 `jsonwebtoken`。
- 全局 `onRequest` 守卫：除 `/health`、登录、注册、静态资源外，所有 `/api` 必须带 `Bearer`，否则 401。
- **为什么零依赖？** 不引 `bcrypt`/`jsonwebtoken`，跨平台/CI/Docker 无原生编译坑，也正好展示密码学基础。

### 3. 测试隔离踩坑（真实复盘）✅⚠️
- 早期把 `DB_PATH` 写成模块顶层 `const`，导致 `tests/setup.js` 里 `DB_PATH=:memory:` 在 import 之后才设、**永不生效**，测试把用例写进了真实库（表现为「全部运行」出现一堆死链 `fetch failed`）。
- 修法：DB 路径改为 `getDb()` 内**惰性解析**，配合 `setupFiles` 在 import 前注入 `:memory:`，彻底隔离。
- **这是面试官最爱问的「你遇到过什么坑」素材**，必须能讲清因果。

### 4. 单端口部署 + SPA 回退
- 前端 `web/dist` 构建后由 Fastify 同源托管（`/*` 静态 + SPA 回退），部署只一个端口、无跨域。
- 提供 Dockerfile + docker-compose，挂卷持久化 SQLite。

## 三、「我改过的点 + 为什么」候选清单（面试前必填）
> 这一栏你亲自过一遍：哪些是你真正拍板的？把不确定的标红，先补。别让面试官从你嘴里听到「这功能是谁写的我不太清楚」。

| 技术决策点 | 你能讲到什么程度 | 验证方式（关源码能不能写出来） | 状态 |
|---|---|---|---|
| 4 类断言的设计 | 为什么分这 4 类、覆盖什么场景 | 默写 `runCase` 断言分支 | 待你确认 |
| 自写 JSONPath 求值器 | 路径怎么分词、[*] 怎么展开 | 默写 `jsonPathGet` | 待你确认 |
| 零依赖鉴权 | scrypt/JWT 流程、防时序攻击 | 默写 `signToken/verifyToken` | 待你确认 |
| 定时任务重启恢复 | registerJob/startScheduler 链路 | 画调度恢复流程图 | 待你确认 |
| 测试隔离方案 | ESM 快照坑的因果 | 讲清惰性解析 + :memory: | 待你确认 |

> 怎么填「状态」：用本仓库 `关源码复现-api-test-platform.md` 的练习，每题能关源码写出来 = ✅ 懂；写不出 = ❌ 没懂，回去补这一块再投。

## 四、高频深挖题 + 参考答案（先理解再背）
1. **为什么用 `node:sqlite` 不引 `better-sqlite3`？** → 零原生编译模块，CI/Docker/不同平台无编译坑。
2. **scrypt 和 bcrypt/argon2 比怎么样？** → Node 内置 `crypto` 就有 scrypt，零依赖；重点是「加盐 + timingSafeEqual 防时序攻击」，不是非得 bcrypt。
3. **手写 JWT 而不是 `jsonwebtoken`？** → 展示能力 + 零依赖；HS256 结构 = base64url(header).base64url(payload).HMAC-SHA256；verify 三步走：拆 3 段 → 重算签名比对（timingSafeEqual）→ 校验 exp。
4. **JSONPath 求值器怎么实现的？** → 路径分词成 steps（field/index/wild），从 root 出发逐 step 收集「匹配值数组」；`[*]` 把数组元素展开；`.length` 处理数组长度；无匹配提前终止返回 []。
5. **定时任务重启怎么恢复？** → `startScheduler()` 启动时遍历 `schedules` 表 `registerJob`；route 增删改后 `refreshJob` 同步注册/停用。
6. **测试怎么不污染生产库？** → DB 路径惰性解析 + `:memory:` + `setupFiles` 在 import 前注入。

## 五、一句话收尾（被问「这项目最大难点」时）
「最大难点是**让测试不污染生产数据**——ESM 模块顶层快照环境变量导致 `:memory:` 永不生效，改成惰性解析才根治。这让我理解了模块加载时序对全局配置的影响。」
