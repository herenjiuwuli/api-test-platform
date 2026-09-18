// 运行通知（M17，vitest，全离线）
//
// M15 让定时任务能跑「分组」，但跑完/跑失败你并不知道——只能事后去翻 runs/reports。
// M17 补可观察性：runScheduledJob 跑完（无论成功/失败/异常）都落一条通知，
// 前端铃铛展示未读角标。本文件钉住：
//   ① 通知存储层的增 / 列（最新在前）/ 未读计数 / 标记已读；
//   ② runScheduledJob 触发落通知：分组全绿→success、单条死链→warn、指向已删用例→error；
//   ③ 通知 HTTP 层：列表 / 未读计数 / 标记已读 / 全部已读；
//   ④ 实时推送（M18）：addNotification 广播给 subscribe 订阅者（含「订阅者抛错不连累落库」），
//      以及 SSE 端点 /api/notifications/stream 真连一次、收到 hello 后收到 notification 事件；
//   ⑤ 降噪与保留（M20）：notifyOn=failure 时 success 不落通知（warn/error 照落）、非法 notifyOn
//      回退 all、通知表自动裁剪只留最近 500 条。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { buildApp } from '../index.js'
import { createCase, deleteCase } from '../src/cases.js'
import { createSchedule, updateSchedule } from '../src/schedules.js'
import { runScheduledJob, stopAllScheduler } from '../src/scheduler.js'
import { addNotification, listNotifications, unreadCount, markRead, markAllRead, subscribe } from '../src/notifications.js'

process.env.DB_PATH = ':memory:'
process.env.API_AUTH_DISABLED = '1'

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

const okCase = (name, group) =>
  createCase({ name, method: 'GET', url: `${targetUrl}/ok`, group, expected: { status: 200 } })
// 死链：连接被拒 → runCase 内部 catch 返回 pass:false（运行失败但不是异常）
const deadCase = (name) =>
  createCase({ name, method: 'GET', url: 'http://127.0.0.1:1/__x', expected: { status: 200 } })

describe('通知存储层（notifications.js）', () => {
  it('addNotification + listNotifications 最新在前', () => {
    addNotification({ level: 'info', title: '较早', body: 'a' })
    addNotification({ level: 'success', title: '较晚', body: 'b' })
    const items = listNotifications().items
    expect(items[0].title).toBe('较晚') // 最新插入的排最前
    expect(items.find((n) => n.title === '较早')).toBeTruthy()
  })

  it('★ unreadCount 随 markRead / markAllRead 变化', () => {
    const n = addNotification({ level: 'warn', title: '待读', body: 'x' })
    const before = unreadCount().count
    expect(before).toBeGreaterThanOrEqual(1)
    markRead(n.id)
    expect(unreadCount().count).toBe(before - 1)
    markAllRead()
    expect(unreadCount().count).toBe(0)
  })

  it('★ subscribe 收到 addNotification 广播；退订后不再收（M18）', () => {
    const got = []
    const unsub = subscribe((n) => got.push(n))
    const a = addNotification({ level: 'success', title: '广播A', body: '' })
    expect(got.length).toBe(1)
    expect(got[0].id).toBe(a.id) // 广播的就是刚落库那条（带 id/createdAt）
    expect(got[0].title).toBe('广播A')
    unsub()
    addNotification({ level: 'info', title: '广播B', body: '' })
    expect(got.length).toBe(1) // 退订后不再收
  })

  it('★ 单个订阅者抛错不影响落库、也不影响其他订阅者（M18）', () => {
    const ok = []
    const unsubBad = subscribe(() => {
      throw new Error('订阅者自己炸了')
    })
    const unsubGood = subscribe((n) => ok.push(n))
    const a = addNotification({ level: 'info', title: '容错', body: '' })
    expect(a.id).toBeTruthy() // 落库照常
    expect(ok.length).toBe(1) // 好订阅者照收
    unsubBad()
    unsubGood()
  })
})

describe('定时任务触发落通知（runScheduledJob × notifications）', () => {
  it('★ 分组定时全绿 → success 通知，body 含通过数', async () => {
    okCase('n-g1', 'M17绿组')
    okCase('n-g2', 'M17绿组')
    const s = createSchedule({ group: 'M17绿组', cron: '0 9 * * *' })
    await runScheduledJob(s)
    const items = listNotifications().items
    const note = items.find((n) => n.title?.includes('M17绿组') && n.level === 'success')
    expect(note).toBeTruthy()
    expect(note.body).toContain('通过 2')
    expect(note.target).toContain('M17绿组')
  })

  it('★ 单条用例死链 → warn 通知（运行失败而非异常）', async () => {
    const c = deadCase('M17死链')
    const s = createSchedule({ caseId: c.id, cron: '*/5 * * * *' })
    await runScheduledJob(s)
    const items = listNotifications().items
    const note = items.find((n) => n.level === 'warn' && n.target?.includes('M17死链'))
    expect(note).toBeTruthy()
    expect(note.title).toContain('M17死链')
  })

  it('★ 单条用例指向已删用例 → error 通知（getCase 返回 undefined）', async () => {
    const c = okCase('M17将删', 'M17删组')
    const s = createSchedule({ caseId: c.id, cron: '*/5 * * * *' })
    deleteCase(c.id) // 用例没了，但 schedule 还在（单条 case_id 不是占位 0）
    await runScheduledJob(s)
    const items = listNotifications().items
    const note = items.find((n) => n.level === 'error' && n.target?.includes('M17将删'))
    expect(note).toBeTruthy()
    expect(note.body).toContain('删除')
  })
})

