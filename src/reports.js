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
                    r.env_id, r.env_name, r.base_url,
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

  // 按「运行环境」聚合（M10）：同一组用例跨了两个环境时，通过率必须分开看 ——
  // 混在一起的平均值会掩盖「换个环境就全红」。分组键用**快照**（名字 + 地址），
  // 所以环境地址改过之后会自然分成两组：历史记录不会被改写成「它从没打过的地址」。
  const byEnv = db
    .prepare(
      `SELECT COALESCE(NULLIF(env_name, ''), '(未记录环境)') AS env_name,
              COALESCE(NULLIF(base_url, ''), '') AS base_url,
              COUNT(*) runs, COALESCE(SUM(pass), 0) passed, MAX(ran_at) last_run_at
       FROM runs GROUP BY runs.env_name, runs.base_url ORDER BY last_run_at DESC, runs DESC`,
    )
    .all()
    .map((row) => ({
      name: row.env_name,
      baseUrl: row.base_url,
      runs: row.runs,
      passed: row.passed,
      failed: row.runs - row.passed,
      passRate: Math.round((row.passed / row.runs) * 100),
      lastRunAt: row.last_run_at,
    }))

  // 按「业务分组」聚合（M12）：用例打了 group 标签后，报告要能「按主题看通过率」——
  // 比如一眼看出「附件全周期」这组最近是不是全红，而不必在 52 条 byCase 里肉眼扫。
  // 没打组的用例归到「(未分组)」。和 byEnv 同理：分组是语义标签，换个说法也不会改写历史。
  const byGroup = db
    .prepare(
      `SELECT COALESCE(NULLIF(c."group", ''), '(未分组)') AS grp,
              COUNT(*) runs, COALESCE(SUM(r.pass), 0) passed, MAX(r.ran_at) last_run_at
       FROM runs r LEFT JOIN test_cases c ON c.id = r.case_id
       GROUP BY c."group" ORDER BY runs DESC`,
    )
    .all()
    .map((row) => ({
      group: row.grp,
      runs: row.runs,
      passed: row.passed,
      failed: row.runs - row.passed,
      passRate: Math.round((row.passed / row.runs) * 100),
      lastRunAt: row.last_run_at,
    }))

  return {
    totalCases,
    totalRuns,
    passedRuns,
    failedRuns,
    passRate,
    byCase,
    byEnv,
    byGroup,
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
    // 环境快照：老记录（M10 之前跑的）这三个字段是空的，用 null 表示「不知道」，别编一个出来
    env: row.base_url ? { id: row.env_id ?? null, name: row.env_name || '', baseUrl: row.base_url } : null,
  }
}
