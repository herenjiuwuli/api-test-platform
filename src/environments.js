// 环境变量集（M9）：把「打谁」从用例里拿出来，变成一处可切换的配置。
//
// 为什么需要它：平台原来只有 BASE 一个环境变量，而且**是在写用例时就被拼进 URL 里的** ——
//   `seed-oa-suite.mjs` 直接把 `http://127.0.0.1:3200` 烤进了 44 条用例的 url。
//   后果很实在：想打测试环境，就得把整套用例重新 seed 一遍（或者手改 44 条 URL）。
//   一个「能上 CI」的测试工具必须能回答「这次打的是哪个环境」，这一节就是那个答案。
//
// 方案：
//   ① 环境 = { name, baseUrl, headers, vars }；用例里写 `{{base}}/api/xxx` 而不是写死地址；
//   ② **同一时刻只有一个「当前环境」**，存在 settings 表里（而不是在 environments 上放 is_active 列）
//      —— 全局只能有一个的状态，放一行 KV 里，就不可能退化成「两个都是 active」；
//   ③ 运行前把环境变量灌进变量袋的**基线**位置，并把环境 headers 作为**默认请求头**。
//
// 设计取舍（都要能讲）：
//   - **优先级：环境 < 用例链抽到的变量**。环境是「你去哪」的基线；extract 抽到的是本次链上刚发生的
//     事实（比如刚登录拿到的 token）。基线盖掉事实，等于用过期 token 假装通过。
//   - **headers：环境是默认值，用例里手写的同名 header 优先**（大小写不敏感）。用例显式写了一个头，
//     那就是它的意图；环境只负责「这个环境所有请求都要带的那些」（比如灰度标 X-Env）。
//   - **baseUrl 归一化**：去掉尾部斜杠 + 必须 http/https。前者防 `{{base}}/api` 变成 `//api`，
//     后者把「地址写错」拦在保存时，而不是等到跑用例时报一个看不懂的 fetch failed。
//   - **vars 里不许叫 base**：`base` 由 baseUrl 派生，两个来源会打架 —— 直接 400 说清楚，别静默忽略。
import { getDb } from './db.js'

const ACTIVE_KEY = 'active_env_id'

// ---------------------------------------------------------------------------
// 归一化与校验
// ---------------------------------------------------------------------------

