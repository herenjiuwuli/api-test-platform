// 用例分组（M12）测试（vitest，全离线）
// 覆盖：createCase 带 group / listCases(group) 过滤 / run-all 按 group 跑 /
//       updateCase 改 group / 套件导出导入保留 group / 报告按 group 聚合。
// group 是 SQL 保留字，后端一律用 "group" 双引号引用，这里只验证行为。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../index.js'
import { createCase, listCases, getCase, updateCase, deleteCase } from '../src/cases.js'
import { runCase } from '../src/runner.js'
import { exportSuite, importSuite } from '../src/suite.js'
import { getReportSummary } from '../src/reports.js'
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

describe('用例分组：读写（cases.js）', () => {
  it('createCase 带 group，getCase 能读回', () => {
    const c = createCase({ name: '分组用例A', method: 'GET', url: `${targetUrl}/ok`, group: '鉴权组', expected: { status: 200 } })
    expect(c.group).toBe('鉴权组')
    expect(getCase(c.id).group).toBe('鉴权组')
    deleteCase(c.id)
  })

  it('不传 group 默认空串', () => {
    const c = createCase({ name: '无分组用例', method: 'GET', url: `${targetUrl}/ok`, expected: { status: 200 } })
    expect(c.group).toBe('')
    deleteCase(c.id)
  })

  it('listCases(group) 只返回该分组', () => {
    const a = createCase({ name: 'gA-1', method: 'GET', url: `${targetUrl}/ok`, group: 'GG' })
    const b = createCase({ name: 'gB-1', method: 'GET', url: `${targetUrl}/ok`, group: 'GH' })
    const none = createCase({ name: 'gNone', method: 'GET', url: `${targetUrl}/ok` })
    const onlyG = listCases('GG')
    expect(onlyG.every((c) => c.group === 'GG')).toBe(true)
    expect(onlyG.some((c) => c.id === b.id)).toBe(false)
    expect(onlyG.some((c) => c.id === none.id)).toBe(false)
    // 不传 group = 全部
    expect(listCases().length).toBeGreaterThanOrEqual(3)
    deleteCase(a.id); deleteCase(b.id); deleteCase(none.id)
  })

  it('updateCase 改 group 并保留其他字段', () => {
    const c = createCase({ name: '改组前', method: 'GET', url: `${targetUrl}/ok`, group: 'OLD' })
    const u = updateCase(c.id, { group: 'NEW' })
    expect(u.group).toBe('NEW')
    expect(u.name).toBe('改组前') // 未传字段保持原值
    expect(u.method).toBe('GET')
    deleteCase(c.id)
  })
})

describe('用例分组：run-all 按 group 过滤（HTTP 层）', () => {
  it('POST /api/run-all {group} 只跑该组', async () => {
    const ga1 = createCase({ name: 'GA-1', method: 'GET', url: `${targetUrl}/ok`, group: 'GA', expected: { status: 200 } })
    const ga2 = createCase({ name: 'GA-2', method: 'GET', url: `${targetUrl}/ok`, group: 'GA', expected: { status: 200 } })
    const gb1 = createCase({ name: 'GB-1', method: 'GET', url: `${targetUrl}/ok`, group: 'GB', expected: { status: 200 } })

    const res = await app.inject({ method: 'POST', url: '/api/run-all', payload: { group: 'GA' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.filter).toBe('GA')
    expect(body.total).toBe(2)
    expect(body.results.every((r) => r.name.startsWith('GA-'))).toBe(true)
    expect(body.results.some((r) => r.name.startsWith('GB-'))).toBe(false)

    // 跑全部时仍是 3 条
    const all = await app.inject({ method: 'POST', url: '/api/run-all', payload: {} })
    expect(JSON.parse(all.body).total).toBe(3)

    await app.inject({ method: 'DELETE', url: `/api/cases/${ga1.id}` })
    await app.inject({ method: 'DELETE', url: `/api/cases/${ga2.id}` })
    await app.inject({ method: 'DELETE', url: `/api/cases/${gb1.id}` })
  })
})

describe('用例分组：套件导出导入保留 group（M11 协同）', () => {
  it('导出带 group，导入（overwrite）后 group 仍正确', async () => {
    const c = createCase({
      name: '套件分组用例',
      method: 'GET',
      url: `${targetUrl}/ok`,
      group: 'GMID',
      expected: { status: 200 },
    })
    const exported = exportSuite()
    const ec = exported.cases.find((x) => x.name === '套件分组用例')
    expect(ec).toBeTruthy()
    expect(ec.group).toBe('GMID')

    // 改掉 group 再 overwrite 导入，验证导入保留了新 group
    const importPayload = {
      kind: exported.kind,
      version: exported.version,
      cases: [{ name: '套件分组用例', method: 'GET', url: `${targetUrl}/ok`, group: 'GMID2', expected: { status: 200 } }],
    }
    const r = importSuite(importPayload, { onConflict: 'overwrite' })
    expect(r.ok).toBe(true)
    expect(getCase(c.id).group).toBe('GMID2')
    deleteCase(c.id)
  })
})

describe('用例分组：报告按 group 聚合（reports.js）', () => {
  it('getReportSummary().byGroup 含该分组且 runs>=1', async () => {
    const c = createCase({ name: '报告分组用例', method: 'GET', url: `${targetUrl}/ok`, group: 'GREP', expected: { status: 200 } })
    await runCase(c)
    const sum = getReportSummary()
    const g = sum.byGroup.find((x) => x.group === 'GREP')
    expect(g).toBeTruthy()
    expect(g.runs).toBeGreaterThanOrEqual(1)
    expect(g.passed).toBeGreaterThanOrEqual(1)
    deleteCase(c.id)
  })
})
