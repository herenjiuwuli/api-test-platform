// 定时任务（schedules）CRUD，基于 db.js 的 schedules 表。
// 字段：case_id（关联用例）/ cron（cron 表达式）/ enabled
import cron from 'node-cron'
import { getDb } from './db.js'

export function validateCron(expr) {
  try {
    return cron.validate(expr)
  } catch {
    return false
  }
}

export function createSchedule({ caseId, cron: expr }) {
  const db = getDb()
  if (!caseId) throw new Error('定时任务 caseId 必填')
  if (!expr || !String(expr).trim()) throw new Error('定时任务 cron 必填')
  if (!validateCron(expr)) throw new Error('定时任务 cron 表达式非法')
  const info = db
    .prepare(`INSERT INTO schedules (case_id, cron) VALUES (?, ?)`)
    .run(Number(caseId), String(expr).trim())
  return getSchedule(info.lastInsertRowid)
}

export function listSchedules() {
  return getDb()
    .prepare(
      `SELECT s.*, c.name AS case_name
       FROM schedules s LEFT JOIN test_cases c ON c.id = s.case_id
       ORDER BY s.id DESC`,
    )
    .all()
    .map(normalize)
}

export function getSchedule(id) {
  const row = getDb()
    .prepare(
      `SELECT s.*, c.name AS case_name
       FROM schedules s LEFT JOIN test_cases c ON c.id = s.case_id
       WHERE s.id = ?`,
    )
    .get(id)
  return row ? normalize(row) : null
}

export function updateSchedule(id, { cron: expr, enabled } = {}) {
  const db = getDb()
  const cur = getSchedule(id)
  if (!cur) return null
  const cronV = expr !== undefined ? String(expr).trim() : cur.cron
  if (!cronV) throw new Error('定时任务 cron 必填')
  if (!validateCron(cronV)) throw new Error('定时任务 cron 表达式非法')
  const enabledV = enabled !== undefined ? (enabled ? 1 : 0) : cur.enabled ? 1 : 0
  db.prepare(`UPDATE schedules SET cron = ?, enabled = ? WHERE id = ?`).run(cronV, enabledV, id)
  return getSchedule(id)
}

export function deleteSchedule(id) {
  return getDb().prepare(`DELETE FROM schedules WHERE id = ?`).run(id).changes > 0
}

function normalize(row) {
  return {
    id: row.id,
    caseId: row.case_id,
    caseName: row.case_name || null,
    cron: row.cron,
    enabled: !!row.enabled,
    createdAt: row.created_at,
  }
}
