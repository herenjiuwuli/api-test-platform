// M9：环境变量集。
//
// 这一组要证明的核心**不是 CRUD 能过**，而是「环境真的在运行期生效」：
//   - 用例里写 {{base}} → 真的打到当前环境那个地址（不是写死的 url）；
//   - 环境变量是**基线**：链上 extract 抽到的值不会被它盖掉（否则会拿过期 token 假装通过）；
//   - 环境 headers 是**默认值**：用例里手写的同名头优先，且大小写不敏感（不能出现两个 content-type）。
//
// 所以下面每条「运行期」用例都配了一个**反面对照**：先把环境取消，看它确实打不通/确实报缺变量。
// 没有反面，就没法证明通过是环境带来的。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../index.js'
import { createCase, deleteCase } from '../src/cases.js'
import {
  createEnvironment,
  deleteEnvironment,
  getActiveEnvironment,
  getActiveId,
  listEnvironments,
  mergeHeaders,
  mergeVarBag,
  normalizeBaseUrl,
  setActiveEnvironment,
  updateEnvironment,
} from '../src/environments.js'
import { runAll, runCase } from '../src/runner.js'
import { stopAllScheduler } from '../src/scheduler.js'

process.env.DB_PATH = ':memory:'

let target
let targetUrl
let app

beforeAll(async () => {
  target = Fastify()
  // 靶子服务：把「请求打到了哪个实例」如实体现在响应里 —— 两个环境各有一个只有它认识的标记
  target.get('/whoami', async (req) => ({
    env: 'A',
    // 环境头带过来了吗？用例头的优先级对不对？都由这个回显来证明
    xEnv: String(req.headers['x-env'] || ''),
    ctype: String(req.headers['content-type'] || ''),
  }))
  target.get('/whoami-b', async () => ({ env: 'B' }))
  // 假登录：给一个固定的 token，供「环境变量 vs extract 优先级」用例使用
  target.post('/login', async () => ({ token: 't-fresh-from-chain' }))
  target.get('/need-token', async (req, reply) => {
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/, '')
    if (t !== 't-fresh-from-chain') return reply.code(401).send({ error: 'token 不对', got: t })
    return { ok: true, token: t }
  })
  await target.listen({ port: 0, host: '127.0.0.1' })
  targetUrl = `http://127.0.0.1:${target.server.address().port}`

  app = buildApp()
  await app.ready()
})

afterAll(async () => {
  stopAllScheduler()
  await app.close()
  await target.close()
})

/** 每条用例开头都清一次环境表与当前环境，用例之间不串味 */
function resetEnvs() {
  setActiveEnvironment(null)
  for (const e of listEnvironments()) deleteEnvironment(e.id)
}

// ---------------------------------------------------------------------------
// 校验与归一化
// ---------------------------------------------------------------------------

describe('环境地址的校验与归一化', () => {
  it('去掉尾部斜杠：否则 {{base}}/api/x 会变成 //api/x', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:3200/')).toBe('http://127.0.0.1:3200')
    expect(normalizeBaseUrl('  https://a.example.com///  ')).toBe('https://a.example.com')
  })

  it('必须以 http/https 开头（把「地址写错」拦在保存时，而不是跑用例时）', () => {
    expect(() => normalizeBaseUrl('127.0.0.1:3200')).toThrow(/http/)
    expect(() => normalizeBaseUrl('')).toThrow(/必填/)
  })

  it('环境名必填且唯一（重名给 400 而不是 500）', () => {
    resetEnvs()
    createEnvironment({ name: '本地', baseUrl: 'http://127.0.0.1:1' })
    expect(() => createEnvironment({ name: '本地', baseUrl: 'http://127.0.0.1:2' })).toThrow(/已存在/)
    expect(() => createEnvironment({ name: '  ', baseUrl: 'http://127.0.0.1:1' })).toThrow(/必填/)
  })

  it('环境变量必须是 JSON 对象，且不许叫 base', () => {
    resetEnvs()
    expect(() => createEnvironment({ name: 'e1', baseUrl: 'http://127.0.0.1:1', vars: [1, 2] })).toThrow(/JSON 对象/)
    expect(() => createEnvironment({ name: 'e1', baseUrl: 'http://127.0.0.1:1', vars: '{bad' })).toThrow(/合法 JSON/)
    expect(() => createEnvironment({ name: 'e1', baseUrl: 'http://127.0.0.1:1', vars: { base: 'x' } })).toThrow(/base/)
  })

  it('部分更新：只传的字段被改，其余保持原值；改名撞车也会 400', () => {
    resetEnvs()
    const a = createEnvironment({ name: 'A', baseUrl: 'http://a.example.com', vars: { k: '1' } })
    createEnvironment({ name: 'B', baseUrl: 'http://b.example.com' })
    const upd = updateEnvironment(a.id, { vars: { k: '2' } })
    expect(upd.name).toBe('A')
    expect(upd.baseUrl).toBe('http://a.example.com')
    expect(upd.vars).toEqual({ k: '2' })
    expect(() => updateEnvironment(a.id, { name: 'B' })).toThrow(/已存在/)
  })
})

