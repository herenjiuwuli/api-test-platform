// 一键跑「office-oa 用例套件」——把闭环做成一条命令。
//
// 做的事：① 拿一个平台账号（没有就现场注册，不碰既有凭据）
//        ② 打印平台当前环境（用例里是 {{base}}，不打出来就不知道到底在打谁）
//        ③ POST /api/run-all {"prefix":"OA-"} 只跑 OA 那一组，不把示例用例的失败算进来
//        ④ 打印逐条结果 + 汇总，**任一条失败就以非 0 退出**（能被 CI / 定时任务直接调用）
//
// ⚠️ 前提：office-oa 已在 3200 上**用当前代码新起进程**。
//    踩过的坑：端口上挂着 M2 之前的旧进程，dept_scoped / token 黑名单看起来「失效」，
//    其实是旧代码在回答 —— 断言会把好功能判成坏的。
//    套件里的「OA-26 附件 404」就是那个哨兵：旧进程会回「接口不存在」，这条必红。
//
// 运行：npm run test:oa
const PLATFORM = process.env.PLATFORM_BASE || 'http://127.0.0.1:3001'
const OA = process.env.OA_BASE || 'http://127.0.0.1:3200'
const RUNNER_USER = process.env.PLATFORM_USER || 'oa-runner'
const RUNNER_PWD = process.env.PLATFORM_PASSWORD || 'oa-runner-123'
const PREFIX = 'OA-'
// 套件用**固定远期日期**订会议室：平台用例是静态 body，拿不到「明天」，而过去时段会被 400 拒。
// 代价是这些日期上的预订会跨轮次残留 —— 上一轮留下的占用会让这一轮的「预订成功 → 201」直接 409。
// 所以跑之前必须清场：**套件能不能重复跑，取决于有没有这一步**（中断的那一轮照样会留垃圾）。
const BOOKING_DATES = ['2027-06-01', '2027-06-02']
// 用 admin（boss 角色，含 room:manage）代取消 —— 取消别人的预订本来就需要这个权限
const OA_ADMIN = process.env.OA_ADMIN || 'admin'
const OA_PWD = process.env.OA_PWD || 'oa123456'

async function platformToken() {
  const reg = await fetch(`${PLATFORM}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: RUNNER_USER, password: RUNNER_PWD }),
  })
  if (reg.ok) {
    console.log(`[run-oa] 已在平台注册跑测账号 ${RUNNER_USER}`)
    return (await reg.json()).token
  }
  const login = await fetch(`${PLATFORM}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: RUNNER_USER, password: RUNNER_PWD }),
  })
  if (!login.ok) throw new Error(`平台登录失败 ${login.status}：${await login.text()}`)
  return (await login.json()).token
}

/**
 * 跑前清场：把固定测试日期上残留的预订全部取消。
 * 不做这一步，套件第二轮必红（OA-68 撞上一轮自己的残留）——「不可重复执行」的套件没有价值。
 */
async function cleanLeftoverBookings() {
  const login = await fetch(`${OA}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: OA_ADMIN, password: OA_PWD }),
  }).catch(() => null)
  if (!login || !login.ok) {
    console.log(`[run-oa] ⚠️ 清场跳过：OA 登录失败（${login ? login.status : '网络不可达'}）——残留预订可能导致会议室段报 409`)
    return
  }
  const { token } = await login.json()
  const auth = { Authorization: `Bearer ${token}` }
  let cleaned = 0
  for (const date of BOOKING_DATES) {
    const list = await fetch(`${OA}/api/room-bookings?date=${date}`, { headers: auth }).catch(() => null)
    if (!list || !list.ok) continue
    const { items } = await list.json()
    for (const b of items || []) {
      const del = await fetch(`${OA}/api/room-bookings/${b.id}`, { method: 'DELETE', headers: auth }).catch(() => null)
      if (del && del.ok) cleaned++
    }
  }
  if (cleaned) console.log(`[run-oa] 跑前清场：取消上一轮残留的会议室预订 ${cleaned} 条（${BOOKING_DATES.join('、')}）`)
}

async function main() {
  // 前置检查：被测系统得起着，否则后面全是「网络层失败」，报告看不出重点
  const health = await fetch(`${OA}/health`).catch(() => null)
  if (!health || !health.ok) throw new Error(`被测系统不可达：${OA}/health —— 请先启动 office-oa（端口 3200）`)
  console.log(`[run-oa] 被测系统在线：${OA}`)

  await cleanLeftoverBookings()

  const token = await platformToken()

  // 用例里写的是 {{base}}，真正打谁取决于平台的「当前环境」——
  //   所以跑之前必须把它打印出来：报告上的 URL 和 OA_BASE 不一致时，这是唯一能解释原因的线索。
  const envRes = await fetch(`${PLATFORM}/api/environments`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (envRes.ok) {
    const { items, activeId } = await envRes.json()
    const active = (items || []).find((e) => e.id === activeId)
    if (active) {
      console.log(`[run-oa] 平台当前环境：「${active.name}」→ ${active.baseUrl}`)
      if (active.baseUrl.replace(/\/+$/, '') !== OA.replace(/\/+$/, '')) {
        console.log(`[run-oa] ⚠️ 与 OA_BASE（${OA}）不一致 —— 平台实际打的是「${active.baseUrl}」`)
      }
    } else {
      console.log('[run-oa] ⚠️ 平台没有「当前环境」—— 用例里的 {{base}} 取不到值，请先 npm run seed:oa')
    }
  }

  const res = await fetch(`${PLATFORM}/api/run-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ prefix: PREFIX }),
  })
  if (!res.ok) throw new Error(`run-all 失败 ${res.status}：${await res.text()}`)
  const out = await res.json()

  console.log(`\n[run-oa] 分组 ${PREFIX}*：共 ${out.total} 条\n`)
  for (const r of out.results) {
    const mark = r.pass ? 'PASS' : 'FAIL'
    const why = r.pass ? '' : `  ← ${r.detail.filter((d) => !d.startsWith('未赋值变量')).join('；')}`
    console.log(`  [${mark}] ${String(r.status).padStart(3)}  ${String(r.durationMs).padStart(4)}ms  ${r.name}${why}`)
  }
  console.log(`\n[run-oa] 结果：${out.passed}/${out.total} 通过，${out.failed} 失败`)
  if (out.failed > 0) {
    console.log('[run-oa] 失败明细已写入平台 runs 表，可在「报告」页看到历史趋势')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('[run-oa] 出错：' + e.message)
  process.exitCode = 1
})
