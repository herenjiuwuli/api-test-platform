// M8：multipart/form-data 请求体（手搓）。
//
// 这一组要证明两件事：
//   ① **拼出来的包是对的** —— 单测直接对字节做断言（boundary / CRLF / 结尾的 `--` / 二进制不外泄）；
//   ② **执行器真的把它发出去了** —— 起一个能收原始字节的目标服务，让它把「收到了什么」如实回报，
//      再断言回报的事实。只测 ① 只能证明「我有个函数」，证明不了「用例真能传文件」。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { createHash } from 'node:crypto'
import { buildApp } from '../index.js'
import { createCase, getCase } from '../src/cases.js'
import { BODY_TYPES, normalizeBodyType } from '../src/bodyTypes.js'
import { FIXTURES } from '../src/fixtures.js'
import { buildMultipart, makeBoundary, resolveFiles, toFields } from '../src/multipart.js'
import { runCase } from '../src/runner.js'
import { stopAllScheduler } from '../src/scheduler.js'

process.env.DB_PATH = ':memory:'

let target
let targetUrl
let app

beforeAll(async () => {
  target = Fastify()
  // 关键：multipart 与 text/plain 都按**原始字节**收下来，不做任何解析
  // —— 我们要看的就是「线路上到底长什么样」，一旦让框架帮忙解析，就看不到原始包了。
  target.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (req, body, done) => done(null, body))
  target.addContentTypeParser('text/plain', { parseAs: 'string' }, (req, body, done) => done(null, body))

  // 把「收到了什么」如实回报：不做判断，只给事实，判断留给断言
  target.post('/upload', async (req) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body))
    return {
      len: raw.length,
      ctype: String(req.headers['content-type'] || ''),
      clen: String(req.headers['content-length'] || ''),
      // 文件字节有没有原样到达：直接在原始包里找那串字节
      pngFound: raw.includes(FIXTURES.png.bytes),
      fakeExeFound: raw.includes(FIXTURES['fake-exe'].bytes),
      dispositionFound: raw.includes(Buffer.from('filename="my.png"')),
      partTypeFound: raw.includes(Buffer.from('Content-Type: image/png')),
      terminated: raw.subarray(-4).toString('utf8') === '--\r\n',
      sha256: createHash('sha256').update(raw).digest('hex'),
    }
  })
  target.post('/raw', async (req) => ({ raw: String(req.body), type: typeof req.body }))
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

describe('multipart 拼包（单测，直接对字节断言）', () => {
  it('结构正确：每段以 --boundary 开头，整体以 --boundary-- 结束', () => {
    const b = makeBoundary()
    const { body, contentType } = buildMultipart([{ name: 'a', value: '1' }], [], b)
    const text = body.toString('utf8')
    expect(contentType).toBe(`multipart/form-data; boundary=${b}`)
    expect(text.startsWith(`--${b}\r\n`)).toBe(true)
    // 结束分隔符尾部必须多两个短横，漏了它很多服务端会认为请求没发完
    expect(text.endsWith(`--${b}--\r\n`)).toBe(true)
    expect(text).toContain('Content-Disposition: form-data; name="a"')
    expect(text).toContain('\r\n\r\n1\r\n')
  })

  it('★ 二进制安全：文件字节原样进包，不被字符串编码破坏', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x89, 0x50, 0x0d, 0x0a, 0x1a, 0x0a, 0xc3, 0x28])
    const { body } = buildMultipart(
      [],
      [{ name: 'file', filename: 'x.bin', contentType: 'application/octet-stream', bytes }],
    )
    expect(body.includes(bytes)).toBe(true)
    expect(body.includes(Buffer.from('filename="x.bin"'))).toBe(true)
  })

  it('文件名里的引号与换行不会撕开 header', () => {
    const { body } = buildMultipart(
      [],
      [{ name: 'file', filename: 'evil"\r\nX-Injected: 1;.png', contentType: 'image/png', bytes: FIXTURES.png.bytes }],
    )
    const text = body.toString('utf8')
    expect(text).not.toContain('\r\nX-Injected: 1') // 注入的换行没了
    expect(text).toContain('filename="evil%22X-Injected: 1;.png"') // 引号被转义
  })

  it('空文本字段也发得出去（value 为空串 ≠ 字段不存在）', () => {
    const { body } = buildMultipart([{ name: 'note', value: '' }], [])
    expect(body.toString('utf8')).toContain('name="note"\r\n\r\n\r\n')
  })
})

describe('files 声明解析', () => {
  it('夹具名命中 → 拿到真实字节与默认元信息', () => {
    const { files, unknown } = resolveFiles([{ name: 'file', fixture: 'png' }])
    expect(unknown).toEqual([])
    expect(files).toHaveLength(1)
    expect(files[0].contentType).toBe('image/png')
    expect(files[0].bytes.equals(FIXTURES.png.bytes)).toBe(true)
  })

  it('夹具名写错 → 记进 unknown（不静默发空文件）', () => {
    const { files, unknown } = resolveFiles([{ name: 'file', fixture: 'nope' }, { name: 'file' }])
    expect(files).toHaveLength(0)
    expect(unknown).toHaveLength(2)
  })

  it('base64 也能用：临时塞一段内容，不必先加夹具', () => {
    const { files } = resolveFiles([{ name: 'file', base64: Buffer.from('hello').toString('base64') }])
    expect(files[0].bytes.toString('utf8')).toBe('hello')
  })

  it('toFields：对象 → 字段列表；给了字符串 → 明确报错而不是默默发出去', () => {
    expect(toFields({ a: 1, b: true })).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'true' },
    ])
    expect(() => toFields('not-an-object')).toThrow(/form-data 的文本字段请写成 JSON 对象/)
  })
})

