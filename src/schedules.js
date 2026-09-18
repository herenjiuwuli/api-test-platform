// 定时任务（schedules）CRUD，基于 db.js 的 schedules 表。
// 字段：case_id（关联用例，分组定时任务用占位 0）/ "group"（业务分组标签）/ cron / enabled
import cron from 'node-cron'
import { getDb } from './db.js'
import { listCases } from './cases.js'

// 分组定时任务的 case_id 占位值（见 db.js migrate 注释）：SQLite 的 case_id 列仍是 NOT NULL，
// 0 不指向任何真实用例；调度时以 group 为准，case_id=0 永远不会被当作「要跑的用例」。
const GROUP_SCHEDULE_CASE_ID = 0

// M20 通知降噪：任务级「什么情况下发通知」。all = 每次跑完都发（M17 原行为）；
// failure = 只在失败侧发（warn 断言失败 / error 没跑成）。白名单外的值一律回退 all——
// 存储层不信任调用方，宁可行为保守也别存进一个调度器不认识的值。
const NOTIFY_MODES = ['all', 'failure']
function normalizeNotifyOn(v) {
  return NOTIFY_MODES.includes(v) ? v : 'all'
}

export function validateCron(expr) {
  try {
    return cron.validate(expr)
  } catch {
    return false
  }
}

export function createSchedule({ caseId, group, cron: expr, notifyOn } = {}) {
  const db = getDb()
  if (!expr || !String(expr).trim()) throw new Error('定时任务 cron 必填')
  if (!validateCron(expr)) throw new Error('定时任务 cron 表达式非法')
  const groupV = group !== undefined ? String(group).trim() : ''
  // 二选一：要么指定分组，要么指定单条用例；分组优先（指定了分组就忽略 caseId）。
  const caseV = groupV ? GROUP_SCHEDULE_CASE_ID : caseId ? Number(caseId) : null
  if (!groupV && !caseV) throw new Error('定时任务必须指定「用例」或「分组」之一')
  if (groupV && listCases(groupV).length === 0) throw new Error('分组不存在或为空')
  const notifyV = normalizeNotifyOn(notifyOn)
  const info = db
    .prepare(`INSERT INTO schedules (case_id, "group", cron, notify_on) VALUES (?, ?, ?, ?)`)
    .run(caseV, groupV, String(expr).trim(), notifyV)
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

export function updateSchedule(id, { cron: expr, enabled, group, caseId, notifyOn } = {}) {
  const db = getDb()
  const cur = getSchedule(id)
  if (!cur) return null
  const cronV = expr !== undefined ? String(expr).trim() : cur.cron
  if (!cronV) throw new Error('定时任务 cron 必填')
  if (!validateCron(cronV)) throw new Error('定时任务 cron 表达式非法')
  const enabledV = enabled !== undefined ? (enabled ? 1 : 0) : cur.enabled ? 1 : 0
  // 分组优先：一旦 group 非空，case_id 落到占位 0；group 清空了才回到单条用例。
  const groupV = group !== undefined ? String(group).trim() : cur.group
  const caseV = groupV
    ? GROUP_SCHEDULE_CASE_ID
    : caseId !== undefined && caseId
      ? Number(caseId)
      : cur.caseId
  if (!groupV && !caseV) throw new Error('定时任务必须指定「用例」或「分组」之一')
  if (groupV && listCases(groupV).length === 0) throw new Error('分组不存在或为空')
  const notifyV = notifyOn !== undefined ? normalizeNotifyOn(notifyOn) : cur.notifyOn
  db.prepare(
    `UPDATE schedules SET cron = ?, enabled = ?, "group" = ?, case_id = ?, notify_on = ? WHERE id = ?`,
  ).run(cronV, enabledV, groupV, caseV, notifyV, id)
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
    group: row.group || '',
    cron: row.cron,
    enabled: !!row.enabled,
    notifyOn: row.notify_on === 'failure' ? 'failure' : 'all',
    createdAt: row.created_at,
  }
}