/** baseUrl 归一化：去空白、去尾部斜杠、只允许 http/https */
export function normalizeBaseUrl(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('环境地址（baseUrl）必填')
  if (!/^https?:\/\//i.test(raw)) throw new Error('环境地址必须以 http:// 或 https:// 开头')
  return raw.replace(/\/+$/, '')
}

/** 把「JSON 对象」类的字段读成对象；字符串会尝试 JSON.parse（前端表单传字符串时更宽容） */
function toObject(value, label) {
  if (value === undefined || value === null || value === '') return {}
  let obj = value
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value)
    } catch {
      throw new Error(`${label}必须是合法 JSON`)
    }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${label}必须是 JSON 对象（如 {"k":"v"}）`)
  return obj
}

function normalizeVars(value) {
  const vars = toObject(value, '环境变量')
  // 键和值统一成字符串：变量是要塞进 url/header 的，留着数字/布尔只会在渲染时出现奇怪的隐式转换
  const out = {}
  for (const [k, v] of Object.entries(vars)) {
    const name = String(k).trim()
    if (!name) throw new Error('环境变量名不能为空')
    if (name === 'base') throw new Error('环境变量名不能叫 base —— {{base}} 由环境地址派生，两个来源会打架')
    out[name] = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')
  }
  return out
}

function normalizeHeaders(value) {
  const headers = toObject(value, '环境请求头')
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    const name = String(k).trim()
    if (!name) throw new Error('请求头名不能为空')
    out[name] = String(v ?? '')
  }
  return out
}

function serialize(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    headers: JSON.parse(row.headers_json || '{}'),
    vars: JSON.parse(row.vars_json || '{}'),
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listEnvironments() {
  return getDb().prepare(`SELECT * FROM environments ORDER BY id ASC`).all().map(serialize)
}

export function getEnvironment(id) {
  const row = getDb().prepare(`SELECT * FROM environments WHERE id = ?`).get(Number(id))
  return serialize(row)
}

export function createEnvironment(input = {}) {
  const payload = normalizeInput(input)
  try {
    const info = getDb()
      .prepare(`INSERT INTO environments (name, base_url, headers_json, vars_json) VALUES (?, ?, ?, ?)`)
      .run(payload.name, payload.baseUrl, JSON.stringify(payload.headers), JSON.stringify(payload.vars))
    return getEnvironment(info.lastInsertRowid)
  } catch (e) {
    throw friendlyUniqueError(e)
  }
}

/** 部分更新：只用传入的字段覆盖，其余保持原值（与 updateCase 同一套语义） */
export function updateEnvironment(id, input = {}) {
  const existing = getEnvironment(id)
  if (!existing) return null
  const merged = normalizeInput({
    name: input.name !== undefined ? input.name : existing.name,
    baseUrl: input.baseUrl !== undefined ? input.baseUrl : existing.baseUrl,
    headers: input.headers !== undefined ? input.headers : existing.headers,
    vars: input.vars !== undefined ? input.vars : existing.vars,
  })
  try {
    getDb()
      .prepare(`UPDATE environments SET name=?, base_url=?, headers_json=?, vars_json=? WHERE id=?`)
      .run(merged.name, merged.baseUrl, JSON.stringify(merged.headers), JSON.stringify(merged.vars), existing.id)
  } catch (e) {
    throw friendlyUniqueError(e)
  }
  return getEnvironment(existing.id)
}

/**
 * 删除环境。删掉的如果是**当前环境**，就把当前环境清空（返回 activeCleared 让界面能提示），
 * 而不是拒绝删除 —— 拒绝会让人卡在「想删却删不掉」的状态里。
 */
export function deleteEnvironment(id) {
  const existing = getEnvironment(id)
  if (!existing) return null
  getDb().prepare(`DELETE FROM environments WHERE id = ?`).run(existing.id)
  const activeCleared = getActiveId() === existing.id
  if (activeCleared) setActiveEnvironment(null)
  return { deleted: true, activeCleared }
}

function normalizeInput(input) {
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('环境名必填')
  return {
    name,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    headers: normalizeHeaders(input.headers),
    vars: normalizeVars(input.vars),
  }
}

function friendlyUniqueError(e) {
  if (/UNIQUE/i.test(e.message)) return new Error('环境名已存在')
  return e
}

// ---------------------------------------------------------------------------
// 当前环境（全局只有一行）
// ---------------------------------------------------------------------------

function getSetting(key) {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key)
  return row ? row.value : null
}

function setSetting(key, value) {
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value === null || value === undefined ? '' : String(value))
}

export function getActiveId() {
  const raw = getSetting(ACTIVE_KEY)
  const id = Number(raw)
  if (!raw || !Number.isInteger(id) || id <= 0) return null
  return id
}

export function getActiveEnvironment() {
  const id = getActiveId()
  if (!id) return null
  const env = getEnvironment(id)
  // 环境被外部删掉了（比如直接改库）→ 当前环境视为空，不要返回一个半截对象
  if (!env) {
    setActiveEnvironment(null)
    return null
  }
  return env
}

/** 设当前环境；传 null / 0 / 不存在的 id 视为「取消当前环境」 */
export function setActiveEnvironment(id) {
  const env = id === null || id === undefined || id === '' ? null : getEnvironment(id)
  setSetting(ACTIVE_KEY, env ? env.id : null)
  return env
}

// ---------------------------------------------------------------------------
// 给执行引擎用的两样东西
// ---------------------------------------------------------------------------

/**
 * 环境变量袋子：`base` 由地址派生，再叠上用户自定义变量。
 * 用途：作为**运行期变量袋的初始值**（不是覆盖 —— see mergeVarBag）。
 */
export function environmentVarBag(env) {
  if (!env) return {}
  return { base: env.baseUrl, ...env.vars }
}

/**
 * 把环境变量灌进变量袋：**只填还没赋值的键**。
 * 这样同一次运行里，前面用例 extract 出来的值（如刚拿到的 token）不会被环境基线盖掉。
 */
export function mergeVarBag(bag, env) {
  const base = environmentVarBag(env)
  for (const [k, v] of Object.entries(base)) {
    if (bag[k] === undefined) bag[k] = v
  }
  return bag
}

/**
 * 合并请求头：环境头是默认值，**用例里手写的同名头优先**（名字大小写不敏感）。
 * 不区分大小写是必须的 —— 否则 `Content-Type` 和 `content-type` 会同时出现在一个请求里。
 */
export function mergeHeaders(envHeaders, caseHeaders) {
  const out = {}
  const put = (name, value) => {
    for (const k of Object.keys(out)) {
      if (k.toLowerCase() === name.toLowerCase()) delete out[k]
    }
    out[name] = value
  }
  for (const [k, v] of Object.entries(envHeaders || {})) put(k, v)
  for (const [k, v] of Object.entries(caseHeaders || {})) put(k, v)
  return out
}
