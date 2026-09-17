// 套件导出 / 导入（M11）：让「测试资产」能从一个库搬到另一个库。
//
// 为什么需要它：M7 之后平台里有了一条 44 条的 office-oa 用例链，但它是**长在这个库里的** ——
//   想发给别人、想换台机器跑、想在 CI 上用，都只能重新 seed 一遍（甚至重写一遍）。
//   测试资产要是带不走，那它就只是本地状态，不是资产。
//
// 三个要想清楚的点（都要能讲）：
//
//   ① **导出不带 id。** id 是本地自增的，换一个库就指向别的东西了 ——
//      带过去只会让「导入后按顺序串链」错位。文件里也不带 created_at（那是本地事实）。
//
//   ② **敏感请求头必须脱敏。** 环境里的 Authorization / Cookie 装的是**凭据**，
//      而导出文件的用途恰恰是"被分享"（发同事、进仓库、贴 issue）——
//      原样打出去是最典型的凭据泄漏姿势。
//      做法：值抹成空串，但**键名保留 + 在文件里列出被抹掉的头名**。
//      只删键不报信，使用者导入后只会拿到一堆莫名的 401；留个标记他才知道该补什么。
//      导入时反过来：名字敏感但值是空的头，认定为"脱敏留下的壳"，丢掉并记一条 warning。
//
//      ⚠️ **但"敏感"看的是值，不是键名**（这条是写测试时被抓出来的）：
//      `X-Token: {{token}}` 的值是**变量占位符**，真实凭据是运行期从链上抽出来的 ——
//      它不是被硬编码在文件里的秘密，抹掉它反而把串链弄断了（导入后第二条用例不带 token，
//      靶子返回空串，断言红）。所以判据是「键名敏感 **且** 值里没有 {{}} 占位」。
//
//   ③ **重名要有策略，而且默认策略要安全。** 同名用例/环境撞上时：
//      `skip`（留旧的）/ `overwrite`（用新的盖掉）/ `rename`（两个都留，新的加后缀）。
//      默认 **rename** —— 它既不会悄悄丢你的数据，也不会悄悄覆盖你的数据。
//      另外导入是**逐条**的：一条坏了不影响其余，坏的那条进 `failed` 里说清楚原因，
//      而不是整个文件 400 打回（一个 43/44 的文件不该因为第 44 条就全丢）。
import { createCase, listCases, updateCase } from './cases.js'
import { createEnvironment, listEnvironments, updateEnvironment } from './environments.js'

export const SUITE_KIND = 'api-test-platform-suite'
export const SUITE_VERSION = 1

/** 这些头里装的是凭据，导出时值一律抹掉 */
const SENSITIVE_HEADER = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-token)$/i

/** 值里出现 {{var}} 说明它是**运行期才求值的占位符**，不是硬编码在文件里的秘密 */
const TEMPLATE_PLACEHOLDER = /\{\{\s*[^}]+?\s*\}\}/

export function isSensitiveHeader(name) {
  return SENSITIVE_HEADER.test(String(name ?? '').trim())
}

export function hasTemplatePlaceholder(value) {
  return TEMPLATE_PLACEHOLDER.test(String(value ?? ''))
}

/**
 * 导出方向：把敏感头的**值**抹成空串，并回报抹掉了哪些（键名要留，使用者才知道该补什么）。
 * 判据是「键名敏感 **且** 值是字面量」——
 * `Authorization: {{token}}` 这种要原样带出去：抹掉它不会更安全，只会把串链弄断。
 */
export function redactHeaders(headers) {
  const out = {}
  const redacted = []
  for (const [k, v] of Object.entries(headers || {})) {
    if (isSensitiveHeader(k) && !hasTemplatePlaceholder(v)) {
      out[k] = ''
      redacted.push(k)
    } else {
      out[k] = v
    }
  }
  return { headers: out, redacted }
}

/** 导入方向：名字敏感但值是空的头，认定为脱敏留下的壳 —— 丢掉并记一条 warning */
function dropBlankSensitive(headers, warnings, where) {
  const out = {}
  const dropped = []
  for (const [k, v] of Object.entries(headers || {})) {
    if (isSensitiveHeader(k) && String(v ?? '') === '') {
      dropped.push(k)
      continue
    }
    out[k] = v
  }
  if (dropped.length) {
    warnings.push(`${where}：${dropped.join('、')} 的值在导出时被脱敏成空串，已跳过这两个头；导入后请补上真实凭据`)
  }
  return out
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export function exportSuite() {
  const environments = listEnvironments().map((env) => {
    const { headers, redacted } = redactHeaders(env.headers)
    return {
      name: env.name,
      baseUrl: env.baseUrl,
      headers,
      vars: env.vars,
      ...(redacted.length ? { redactedHeaders: redacted } : {}),
    }
  })

  // ⚠️ 顺序很关键：用例是**按创建顺序**串链跑的（M7 的 run-all 依赖这个），
  // 而 listCases() 是按 id **倒序**返回的（列表页要新在前）。
  // 直接导出会导致导入后链上 extract 出来的变量跑到「用它的那条用例」后面 —— 链条静默断掉。
  // 所以这里显式按 id 升序排一遍。
  const cases = [...listCases()]
    .sort((a, b) => a.id - b.id)
    .map((c) => {
      const { headers, redacted } = redactHeaders(c.headers)
      return {
        name: c.name,
        method: c.method,
        url: c.url,
        headers,
        body: c.body,
        bodyType: c.bodyType,
        files: c.files,
        expected: c.expected,
        extract: c.extract,
        ...(redacted.length ? { redactedHeaders: redacted } : {}),
      }
    })

  const fileBytes = cases.reduce(
    (n, c) => n + (c.files || []).reduce((m, f) => m + String(f.base64 || '').length, 0),
    0,
  )

  return {
    kind: SUITE_KIND,
    version: SUITE_VERSION,
    exportedAt: new Date().toISOString(),
    note: '不含 id（本地自增，跨库无意义）；敏感请求头（Authorization / Cookie 等）的值已抹成空串，导入后需补上。用例顺序 = 串链顺序。',
    counts: { environments: environments.length, cases: cases.length, fixtureBase64Chars: fileBytes },
    environments,
    cases,
  }
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

export function normalizeOnConflict(value) {
  const s = String(value ?? 'rename').toLowerCase()
  return ['skip', 'overwrite', 'rename'].includes(s) ? s : 'rename'
}

export function validateSuite(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: '导入内容必须是一个 JSON 对象' }
  }
  if (payload.kind !== SUITE_KIND) {
    return {
      ok: false,
      error: `这不是本平台的套件文件：kind 应为 "${SUITE_KIND}"，实际是 "${payload.kind ?? '空'}"`,
    }
  }
  const v = Number(payload.version)
  if (!Number.isInteger(v) || v < 1 || v > SUITE_VERSION) {
    return { ok: false, error: `不支持的套件版本 ${payload.version}（本平台当前支持 1 ~ ${SUITE_VERSION}）` }
  }
  if (!Array.isArray(payload.cases) && !Array.isArray(payload.environments)) {
    return { ok: false, error: '套件里既没有 cases 也没有 environments，没什么可导入的' }
  }
  return { ok: true }
}

