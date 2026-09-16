---
type: spec
tags: [项目/测试运维, 项目/全栈练手, 类型/trae指令]
---

# API 测试平台 · AI 生成用例模块（开发指令）

> 用途：给 API 自动化测试平台加「AI 生成用例」能力——输入接口信息，AI 自动设计测试用例（正常/边界/异常），人预览、编辑、勾选后批量保存进用例库。
> 代码：`D:\Projects\api-test-platform`（Fastify + SQLite + Vue3 + Element Plus）
> 日期：2026-09-01

## 目标形态

```
用例列表页 → 「AI 生成用例」按钮
  → 弹窗：填 method / url / body（可选）/ 接口说明（可选）
  → 点生成 → AI 返回 5-8 个用例（符合平台用例模型）
  → 预览表格（每条可编辑 name/expected、可勾选）
  → 「保存选中」→ 批量写入用例库 → 可直接执行
```

## 全局约束

1. 用例模型完全对齐现有：`{ name, method, url, headers, body, expected: { status?, contains?, maxTimeMs?, jsonChecks?: [{path, op, value}] } }`
2. DEEPSEEK_API_KEY 放后端环境变量（`.env`），不进前端/不提交 Git；参考 `D:\Projects\resume-interview\server\lib\ai.js` 的封装方式（chatWithDeepSeek + chatJSON，支持 DEEPSEEK_BASE_URL）
3. AI 返回必须严格 JSON，解析失败给友好错误
4. 生成的用例必须先预览、人工勾选后才保存（AI 是助手，人验收）

---

## 开发指令（复制给 Trae）

```
在 D:\Projects\api-test-platform 上新增「AI 生成用例」模块。

## 后端

1. 新建 src/ai.js：
   - chatWithDeepSeek(messages)：调 DeepSeek（DEEPSEEK_API_KEY，可选 DEEPSEEK_BASE_URL，默认 https://api.deepseek.com），response_format json_object，timeout 60s
   - chatJSON(messages)：调 DeepSeek 并解析严格 JSON（兼容 ```json 围栏）

2. 新建 src/aiCases.js：
   - export async function generateCases({ method, url, headers, body, description })
   - 构造 system prompt：
     「你是资深 API 测试工程师。根据给定的接口信息，设计 5-8 条测试用例，覆盖正常情况、边界情况、异常情况（如必填缺失、非法参数、超长输入、错误方法等）。返回严格 JSON 数组，每项格式：
     { "name": "用例名（中文，一句话说明测什么）", "method": "GET|POST|PUT|DELETE", "url": "完整请求 URL", "headers": { }, "body": null 或对象, "expected": { "status": 期望状态码, "contains": "响应应包含的文本（可选）", "maxTimeMs": 毫秒上限（可选）, "jsonChecks": [{"path": "JSONPath 路径", "op": "eq|ne|gt|gte|lt|lte|contains|exists", "value": 期望值}] } }
     要求：url 必须基于用户提供的接口 URL 拼接（如 /users/99999 表示不存在的 id）；jsonChecks 里的 JSONPath 用 $.xxx 格式；异常用例的 expected.status 要符合 REST 习惯（404/400/422）。」
   - user content 给接口信息：method/url/headers/body/description
   - 返回生成的用例数组

3. index.js 注册路由：
   - POST /api/ai/generate-cases：接收 { method, url, headers?, body?, description? }，校验 url 必填，调 generateCases，返回 { cases: [...] }
   - 错误处理：DeepSeek 失败返回 502「AI 生成失败，请稍后重试」

## 前端

4. 用例列表页（web/src/views/CaseList.vue）加「AI 生成用例」按钮（次要按钮，在「新建用例」旁）
5. 新建弹窗组件 web/src/components/AiGenerateDialog.vue：
   - 表单：method 下拉（GET/POST/PUT/DELETE）、url 输入（必填）、body 文本域（JSON，可选）、接口说明（可选）
   - 「生成」按钮 → 调 POST /api/ai/generate-cases → 加载态
   - 结果表格：每行一条用例（name / method / url / expected 摘要），行内可编辑 name 和 expected.status、可勾选、可删除
   - 底部「保存选中（N）」→ 批量调现有创建用例接口 → 成功提示 → 关闭弹窗 → 刷新列表
   - 错误提示用 ElMessage
6. web/src/api.js 加 aiGenerateCases 方法

## 验收

- 后端：POST /api/ai/generate-cases（给真实接口如 /api/cases）返回 5-8 条结构化用例
- 前端：生成 → 预览 → 勾选 → 保存 → 列表出现新用例 → 可执行
- 老功能不破坏（28 个 vitest 全绿）
```

## 测试补充（做完后）

- 跑现有 vitest：`npm test` 全绿
- 可给 src/aiCases.js 补 1-2 个单测（prompt 构造、用例模型校验），mock DeepSeek

## 相关
- 项目主页：[[项目主页]]
