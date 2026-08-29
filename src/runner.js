// 核心：HTTP 用例执行引擎。一次用例 = 发一个请求 + 按 expected 断言。
// 这是「API 自动化测试平台」的心脏，定时任务/报告都建立在它之上。
import { saveRun } from './cases.js'
import { jsonPathGet } from './jsonpath.js'

/**
 * 执行单个用例。
 * @param {{name?:string,method?:string,url:string,headers?:object,body?:any,expected?:{status?:number,contains?:string,maxTimeMs?:number,jsonChecks?:Array<{path:string,op:string,value?:any}>}}} def
 * @param {{persist?:boolean}} opts persist=true 时把结果写 runs 表
 * jsonChecks op 支持：eq / ne / gt / gte / lt / lte / contains / exists
 * 多匹配（[*]）时按首个匹配值断言；exists 只判断是否有匹配。
 */
export async function runCase(def, { persist = true } = {}) {
  const started = performance.now()
  try {
    const res = await fetch(def.url, {
      method: (def.method || 'GET').toUpperCase(),
      headers: def.headers,
      body: def.body !== undefined ? JSON.stringify(def.body) : undefined,
    })
    const status = res.status
    const text = await res.text()
    const durationMs = Math.round(performance.now() - started)

    const exp = def.expected || {}
    const detail = []
    let pass = true

    if (exp.status !== undefined && status !== exp.status) {
      pass = false
      detail.push(`状态码期望 ${exp.status}，实际 ${status}`)
    }
    if (exp.contains !== undefined && !text.includes(exp.contains)) {
      pass = false
      detail.push(`响应体未包含「${exp.contains}」`)
    }
    if (exp.maxTimeMs !== undefined && durationMs > exp.maxTimeMs) {
      pass = false
      detail.push(`耗时 ${durationMs}ms 超过上限 ${exp.maxTimeMs}ms`)
    }
    // JSONPath 断言（M3）：解析响应 JSON 后逐条求值
    if (Array.isArray(exp.jsonChecks) && exp.jsonChecks.length) {
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      for (const check of exp.jsonChecks) {
        if (!check || !check.path) continue
        if (parsed === null) {
          pass = false
          detail.push(`JSONPath 断言「${check.path}」失败：响应不是合法 JSON`)
          continue
        }
        const vals = jsonPathGet(parsed, check.path)
        const first = vals.length ? vals[0] : undefined
        if (!evalJsonCheck(first, vals.length, check)) {
          pass = false
          detail.push(
            `JSONPath ${check.path} ${check.op} ${JSON.stringify(check.value)} 不成立（实际 ${JSON.stringify(first)}）`,
          )
        }
      }
    }

    const result = { pass, status, durationMs, detail, bodyPreview: text.slice(0, 200) }
    if (persist) saveRun({ caseId: def.id, pass, status, durationMs, detail })
    return result
  } catch (e) {
    const durationMs = Math.round(performance.now() - started)
    const result = { pass: false, status: 0, durationMs, detail: [e.message], error: true }
    if (persist) saveRun({ caseId: def.id, pass: false, status: 0, durationMs, detail: [e.message] })
    return result
  }
}

// JSONPath 断言求值：首匹配值 + 匹配数
function evalJsonCheck(first, count, { op, value }) {
  switch (op) {
    case 'exists':
      return count > 0
    case 'eq':
      return looseEq(first, value)
    case 'ne':
      return !looseEq(first, value)
    case 'gt':
      return numeric(first) > numeric(value)
    case 'gte':
      return numeric(first) >= numeric(value)
    case 'lt':
      return numeric(first) < numeric(value)
    case 'lte':
      return numeric(first) <= numeric(value)
    case 'contains':
      return String(first).includes(String(value))
    default:
      return false
  }
}

function looseEq(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return String(a) === String(b)
}

function numeric(x) {
  const n = Number(x)
  return Number.isNaN(n) ? NaN : n
}

/**
 * 批量执行（顺序），返回带 caseId/name 的结果数组。
 */
export async function runAll(cases, opts = {}) {
  const results = []
  for (const c of cases) {
    results.push({ caseId: c.id, name: c.name, ...(await runCase(c, opts)) })
  }
  return results
}
