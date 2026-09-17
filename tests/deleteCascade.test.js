// 删用例的「连带清理」测试（vitest，全离线）
//
// 起因：`runs.case_id` 与 `schedules.case_id` **都不是外键**，历史上三条删用例的路径都不管派生数据
// （`deleteCase()` 只删用例；`npm run seed` / `npm run seed:oa` 各自直接 `DELETE FROM test_cases`）。
// 结果：报告页「按用例汇总」里冒出一堆连名字都没有的「用例#id」，而且每重新 seed 一次就多一批
// （本机实测积到 791 条）。
//
// 本文件钉住修复后的行为：
//   ① 删用例连带删执行记录；② 连带删定时任务并把 id 回传（路由要拿它停内存里的 cron）；
//   ③ 删不存在的用例整笔回滚、不碰任何数据；④ 孤儿清掉后报告里不再出现「用例#id」。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../index.js'
import { createCase, getCase, deleteCase, saveRun } from '../src/cases.js'
import { createSchedule, listSchedules, getSchedule } from '../src/schedules.js'
import { listRuns, getReportSummary } from '../src/reports.js'
import { getDb } from '../src/db.js'
import { stopAllScheduler } from '../src/scheduler.js'

process.env.DB_PATH = ':memory:'

let target
let targetUrl
let app

beforeAll(async () => {
  target = Fastify()
  target.get('/ok', async () => 'hello world')
  await target.listen({ port: 0, host: '127.0.0.1' })
  targetUrl = 'http://127.0.0.1:' + target.server.address().port
  app = buildApp()
  await app.ready()
})

afterAll(async () => {
  stopAllScheduler()
  await target.close()
  await app.close()
})

const newCase = (name) =>
  createCase({ name, method: 'GET', url: `${targetUrl}/ok`, expected: { status: 200 } })

const addRun = (caseId) => saveRun({ caseId, pass: true, status: 200, durationMs: 1, detail: [] })

/** 报告里「名字都查不到」的那种行（byCase 对找不到用例的记录会回落到 `用例#id`） */
const orphanRows = () => getReportSummary().byCase.filter((x) => String(x.name).startsWith('用例#'))

describe('删用例的连带清理（cases.js）', () => {
  it('★ 删用例连带删掉它的执行记录（否则报告里留「用例#id」孤儿）', () => {
    const c = newCase('连带有执行记录')
    addRun(c.id)
    addRun(c.id)
    saveRun({ caseId: c.id, pass: false, status: 500, durationMs: 9, detail: ['boom'] })
    expect(listRuns({ caseId: c.id }).length).toBe(3)

    const r = deleteCase(c.id)
    expect(r.deleted).toBe(true)
    expect(r.runsDeleted).toBe(3)
    expect(listRuns({ caseId: c.id }).length).toBe(0)
    expect(getCase(c.id)).toBeNull()
  })

  it('★ 删用例连带删掉挂在上面的定时任务，并把 scheduleIds 回传（路由要拿它停 cron）', () => {
    const c = newCase('连带有定时任务')
    const s1 = createSchedule({ caseId: c.id, cron: '0 9 * * *' })
    const s2 = createSchedule({ caseId: c.id, cron: '*/5 * * * *' })
    expect(listSchedules().filter((s) => s.caseId === c.id).length).toBe(2)

    const r = deleteCase(c.id)
    expect(r.scheduleIds.slice().sort()).toEqual([s1.id, s2.id].sort())
    expect(getSchedule(s1.id)).toBeNull()
    expect(getSchedule(s2.id)).toBeNull()
    // 不带 caseId 的其它任务不该被误伤
    expect(listSchedules().every((s) => s.caseId !== c.id)).toBe(true)
  })

  it('删不存在的用例 → deleted:false 且整笔回滚，不碰任何数据', () => {
    const alive = newCase('活着的用例')
    addRun(alive.id)

    const r = deleteCase(999999)
    expect(r).toEqual({ deleted: false, runsDeleted: 0, scheduleIds: [] })
    // 别人的记录、别人的用例都还在
    expect(listRuns({ caseId: alive.id }).length).toBe(1)
    expect(getCase(alive.id)).not.toBeNull()
    deleteCase(alive.id)
  })

  it('★ 孤儿被清掉之后，报告里不再出现「用例#id」', () => {
    const c = newCase('模拟老路径删出来的孤儿')
    addRun(c.id)
    // 模拟「修复前」的删除路径：绕过 deleteCase，直接删用例 → 执行记录变孤儿
    getDb().prepare(`DELETE FROM test_cases WHERE id = ?`).run(c.id)
    expect(orphanRows().some((x) => x.caseId === c.id)).toBe(true)

    // 修复后的扫尾（等价于 scripts/clean-orphan-runs.mjs --yes 干的事）
    getDb()
      .prepare(`DELETE FROM runs WHERE case_id IS NOT NULL AND case_id NOT IN (SELECT id FROM test_cases)`)
      .run()
    expect(orphanRows().some((x) => x.caseId === c.id)).toBe(false)
  })
})

describe('删用例的 HTTP 层（app.inject）', () => {
  it('DELETE /api/cases/:id 回传连带删掉的条数（前端据此提示「连带 N 条执行记录」）', async () => {
    const c = newCase('HTTP 连带有记录')
    addRun(c.id)
    createSchedule({ caseId: c.id, cron: '0 9 * * *' })

    const res = await app.inject({ method: 'DELETE', url: `/api/cases/${c.id}` })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ deleted: true, runsDeleted: 1, schedulesDeleted: 1 })
  })

  it('DELETE 一个不存在的用例 → 404，且不静默动数据', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/cases/999999' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toBe('用例不存在')
  })
})
