// 核心：HTTP 用例执行引擎。一次用例 = 发一个请求 + 按 expected 断言。
// 这是「API 自动化测试平台」的心脏，后续 M2+ 的定时任务/报告都建立在它之上。
import { saveRun } from './cases.js'

/**
 * 执行单个用例。
 * @param {{name?:string,method?:string,url:string,headers?:object,body?:any,expected?:{status?:number,contains?:string,maxTimeMs?:number}}} def
 * @param {{persist?:boolean}} opts persist=true 时把结果写 runs 表
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
