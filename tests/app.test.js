// API 测试平台 M1 冒烟测试（vitest，全离线）
// 策略：本地起一个「被测目标服务」提供 /ok /echo /boom，再用 runner 打它；
// 平台自身用 app.inject 测 HTTP 层。DB 用 :memory:，不落盘。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../index.js'
import { createCase, listCases, getCase, updateCase, deleteCase } from '../src/cases.js'
import { runCase, runAll } from '../src/runner.js'
import { stopAllScheduler } from '../src/scheduler.js'

// 必须在首个 db 调用前设置（导入模块不触达 db，故放此处即可）
process.env.DB_PATH = ':memory:'

let target
let targetUrl
let app

beforeAll(async () => {
  target = Fastify()
  target.get('/ok', async () => 'hello world')
  target.post('/echo', async (req) => ({ got: req.body }))
  target.get('/boom', async () => {
    throw new Error('boom')
  })
  target.get('/json', async () => ({
    code: 0,
    data: { list: [{ id: 1, tags: ['a', 'b'] }, { id: 2, tags: [] }], total: 2 },
  }))
  await target.listen({ port: 0, host: '127.0.0.1' })
  targetUrl = 'http://127.0.0.1:' + target.server.address().port

  app = buildApp()
  await app.ready()
})

afterAll(async () => {
  stopAllScheduler() // 清理测试中注册的 cron 任务
  await target.close()
  await app.close()
})

