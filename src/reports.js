// 执行记录查询与报告聚合（M3 报告模块）。
import { getDb } from './db.js'

/** 查执行记录（可按时用例过滤），默认最近 20 条 */
export function listRuns({ caseId, limit = 20 } = {}) {
  const db = getDb()
  const where = []
  const args = []
  if (caseId) {
    where.push('r.case_id = ?')
    args.push(Number(caseId))
  }
  let sql = `SELECT r.id, r.case_id, r.pass, r.status, r.duration_ms, r.detail_json, r.ran_at,
                    c.name AS case_name
             FROM runs r LEFT JOIN test_cases c ON c.id = r.case_id`
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY r.id DESC LIMIT ?'
  args.push(Math.min(Math.max(Number(limit) || 20, 1), 200))
  return db.prepare(sql).all(...args).map(normalizeRun)
}

/** 报告汇总：总用例/总执行/通过率/按用例聚合/最近记录 */
export function getReportSummary() {
  const db = getDb()
  const { n: totalCases } = db.prepare(`SELECT COUNT(*) n FROM test_cases`).get()
  const stats = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(pass), 0) passed FROM runs`).get()
  const totalRuns = stats.n
  const passedRuns = stats.passed
  const failedRuns = totalRuns - passedRuns
  const passRate = totalRuns ? Math.round((passedRuns / totalRuns) * 100) : 0

  const byCase = db
    .prepare(
      `SELECT r.case_id, c.name, COUNT(*) runs, COALESCE(SUM(r.pass),0) passed,
              MAX(r.ran_at) last_run_at,
              (SELECT pass FROM runs r2 WHERE r2.case_id = r.case_id ORDER BY r2.id DESC LIMIT 1) AS last_pass
       FROM runs r LEFT JOIN test_cases c ON c.id = r.case_id
       GROUP BY r.case_id ORDER BY runs DESC`,
    )
    .all()
    .map((row) => ({
      caseId: row.case_id,
      name: row.name || `用例#${row.case_id}`,
      runs: row.runs,
      passed: row.passed,
      failed: row.runs - row.passed,
      passRate: Math.round((row.passed / row.runs) * 100),
      lastRunAt: row.last_run_at,
      lastPass: !!row.last_pass,
    }))

  return {
    totalCases,
    totalRuns,
    passedRuns,
    failedRuns,
    passRate,
    byCase,
    recentRuns: listRuns({ limit: 10 }),
  }
}

function normalizeRun(row) {
  let detail = []
  try {
    detail = JSON.parse(row.detail_json)
  } catch {
    detail = []
  }
  return {
    id: row.id,
    caseId: row.case_id,
    caseName: row.case_name || `用例#${row.case_id}`,
    pass: !!row.pass,
    status: row.status,
    durationMs: row.duration_ms,
    detail,
    ranAt: row.ran_at,
  }
}
