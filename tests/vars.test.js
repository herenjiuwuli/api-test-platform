// M4 用例链测试：{{var}} 渲染 + 响应抽变量 + 链上传递。
// 用本地假目标服务复现真实链路：登录抽 token → 带 token 调受保护接口。
// 关键设计：不只测「能通过」，还测「去掉链就应该失败」——否则无法证明通过是链带来的。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { applyExtract, createVarBag, missingVarNote, renderTemplate } from '../src/vars.js'
import { createCase, deleteCase } from '../src/cases.js'
import { runAll, runCase } from '../src/runner.js'
import { buildApp } from '../index.js'

process.env.DB_PATH = ':memory:'

let target
let targetUrl
let app

beforeAll(async () => {
  target = Fastify()
  target.post('/login', async () => ({ token: 't-secret-123', user: { name: '张三' } }))
  target.get('/profile', async (req, reply) => {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/)
    if (m?.[1] !== 't-secret-123') return reply.code(401).send({ error: '未登录' })
    return { name: '张三', roles: ['employee'] }
  })
  target.post('/echo-body', async (req) => ({ got: req.body }))
  target.get('/not-json', async (req, reply) => reply.type('text/plain').send('pure text'))
  await target.listen({ port: 0, host: '127.0.0.1' })
  targetUrl = 'http://127.0.0.1:' + target.server.address().port

  app = buildApp()
  await app.ready()
})

afterAll(async () => {
  await target.close()
  await app.close()
})

describe('renderTemplate（{{var}} 模板渲染）', () => {
  it('替换字符串里的占位', () => {
    expect(renderTemplate('Bearer {{token}}', { token: 'abc' })).toEqual({ value: 'Bearer abc', missing: [] })
  })

  it('递归替换对象与数组（headers / body 都要能用）', () => {
    const r = renderTemplate(
      { headers: { Authorization: 'Bearer {{token}}' }, list: ['{{a}}', 'x{{b}}'] },
      { token: 't', a: 1, b: 2 },
    )
    expect(r.value).toEqual({ headers: { Authorization: 'Bearer t' }, list: ['1', 'x2'] })
    expect(r.missing).toEqual([])
  })

  it('缺失变量替换成空串并回报名字 —— 不能把 {{token}} 原样发给被测系统', () => {
    const r = renderTemplate('Bearer {{token}}', {})
    expect(r.value).toBe('Bearer ')
    expect(r.missing).toEqual(['token'])
  })

  it('非字符串值原样保留（数字/布尔/null 不该被转成字符串）', () => {
    const r = renderTemplate({ n: 1, b: false, z: null }, {})
    expect(r.value).toEqual({ n: 1, b: false, z: null })
  })

  it('允许 {{ token }} 带空格', () => {
    expect(renderTemplate('{{ token }}', { token: 'v' }).value).toBe('v')
  })
})

describe('applyExtract（按 JSONPath 从响应抽变量）', () => {
  it('抽到字符串与数字，值统一转字符串（要能塞进 header）', () => {
    expect(applyExtract('{"token":"abc","n":42}', [{ name: 'token', path: '$.token' }, { name: 'n', path: '$.n' }])).toEqual({
      token: 'abc',
      n: '42',
    })
  })

  it('抽嵌套 / 数组通配（第一个匹配值）', () => {
    expect(applyExtract('{"user":{"roles":["employee","boss"]}}', [{ name: 'role', path: '$.user.roles[*]' }])).toEqual({
      role: 'employee',
    })
  })

  it('响应不是 JSON → 返回空对象，不抛错（断言层会报失败，不重复报）', () => {
    expect(applyExtract('pure text', [{ name: 'token', path: '$.token' }])).toEqual({})
  })

  it('路径无匹配 → 跳过该变量', () => {
    expect(applyExtract('{"a":1}', [{ name: 'token', path: '$.token' }])).toEqual({})
  })

  it('缺 name / path 的声明被忽略', () => {
    expect(applyExtract('{"token":"abc"}', [{ name: '', path: '$.token' }, { name: 'x' }, null])).toEqual({})
  })
})

