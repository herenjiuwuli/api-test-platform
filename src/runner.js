// 核心：HTTP 用例执行引擎。一次用例 = 发一个请求 + 按 expected 断言。
// 这是「API 自动化测试平台」的心脏，定时任务/报告都建立在它之上。
//
// M4：支持用例链 —— url/headers/body 里的 {{var}} 会先用变量袋渲染，
//     响应回来后按 def.extract 抽值**写回同一个变量袋**，供链上下一个用例使用。
import { saveRun } from './cases.js'
import { jsonPathGet } from './jsonpath.js'
import { applyExtract, createVarBag, missingVarNote, renderTemplate } from './vars.js'

/**
 * 执行单个用例。
 * @param {{id?:number,name?:string,method?:string,url:string,headers?:object,body?:any,
 *          expected?:{status?:number,contains?:string,maxTimeMs?:number,jsonChecks?:Array<{path:string,op:string,value?:any}>},
 *          extract?:Array<{name:string,path:string}>}} def
 * @param {{persist?:boolean,vars?:Record<string,string>}} opts persist=true 时把结果写 runs 表；
 *        vars 是**共享变量袋**（run-all 会一直传同一个，单跑不传则用临时空袋）
 * jsonChecks op 支持：eq / ne / gt / gte / lt / lte / contains / exists
 * 多匹配（[*]）语义：contains = 任一命中；exists = 有无匹配；其余按首个匹配值断言。
 */
export async function runCase(def, { persist = true, vars } = {}) {
  const started = performance.now()
  const bag = vars || {}
  try {
    // ① 先渲染模板：把 {{token}} 之类的占位换成变量袋里的实际值
    const url = renderTemplate(def.url, bag)
    const headers = renderTemplate(def.headers || {}, bag)
    const body = def.body !== undefined ? renderTemplate(def.body, bag) : undefined
    const missing = [...new Set([...url.missing, ...headers.missing, ...(body ? body.missing : [])])]

    const res = await fetch(url.value, {
      method: (def.method || 'GET').toUpperCase(),
      headers: headers.value,
      body: body !== undefined ? JSON.stringify(body.value) : undefined,
    })
    const status = res.status
    const text = await res.text()
    const durationMs = Math.round(performance.now() - started)

    const exp = def.expected || {}
    const detail = []
    let pass = true

    // 变量没赋值不判失败（请求本身也会失败），但必须写明来源，否则排障时容易误判成被测系统的问题
    const note = missingVarNote(missing)
    if (note) detail.push(note)

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
        if (!evalJsonCheck(first, vals, check)) {
          pass = false
          detail.push(
            `JSONPath ${check.path} ${check.op} ${JSON.stringify(check.value)} 不成立（匹配 ${vals.length} 个，首个 ${JSON.stringify(first)}）`,
          )
        }
      }
    }

    // ② 抽变量：无论断言成不成功都抽（有些接口「失败响应里也带信息」，比如 401 里的 reason）
    const extracted = applyExtract(text, def.extract)
    Object.assign(bag, extracted)

    const result = {
      pass,
      status,
      durationMs,
      detail,
      extracted,
      bodyPreview: text.slice(0, 200),
    }
    if (persist) saveRun({ caseId: def.id, pass, status, durationMs, detail })
    return result
  } catch (e) {
    const durationMs = Math.round(performance.now() - started)
    const result = { pass: false, status: 0, durationMs, detail: [e.message], error: true }
    if (persist) saveRun({ caseId: def.id, pass: false, status: 0, durationMs, detail: [e.message] })
    return result
  }
}

// JSONPath 断言求值
// ★ 多匹配（用了 [*]）时的语义必须写清楚，否则「数组里有没有某个值」这种断言会假失败：
//   - contains：**任一**匹配命中即通过。这是测「数组里包含某元素」的唯一正确语义 ——
//     曾经它只看首个匹配，于是 $.permissions[*] contains 'user:read'
//     会因为数组第一个元素是 announcement:write 而判失败（用真系统测出来的语义坑）。
//   - exists：只看有没有匹配。
//   - 其余操作符（eq/ne/gt/gte/lt/lte）：按**首个**匹配值断言。
function evalJsonCheck(first, vals, { op, value }) {
  switch (op) {
    case 'exists':
      return vals.length > 0
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
      return vals.some((v) => String(v).includes(String(value)))
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
 *
 * ⚠️ 顺序有意义：用例链靠「前面的用例抽变量、后面的用例用变量」串起来，
 * 所以这里**必须顺序跑**，并且默认**共享同一个变量袋**（不要改成 Promise.all 并发）。
 * 想隔离可以用 opts.vars 自己传一个袋子。
 */
export async function runAll(cases, opts = {}) {
  const vars = opts.vars || createVarBag()
  const results = []
  for (const c of cases) {
    results.push({ caseId: c.id, name: c.name, ...(await runCase(c, { ...opts, vars })) })
  }
  return results
}