describe('runner（用例执行引擎）', () => {
  it('通过：状态码 + 响应体包含都符合', async () => {
    const r = await runCase({ method: 'GET', url: `${targetUrl}/ok`, expected: { status: 200, contains: 'hello' } })
    expect(r.pass).toBe(true)
    expect(r.status).toBe(200)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('失败：状态码不符', async () => {
    const r = await runCase({ method: 'GET', url: `${targetUrl}/ok`, expected: { status: 404 } })
    expect(r.pass).toBe(false)
    expect(r.detail.join()).toContain('状态码')
  })

  it('错误：目标不可达（网络层失败）', async () => {
    const r = await runCase({ method: 'GET', url: 'http://127.0.0.1:1/ok' })
    expect(r.pass).toBe(false)
    expect(r.error).toBe(true)
  })

  it('runAll 顺序执行并返回汇总', async () => {
    const results = await runAll([
      { method: 'GET', url: `${targetUrl}/ok`, expected: { status: 200 } },
      { method: 'GET', url: `${targetUrl}/boom`, expected: { status: 200 } },
    ])
    expect(results).toHaveLength(2)
    expect(results[0].pass).toBe(true)
    expect(results[1].pass).toBe(false)
  })
})

describe('runner JSONPath 断言（M3）', () => {
  it('jsonChecks 全部通过（eq/exists/gte/下标）', async () => {
    const r = await runCase({
      method: 'GET',
      url: `${targetUrl}/json`,
      expected: {
        jsonChecks: [
          { path: '$.code', op: 'eq', value: 0 },
          { path: '$.data.total', op: 'gte', value: 1 },
          { path: '$.data.list[0].id', op: 'eq', value: 1 },
          { path: '$.data.list[*].id', op: 'exists' },
        ],
      },
    })
    expect(r.pass).toBe(true)
  })

  it('jsonChecks 失败给出明细', async () => {
    const r = await runCase({
      method: 'GET',
      url: `${targetUrl}/json`,
      expected: { jsonChecks: [{ path: '$.code', op: 'eq', value: 1 }] },
    })
    expect(r.pass).toBe(false)
    expect(r.detail.join()).toContain('$.code')
    expect(r.detail.join()).toContain('首个 0')
  })

  it('⭐ 多匹配时 contains = 任一命中（数组里包含某元素）', async () => {
    // 用真系统测出来的语义坑：$.permissions[*] contains 'user:read' 曾因「只看首个匹配」而假失败
    const hit = await runCase({
      method: 'GET',
      url: `${targetUrl}/json`,
      expected: { status: 200, jsonChecks: [{ path: '$.data.list[*].tags[*]', op: 'contains', value: 'b' }] },
    })
    expect(hit.pass).toBe(true)

    const miss = await runCase({
      method: 'GET',
      url: `${targetUrl}/json`,
      expected: { jsonChecks: [{ path: '$.data.list[*].tags[*]', op: 'contains', value: 'zzz' }] },
    })
    expect(miss.pass).toBe(false)
    expect(miss.detail.join()).toContain('匹配 2 个')
  })

  it('响应非 JSON 时 jsonChecks 失败', async () => {
    const r = await runCase({
      method: 'GET',
      url: `${targetUrl}/ok`,
      expected: { jsonChecks: [{ path: '$.a', op: 'exists' }] },
    })
    expect(r.pass).toBe(false)
    expect(r.detail.join()).toContain('不是合法 JSON')
  })

  it('gt / lt / contains 数值与包含断言', async () => {
    const r = await runCase({
      method: 'GET',
      url: `${targetUrl}/json`,
      expected: {
        jsonChecks: [
          { path: '$.data.list[0].tags.length', op: 'gt', value: 1 },
          { path: '$.data.list[1].tags.length', op: 'lt', value: 1 },
          { path: '$.data.list[0].tags', op: 'contains', value: 'a' },
        ],
      },
    })
    expect(r.pass).toBe(true)
  })
})

describe('用例 CRUD（SQLite）', () => {
  it('新建→查询→删除 闭环', () => {
    const c = createCase({ name: '健康检查', method: 'GET', url: `${targetUrl}/ok`, expected: { status: 200 } })
    expect(c.id).toBeTruthy()
    expect(getCase(c.id).name).toBe('健康检查')
    const before = listCases().length
    expect(before).toBeGreaterThan(0)
    expect(deleteCase(c.id).deleted).toBe(true)
    expect(getCase(c.id)).toBeNull()
  })

  it('updateCase 部分更新：未传字段保持原值', () => {
    const c = createCase({ name: 'CRUD更新', method: 'GET', url: `${targetUrl}/ok`, expected: { status: 200 } })
    const u = updateCase(c.id, { name: 'CRUD更新2', expected: { contains: 'hello' } })
    expect(u.name).toBe('CRUD更新2')
    expect(u.method).toBe('GET')
    expect(u.expected.contains).toBe('hello')
    expect(u.expected.status).toBeUndefined() // expected 整体替换（不深合并），未传字段消失
    expect(updateCase(999999, { name: 'x' })).toBeNull()
    expect(deleteCase(c.id).deleted).toBe(true)
  })
})

describe('HTTP 层（app.inject）', () => {
  it('GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)
  })

  it('POST /api/cases 新建 + GET /api/cases 列出', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/cases',
      payload: { name: '注入用例', method: 'GET', url: `${targetUrl}/ok`, expected: { status: 200 } },
    })
    expect(create.statusCode).toBe(201)
    const id = JSON.parse(create.body).id

    const list = await app.inject({ method: 'GET', url: '/api/cases' })
    expect(list.statusCode).toBe(200)
    expect(JSON.parse(list.body).some((c) => c.id === id)).toBe(true)

    await app.inject({ method: 'DELETE', url: `/api/cases/${id}` })
  })

  it('POST /api/run-all 跑全部并返回汇总', async () => {
    const c = createCase({ name: '汇总用例', method: 'GET', url: `${targetUrl}/ok`, expected: { status: 200 } })
    const res = await app.inject({ method: 'POST', url: '/api/run-all' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toHaveProperty('total')
    expect(body.passed).toBeGreaterThanOrEqual(1)
    await app.inject({ method: 'DELETE', url: `/api/cases/${c.id}` })
  })

  it('POST /api/cases 缺 url 返回 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/cases', payload: { name: 'x' } })
    expect(res.statusCode).toBe(400)
  })

  it('GET /api/cases/:id 查询 + 404', async () => {
    const c = createCase({ name: '查询用例', method: 'GET', url: `${targetUrl}/ok` })
    const ok = await app.inject({ method: 'GET', url: `/api/cases/${c.id}` })
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.body).name).toBe('查询用例')

    const miss = await app.inject({ method: 'GET', url: '/api/cases/999999' })
    expect(miss.statusCode).toBe(404)
    await app.inject({ method: 'DELETE', url: `/api/cases/${c.id}` })
  })

  it('PUT /api/cases/:id 更新 + 404 + 400', async () => {
    const c = createCase({ name: '更新前', method: 'GET', url: `${targetUrl}/ok` })
    const res = await app.inject({
      method: 'PUT',
      url: `/api/cases/${c.id}`,
      payload: { name: '更新后', url: `${targetUrl}/echo`, expected: { status: 200, contains: 'hello' } },
    })
    expect(res.statusCode).toBe(200)
    const updated = JSON.parse(res.body)
    expect(updated.name).toBe('更新后')
    expect(updated.method).toBe('GET') // 未传字段保持原值

    const miss = await app.inject({ method: 'PUT', url: '/api/cases/999999', payload: { name: 'x' } })
    expect(miss.statusCode).toBe(404)

    const bad = await app.inject({ method: 'PUT', url: `/api/cases/${c.id}`, payload: { name: '' } })
    expect(bad.statusCode).toBe(400)
    await app.inject({ method: 'DELETE', url: `/api/cases/${c.id}` })
  })
})

