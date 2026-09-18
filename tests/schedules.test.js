// 定时任务「分组维度」测试（M15，vitest，全离线）
//
// M12 给用例加了 group 标签（列表筛选 / 按组跑 / 报告按组看），但定时任务一直只能跑「单条用例」。
// M15 让定时任务也能按分组跑：一个 cron 周期到了，自动跑完该分组下的全部用例。
// 本文件钉住：
//   ① 建「分组定时任务」需要 group / caseId 二选一、group 非空校验、listSchedules 透出 group；
//   ② 分组定时触发 = 跑该组全部用例（runScheduledJob 按创建顺序跑，落 runs）；
//   ③ 单条用例定时触发仍只跑那一条（回归）；
//   ④ 删用例不误伤分组定时任务（它的 case_id 是占位 0，deleteCase 按 case_id 删，碰不到）；
//   ⑤ HTTP 层带 group 创建 / 缺参 400。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../index.js'
import { createCase, deleteCase, getCase } from '../src/cases.js'
import { createSchedule, getSchedule, listSchedules, updateSchedule } from '../src/schedules.js'
import { runScheduledJob, stopAllScheduler } from '../src/scheduler.js'
import { listRuns, getReportSummary } from '../src/reports.js'

process.env.DB_PATH = ':memory:'
process.env.API_AUTH_DISABLED = '1'

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

const newCase = (name, group) =>
  createCase({ name, method: 'GET', url: `${targetUrl}/ok`, group, expected: { status: 200 } })

describe('分组定时任务的 CRUD（schedules.js）', () => {
  it('★ 建「分组定时任务」：group 二选一，listSchedules 透出 group', () => {
    newCase('审批引擎里的用例', '审批引擎') // 先有该分组的用例，否则分组定时会因「分组为空」被拒
    const s = createSchedule({ group: '审批引擎', cron: '0 9 * * *' })
    expect(s.group).toBe('审批引擎')
    expect(s.caseId).toBe(0) // 分组定时的占位 case_id（不指向任何真实用例）
    expect(s.caseName).toBeNull()
    expect(listSchedules().find((x) => x.id === s.id)?.group).toBe('审批引擎')
  })

  it('建「单条用例定时任务」仍是老行为（caseId + caseName 透出）', () => {
    const c = newCase('单条定时目标', '审批引擎')
    const s = createSchedule({ caseId: c.id, cron: '*/5 * * * *' })
    expect(s.group).toBe('')
    expect(s.caseId).toBe(c.id)
    expect(s.caseName).toBe('单条定时目标')
  })

  it('★ group 与 caseId 都不给 → 报错', () => {
    expect(() => createSchedule({ cron: '0 9 * * *' })).toThrow(/用例|分组/)
  })

  it('★ group 指向一个不存在/为空的分组 → 报错', () => {
    expect(() => createSchedule({ group: '不存在的组', cron: '0 9 * * *' })).toThrow(/分组不存在或为空/)
  })

  it('★ 同时给 group 和 caseId：分组优先（case_id 落到占位 0）', () => {
    const c = newCase('两者都给', '审批引擎')
    const s = createSchedule({ caseId: c.id, group: '审批引擎', cron: '0 9 * * *' })
    expect(s.group).toBe('审批引擎')
    expect(s.caseId).toBe(0)
  })

  it('★ 分组定时改成单条用例：清空 group 必须补 caseId 才合法', () => {
    const c = newCase('被改成单条', '审批引擎')
    const s = createSchedule({ group: '审批引擎', cron: '0 9 * * *' })
    const updated = updateSchedule(s.id, { group: '', caseId: c.id })
    expect(updated.group).toBe('')
    expect(updated.caseId).toBe(c.id)
  })

  it('单条用例定时改成分组：带上 group 即可，caseId 被忽略', () => {
    const c = newCase('被改成分组', '附件全周期')
    const s = createSchedule({ caseId: c.id, cron: '*/5 * * * *' })
    const updated = updateSchedule(s.id, { group: '附件全周期' })
    expect(updated.group).toBe('附件全周期')
    expect(updated.caseId).toBe(0)
  })
})

describe('分组定时的触发（scheduler.runScheduledJob）', () => {
  it('★ 分组定时触发 = 跑该组全部用例并落 runs（按创建顺序，不碰别的组）', async () => {
    newCase('g1-a', 'M15组')
    newCase('g1-b', 'M15组')
    newCase('g1-c', 'M15组')
    newCase('别的组', '别的')
    const s = createSchedule({ group: 'M15组', cron: '0 9 * * *' })
    await runScheduledJob(s)
    const runs = listRuns({ limit: 200 }).filter((r) => r.caseName && r.caseName.startsWith('g1-'))
    expect(runs.length).toBe(3) // 只跑了 M15组 的三条，没跑「别的组」
    expect(runs.every((r) => r.pass)).toBe(true)
    // runs 通过 case_id 回连 test_cases.group → 报告按组汇总里出现 M15组
    const grp = getReportSummary().byGroup.find((g) => g.group === 'M15组')
    expect(grp.runs).toBe(3)
    expect(grp.passed).toBe(3)
  })

  it('★ 单条用例定时触发仍只跑那一条（回归）', async () => {
    const c = newCase('单条回归', 'M15组')
    const s = createSchedule({ caseId: c.id, cron: '*/5 * * * *' })
    await runScheduledJob(s)
    expect(listRuns({ caseId: c.id }).length).toBe(1)
  })
})

describe('删用例不误伤分组定时任务（M15 + M13 交叉）', () => {
  it('★ 删一条属于某分组的用例，分组定时任务（case_id=0）不被删', () => {
    const victim = newCase('要被删的', 'M15组')
    const s = createSchedule({ group: 'M15组', cron: '0 9 * * *' })
    expect(getSchedule(s.id)).not.toBeNull()
    const r = deleteCase(victim.id)
    expect(r.deleted).toBe(true)
    expect(r.scheduleIds).toEqual([]) // 分组定时任务 case_id=0，不会被这个删除牵连
    expect(getSchedule(s.id)).not.toBeNull() // 分组定时任务还在
  })
})

describe('分组定时的 HTTP 层（app.inject）', () => {
  it('POST /api/schedules 带 group → 201 透出 group', async () => {
    newCase('http分组目标', 'http组')
    const res = await app.inject({ method: 'POST', url: '/api/schedules', payload: { group: 'http组', cron: '0 9 * * *' } })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).group).toBe('http组')
  })

  it('POST /api/schedules 既没 group 也没 caseId → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/schedules', payload: { cron: '0 9 * * *' } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toMatch(/用例|分组/)
  })
})
