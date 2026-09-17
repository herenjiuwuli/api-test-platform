// 用例 CRUD（基于 db.js）。用例 = 一次 HTTP 测试的定义。
// 字段：name / method / url / headers / body / bodyType（M8）/ files（M8）
//      / expected(status, contains, maxTimeMs, jsonChecks)
//      / extract（M4：从本用例响应里按 JSONPath 抽变量，供链上后面的用例用）
//      / group（M12：业务分组标签，如「审批引擎」「站内通知」，用于筛选/按组跑/报告）
import { getDb } from './db.js'
import { normalizeBodyType } from './bodyTypes.js'

export function createCase(input = {}) {
  const db = getDb()
  const name = String(input.name || '').trim()
  if (!name) throw new Error('用例 name 必填')
  if (!input.url) throw new Error('用例 url 必填')
  const stmt = db.prepare(
    `INSERT INTO test_cases (name, method, url, headers_json, body_json, body_type, files_json, expected_json, extract_json, "group")
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    String(input.group || '').trim(),
  )
  return getCase(info.lastInsertRowid)
}

// 可选 group 参数：传了（非空字符串）就只返回该分组下的用例。
// 列表页用它在前端筛选用例；run-all 用它「按主题跑一组」。
export function listCases(group) {
  const db = getDb()
  if (group) {
    return db.prepare(`SELECT * FROM test_cases WHERE "group" = ? ORDER BY id DESC`).all(String(group)).map(normalize)
  }
  return db.prepare(`SELECT * FROM test_cases ORDER BY id DESC`).all().map(normalize)
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
    group: input.group !== undefined ? String(input.group).trim() : existing.group,
  }
  if (!merged.name) throw new Error('用例 name 必填')
  if (!merged.url) throw new Error('用例 url 必填')
  getDb()
    .prepare(
      `UPDATE test_cases SET name=?, method=?, url=?, headers_json=?, body_json=?, body_type=?, files_json=?, expected_json=?, extract_json=?, "group"=? WHERE id=?`,
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
      merged.group,
      id,
    )
  return getCase(id)
}

/**
 * 删除用例 —— **连带删掉它的执行记录与定时任务**（同一事务）。
 *
 * 为什么必须连带删：`runs.case_id` / `schedules.case_id` 都不是外键，删用例时派生数据不会被带走，
 * 只会留成「孤儿」—— 报告里冒出一个连名字都没有的「用例#id」，调度器里留一个指向空用例的任务。
 * 而 `npm run seed`（示例用例）和 `npm run seed:oa`（OA 套件）**每次都要先删旧用例再插新的**，
 * 于是孤儿一遍遍累积（本机实测积到 **791 条**）。
 * 用例没了，它的执行历史也就不可解释了（连「跑的是哪条用例」都答不出来），留着只是噪声。
 *
 * 返回 `{ deleted, runsDeleted, scheduleIds }`。⚠️ 调用方（路由层）必须拿 `scheduleIds`
 * 去**停掉内存里的 cron** —— 删库行不会自动停任务，这条只能由路由补。
 */
export function deleteCase(id) {
  const db = getDb()
  db.exec('BEGIN')
  try {
    const scheduleIds = db
      .prepare(`SELECT id FROM schedules WHERE case_id = ?`)
      .all(id)
      .map((row) => row.id)
    const runsDeleted = db.prepare(`DELETE FROM runs WHERE case_id = ?`).run(id).changes
    db.prepare(`DELETE FROM schedules WHERE case_id = ?`).run(id)
    const deleted = db.prepare(`DELETE FROM test_cases WHERE id = ?`).run(id).changes > 0
    if (!deleted) {
      // 用例不存在：整笔回滚，别顺手删掉恰好指向这个 id 的历史数据
      db.exec('ROLLBACK')
      return { deleted: false, runsDeleted: 0, scheduleIds: [] }
    }
    db.exec('COMMIT')
    return { deleted: true, runsDeleted, scheduleIds }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
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
    group: row.group || '',
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