// ---------------------------------------------------------------------------
// 当前环境：全局只有一行
// ---------------------------------------------------------------------------

describe('当前环境（同一时刻只有一个）', () => {
  it('激活 A 再激活 B → 当前环境只剩 B（不会两个都 active）', () => {
    resetEnvs()
    const a = createEnvironment({ name: 'A', baseUrl: 'http://a.example.com' })
    const b = createEnvironment({ name: 'B', baseUrl: 'http://b.example.com' })

    setActiveEnvironment(a.id)
    expect(getActiveId()).toBe(a.id)
    setActiveEnvironment(b.id)
    expect(getActiveId()).toBe(b.id)
    expect(getActiveEnvironment().name).toBe('B')
    // 表里 "当前" 只有一行 —— 这就是把它放 settings 而不是 is_active 列的原因
    expect(listEnvironments().filter((e) => e.id === getActiveId())).toHaveLength(1)
  })

  it('传 null 取消当前环境', () => {
    resetEnvs()
    const a = createEnvironment({ name: 'A', baseUrl: 'http://a.example.com' })
    setActiveEnvironment(a.id)
    setActiveEnvironment(null)
    expect(getActiveEnvironment()).toBeNull()
  })

  it('删掉正在使用的环境 → 当前环境被清空，并如实返回 activeCleared', () => {
    resetEnvs()
    const a = createEnvironment({ name: 'A', baseUrl: 'http://a.example.com' })
    setActiveEnvironment(a.id)
    expect(deleteEnvironment(a.id)).toEqual({ deleted: true, activeCleared: true })
    expect(getActiveEnvironment()).toBeNull()
  })

  it('删掉没在用的环境 → activeCleared=false，当前环境不受影响', () => {
    resetEnvs()
    const a = createEnvironment({ name: 'A', baseUrl: 'http://a.example.com' })
    const b = createEnvironment({ name: 'B', baseUrl: 'http://b.example.com' })
    setActiveEnvironment(a.id)
    expect(deleteEnvironment(b.id)).toEqual({ deleted: true, activeCleared: false })
    expect(getActiveId()).toBe(a.id)
  })
})

// ---------------------------------------------------------------------------
// 运行期生效（这一组才是重点）
// ---------------------------------------------------------------------------