describe('请求体类型归一化', () => {
  it('只认三种，其它一律回落到 json', () => {
    expect(BODY_TYPES).toEqual(['json', 'raw', 'form-data'])
    expect(normalizeBodyType(undefined)).toBe('json')
    expect(normalizeBodyType('RAW')).toBe('raw')
    expect(normalizeBodyType(' form-data ')).toBe('form-data')
    expect(normalizeBodyType('xml')).toBe('json')
  })
})

describe('★ 真发包：执行器把 multipart 发到线路上', () => {
  it('★ form-data 上传：Content-Type 被接管、文件字节逐字节到达、包正常收尾', async () => {
    const c = createCase({
      name: 'multipart 上传',
      method: 'POST',
      url: `${targetUrl}/upload`,
      // 故意手填一个错的 Content-Type：multipart 的 boundary 只能由执行器给
      headers: { 'Content-Type': 'application/json' },
      bodyType: 'form-data',
      body: { note: 'hello', count: 2 },
      files: [{ name: 'file', fixture: 'png', filename: 'my.png' }],
      expected: {
        status: 200,
        jsonChecks: [
          { path: '$.ctype', op: 'contains', value: 'multipart/form-data; boundary=' },
          { path: '$.pngFound', op: 'eq', value: true },
          { path: '$.dispositionFound', op: 'eq', value: true },
          { path: '$.partTypeFound', op: 'eq', value: true },
          { path: '$.terminated', op: 'eq', value: true },
        ],
      },
    })
    const r = await runCase(c, { persist: false })
    expect(r.detail).toEqual([])
    expect(r.pass).toBe(true)
    expect(r.status).toBe(200)
    // 同时确认「覆盖 Content-Type」这件事真的发生了：用例里写的是 application/json
    expect(getCase(c.id).headers['Content-Type']).toBe('application/json')
  })

  it('★ 文本字段里的 {{var}} 也会被渲染（不是只有 url/headers 支持）', async () => {
    const c = createCase({
      name: 'multipart 里的变量',
      method: 'POST',
      url: `${targetUrl}/upload`,
      bodyType: 'form-data',
      body: { token: '{{token}}' },
      files: [{ name: 'file', fixture: 'png' }],
      expected: { status: 200, jsonChecks: [{ path: '$.pngFound', op: 'eq', value: true }] },
    })
    const r = await runCase(c, { persist: false, vars: { token: 't-123' } })
    expect(r.pass).toBe(true)
    expect(r.detail).toEqual([])
  })

  it('夹具名写错 → 用例失败且 detail 说得清（不是 500、不是静默通过）', async () => {
    const c = createCase({
      name: 'multipart 夹具写错',
      method: 'POST',
      url: `${targetUrl}/upload`,
      bodyType: 'form-data',
      files: [{ name: 'file', fixture: 'pngg' }],
      expected: { status: 200 },
    })
    const r = await runCase(c, { persist: false })
    expect(r.pass).toBe(false)
    expect(r.status).toBe(0)
    expect(r.detail[0]).toContain('不存在的文件夹具')
    expect(r.detail[0]).toContain('png')
  })

  it('伪装成图片的可执行文件也能当夹具发出去（供被测系统验「只认字节」）', async () => {
    const c = createCase({
      name: 'multipart 伪装文件',
      method: 'POST',
      url: `${targetUrl}/upload`,
      bodyType: 'form-data',
      files: [{ name: 'file', fixture: 'fake-exe', filename: 'invoice.png', contentType: 'image/png' }],
      expected: { status: 200, jsonChecks: [{ path: '$.fakeExeFound', op: 'eq', value: true }] },
    })
    const r = await runCase(c, { persist: false })
    expect(r.pass).toBe(true)
  })
})

describe('raw / json 两种请求体（补上原有行为的回归网）', () => {
  it('raw：原样发字符串，不会被 JSON.stringify 加引号', async () => {
    const c = createCase({
      name: 'raw 请求体',
      method: 'POST',
      url: `${targetUrl}/raw`,
      headers: { 'Content-Type': 'text/plain' },
      bodyType: 'raw',
      body: 'a=1&b=2',
      expected: {
        status: 200,
        jsonChecks: [
          { path: '$.raw', op: 'eq', value: 'a=1&b=2' },
          { path: '$.type', op: 'eq', value: 'string' },
        ],
      },
    })
    const r = await runCase(c, { persist: false })
    expect(r.pass).toBe(true)
  })

  it('json（默认）：仍然是 JSON.stringify，且不动用户手填的 Content-Type', async () => {
    const c = createCase({
      name: 'json 请求体',
      method: 'POST',
      url: `${targetUrl}/upload`,
      headers: { 'Content-Type': 'application/json' },
      body: { a: 1 },
      expected: {
        status: 200,
        jsonChecks: [
          // 用户写的 Content-Type 原样保留（只有 form-data 分支才接管它）
          { path: '$.ctype', op: 'contains', value: 'application/json' },
          // 也没有 multipart 的收尾分隔符 —— 证明没走 form-data 分支
          { path: '$.terminated', op: 'eq', value: false },
          { path: '$.pngFound', op: 'eq', value: false },
        ],
      },
    })
    expect(getCase(c.id).bodyType).toBe('json')
    const r = await runCase(c, { persist: false })
    expect(r.pass).toBe(true)
  })
})
