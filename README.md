# API 自动化测试平台

> 面向全栈 / 测试运维岗位的简历项目。**M3 已完成**：自写 JSONPath 断言 + node-cron 定时任务 + 报告页。
> 背景：实习每天手动点接口验证采集脚本，于是造一个能「存用例 → 手动/定时跑 → 出报告」的自用测试工具。

## 技术栈

- 后端：**Fastify 5** + **Node 22 内置 SQLite（`node:sqlite`，零原生依赖）** + **node-cron**
- 前端：**Vue3 + Vite + Element Plus** + vue-router + axios（`web/` 子目录）
- 测试：**Vitest**

## 当前能力（M3）

- 用例模型：`name / method / url / headers / body / expected(status, contains, maxTimeMs, jsonChecks)`
- 执行引擎 `runCase`：发请求 → 按 expected 断言 → 返回 `{pass, status, durationMs, detail, bodyPreview}`
- **JSONPath 断言（自写求值器，未用第三方库）**：`expected.jsonChecks` = `[{path, op, value}]`，支持 `$.a.b / $.arr[0] / $.arr[*] / .length` 路径 + `eq / ne / gt / gte / lt / lte / contains / exists` 操作符
- **定时任务（node-cron）**：用例 + cron 表达式 → 到点自动执行并落执行记录；可启停/删除，重启自动恢复
- **报告**：`/api/reports/summary` 聚合（总用例/总执行/通过率/按用例统计/最近记录）
- HTTP 接口：
  - `GET /health`
  - `GET /api/cases`、`POST /api/cases`、`GET /api/cases/:id`、`PUT /api/cases/:id`、`DELETE /api/cases/:id`
  - `POST /api/cases/:id/run`（单条运行）、`POST /api/run-all`（全部运行汇总）
  - `GET /api/schedules`、`POST /api/schedules`、`PUT /api/schedules/:id`、`DELETE /api/schedules/:id`
  - `GET /api/runs?caseId=&limit=`、`GET /api/reports/summary`
- 前端（`web/`）：用例列表（CRUD/单条运行/全部运行）+ **请求编辑器**（方法/URL/请求头/请求体/状态码·包含·耗时·**JSONPath 断言**编辑）+ 运行结果弹窗 + **报告页**（统计卡片/按用例汇总/执行明细/**定时任务管理**）
- 数据持久化：用例 `test_cases`、执行记录 `runs`、定时任务 `schedules`

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
npm test           # vitest 28 例全绿（全离线）
cd web && npm run build   # 前端产物 web/dist
```

## 里程碑路线

| 里程碑 | 目标 | 状态 |
|---|---|---|
| **M1** | 后端骨架 + 执行引擎 + SQLite + 单测 | ✅ 已完成（9 例） |
| **M2** | 前端请求编辑器 + 手动运行（Vue3 + Element Plus） | ✅ 已完成（12 例） |
| **M3** | 断言(JSONPath) + `node-cron` 定时跑 + 报告 | ✅ 已完成（28 例） |
| **M4** | 鉴权 + 部署（Vercel / 云服务器） | ⏳ |
| **M5** | 教学博客（有余力） | ⏳ |

## 目录

```
index.js          Fastify 应用 + 路由（含 schedules/runs/reports）
src/db.js         SQLite 封装（test_cases / runs / schedules）
src/cases.js      用例 CRUD（含 updateCase 部分更新）
src/jsonpath.js   自写 JSONPath 求值器（M3 核心之一）
src/runner.js     用例执行引擎（status/contains/maxTimeMs/jsonChecks 断言）
src/schedules.js  定时任务 CRUD（cron 校验）
src/scheduler.js  node-cron 调度器（注册/启停/恢复）
src/reports.js    执行记录查询 + 报告聚合
tests/app.test.js + tests/jsonpath.test.js  共 28 例，全离线
web/              Vue3 + Element Plus 前端
  src/views/CaseList.vue   用例列表 + 运行/汇总结果
  src/views/CaseEditor.vue 请求编辑器（含 JSON 断言编辑）
  src/views/Reports.vue    报告页（统计/明细/定时任务管理）
```