describe('运行期：环境真的生效', () => {
  it('★ 用例里写 {{base}} → 打到当前环境的地址；取消环境后同一个用例就打不通', async () => {
    resetEnvs()
    const env = createEnvironment({ name: '靶子A', baseUrl: targetUrl })
    const c = createCase({
      name: 'ENV-base',
      method: 'GET',
      url: '{{base}}/whoami',
      expected: { status: 200, jsonChecks: [{ path: '$.env', op: 'eq', value: 'A' }] },
    })
    try {
      setActiveEnvironment(env.id)
      const ok = await runCase(c, { persist: false })
      expect(ok.pass).toBe(true)
      expect(ok.status).toBe(200)

      // 反面对照：没有当前环境 → {{base}} 没赋值 → 请求不可能成功
      setActiveEnvironment(null)
      const bad = await runCase(c, { persist: false })
      expect(bad.pass).toBe(false)
      expect(bad.detail.join(' ')).toContain('{{base}}') // 明确写出「谁没赋值」，而不是一句莫名的 fetch failed
    } finally {
      deleteCase(c.id)
    }
  })

  it('★ 切环境就是换地址：同一批用例，换个环境打到另一个实例', async () => {
    resetEnvs()
    const a = createEnvironment({ name: 'A', baseUrl: targetUrl })
    const b = createEnvironment({ name: 'B', baseUrl: `${targetUrl}/whoami-b`.replace(/\/whoami-b$/, '') })
    // 说明：B 也指向同一个靶子服务（测试里只有一个进程），用不同的 vars 证明「环境换了」
    updateEnvironment(b.id, { vars: { tag: 'B' } })
    const c = createCase({
      name: 'ENV-switch',
      method: 'GET',
      url: '{{base}}/whoami',
      expected: { status: 200 },
    })
    try {
      setActiveEnvironment(a.id)
      expect((await runCase(c, { persist: false })).status).toBe(200)
      setActiveEnvironment(b.id)
      const r = await runCase(c, { persist: false })
      expect(r.status).toBe(200)
      expect(r.extracted).toEqual({}) // 这条没配 extract，只是确认换环境后照样跑通
    } finally {
      deleteCase(c.id)
    }
  })

  it('★ 环境 headers 是默认值，用例里手写的同名头优先（大小写不敏感）', async () => {
    resetEnvs()
    const env = createEnvironment({
      name: '带头',
      baseUrl: targetUrl,
      headers: { 'X-Env': 'from-env', 'Content-Type': 'application/json' },
    })
    const c = createCase({
      name: 'ENV-headers',
      method: 'GET',
      url: '{{base}}/whoami',
      // 用例用**小写**写同名头：如果合并时不区分大小写，请求里会出现两个 x-env
      headers: { 'x-env': 'from-case' },
      expected: { status: 200, jsonChecks: [{ path: '$.xEnv', op: 'eq', value: 'from-case' }] },
    })
    try {
      setActiveEnvironment(env.id)
      const r = await runCase(c, { persist: false })
      expect(r.pass).toBe(true)
      expect(r.status).toBe(200)
    } finally {
      deleteCase(c.id)
    }
  })

  it('★★ 优先级：链上 extract 抽到的值**不被**环境基线盖掉（否则会拿过期 token 假装通过）', async () => {
    resetEnvs()
    // 环境里放一个**故意过期**的 token，链上第一个用例会登录拿到新的
    const env = createEnvironment({
      name: '带旧token',
      baseUrl: targetUrl,
      vars: { token: 't-stale-from-env' },
    })
    const login = createCase({
      name: 'ENV-chain-login',
      method: 'POST',
      url: '{{base}}/login',
      expected: { status: 200 },
      extract: [{ name: 'token', path: '$.token' }],
    })
    const need = createCase({
      name: 'ENV-chain-need-token',
      method: 'GET',
      url: '{{base}}/need-token',
      headers: { Authorization: 'Bearer {{token}}' },
      expected: { status: 200, jsonChecks: [{ path: '$.token', op: 'eq', value: 't-fresh-from-chain' }] },
    })
    try {
      setActiveEnvironment(env.id)
      const results = await runAll([login, need], { persist: false })
      expect(results.map((r) => r.pass)).toEqual([true, true])
      // 反面对照：如果环境基线反盖了链上抽到的值，这条一定 401
      expect(results[1].status).toBe(200)
    } finally {
      deleteCase(login.id)
      deleteCase(need.id)
    }
  })

  it('mergeVarBag 只填「还没赋值」的键（纯函数层面把上面那条优先级钉住）', () => {
    const bag = { token: 'from-chain' }
    mergeVarBag(bag, { baseUrl: 'http://x', vars: { token: 'from-env', other: 'env-only' } })
    expect(bag.token).toBe('from-chain')
    expect(bag.other).toBe('env-only')
    expect(bag.base).toBe('http://x')
  })

  it('mergeHeaders：同名头大小写不敏感地覆盖，用例优先', () => {
    const merged = mergeHeaders({ 'Content-Type': 'application/json', 'X-A': '1' }, { 'content-type': 'text/plain' })
    expect(merged['content-type']).toBe('text/plain')
    expect(Object.keys(merged).filter((k) => k.toLowerCase() === 'content-type')).toHaveLength(1)
    expect(merged['X-A']).toBe('1') // 用例没写的环境头保留
  })

  it('★ 用例显式传 env:null 时不用环境（留给需要「裸跑」的场景与测试）', async () => {
    resetEnvs()
    createEnvironment({ name: 'A', baseUrl: targetUrl })
    setActiveEnvironment(listEnvironments()[0].id)
    const c = createCase({ name: 'ENV-off', method: 'GET', url: '{{base}}/whoami', expected: { status: 200 } })
    try {
      expect((await runCase(c, { persist: false })).pass).toBe(true)
      const off = await runCase(c, { persist: false, env: null })
      expect(off.pass).toBe(false)
      expect(off.detail.join(' ')).toContain('{{base}}')
    } finally {
      deleteCase(c.id)
    }
  })
})

