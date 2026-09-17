// M11：套件导出 / 导入。
//
// 这一组要证明的不是「JSON 能读能写」，而是三件容易做错的事：
//   ① **敏感头真的被脱敏了** —— 导出文件是要被分享的，凭据混进去就是泄漏；
//   ② **导出的顺序 = 串链顺序** —— 顺序错了，导入后 extract 出来的变量会跑到用它的人后面，
//      链条「静默断掉」（用例还是一条条跑，只是全红），比报错难查得多；
//   ③ **重名不静默毁数据** —— 默认 rename 既不丢旧的也不覆盖新的，overwrite/skip 是显式选择。
//
// 最后一条「导出 → 清空库 → 导入 → 再跑一遍全绿」是这一组的地基：
// 它同时证明了顺序、变量、环境三者都被完整搬过去了。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../index.js'
import { getDb } from '../src/db.js'
import { createCase, listCases } from '../src/cases.js'
import { createEnvironment, listEnvironments, setActiveEnvironment } from '../src/environments.js'
import { exportSuite, importSuite, isSensitiveHeader, redactHeaders } from '../src/suite.js'
import { runAll } from '../src/runner.js'
import { stopAllScheduler } from '../src/scheduler.js'

process.env.DB_PATH = ':memory:'

let target
let targetUrl
let app