describe('用例链（登录 → 带 token 调受保护接口）', () => {
  it('⭐ 共享变量袋：前一条抽的 token，后一条直接可用', async () => {
    const results = await runAll(
      [
        {
          id: 1,
          name: '登录',
          method: 'POST',
          url: `${targetUrl}/login`,
          expected: { status: 200 },
          extract: [{ name: 'token', path: '$.token' }],
        },
        {
          id: 2,
          name: '读我的资料',
          method: 'GET',
          url: `${targetUrl}/profile`,
          headers: { Authorization: 'Bearer {{token}}' },
          expected: { status: 200, jsonChecks: [{ path: '$.name', op: 'eq', value: '张三' }] },
        },
      ],
      { persist: false },
    )
    expect(results[0].extracted).toEqual({ token: 't-secret-123' })
    expect(results[1].pass).toBe(true)
    expect(results[1].status).toBe(200)
  })

  it('POST 请求体里的占位同样会被渲染', async () => {
    const results = await runAll(
      [
        { id: 3, name: '登录', method: 'POST', url: `${targetUrl}/login`, extract: [{ name: 'token', path: '$.token' }] },
        {
          id: 4,
          name: '带变量的请求体',
          method: 'POST',
          url: `${targetUrl}/echo-body`,
          headers: { 'Content-Type': 'application/json' },
          body: { tk: '{{token}}' },
          expected: { status: 200, jsonChecks: [{ path: '$.got.tk', op: 'eq', value: 't-secret-123' }] },
        },
      ],
      { persist: false },
    )
    expect(results[1].pass).toBe(true)
  })

  it('⭐ 单跑（没有变量袋）受保护接口必须失败 —— 反过来证明上一条的通过是链带来的', async () => {
    const alone = await runCase(
      {
        method: 'GET',
        url: `${targetUrl}/profile`,
        headers: { Authorization: 'Bearer {{token}}' },
        expected: { status: 200 },
      },
      { persist: false },
    )
    expect(alone.pass).toBe(false)
    expect(alone.status).toBe(401)
    // 排障提示要点出「变量没赋值」，别让人误以为是被测系统的毛病
    expect(alone.detail.join()).toContain('未赋值变量：{{token}}')
  })

  it('每次 run-all 用新变量袋，不跨运行复用（防止拿上次的 token 假装通过）', async () => {
    const only = [{ id: 5, method: 'GET', url: `${targetUrl}/profile`, headers: { Authorization: 'Bearer {{token}}' }, expected: { status: 200 } }]
    const first = await runAll(only, { persist: false })
    const second = await runAll(only, { persist: false })
    expect(first[0].pass).toBe(false)
    expect(second[0].pass).toBe(false)
  })
})

describe('run-all 接口：按创建顺序串链', () => {
  it('先建的「登录」排在前面，后建的「取资料」能用上它的 token', async () => {
    const login = createCase({
      name: '链-登录',
      method: 'POST',
      url: `${targetUrl}/login`,
      extract: [{ name: 'token', path: '$.token' }],
      expected: { status: 200 },
    })
    const profile = createCase({
      name: '链-取资料',
      method: 'GET',
      url: `${targetUrl}/profile`,
      headers: { Authorization: 'Bearer {{token}}' },
      expected: { status: 200 },
    })
    try {
      const res = await app.inject({ method: 'POST', url: '/api/run-all' })
      const body = res.json()
      const byId = Object.fromEntries(body.results.map((r) => [r.caseId, r]))
      // 结果是「按创建顺序」返回的，不是倒序
      expect(body.results.map((r) => r.caseId)).toEqual([login.id, profile.id])
      expect(byId[login.id].pass).toBe(true)
      expect(byId[profile.id].pass).toBe(true)
    } finally {
      deleteCase(login.id)
      deleteCase(profile.id)
    }
  })

  it('run-all 支持 prefix：只跑一组用例，不把别的组的失败算进来', async () => {
    // 一个平台里常挂着多个被测系统的用例；不分组的「跑全部」会把别人的红算到自己头上
    const grp = createCase({
      name: 'GRP-只此一条',
      method: 'GET',
      url: `${targetUrl}/login`, // 该路由只注册了 POST，GET 必然 404 —— 断言它与别的组无关
      expected: { status: 404 },
    })
    try {
      const res = await app.inject({ method: 'POST', url: '/api/run-all', payload: { prefix: 'GRP-' } })
      const body = res.json()
      expect(body.total).toBe(1)
      expect(body.filter).toBe('GRP-')
      expect(body.results[0].caseId).toBe(grp.id)
      expect(body.results[0].pass).toBe(true)
    } finally {
      deleteCase(grp.id)
    }
  })
})

describe('辅助函数', () => {
  it('createVarBag 返回可写袋子', () => {
    const bag = createVarBag({ a: '1' })
    bag.b = '2'
    expect(bag).toEqual({ a: '1', b: '2' })
  })

  it('missingVarNote：无缺失返回 null，有缺失给出可读提示', () => {
    expect(missingVarNote([])).toBeNull()
    expect(missingVarNote(['token', 'uid'])).toContain('{{token}}')
    expect(missingVarNote(['token', 'uid'])).toContain('{{uid}}')
  })
})