describe('通知降噪与保留策略（M20）', () => {
  it('★ 默认 notifyOn=all（不传也回归 M17 行为）；非法值回退 all；update 可改 failure', () => {
    const c = okCase('M20校验', 'M20校验组')
    const s1 = createSchedule({ caseId: c.id, cron: '0 9 * * *' })
    expect(s1.notifyOn).toBe('all') // 不传 = M17 原行为
    const s2 = createSchedule({ caseId: c.id, cron: '0 9 * * *', notifyOn: 'hacker' })
    expect(s2.notifyOn).toBe('all') // 白名单外回退默认——存储层不信任调用方
    const s3 = updateSchedule(s2.id, { notifyOn: 'failure' })
    expect(s3.notifyOn).toBe('failure')
    const s4 = updateSchedule(s2.id, { notifyOn: 'again-bad' })
    expect(s4.notifyOn).toBe('all') // 更新时同样走白名单
  })

  it('★ notifyOn=failure：全绿不落 success 通知；断言失败（warn）照落', async () => {
    okCase('M20绿', 'M20失败组')
    const s = createSchedule({ group: 'M20失败组', cron: '0 9 * * *', notifyOn: 'failure' })
    await runScheduledJob(s) // 全绿 → success 在落库前被拦
    expect(
      listNotifications().items.find((n) => n.target?.includes('M20失败组')),
    ).toBeUndefined()
    // 塞一条死链进同组再跑：runAll 内部按组现拉用例（schedule 对象只是触发器），1 绿 1 红 → warn
    createCase({
      name: 'M20红',
      method: 'GET',
      url: 'http://127.0.0.1:1/__x',
      group: 'M20失败组',
      expected: { status: 200 },
    })
    await runScheduledJob(s)
    const note = listNotifications().items.find(
      (n) => n.level === 'warn' && n.target?.includes('M20失败组'),
    )
    expect(note).toBeTruthy() // 失败侧无论什么模式都通知
    expect(note.body).toContain('失败 1')
  })

  it('★ 通知表保留策略：落库自动裁剪，只留最近 500 条', () => {
    for (let i = 0; i < 505; i++) addNotification({ level: 'info', title: `ret-${i}` })
    const items = listNotifications({ limit: 1000 }).items
    expect(items.length).toBe(500) // 老的被裁掉，只留最近 500
    expect(items[0].title).toBe('ret-504') // 最新在前
    expect(items.find((n) => n.title === 'ret-0')).toBeUndefined()
  })
})

describe('通知 HTTP 层（app.inject）', () => {
  it('GET /api/notifications 返回 items（最新在前）', async () => {
    addNotification({ level: 'info', title: 'HTTP探针', body: 'probe' })
    const res = await app.inject({ method: 'GET', url: '/api/notifications' })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body)
    expect(Array.isArray(data.items)).toBe(true)
    expect(data.items[0].title).toBe('HTTP探针')
  })

  it('GET /api/notifications/unread-count 返回数字', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/notifications/unread-count' })
    expect(res.statusCode).toBe(200)
    expect(typeof JSON.parse(res.body).count).toBe('number')
  })

  it('★ POST /api/notifications/:id/read 标记已读', async () => {
    const n = addNotification({ level: 'warn', title: '待读HTTP', body: 'y' })
    const c0 = unreadCount().count
    const res = await app.inject({ method: 'POST', url: `/api/notifications/${n.id}/read` })
    expect(res.statusCode).toBe(200)
    expect(unreadCount().count).toBe(c0 - 1)
  })

  it('★ POST /api/notifications/read-all 全部已读', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/notifications/read-all' })
    expect(res.statusCode).toBe(200)
    expect(unreadCount().count).toBe(0)
  })
})

describe('通知实时推送 HTTP 层（M18，SSE）', () => {
  let baseUrl

  beforeAll(async () => {
    // SSE 是长连接：app.inject 会一直挂着不返回（hijack 后流不会 end）。
    // 所以这里真起一个端口，用 fetch 读流 —— 这才算「证明它真的推得出来」。
    await app.listen({ port: 0, host: '127.0.0.1' })
    baseUrl = 'http://127.0.0.1:' + app.server.address().port
  })

  it('★ GET /api/notifications/stream 建立 SSE 连接，先收到 hello', async () => {
    const ctrl = new AbortController()
    const res = await fetch(`${baseUrl}/api/notifications/stream`, { signal: ctrl.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const { value } = await res.body.getReader().read()
    expect(new TextDecoder().decode(value)).toContain('"type":"hello"')
    ctrl.abort()
  })

  it('★★ 连接后 addNotification → 实时收到 notification 事件（端到端推送）', async () => {
    const ctrl = new AbortController()
    const res = await fetch(`${baseUrl}/api/notifications/stream`, { signal: ctrl.signal })
    const reader = res.body.getReader()
    await reader.read() // 先吃掉 hello
    // 连接建立时订阅已同步注册，这里再落一条 → 应被推过来
    addNotification({ level: 'error', title: '实时推送探针', body: 'live' })
    const { value } = await reader.read()
    const chunk = new TextDecoder().decode(value)
    expect(chunk).toContain('"type":"notification"')
    expect(chunk).toContain('实时推送探针')
    ctrl.abort()
  })
})
