// 用例 CRUD（基于 db.js）。用例 = 一次 HTTP 测试的定义。
// 字段：name / method / url / headers / body / expected(status, contains, maxTimeMs)
import { getDb } from './db.js'

export function createCase(input = {}) {
  const db = getDb()
  const name = String(input.name || '').trim()
  if (!name) throw new Error('用例 name 必填')
  if (!input.url) throw new Error('用例 url 必填')
  const stmt = db.prepare(
    `INSERT INTO test_cases (name, method, url, headers_json, body_json, expected_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const info = stmt.run(
    name,
    (input.method || 'GET').toUpperCase(),
    input.url,
    JSON.stringify(input.headers || {}),
    input.body !== undefined ? JSON.stringify(input.body) : '',
    JSON.stringify(input.expected || {}),
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
    expected: input.expected !== undefined ? input.expected : existing.expected,
  }
  if (!merged.name) throw new Error('用例 name 必填')
  if (!merged.url) throw new Error('用例 url 必填')
  getDb()
    .prepare(
      `UPDATE test_cases SET name=?, method=?, url=?, headers_json=?, body_json=?, expected_json=? WHERE id=?`,
    )
    .run(
      merged.name,
      merged.method,
      merged.url,
      JSON.stringify(merged.headers || {}),
      merged.body !== undefined ? JSON.stringify(merged.body) : '',
      JSON.stringify(merged.expected || {}),
      id,
    )
  return getCase(id)
}

export function deleteCase(id) {
  return getDb().prepare(`DELETE FROM test_cases WHERE id = ?`).run(id).changes > 0
}

export function saveRun({ caseId, pass, status, durationMs, detail }) {
  getDb()
    .prepare(
      `INSERT INTO runs (case_id, pass, status, duration_ms, detail_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(caseId ?? null, pass ? 1 : 0, status || 0, durationMs || 0, JSON.stringify(detail || []))
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
    expected: safeParse(row.expected_json, {}),
    createdAt: row.created_at,
  }
}

function safeParse(s, fallback) {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}