describe('定时任务与报告（M3）', () => {
  it('schedules CRUD + 执行记录 + 报告汇总 闭环', async () => {
    const c = createCase({
      name: 'M3用例',
      method: 'GET',
      url: `${targetUrl}/json`,
      expected: { jsonChecks: [{ path: '$.code', op: 'eq', value: 0 }] },
    })
    // 先跑一次产生执行记录
    const run = await app.inject({ method: 'POST', url: `/api/cases/${c.id}/run` })
    expect(JSON.parse(run.body).pass).toBe(true)

    // 新建定时任务
    const create = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: { caseId: c.id, cron: '*/30 * * * *' },
    })
    expect(create.statusCode).toBe(201)
    const sid = JSON.parse(create.body).id

    const list = await app.inject({ method: 'GET', url: '/api/schedules' })
    expect(JSON.parse(list.body).some((s) => s.id === sid)).toBe(true)

    // 非法 cron → 400
    const bad = await app.inject({ method: 'POST', url: '/api/schedules', payload: { caseId: c.id, cron: 'nope' } })
    expect(bad.statusCode).toBe(400)

    // 更新：禁用
    const upd = await app.inject({ method: 'PUT', url: `/api/schedules/${sid}`, payload: { enabled: false } })
    expect(JSON.parse(upd.body).enabled).toBe(false)

    // 执行记录查询
    const runs = await app.inject({ method: 'GET', url: `/api/runs?caseId=${c.id}` })
    const runList = JSON.parse(runs.body)
    expect(runList.length).toBeGreaterThanOrEqual(1)
    expect(runList[0].caseName).toBe('M3用例')

    // 报告汇总
    const rep = await app.inject({ method: 'GET', url: '/api/reports/summary' })
    const summary = JSON.parse(rep.body)
    expect(summary.totalCases).toBeGreaterThanOrEqual(1)
    expect(summary.totalRuns).toBeGreaterThanOrEqual(1)
    expect(summary.passRate).toBeGreaterThanOrEqual(0)
    expect(summary.byCase.some((b) => b.caseId === c.id)).toBe(true)

    // 清理
    await app.inject({ method: 'DELETE', url: `/api/schedules/${sid}` })
    await app.inject({ method: 'DELETE', url: `/api/cases/${c.id}` })
  })

  it('schedules 更新不存在的返回 404', async () => {
    const miss = await app.inject({ method: 'PUT', url: '/api/schedules/999999', payload: { cron: '* * * * *' } })
    expect(miss.statusCode).toBe(404)
  })

  it('scheduler 注册/停用/校验', async () => {
    const { registerJob, stopJob, jobCount } = await import('../src/scheduler.js')
    const { validateCron } = await import('../src/schedules.js')
    expect(validateCron('*/5 * * * *')).toBe(true)
    expect(validateCron('nope')).toBe(false)
    const c = createCase({ name: '调度器用例', method: 'GET', url: `${targetUrl}/ok` })
    const s = { id: 99991, caseId: c.id, cron: '*/10 * * * *', enabled: true }
    registerJob(s)
    expect(jobCount()).toBeGreaterThanOrEqual(1)
    stopJob(s.id)
    expect(jobCount()).toBe(0)
    await app.inject({ method: 'DELETE', url: `/api/cases/${c.id}` })
  })
})
