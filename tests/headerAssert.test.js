// M14：断言响应头。
//
// 为什么要补：M4 给 office-oa 加了「导出 CSV」，而「导出对不对」有一半答案**在响应头里** ——
// Content-Type 是不是 text/csv、Content-Disposition 有没有 attachment、条数有没有如实回传。
// 执行器原来只读 res.text()，这些断言**根本写不出来**。能力和边界都是被真实被测系统逼出来的
// （同 M8 的 multipart）。
//
// 这一组要证明两件事：
//   ① 三种操作符的语义对（尤其是「头不存在」时必须**失败**，不能因为 undefined 就悄悄通过）；
//   ② 头名大小写不敏感 —— HTTP 头本来就不区分大小写，用例里写成 Content-Type 也得能查到。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../index.js'
import { createCase, deleteCase } from '../src/cases.js'
import { runAll, runCase } from '../src/runner.js'
import { stopAllScheduler } from '../src/scheduler.js'

process.env.DB_PATH = ':memory:'

let target
let targetUrl
let app

beforeAll(async () => {
  target = Fastify()
  // 模拟一个「导出 CSV」的接口：三个头各有各的考点
  target.get('/csv', async (req, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', 'attachment; filename="requests-20260917-090503.csv"')
    reply.header('X-Total-Count', '3')
    return '\ufeff单据号,标题\r\n1,测试'
  })
  target.get('/plain', async () => ({ ok: true }))
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

/** 建一条用例并跑（不落库到报告也无所谓，persist 默认 true 但内存库） */
async function run(expected, { url = '/csv' } = {}) {
  const c = createCase({ name: `头断言-${Math.random().toString(36).slice(2, 8)}`, url: `${targetUrl}${url}`, expected })
  try {
    return await runCase(c)
  } finally {
    deleteCase(c.id)
  }
}

describe('响应头断言：contains / eq / exists 的语义', () => {
  it('contains 命中：content-type 里含 text/csv', async () => {
    const r = await run({ status: 200, headers: [{ name: 'content-type', op: 'contains', value: 'text/csv' }] })
    expect(r.pass).toBe(true)
    expect(r.detail).toEqual([])
  })

  it('⭐ contains 不命中 → 失败，且 detail 说清「实际是什么」', async () => {
    const r = await run({ headers: [{ name: 'content-type', op: 'contains', value: 'application/json' }] })
    expect(r.pass).toBe(false)
    expect(r.detail.join(' ')).toContain('响应头 content-type')
    expect(r.detail.join(' ')).toContain('text/csv') // 实际值要出现在报错里，否则只能去猜
  })

  it('eq 全等命中：X-Total-Count 就是 3', async () => {
    const r = await run({ headers: [{ name: 'x-total-count', op: 'eq', value: '3' }] })
    expect(r.pass).toBe(true)
  })

  it('⭐ eq 差一个字符就失败（这正是「写 eq 还是 contains」的取舍所在）', async () => {
    // 真实场景：有人写 eq 'text/csv'，但服务端回的是 'text/csv; charset=utf-8' —— 必须红，
    // 否则「断言写太松」会一路绿到上线
    const r = await run({ headers: [{ name: 'content-type', op: 'eq', value: 'text/csv' }] })
    expect(r.pass).toBe(false)
    expect(r.detail.join(' ')).toContain('charset=utf-8')
  })

  it('⭐ 头名大小写不敏感：用例里写 Content-Type 也能查到', async () => {
    const r = await run({ headers: [{ name: 'Content-Type', op: 'contains', value: 'text/csv' }] })
    expect(r.pass).toBe(true)
    const r2 = await run({ headers: [{ name: 'CONTENT-TYPE', op: 'contains', value: 'text/csv' }] })
    expect(r2.pass).toBe(true)
  })

  it('exists：头在就通过；以及不存在的头 → 失败', async () => {
    const ok = await run({ headers: [{ name: 'content-disposition', op: 'exists' }] })
    expect(ok.pass).toBe(true)
    const bad = await run({ headers: [{ name: 'x-不存在的头', op: 'exists' }] })
    expect(bad.pass).toBe(false)
    expect(bad.detail.join(' ')).toContain('不存在')
  })

  it('⭐ 头不存在时 eq / contains 一律失败（不能因为 undefined 就悄悄通过）', async () => {
    // 「默认严格」是刻意的：一个聪明的假通过（undefined == ''）比一条红危险得多
    const r1 = await run({ headers: [{ name: 'x-没有这个头', op: 'eq', value: '' }] })
    expect(r1.pass).toBe(false)
    const r2 = await run({ headers: [{ name: 'x-没有这个头', op: 'contains', value: '' }] })
    expect(r2.pass).toBe(false)
  })

  it('结果里带回**实际响应头**（排障时不用再猜，也不用重跑一次 + curl）', async () => {
    const r = await run({ headers: [{ name: 'content-type', op: 'contains', value: 'text/csv' }] })
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(r.headers['x-total-count']).toBe('3')
  })

  it('多条头断言 + 状态码 + 文本断言同时成立才通过；任一不成立就红', async () => {
    const allOk = await run({
      status: 200,
      contains: '单据号',
      headers: [
        { name: 'content-type', op: 'contains', value: 'text/csv' },
        { name: 'content-disposition', op: 'contains', value: 'attachment' },
        { name: 'content-disposition', op: 'contains', value: 'filename=' },
      ],
    })
    expect(allOk.pass).toBe(true)

    const oneBad = await run({
      status: 200,
      headers: [
        { name: 'content-type', op: 'contains', value: 'text/csv' },
        { name: 'x-total-count', op: 'eq', value: '999' }, // 这一条是错的
      ],
    })
    expect(oneBad.pass).toBe(false)
    expect(oneBad.detail.join(' ')).toContain('x-total-count')
  })

  it('缺省不写 headers → 一条头断言都不跑（不影响既有用例）', async () => {
    const r = await run({ status: 200 })
    expect(r.pass).toBe(true)
  })

  it('⭐ BOM 属于**响应体**，用 contains 断言（平台不需要为它单开一个操作符）', async () => {
    const r = await run({ contains: '\ufeff单据号' })
    expect(r.pass).toBe(true)
    const bad = await run({ contains: '\ufeff不存在的前缀' })
    expect(bad.pass).toBe(false)
  })

  it('run-all 这条路径同样支持头断言（不是只在单跑里生效）', async () => {
    const c = createCase({
      name: `头断言-runall-${Date.now()}`,
      url: `${targetUrl}/csv`,
      expected: { status: 200, headers: [{ name: 'content-type', op: 'contains', value: 'text/csv' }] },
    })
    try {
      const results = await runAll([c])
      expect(results).toHaveLength(1)
      expect(results[0].pass).toBe(true)
    } finally {
      deleteCase(c.id)
    }
  })

  it('HTTP 层：headers 断言能存能取（走 createCase → 库 → getCase 往返）', async () => {
    const c = createCase({
      name: '头断言-持久化',
      url: `${targetUrl}/csv`,
      expected: { headers: [{ name: 'Content-Type', op: 'contains', value: 'text/csv' }] },
    })
    try {
      const got = await app.inject({ method: 'GET', url: `/api/cases/${c.id}` })
      const body = JSON.parse(got.body)
      expect(body.expected.headers).toEqual([{ name: 'Content-Type', op: 'contains', value: 'text/csv' }])
    } finally {
      deleteCase(c.id)
    }
  })
})