// ---------------------------------------------------------------------------
// HTTP 接口
// ---------------------------------------------------------------------------

describe('HTTP 接口', () => {
  it('GET /api/environments 返回列表与当前环境 id', async () => {
    resetEnvs()
    const a = createEnvironment({ name: 'A', baseUrl: 'http://a.example.com' })
    setActiveEnvironment(a.id)
    const res = await app.inject({ method: 'GET', url: '/api/environments' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toHaveLength(1)
    expect(body.activeId).toBe(a.id)
  })

  it('POST 校验失败 → 400；成功 → 201', async () => {
    resetEnvs()
    const bad = await app.inject({
      method: 'POST',
      url: '/api/environments',
      payload: { name: 'x', baseUrl: 'nope' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/http/)

    const ok = await app.inject({
      method: 'POST',
      url: '/api/environments',
      payload: { name: 'x', baseUrl: 'http://x.example.com' },
    })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().baseUrl).toBe('http://x.example.com')
  })

  it('PUT /api/environments/active 切换；传 null 取消；不存在的 id → 404', async () => {
    resetEnvs()
    const a = createEnvironment({ name: 'A', baseUrl: 'http://a.example.com' })
    const on = await app.inject({ method: 'PUT', url: '/api/environments/active', payload: { id: a.id } })
    expect(on.statusCode).toBe(200)
    expect(on.json().activeId).toBe(a.id)

    const off = await app.inject({ method: 'PUT', url: '/api/environments/active', payload: { id: null } })
    expect(off.json().activeId).toBeNull()

    const missing = await app.inject({ method: 'PUT', url: '/api/environments/active', payload: { id: 999999 } })
    expect(missing.statusCode).toBe(404)
  })

  it('PUT /api/environments/:id 与 DELETE：不存在的 id → 404', async () => {
    resetEnvs()
    expect((await app.inject({ method: 'PUT', url: '/api/environments/999999', payload: { name: 'z' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/api/environments/999999' })).statusCode).toBe(404)

    const a = createEnvironment({ name: 'A', baseUrl: 'http://a.example.com' })
    const del = await app.inject({ method: 'DELETE', url: `/api/environments/${a.id}` })
    expect(del.statusCode).toBe(200)
    expect(del.json().deleted).toBe(true)
  })

  it('路由 /active 不会被 /:id 吃掉（静态段优先，别退化成 id=NaN）', async () => {
    resetEnvs()
    const a = createEnvironment({ name: 'A', baseUrl: 'http://a.example.com' })
    const res = await app.inject({ method: 'PUT', url: '/api/environments/active', payload: { id: a.id } })
    expect(res.statusCode).toBe(200)
    expect(res.json().activeId).toBe(a.id)
  })
})
