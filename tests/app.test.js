// API 测试平台 M1 冒烟测试（vitest，全离线）
// 策略：本地起一个「被测目标服务」提供 /ok /echo /boom，再用 runner 打它；
// 平台自身用 app.inject 测 HTTP 层。DB 用 :memory:，不落盘。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../index.js'
import { createCase, listCases, getCase, updateCase, deleteCase } from '../src/cases.js'
import { runCase, runAll } from '../src/runner.js'

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
  await target.listen({ port: 0, host: '127.0.0.1' })
  targetUrl = 'http://127.0.0.1:' + target.server.address().port

  app = buildApp()
  await app.ready()
})

afterAll(async () => {
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

describe('用例 CRUD（SQLite）', () => {
  it('新建→查询→删除 闭环', () => {
    const c = createCase({ name: '健康检查', method: 'GET', url: `${targetUrl}/ok`, expected: { status: 200 } })
    expect(c.id).toBeTruthy()
    expect(getCase(c.id).name).toBe('健康检查')
    const before = listCases().length
    expect(before).toBeGreaterThan(0)
    expect(deleteCase(c.id)).toBe(true)
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
    expect(deleteCase(c.id)).toBe(true)
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
