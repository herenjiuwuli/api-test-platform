// 一键跑「office-oa 用例套件」——把闭环做成一条命令。
//
// 做的事：① 拿一个平台账号（没有就现场注册，不碰既有凭据）
//        ② POST /api/run-all {"prefix":"OA-"} 只跑 OA 那一组，不把示例用例的失败算进来
//        ③ 打印逐条结果 + 汇总，**任一条失败就以非 0 退出**（能被 CI / 定时任务直接调用）
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

async function main() {
  // 前置检查：被测系统得起着，否则后面全是「网络层失败」，报告看不出重点
  const health = await fetch(`${OA}/health`).catch(() => null)
  if (!health || !health.ok) throw new Error(`被测系统不可达：${OA}/health —— 请先启动 office-oa（端口 3200）`)
  console.log(`[run-oa] 被测系统在线：${OA}`)

  const token = await platformToken()
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
