// 用例 CRUD（基于 db.js）。用例 = 一次 HTTP 测试的定义。
// 字段：name / method / url / headers / body / bodyType（M8）/ files（M8）
//      / expected(status, contains, maxTimeMs, jsonChecks)
//      / extract（M4：从本用例响应里按 JSONPath 抽变量，供链上后面的用例用）
import { getDb } from './db.js'
import { normalizeBodyType } from './bodyTypes.js'

export function createCase(input = {}) {
  const db = getDb()
  const name = String(input.name || '').trim()
  if (!name) throw new Error('用例 name 必填')
  if (!input.url) throw new Error('用例 url 必填')
  const stmt = db.prepare(
    `INSERT INTO test_cases (name, method, url, headers_json, body_json, body_type, files_json, expected_json, extract_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const info = stmt.run(
    name,
    (input.method || 'GET').toUpperCase(),
    input.url,
    JSON.stringify(input.headers || {}),
    input.body !== undefined ? JSON.stringify(input.body) : '',
    normalizeBodyType(input.bodyType),
    JSON.stringify(normalizeFiles(input.files)),
    JSON.stringify(input.expected || {}),
    JSON.stringify(normalizeExtract(input.extract)),
  )
  return getCase(info.lastInsertRowid)
}

export function listCases() {
  return getDb().prepare(`SELECT * FROM test_cases ORDER BY id DESC`).all().map(normalize)
}

export function getCase(id) {
  const row = getDb().prepare(`SELECT * FROM test_cases WHERE id = ?`).get(id)
  return row ? normalize(row) : null
}

// 部分更新：只更新传入的字段，未传字段保持原值；返回更新后的用例（不存在返回 null）
export function updateCase(id, input = {}) {
  const existing = getCase(id)
  if (!existing) return null
  const merged = {
    name: input.name !== undefined ? String(input.name).trim() : existing.name,
    method: input.method !== undefined ? String(input.method).toUpperCase() : existing.method,
    url: input.url !== undefined ? input.url : existing.url,
    headers: input.headers !== undefined ? input.headers : existing.headers,
    body: input.body !== undefined ? input.body : existing.body,
    bodyType: input.bodyType !== undefined ? normalizeBodyType(input.bodyType) : existing.bodyType,
    files: input.files !== undefined ? normalizeFiles(input.files) : existing.files,
    expected: input.expected !== undefined ? input.expected : existing.expected,
    extract: input.extract !== undefined ? normalizeExtract(input.extract) : existing.extract,
  }
  if (!merged.name) throw new Error('用例 name 必填')
  if (!merged.url) throw new Error('用例 url 必填')
  getDb()
    .prepare(
      `UPDATE test_cases SET name=?, method=?, url=?, headers_json=?, body_json=?, body_type=?, files_json=?, expected_json=?, extract_json=? WHERE id=?`,
    )
    .run(
      merged.name,
      merged.method,
      merged.url,
      JSON.stringify(merged.headers || {}),
      merged.body !== undefined ? JSON.stringify(merged.body) : '',
      merged.bodyType,
      JSON.stringify(normalizeFiles(merged.files)),
      JSON.stringify(merged.expected || {}),
      JSON.stringify(normalizeExtract(merged.extract)),
      id,
    )
  return getCase(id)
}

export function deleteCase(id) {
  return getDb().prepare(`DELETE FROM test_cases WHERE id = ?`).run(id).changes > 0
}

/**
 * 写一条执行记录。
 * `env` 是**运行时的环境快照**（{id,name,baseUrl} 或 null）—— 存快照而不是只存 env_id，
 * 这样以后改了环境地址，历史记录不会跟着被改写（「那次实际打的是哪个地址」必须留得住）。
 */
export function saveRun({ caseId, pass, status, durationMs, detail, env }) {
  const snapshot = env && env.baseUrl ? env : null
  getDb()
    .prepare(
      `INSERT INTO runs (case_id, pass, status, duration_ms, detail_json, env_id, env_name, base_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      caseId ?? null,
      pass ? 1 : 0,
      status || 0,
      durationMs || 0,
      JSON.stringify(detail || []),
      snapshot ? snapshot.id ?? null : null,
      snapshot ? snapshot.name || '' : '',
      snapshot ? snapshot.baseUrl : '',
    )
}

// 把数据库行（JSON 字符串字段）还原成结构化用例
function normalize(row) {
  return {
    id: row.id,
    name: row.name,
    method: row.method,
    url: row.url,
    headers: safeParse(row.headers_json, {}),
    body: row.body_json ? safeParse(row.body_json, null) : undefined,
    bodyType: normalizeBodyType(row.body_type),
    files: safeParse(row.files_json, []),
    expected: safeParse(row.expected_json, {}),
    extract: safeParse(row.extract_json, []),
    createdAt: row.created_at,
  }
}

// files 只留合法项：必须有 name，且**至少**给了 fixture 或 base64 之一（否则就是个发不出去的空壳）
function normalizeFiles(files) {
  if (!Array.isArray(files)) return []
  return files
    .filter((f) => f && typeof f.name === 'string' && f.name.trim() && (f.fixture || f.base64))
    .map((f) => {
      const out = { name: f.name.trim() }
      if (f.fixture) out.fixture = String(f.fixture).trim()
      if (f.base64) out.base64 = String(f.base64)
      if (f.filename) out.filename = String(f.filename).trim()
      if (f.contentType) out.contentType = String(f.contentType).trim()
      return out
    })
}

// extract 只留合法项（有 name 有 path），挡住手抖写错的结构进库
function normalizeExtract(extract) {
  if (!Array.isArray(extract)) return []
  return extract
    .filter((e) => e && typeof e.name === 'string' && e.name.trim() && typeof e.path === 'string' && e.path.trim())
    .map((e) => ({ name: e.name.trim(), path: e.path.trim() }))
}

function safeParse(s, fallback) {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}
