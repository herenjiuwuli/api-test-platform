// 执行器的查询参数支持（M6 补能力）
//
// 起因：office-oa 的统计接口按 ?scope= 返回不同范围，执行器却发不出 query string ——
// 用例里写的 query 被静默丢弃，服务器永远收到「没带参数」的请求。
// 这与 M8 的 multipart 是同一个故事：**SUT 长出新面，工具跟着长**。
// 这组用例把行为钉死：拼 URL、渲染 {{var}}、缺失变量照常拦截。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { runCase } from '../src/runner.js'
import { stopAllScheduler } from '../src/scheduler.js'

process.env.DB_PATH = ':memory:'

let target
let targetUrl

// runCase 的返回里没有 json 字段，响应体只以 bodyPreview（前 200 字符）回传 —— 回声接口够短，直接解析
function bodyOf(r) {
  return JSON.parse(r.bodyPreview)
}

beforeAll(async () => {
  target = Fastify()
  // 回声接口：把收到的 query 原样返回 —— 断言「执行器到底发出了什么」就看这里
  target.get('/echo', async (req) => ({ q: req.query || {} }))
  await target.listen({ port: 0, host: '127.0.0.1' })
  targetUrl = 'http://127.0.0.1:' + target.server.address().port
})

afterAll(async () => {
  stopAllScheduler()
  await target.close()
})

describe('执行器 query 支持（M6）', () => {
  it('query 对象被拼到 URL，服务器真的收到了', async () => {
    const r = await runCase(
      { method: 'GET', url: `${targetUrl}/echo`, query: { scope: 'all', page: '2' }, expected: { status: 200 } },
      { env: null, persist: false },
    )
    expect(r.pass).toBe(true)
    expect(bodyOf(r).q).toEqual({ scope: 'all', page: '2' })
  })

  it('query 的值也过变量渲染（{{var}} 能进查询串）', async () => {
    const r = await runCase(
      {
        method: 'GET',
        url: `${targetUrl}/echo`,
        query: { scope: '{{myscope}}' },
        expected: { status: 200 },
      },
      { env: null, persist: false, vars: { myscope: 'dept' } },
    )
    expect(r.pass).toBe(true)
    expect(bodyOf(r).q.scope).toBe('dept')
  })

  it('URL 已带 ? 时用 & 追加（不产生 ??）', async () => {
    const r = await runCase(
      { method: 'GET', url: `${targetUrl}/echo?a=1`, query: { b: '2' }, expected: { status: 200 } },
      { env: null, persist: false },
    )
    expect(r.pass).toBe(true)
    expect(bodyOf(r).q).toEqual({ a: '1', b: '2' })
  })

  it('query 里的变量没赋值 → detail 点名（与 url/headers/body 同一套处理）', async () => {
    // 平台对「变量没赋值」的既定语义是**不判失败**（请求本身通常也会失败），
    // 但必须在 detail 里写清楚是哪个变量 —— 否则排障时会误判成被测系统的问题。
    // 这里顺手把 query 也钉进这套语义：不能因为它后加的就悄悄例外。
    const r = await runCase(
      { method: 'GET', url: `${targetUrl}/echo`, query: { scope: '{{nope}}' }, expected: { status: 200 } },
      { env: null, persist: false },
    )
    expect((r.detail || []).join()).toContain('{{nope}}')
  })

  it('值会被 encodeURIComponent（特殊字符不破坏 query 结构）', async () => {
    const r = await runCase(
      { method: 'GET', url: `${targetUrl}/echo`, query: { kw: 'a&b=c' }, expected: { status: 200 } },
      { env: null, persist: false },
    )
    expect(r.pass).toBe(true)
    expect(bodyOf(r).q.kw).toBe('a&b=c')
  })
})
