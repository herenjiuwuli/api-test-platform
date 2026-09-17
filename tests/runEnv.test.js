// M10：执行记录要记住「这次跑在哪个环境」
//
// 为什么单独一个文件：这块的核心不是 CRUD，而是一条**快照语义**——
//   改了环境地址之后，历史记录不能被改写成「它从没打过的地址」。
//   这与 office-oa 的 `flow_snapshot`（改流程模板不影响在途单据）是同一条设计教训：
//   **配置是活的，历史是死的。**
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../index.js'
import { createCase } from '../src/cases.js'
import { getReportSummary, listRuns } from '../src/reports.js'
import { runCase } from '../src/runner.js'
import { createEnvironment, setActiveEnvironment, updateEnvironment } from '../src/environments.js'
import { stopAllScheduler } from '../src/scheduler.js'

// 必须在首个 db 调用前设置
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

// 每个用例都从一个干净状态开始：把「当前环境」取消掉
beforeEach(() => {
  setActiveEnvironment(null)
})

describe('执行记录里的环境快照（M10）', () => {
  it('跑一条用例后，记录里带着当时的环境名与地址', async () => {
    const env = createEnvironment({ name: '冒烟环境', baseUrl: targetUrl })
    setActiveEnvironment(env.id)

    const r = await runCase({ method: 'GET', url: '{{base}}/ok', expected: { status: 200 } })
    expect(r.pass).toBe(true)
    expect(r.env).toEqual({ id: env.id, name: '冒烟环境', baseUrl: targetUrl })

    const [run] = listRuns({ limit: 1 })
    expect(run.env.name).toBe('冒烟环境')
    expect(run.env.baseUrl).toBe(targetUrl)
  })

  it('★ 快照语义：改了环境地址，历史记录里的地址不变', async () => {
    const env = createEnvironment({ name: '会被改地址的环境', baseUrl: targetUrl })
    setActiveEnvironment(env.id)
    await runCase({ method: 'GET', url: '{{base}}/ok', expected: { status: 200 } })

    // 把地址改到一个根本打不通的地方（模拟「本地 → 预发」）
    updateEnvironment(env.id, { baseUrl: 'http://127.0.0.1:9' })

    const [run] = listRuns({ limit: 1 })
    expect(run.env.baseUrl).toBe(targetUrl) // 还是当时真正打的那个地址
    expect(run.env.name).toBe('会被改地址的环境')
  })

  it('没有当前环境时：记录里 env 为 null，不编造环境名', async () => {
    setActiveEnvironment(null)
    const r = await runCase({ method: 'GET', url: `${targetUrl}/ok`, expected: { status: 200 } })
    expect(r.env).toBeNull()
    const [run] = listRuns({ limit: 1 })
    expect(run.env).toBeNull()
  })

  it('跑失败（catch 分支）的记录同样带环境快照', async () => {
    const env = createEnvironment({ name: '异常分支环境', baseUrl: targetUrl })
    setActiveEnvironment(env.id)
    // {{nope}} 没赋值 → url 变成 /ok 之外的相对路径 → fetch 抛错，走 catch 分支
    const r = await runCase({ method: 'GET', url: '{{nope}}/ok', expected: { status: 200 } })
    expect(r.error).toBe(true)
    expect(r.env).toEqual({ id: env.id, name: '异常分支环境', baseUrl: targetUrl })
    const [run] = listRuns({ limit: 1 })
    expect(run.env.name).toBe('异常分支环境')
  })
})

describe('报告按环境聚合（M10）', () => {
  it('同一组用例跨两个地址时，通过率分成两组分别算', async () => {
    // A 环境：能打通
    const a = createEnvironment({ name: 'A 环境', baseUrl: targetUrl })
    setActiveEnvironment(a.id)
    await runCase({ method: 'GET', url: '{{base}}/ok', expected: { status: 200 } })

    // B 环境：打不通（同一个用例、不同的地址）→ 通过率必须能看出来是 0
    const b = createEnvironment({ name: 'B 环境', baseUrl: 'http://127.0.0.1:9' })
    setActiveEnvironment(b.id)
    await runCase({ method: 'GET', url: '{{base}}/ok', expected: { status: 200 } })

    const { byEnv } = getReportSummary()
    const groupA = byEnv.find((e) => e.name === 'A 环境')
    const groupB = byEnv.find((e) => e.name === 'B 环境')
    expect(groupA.passRate).toBe(100)
    expect(groupB.passRate).toBe(0)
    expect(groupA.baseUrl).toBe(targetUrl)
    expect(groupB.baseUrl).toBe('http://127.0.0.1:9')
  })

  it('没有环境的老记录归到「(未记录环境)」一组，而不是被算进某个真实环境', async () => {
    setActiveEnvironment(null)
    await runCase({ method: 'GET', url: `${targetUrl}/ok`, expected: { status: 200 } })
    const { byEnv } = getReportSummary()
    const unknown = byEnv.find((e) => e.name === '(未记录环境)')
    expect(unknown).toBeTruthy()
    expect(unknown.baseUrl).toBe('')
  })
})

describe('run-all 响应带上整轮环境（M10）', () => {
  it('响应里的 env 说明这一轮打的是谁', async () => {
    const env = createEnvironment({ name: '整轮环境', baseUrl: targetUrl })
    setActiveEnvironment(env.id)
    createCase({ name: 'M10-冒烟', method: 'GET', url: '{{base}}/ok', expected: { status: 200 } })

    const res = await app.inject({ method: 'POST', url: '/api/run-all', payload: { prefix: 'M10-' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.env).toEqual({ id: env.id, name: '整轮环境', baseUrl: targetUrl })
    expect(body.results[0].env.name).toBe('整轮环境')
  })
})