beforeAll(async () => {
  target = Fastify()
  target.get('/whoami', async (req) => ({
    ok: true,
    token: String(req.headers['x-token'] || ''),
    env: String(req.headers['x-env'] || ''),
  }))
  // 假登录：链上第一条负责 extract 出 token，第二条拿它去请求 —— 顺序错了这里就红
  target.post('/login', async () => ({ token: 'tok-from-chain' }))
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

beforeEach(() => {
  // 内存库跨用例复用，逐条清干净，免得重名检测被上一条用例污染
  getDb().exec('DELETE FROM test_cases; DELETE FROM environments; DELETE FROM settings;')
})

// 一条最小可跑的链：登录抽 token → 带上它请求。串链顺序错了第二条必红。
function seedChain() {
  const env = createEnvironment({
    name: '靶子环境',
    baseUrl: targetUrl,
    headers: { 'X-Env': 'from-env', Authorization: 'Bearer super-secret-token' },
    vars: { who: 'tester' },
  })
  setActiveEnvironment(env.id)
  createCase({
    name: '1-登录',
    method: 'POST',
    url: '{{base}}/login',
    extract: [{ name: 'token', path: '$.token' }],
  })
  createCase({
    name: '2-带 token 请求',
    method: 'GET',
    url: '{{base}}/whoami',
    headers: { 'X-Token': '{{token}}' },
    expected: { status: 200, jsonChecks: [{ path: '$.token', op: 'eq', value: 'tok-from-chain' }] },
  })
  return env
}

describe('敏感头识别', () => {
  it('常见凭据头都被认出来，普通头不受影响', () => {
    for (const name of ['Authorization', 'authorization', 'Cookie', 'X-Api-Key', 'X-Token', 'Proxy-Authorization']) {
      expect(isSensitiveHeader(name), name).toBe(true)
    }
    for (const name of ['Content-Type', 'X-Env', 'Accept', 'User-Agent']) {
      expect(isSensitiveHeader(name), name).toBe(false)
    }
  })

  it('redactHeaders 抹掉值但保留键名，并回报抹了哪些', () => {
    const { headers, redacted } = redactHeaders({ 'X-Env': 'gray', Authorization: 'Bearer abc', 'X-Token': 't' })
    expect(headers['X-Env']).toBe('gray')
    expect(headers.Authorization).toBe('')
    expect(headers['X-Token']).toBe('')
    expect(redacted.sort()).toEqual(['Authorization', 'X-Token'])
  })

  it('★ 值是 {{变量}} 的敏感头不脱敏 —— 那不是藏在文件里的秘密，是运行期从链上取的', () => {
    // 这条是端到端测试先失败、才回头补上的规则：
    // 原来按「键名敏感就抹」，把 `X-Token: {{token}}` 也抹成了空串，
    // 导入后第二条用例不带 token → 靶子返回空串 → 断言红（串链被脱敏悄悄弄断）。
    const { headers, redacted } = redactHeaders({
      'X-Token': '{{token}}',
      Authorization: 'Bearer {{token}}',
      Cookie: 'sid=real-secret',
    })
    expect(headers['X-Token']).toBe('{{token}}')
    expect(headers.Authorization).toBe('Bearer {{token}}')
    expect(headers.Cookie).toBe('')
    expect(redacted).toEqual(['Cookie'])
  })
})

describe('导出', () => {
  it('★ 凭据不进导出文件：Authorization 的值被抹成空串，且键名留在 redactedHeaders 里', () => {
    seedChain()
    const suite = exportSuite()

    const env = suite.environments.find((e) => e.name === '靶子环境')
    expect(env.headers.Authorization).toBe('')
    expect(env.redactedHeaders).toContain('Authorization')
    // 关键：整个文件里不能出现凭据原文
    expect(JSON.stringify(suite)).not.toContain('super-secret-token')
    // 非敏感头照常带出去（否则导入后环境就不完整了）
    expect(env.headers['X-Env']).toBe('from-env')
  })

  it('不带 id（本地自增，跨库无意义），但带上 kind/version 供导入校验', () => {
    seedChain()
    const suite = exportSuite()
    expect(suite.kind).toBe('api-test-platform-suite')
    expect(suite.version).toBe(1)
    for (const c of suite.cases) expect(c.id).toBeUndefined()
    for (const e of suite.environments) expect(e.id).toBeUndefined()
  })

  it('★ 用例按创建顺序导出（= 串链顺序），而不是列表页那个倒序', () => {
    seedChain()
    // 列表页拿到的顺序（id 倒序）与串链顺序相反，这里顺带把这个前提固定下来
    expect(listCases().map((c) => c.name)).toEqual(['2-带 token 请求', '1-登录'])
    expect(exportSuite().cases.map((c) => c.name)).toEqual(['1-登录', '2-带 token 请求'])
  })

  it('url 里的 {{base}} 原样导出（导入后换环境仍然有效）', () => {
    seedChain()
    const suite = exportSuite()
    expect(suite.cases.map((c) => c.url)).toEqual(['{{base}}/login', '{{base}}/whoami'])
  })
})

describe('导入 · 冲突策略', () => {
  it('默认 rename：重名不覆盖也不丢，新的加 (2) 后缀', () => {
    seedChain()
    const suite = exportSuite()
    const r = importSuite(suite)

    expect(r.ok).toBe(true)
    expect(r.renamed).toBe(3) // 1 个环境 + 2 条用例
    expect(r.created).toBe(3)
    expect(listCases().map((c) => c.name)).toContain('1-登录 (2)')
    expect(listEnvironments().map((e) => e.name)).toContain('靶子环境 (2)')
    // 原始的还在
    expect(listCases().map((c) => c.name)).toContain('1-登录')
  })

  it('overwrite：重名时用文件里的内容盖掉，不新增条目', () => {
    seedChain()
    const suite = exportSuite()
    suite.cases.find((c) => c.name === '1-登录').url = '{{base}}/login-changed'

    const before = listCases().length
    const r = importSuite(suite, { onConflict: 'overwrite' })

    expect(r.updated).toBe(3)
    expect(r.created).toBe(0)
    expect(listCases().length).toBe(before)
    expect(listCases().find((c) => c.name === '1-登录').url).toBe('{{base}}/login-changed')
  })

  it('skip：重名一律不动，库里保持原样', () => {
    seedChain()
    const suite = exportSuite()
    suite.cases.forEach((c) => (c.url = '{{base}}/nope'))

    const r = importSuite(suite, { onConflict: 'skip' })
    expect(r.skipped).toBe(3)
    expect(r.created).toBe(0)
    expect(listCases().every((c) => c.url !== '{{base}}/nope')).toBe(true)
  })

  it('导入时脱敏留下的空凭据头被丢掉，并给出可读的 warning', () => {
    seedChain()
    const suite = exportSuite()
    getDb().exec('DELETE FROM environments')

    const r = importSuite(suite)
    expect(r.warnings.join('\n')).toContain('Authorization')
    const env = listEnvironments().find((e) => e.name === '靶子环境')
    // 空值的 Authorization 不该写进去 —— 否则每个请求都带一个空的凭据头，只会在远端吃 401
    expect(env.headers.Authorization).toBeUndefined()
    expect(env.headers['X-Env']).toBe('from-env')
  })
})

describe('导入 · 坏输入不炸整锅', () => {
  it('不是本平台的文件 → 明确报错，而不是导进去一堆怪东西', () => {
    const r = importSuite({ kind: 'postman-collection', item: [] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('api-test-platform-suite')
  })

  it('版本高过支持范围 → 拒绝，不做「尽力而为」的猜测', () => {
    const r = importSuite({ kind: 'api-test-platform-suite', version: 99, cases: [] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('99')
  })

  it('★ 一条坏用例不影响其余：43/44 不该因为第 44 条被整份打回', () => {
    seedChain()
    const suite = exportSuite()
    suite.cases.push({ name: '坏用例-没有 url', method: 'GET' })
    getDb().exec('DELETE FROM test_cases; DELETE FROM environments;')

    const r = importSuite(suite)
    expect(r.created).toBe(3) // 1 个环境 + 2 条用例；坏的那条没进来
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]).toMatchObject({ kind: 'case', name: '坏用例-没有 url' })
    expect(r.failed[0].reason).toContain('url')
    expect(listCases()).toHaveLength(2)
  })

  it('空文件不算错，但也不声称导入了东西', () => {
    const r = importSuite({ kind: 'api-test-platform-suite', version: 1, cases: [], environments: [] })
    expect(r.ok).toBe(true)
    expect(r.imported).toBe(0)
    expect(r.failed).toHaveLength(0)
  })
})

describe('HTTP 路由', () => {
  it('GET /api/suite/export 返回可下载的 JSON（带 Content-Disposition）', async () => {
    seedChain()
    const res = await app.inject({ method: 'GET', url: '/api/suite/export' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.headers['content-disposition']).toContain('.json')
    const body = res.json()
    expect(body.kind).toBe('api-test-platform-suite')
    expect(body.counts.cases).toBe(2)
  })

  it('POST /api/suite/import 走得通，并把冲突策略透传给 importSuite', async () => {
    seedChain()
    const suite = exportSuite()
    const res = await app.inject({
      method: 'POST',
      url: '/api/suite/import?onConflict=skip',
      payload: suite,
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.onConflict).toBe('skip')
    expect(body.skipped).toBe(3)
  })

  it('POST /api/suite/import 拿错文件 → 400（不是 500，也不是静默成功）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/suite/import',
      payload: { hello: 'world' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeTruthy()
  })
})

describe('★ 端到端：资产真的能搬走', () => {
  it('导出 → 清空库 → 导入 → 再跑一遍，仍然 2/2 全绿', async () => {
    seedChain()
    const first = await runAll(listCases().sort((a, b) => a.id - b.id), { persist: false })
    expect(first.every((r) => r.pass)).toBe(true)

    const snapshot = exportSuite()

    // 把库清成一张白纸（模拟「换一台机器」）
    getDb().exec('DELETE FROM test_cases; DELETE FROM environments; DELETE FROM settings;')
    expect(listCases()).toHaveLength(0)
    expect(listEnvironments()).toHaveLength(0)

    const r = importSuite(snapshot)
    expect(r.ok).toBe(true)
    expect(r.created).toBe(3)

    // 环境没自动变成「当前环境」（那是本机状态，导出文件里不该带）→ 手动选一次
    const env = listEnvironments().find((e) => e.name === '靶子环境')
    expect(env).toBeTruthy()
    setActiveEnvironment(env.id)

    const second = await runAll(listCases().sort((a, b) => a.id - b.id), { persist: false })
    expect(second.map((r2) => r2.name)).toEqual(['1-登录', '2-带 token 请求'])
    expect(second.every((r2) => r2.pass)).toBe(true)
    // 串链真的接上了：第二条用的 token 是第一条 extract 出来的
    expect(second[1].env?.baseUrl).toBe(targetUrl)
  })
})
