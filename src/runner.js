// 核心：HTTP 用例执行引擎。一次用例 = 发一个请求 + 按 expected 断言。
// 这是「API 自动化测试平台」的心脏，定时任务/报告都建立在它之上。
//
// M4：支持用例链 —— url/headers/body 里的 {{var}} 会先用变量袋渲染，
//     响应回来后按 def.extract 抽值**写回同一个变量袋**，供链上下一个用例使用。
// M8：支持请求体类型 —— json（默认）/ raw（原样发文本）/ form-data（手搓 multipart，可带内置夹具文件）。
// M9：支持环境变量集 —— 当前环境提供 `{{base}}` 与自定义变量（**基线**，不覆盖链上抽到的值），
//     并提供默认请求头（用例里手写的同名头优先）。三条运行路径（单跑 / run-all / 定时）都走这里，所以只用改一处。
import { saveRun } from './cases.js'
import { normalizeBodyType } from './bodyTypes.js'
import { getActiveEnvironment, mergeHeaders, mergeVarBag } from './environments.js'
import { jsonPathGet } from './jsonpath.js'
import { buildMultipart, resolveFiles, toFields, unknownFixtureMessage } from './multipart.js'
import { applyExtract, createVarBag, missingVarNote, renderTemplate } from './vars.js'

/**
 * 执行单个用例。
 * @param {{id?:number,name?:string,method?:string,url:string,headers?:object,body?:any,
 *          bodyType?:'json'|'raw'|'form-data',files?:Array<{name:string,fixture?:string,base64?:string,filename?:string,contentType?:string}>,
 *          expected?:{status?:number,contains?:string,maxTimeMs?:number,jsonChecks?:Array<{path:string,op:string,value?:any}>,
 *                     headers?:Array<{name:string,op:'exists'|'eq'|'contains',value?:any}>},
 *          extract?:Array<{name:string,path:string}>}} def
 * @param {{persist?:boolean,vars?:Record<string,string>,env?:object|null}} opts persist=true 时把结果写 runs 表；
 *        vars 是**共享变量袋**（run-all 会一直传同一个，单跑不传则用临时空袋）；
 *        env 不传 = 用当前环境；传 null = 显式不用环境（测试用）
 * jsonChecks op 支持：eq / ne / gt / gte / lt / lte / contains / exists
 * 多匹配（[*]）语义：contains = 任一命中；exists = 有无匹配；其余按首个匹配值断言。
 * headers（M14）op 支持：exists（在不在）/ eq（值全等）/ contains（值含子串）
 */