/** 生成一个没被占用的名字：`登录` → `登录 (2)` → `登录 (3)` … */
function uniqueName(base, taken) {
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base} (${i})`)) i++
  return `${base} (${i})`
}

/**
 * 导入套件。
 * @returns 永不抛错：坏文件返回 `{ok:false,error}`，坏条目进 `failed`，其余照常导入。
 */
export function importSuite(payload, options = {}) {
  const check = validateSuite(payload)
  if (!check.ok) return { ok: false, error: check.error }

  const onConflict = normalizeOnConflict(options.onConflict)
  const result = {
    ok: true,
    onConflict,
    created: 0,
    updated: 0,
    skipped: 0,
    renamed: 0,
    imported: 0,
    failed: [],
    warnings: [],
    caseIds: [],
    environmentIds: [],
  }

  importEnvironments(payload.environments, onConflict, result)
  // 先环境后用例：用例里的 `{{base}}` 要靠环境才有意义，先落地环境更贴近文件作者的意图
  importCases(payload.cases, onConflict, result)

  result.imported = result.created + result.updated
  return result
}

function importEnvironments(list, onConflict, result) {
  if (!Array.isArray(list) || !list.length) return
  const byName = new Map(listEnvironments().map((e) => [e.name, e]))
  const taken = new Set(byName.keys())

  for (const raw of list) {
    const name = String(raw?.name ?? '').trim()
    try {
      if (!name) throw new Error('环境名必填')
      const headers = dropBlankSensitive(raw?.headers, result.warnings, `环境「${name}」`)
      const payload = { baseUrl: raw?.baseUrl, headers, vars: raw?.vars }
      const existing = byName.get(name)

      if (!existing) {
        const created = createEnvironment({ name, ...payload })
        byName.set(name, created)
        taken.add(name)
        result.created++
        result.environmentIds.push(created.id)
      } else if (onConflict === 'skip') {
        result.skipped++
      } else if (onConflict === 'overwrite') {
        const updated = updateEnvironment(existing.id, payload)
        result.updated++
        result.environmentIds.push(updated.id)
      } else {
        const newName = uniqueName(name, taken)
        const created = createEnvironment({ name: newName, ...payload })
        byName.set(newName, created)
        taken.add(newName)
        result.created++
        result.renamed++
        result.environmentIds.push(created.id)
      }
    } catch (e) {
      result.failed.push({ kind: 'environment', name: name || '(未命名)', reason: e.message })
    }
  }
}

function importCases(list, onConflict, result) {
  if (!Array.isArray(list) || !list.length) return
  const byName = new Map(listCases().map((c) => [c.name, c]))
  const taken = new Set(byName.keys())

  for (const raw of list) {
    const name = String(raw?.name ?? '').trim()
    try {
      if (!name) throw new Error('用例名称必填')
      if (!raw?.url) throw new Error('用例 url 必填（没有 url 就无法执行）')
      const headers = dropBlankSensitive(raw?.headers, result.warnings, `用例「${name}」`)
      const payload = {
        method: raw.method,
        url: raw.url,
        headers,
        body: raw.body,
        bodyType: raw.bodyType,
        files: raw.files,
        expected: raw.expected,
        extract: raw.extract,
      }
      const existing = byName.get(name)

      if (!existing) {
        const created = createCase({ name, ...payload })
        byName.set(name, created)
        taken.add(name)
        result.created++
        result.caseIds.push(created.id)
      } else if (onConflict === 'skip') {
        result.skipped++
      } else if (onConflict === 'overwrite') {
        const updated = updateCase(existing.id, payload)
        result.updated++
        result.caseIds.push(updated.id)
      } else {
        const newName = uniqueName(name, taken)
        const created = createCase({ name: newName, ...payload })
        byName.set(newName, created)
        taken.add(newName)
        result.created++
        result.renamed++
        result.caseIds.push(created.id)
      }
    } catch (e) {
      result.failed.push({ kind: 'case', name: name || '(未命名)', reason: e.message })
    }
  }
}
