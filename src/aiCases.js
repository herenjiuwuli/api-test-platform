// AI 生成用例：根据接口信息让 DeepSeek 设计 5-8 条测试用例（正常/边界/异常）。
// 生成结果只做结构与字段校验，必须经人工预览、勾选后才会写入用例库。
import { chatJSON } from './ai.js'

const SYSTEM_PROMPT = `你是资深 API 测试工程师。根据给定的接口信息，设计 5-8 条测试用例，覆盖正常情况、边界情况、异常情况（如必填缺失、非法参数、超长输入、错误方法等）。
返回严格 JSON 对象，格式为 {"cases": [用例数组]}，每项格式：
{ "name": "用例名（中文，一句话说明测什么）", "method": "GET|POST|PUT|DELETE", "url": "完整请求 URL", "headers": { }, "body": null 或对象, "expected": { "status": 期望状态码, "contains": "响应应包含的文本（可选）", "maxTimeMs": 毫秒上限（可选）, "jsonChecks": [{"path": "JSONPath 路径", "op": "eq|ne|gt|gte|lt|lte|contains|exists", "value": 期望值}] } }
要求：url 必须基于用户提供的接口 URL 拼接（如 /users/99999 表示不存在的 id）；jsonChecks 里的 JSONPath 用 $.xxx 格式；异常用例的 expected.status 要符合 REST 习惯（404/400/422）。
重要约束：
1. body/expected.value/contains 等所有字段必须是真实的 JSON 字符串/数字，禁止使用 .repeat() 等代码表达式（如不要写 "a".repeat(1000)）；表示超长输入时直接写 20-30 个实际字符（如 "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"）即可，重点是测边界行为
2. 输出必须是完整合法的 JSON，不要截断、不要省略号`

// 构造 DeepSeek 消息（导出便于单测）
export function buildMessages({ method, url, headers, body, description } = {}) {
  const interfaceInfo = {
    method: method || 'GET',
    url,
    headers: headers || {},
    body: body ?? null,
    description: description || '',
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '接口信息：\n' + JSON.stringify(interfaceInfo, null, 2) },
  ]
}

const VALID_METHODS = ['GET', 'POST', 'PUT', 'DELETE']
const VALID_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']

// 校验并归一化 AI 返回的用例数组（导出便于单测）。非法用例直接跳过，有效用例不足时抛友好错误。
export function normalizeCases(raw) {
  // 兼容：根为数组，或 {"cases": [...]}
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.cases) ? raw.cases : null
  if (!list || list.length === 0) throw new Error('AI 返回的用例为空或格式不正确')

  const valid = list.map(normalizeCase).filter(Boolean)
  if (valid.length < 3) {
    throw new Error(`AI 返回的有效用例过少（${valid.length} 条，不足 3 条），请重试`)
  }
  return valid
}

// 单条归一化：合法返回结构化用例，非法返回 null（跳过）
function normalizeCase(item) {
  if (!item || typeof item !== 'object') return null
  const name = String(item.name || '').trim()
  const method = String(item.method || 'GET').toUpperCase()
  const url = String(item.url || '').trim()
  // 缺 name/url 或 method 超出模型范围（AI 偶发返回 HEAD 等）→ 跳过
  if (!name || !url || !VALID_METHODS.includes(method)) return null

  const expected = item.expected && typeof item.expected === 'object' ? item.expected : {}
  const jsonChecks = Array.isArray(expected.jsonChecks)
    ? expected.jsonChecks
        .filter((c) => c && typeof c === 'object' && c.path && VALID_OPS.includes(c.op))
        .map((c) => ({ path: String(c.path), op: c.op, value: c.value }))
    : undefined

  const normalizedExpected = {}
  if (expected.status !== undefined && expected.status !== null) normalizedExpected.status = Number(expected.status) || 0
  if (expected.contains) normalizedExpected.contains = String(expected.contains)
  if (expected.maxTimeMs) normalizedExpected.maxTimeMs = Number(expected.maxTimeMs) || 0
  if (jsonChecks && jsonChecks.length) normalizedExpected.jsonChecks = jsonChecks

  const out = { name, method, url, headers: item.headers && typeof item.headers === 'object' ? item.headers : {} }
  if (item.body !== undefined && item.body !== null) out.body = item.body
  out.expected = normalizedExpected
  return out
}

export async function generateCases(input = {}) {
  const cases = await chatJSON(buildMessages(input))
  return normalizeCases(cases)
}