export async function runCase(def, { persist = true, vars, env } = {}) {
  const started = performance.now()
  const bag = vars || createVarBag()
  // 环境变量灌成**基线**：只填还没赋值的键，别盖掉链上前面用例 extract 出来的值
  const activeEnv = env !== undefined ? env : getActiveEnvironment()
  mergeVarBag(bag, activeEnv)
  // 「谁没赋值」必须在**发请求之前**算出来并留好 —— 因为它最常导致的后果就是请求本身发不出去
  // （{{base}} 没赋值 → url 变成 "/whoami" → fetch 直接抛 "Failed to parse URL"）。
  // 早期只把它塞进成功分支的 detail，于是 catch 分支只剩一句 fetch 的原始报错，
  // 恰好把最有用的线索弄丢了（用真环境打用例时踩到的）。
  let missingNote = null
  try {
    // ① 先渲染模板：把 {{token}} 之类的占位换成变量袋里的实际值（文件名里也允许写变量）
    const url = renderTemplate(def.url, bag)
    // 请求头：环境头是默认值，用例里手写的同名头优先（大小写不敏感）
    const headers = renderTemplate(mergeHeaders(activeEnv ? activeEnv.headers : {}, def.headers || {}), bag)
    const body = def.body !== undefined ? renderTemplate(def.body, bag) : undefined
    const files = renderTemplate(def.files || [], bag)
    const missing = [
      ...new Set([...url.missing, ...headers.missing, ...(body ? body.missing : []), ...files.missing]),
    ]
    missingNote = missingVarNote(missing)

    // ② 按请求体类型组装真正发出去的东西（form-data 会接管 Content-Type / Content-Length）
    const req = buildRequest({ def, headers: headers.value, body, files })
    const res = await fetch(url.value, {
      method: (def.method || 'GET').toUpperCase(),
      headers: req.headers,
      body: req.body,
    })
    const status = res.status
    // ⚠️ 必须**自己按字节解码**，不能用 `res.text()` —— Fetch 规范的 text() 会按 UTF-8
    //    「decode with BOM removal」把**开头的 BOM 吃掉**。于是「导出的 CSV 有没有带 BOM」
    //    这类断言永远写不出来（写 `contains: '\ufeff…'` 会永远假失败，且看不出为什么）。
    //    实测踩到：M14 补头断言时顺手写的 BOM 用例红了，才发现请求本身是对的、是被解码环节吃掉的。
    //    代价：解析 JSON 的地方要自己剥一下 BOM 前缀（见 jsonText）。
    const rawBytes = Buffer.from(await res.arrayBuffer())
    const text = rawBytes.toString('utf8')
    /** 只在「解析」时剥 BOM：`text` 保留 BOM 供 contains 断言，JSON.parse 则不接受前置 BOM */
    const jsonText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    // 响应头（M14）。以前这里只取 body —— 于是「导出一个 CSV，Content-Type 对不对、
    // Content-Disposition 有没有、BOM 在不在」这类断言**根本写不出来**。
    // 能力边界是被 office-oa 的导出功能逼出来的（同 M8 的 multipart）。
    // 摊平成小写键的对象：查头名大小写不敏感（HTTP 头本来就不区分大小写）。
    const responseHeaders = Object.fromEntries(res.headers.entries())
    const durationMs = Math.round(performance.now() - started)

    const exp = def.expected || {}
    const detail = []
    let pass = true

    // 变量没赋值不判失败（请求本身也会失败），但必须写明来源，否则排障时容易误判成被测系统的问题
    const note = missingNote
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
        parsed = JSON.parse(jsonText) // 用剥过 BOM 的文本：JSON.parse 不接受前置 BOM
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

    // 响应头断言（M14）：expected.headers = [{name, op, value}]
    // 三个操作符的语义，和 JSON 断言刻意保持一致（同一套心智，不用记两套）：
    //   exists   → 这个头在不在（不看值）
    //   eq       → 值全等
    //   contains → 值包含子串（如 content-type 只关心是不是 text/csv、后面带不带 charset）
    if (Array.isArray(exp.headers) && exp.headers.length) {
      for (const check of exp.headers) {
        if (!check || !check.name) continue
        const key = String(check.name).toLowerCase()
        const actual = responseHeaders[key] // 头名不区分大小写，所以统一下标查找
        if (!evalHeaderCheck(actual, check)) {
          pass = false
          detail.push(
            `响应头 ${check.name} ${check.op} ${JSON.stringify(check.value)} 不成立（实际 ${
              actual === undefined ? '不存在' : JSON.stringify(actual)
            }）`,
          )
        }
      }
    }

    // ② 抽变量：无论断言成不成功都抽（有些接口「失败响应里也带信息」，比如 401 里的 reason）
    const extracted = applyExtract(jsonText, def.extract)
    Object.assign(bag, extracted)

    const result = {
      pass,
      status,
      durationMs,
      detail,
      extracted,
      bodyPreview: text.slice(0, 200),
      // 带上实际响应头：头断言红了的时候，「期望 X 实际没有」和「实际是别的东西」是两种问题，
      // 光看 detail 那句话分不清（尤其是一个头出现过又消失的场景）
      headers: responseHeaders,
      // 这条用例是在哪个环境上跑的 —— 结果里带上，报告才说得清「这次打的是谁」
      env: envSnapshot(activeEnv),
    }
    if (persist) saveRun({ caseId: def.id, pass, status, durationMs, detail, env: activeEnv })
    return result
  } catch (e) {
    const durationMs = Math.round(performance.now() - started)
    // 把「谁没赋值」放在最前面：读报告的人应该先看到「是变量缺了」，再看到 fetch 的原始报错
    const detail = missingNote ? [missingNote, e.message] : [e.message]
    const result = { pass: false, status: 0, durationMs, detail, error: true, env: envSnapshot(activeEnv) }
    if (persist) saveRun({ caseId: def.id, pass: false, status: 0, durationMs, detail, env: activeEnv })
    return result
  }
}

/** 环境快照：只留会写进记录的那三个字段，避免把整份环境对象（含 headers/vars）带进响应 */
export function envSnapshot(env) {
  if (!env || !env.baseUrl) return null
  return { id: env.id ?? null, name: env.name || '', baseUrl: env.baseUrl }
}

// ---------------------------------------------------------------------------
// 请求体组装（M8）
// ---------------------------------------------------------------------------

/**
 * 按 bodyType 组装真正发出去的 {headers, body}。
 * @param {{def:object, headers:object, body?:{value:*,missing:string[]}, files:{value:Array}}} p
 */
function buildRequest({ def, headers, body, files }) {
  const out = { ...headers }
  const type = normalizeBodyType(def.bodyType)

  if (type === 'form-data') {
    const { files: parts, unknown } = resolveFiles(files ? files.value : [])
    // 夹具名写错要当场报清楚：静默发一个空文件出去，会让人以为「上传接口有 bug」
    if (unknown.length) throw new Error(unknownFixtureMessage(unknown))
    const built = buildMultipart(toFields(body ? body.value : undefined), parts)
    // ★ multipart 的 Content-Type 必须带 boundary，所以这里**覆盖**用例里手填的那个；
    //   同时自己算 Content-Length —— 请求体是二进制，让运行时去猜长度不如直接给。
    setHeader(out, 'Content-Type', built.contentType)
    setHeader(out, 'Content-Length', String(built.body.length))
    return { headers: out, body: built.body }
  }

  if (body === undefined) return { headers: out, body: undefined }
  return { headers: out, body: type === 'raw' ? String(body.value) : JSON.stringify(body.value) }
}

// header 名大小写不敏感：先删掉同名的（任意大小写）再设，避免同时出现 Content-Type 和 content-type
function setHeader(headers, name, value) {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) delete headers[k]
  }
  headers[name] = value
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

// 响应头断言求值（M14）。
// 语义与 evalJsonCheck 保持一致：exists = 在不在；eq = 全等；contains = 包含子串。
// ⚠️ 头不存在时：eq / contains 一定失败（拿 undefined 比什么都是假的），exists 失败 —— 也就是「默认严格」。
function evalHeaderCheck(actual, { op, value }) {
  switch (op) {
    case 'exists':
      return actual !== undefined
    case 'eq':
      return actual !== undefined && String(actual) === String(value)
    case 'contains':
      return actual !== undefined && String(actual).includes(String(value))
    default:
      return false
  }
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
