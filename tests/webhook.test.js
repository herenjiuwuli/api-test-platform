// 通知出口（M21，vitest，全离线）
//
// M20 之前的通知都只活在平台页面里——人不在电脑前就收不到。M21 补「升级外呼」：
// 失败侧（warn/error）通知落库后 POST 到配置的 webhook（可指向飞书机器人 / hermes）。
// 本文件钉住：
//   ① 出口地址管理：默认空、非法 URL / 非 http(s) 拒绝、HTTP GET/PUT 路由；
//   ② forwardToWebhook：warn/error 且已配置才发（success 永不转）、消息体字段齐全；
//   ③ ⭐ 容错：目标宕机时 forwardToWebhook 返回 {ok:false} 而不抛错，
//      runScheduledJob 照常落站内通知——出口挂了不能影响调度本体。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../index.js'
import { createCase, deleteCase } from '../src/cases.js'
import { createSchedule } from '../src/schedules.js'
import { runScheduledJob, stopAllScheduler } from '../src/scheduler.js'
import { addNotification, listNotifications } from '../src/notifications.js'
import { getWebhookUrl, setWebhookUrl, forwardToWebhook } from '../src/webhook.js'

process.env.DB_PATH = ':memory:'
process.env.API_AUTH_DISABLED = '1'

let target
let targetUrl
let received // mock 收端最近一次收到的 JSON
let app

beforeAll(async () => {
  // 本地 mock「收端」：扮演飞书机器人 / hermes，记录收到的 POST
  target = Fastify()
  target.post('/hook', async (req) => {
    received = req.body
    return { ok: true }
  })
  await target.listen({ port: 0, host: '127.0.0.1' })
  targetUrl = 'http://127.0.0.1:' + target.server.address().port
  app = buildApp()
  await app.ready()
})

afterAll(async () => {
  stopAllScheduler()
  await target.close()
  await app.close()
  setWebhookUrl('') // 清出口，不污染同进程其他用例
})

describe('出口地址管理（webhook settings）', () => {
  it('默认未配置（空串）', () => {
    expect(getWebhookUrl()).toBe('')
  })

  it('★ 非法地址拒绝：解析不了 / 非 http(s) 协议', () => {
    expect(() => setWebhookUrl('not a url')).toThrow(/URL/)
    expect(() => setWebhookUrl('ftp://example.com/hook')).toThrow(/http\/https/)
    expect(getWebhookUrl()).toBe('') // 拒绝后不能留下半配置状态
  })

  it('★ 配置 → 生效 → 清空关闭', () => {
    const url = setWebhookUrl(`${targetUrl}/hook`)
    expect(url).toBe(`${targetUrl}/hook`)
    expect(getWebhookUrl()).toBe(`${targetUrl}/hook`)
    setWebhookUrl('')
    expect(getWebhookUrl()).toBe('')
  })

  it('HTTP 层：GET 读 / PUT 配置 / 非法 400', async () => {
    let res = await app.inject({ method: 'PUT', url: '/api/notifications/webhook', payload: { url: 'abc' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('URL')

    res = await app.inject({ method: 'PUT', url: '/api/notifications/webhook', payload: { url: `${targetUrl}/hook` } })
    expect(res.statusCode).toBe(200)
    expect(res.json().url).toBe(`${targetUrl}/hook`)

    res = await app.inject({ method: 'GET', url: '/api/notifications/webhook' })
    expect(res.statusCode).toBe(200)
    expect(res.json().url).toBe(`${targetUrl}/hook`)

    await app.inject({ method: 'PUT', url: '/api/notifications/webhook', payload: { url: '' } })
  })
})

describe('转发行为（forwardToWebhook）', () => {
  it('★ warn/error 且已配置 → POST 到收端，消息体字段齐全；success 永不转', async () => {
    setWebhookUrl(`${targetUrl}/hook`)
    received = null
    const r1 = await forwardToWebhook({ level: 'error', title: '出口探针', body: 'b', target: 't', createdAt: '2026-09-18' })
    expect(r1.ok).toBe(true)
    expect(received.type).toBe('api-test-platform.notify')
    expect(received.level).toBe('error')
    expect(received.title).toBe('出口探针')
    expect(received.target).toBe('t')

    received = null
    const r2 = await forwardToWebhook({ level: 'success', title: '不该转的' })
    expect(r2.skipped).toContain('success')
    expect(received).toBeNull()

    const r3 = await forwardToWebhook({ level: 'warn', title: 'warn 也转' })
    expect(r3.ok).toBe(true)
    expect(received.level).toBe('warn')
    setWebhookUrl('')
  })

  it('未配置时跳过（不报错）', async () => {
    const r = await forwardToWebhook({ level: 'error', title: '没出口' })
    expect(r.ok).toBe(false)
    expect(r.skipped).toContain('未配置')
  })
})

describe('⭐ 调度容错：出口挂了不影响调度本体', () => {
  it('★ webhook 指向死地址 → runScheduledJob 仍落站内通知（runCase 照常执行）', async () => {
    setWebhookUrl('http://127.0.0.1:1/__dead') // 不可达端口，fetch 必失败
    const c = createCase({ name: 'M21死链', method: 'GET', url: 'http://127.0.0.1:1/__x', expected: { status: 200 } })
    const s = createSchedule({ caseId: c.id, cron: '*/5 * * * *' })
    await runScheduledJob(s) // 内部 await forwardToWebhook——若它会抛错这里就炸
    const note = listNotifications().items.find((n) => n.target?.includes('M21死链'))
    expect(note).toBeTruthy() // 站内记录没丢
    expect(note.level).toBe('warn')
    deleteCase(c.id)
    setWebhookUrl('')
  })
})
