// 一条命令复现「测穿闭环」：起一个隔离平台实例 → seed:oa → test:oa → m9 → m10 → 收尾。
//
// 为什么需要它：闭环是这个项目的招牌（「我写了被测系统，又用自写平台把它测穿了」），
// 但复现它要四步手工操作 + 一个在跑的 office-oa，而且 m9/m10（24 条真机断言）**一直不在任何门禁里** ——
// 与 m11/m12 一模一样的毛病。这个脚本把那条链路固定成一条命令，顺带让 m9/m10 有了归属。
//
// 与 check:ui:auto 的分工（刻意分开，因为前置条件不一样）：
//   check:ui:auto      只依赖平台自己      → 能进 CI（第 ⑤ 层）
//   check:closure:auto 需要一个在跑的 office-oa → **不能**进 CI，是本机 / 联调时的一条命令
//
// ⚠️ 前提：office-oa 已在 3200 上**用当前代码新起进程**。端口上挂旧进程是最坑的一种失败 ——
//    dept_scoped / token 黑名单看着像「功能失效」，其实是旧代码在回答，断言把好功能判成坏的。
//    套件里的 `OA-26 附件 404` 就是这个哨兵（旧进程回「接口不存在」，这条必红）。下面先探一次
//    `/health`，探不到就直接说清「先把 OA 起来」，而不是跑到一半炸在一个看不懂的地方。
//
// 四个沿用 check:ui:auto 的设计（都踩过）：
// 1. 独立库 + 独立端口：data/closure-check.db + 3112，绝不碰开发用的 data/app.db。
// 2. 谁拉起的服务谁收尾，本来就在跑的复用、绝不 kill。
// 3. 失败也收尾、退出码透传：try/catch 里显式 cleanup 再 throw，**不写 finally**（会吞输出）。
// 4. 探活用 node 原生 fetch，不用 curl（沙箱透明代理会劫持 127.0.0.1）。
//
// ⚠️ 第 5 条是自己踩出来的：**隔离库必须同时给「服务」和「所有直接读写那个库的脚本」**。
//    第一版只给了服务，忘了给 seed 脚本 —— 于是 `seed:oa` 把数据写进了开发库 data/app.db
//    （顺手清掉了那边的 OA 执行记录），而 test:oa 打在空实例上，一路红到 m10 才看出来。
//    现在除了把 DB_PATH 传下去，还加了一道守卫：声明 touchesDb 的环节跑完，隔离库的 mtime 必须变。
//    教训一句话：**「隔离」是一组路径，不是一个端口。**
//
// 用法：node scripts/run-closure-check.mjs
//   CLOSURE_PORT=3113              换端口（3112 被占时）
//   OA_BASE=http://127.0.0.1:3300  换被测系统地址（默认 3200）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { oaBase } from './lib/cdp.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.CLOSURE_PORT || 3112)
const BASE = `http://127.0.0.1:${PORT}`
const OA = oaBase()
const DB = path.join(ROOT, 'data', 'closure-check.db')
const DIST = path.join(ROOT, 'web', 'dist')

// 闭环的四个环节，顺序不能乱：先有数据（seed:oa）才谈得上跑（test:oa），
// 先有执行记录（test:oa）才谈得上 m10 从报告里读回「这一轮打的是哪个环境」。
// `touchesDb: true` 的环节跑完，隔离库必须真的被动过 —— 这是下面那道守卫要用的（见注释）。
const STEPS = [
  { script: 'seed-oa-suite.mjs', what: '写入 OA 套件（84 条 + 12 个分组 + 定义并选中当前环境）', touchesDb: true },
  { script: 'run-oa-suite.mjs', what: '让平台去打 office-oa（用例链；任一条失败即以非 0 退出）', touchesDb: true },
  { script: 'scripts/m9-env-ui-check.mjs', what: '真机：环境变量集界面与页头徽标一致性（13 条）' },
  { script: 'scripts/m10-report-env-check.mjs', what: '真机：从报告接口读回「这一轮实际打的是哪个环境」（11 条）' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function runInherit(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env })
    p.on('exit', (c) => resolve(c ?? 1))
    p.on('error', reject)
  })
}

async function probe(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return r.ok ? await r.json().catch(() => ({})) : null
  } catch {
    return null
  }
}

const platformHealthy = () => probe(`${BASE}/health`)

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`没有前端产物 ${path.join('web', 'dist', 'index.html')} —— 先跑 npm run build（m9/m10 打的是构建后的页面）`)
  }

  // 先探 office-oa：这一步探不到，后面每一条都会红，而且红得很难看懂（超时 / fetch failed）。
  // 与其让使用者在一堆红里猜，不如一开始就说清「你少了哪个前置条件」。
  const oaHealth = await probe(`${OA}/health`)
  if (!oaHealth || oaHealth.service !== 'office-oa') {
    throw new Error(
      `office-oa 没在 ${OA} 上应答 /health（拿到的是 ${oaHealth ? JSON.stringify(oaHealth) : '连不上'}）\n` +
        `        这个命令测的是「平台 → office-oa」这条闭环，没有 OA 就无从跑起。先起 OA：\n` +
        `          cd ../office-oa && npm start        # 或 npm run dev\n` +
        `        ⚠️ 一定用当前代码新起进程：端口上挂旧进程会让断言把好功能判成坏的。`,
    )
  }

  fs.mkdirSync(path.dirname(DB), { recursive: true })
  console.log(`[closure] 隔离环境：库 data/closure-check.db · 端口 ${PORT} · 不碰 data/app.db`)
  console.log(`[closure] 被测系统：${OA}（/health 已确认是 office-oa）`)

  let server = null
  if (await platformHealthy()) {
    console.log(`[closure] ${BASE} 已有服务在跑 → 复用（本脚本不负责收尾它）`)
  } else {
    server = spawn(process.execPath, ['index.js'], {
      cwd: ROOT,
      stdio: 'inherit',
      // DEEPSEEK_API_KEY 置空：隔离实例上不希望任何一次误触变成真实的模型调用
      env: { ...process.env, DB_PATH: DB, PORT: String(PORT), DEEPSEEK_API_KEY: '' },
    })
    const t0 = Date.now()
    while (Date.now() - t0 < 40_000) {
      if (await platformHealthy()) break
      if (server.exitCode !== null) throw new Error(`服务进程提前退出（退出码 ${server.exitCode}）`)
      await sleep(300)
    }
    if (!(await platformHealthy())) throw new Error(`服务 40 秒内没就绪：${BASE}/health`)
    console.log('[closure] 平台已就绪')
  }

  const cleanup = () => {
    if (server && server.exitCode === null) {
      console.log('[closure] 收尾：停掉本脚本拉起的服务')
      server.kill()
    }
  }

  // ⚠️ DB_PATH 必须一起传下去 —— 这里踩过一次真的：
  //    隔离库只给了**服务**，忘了给**往库里写数据的脚本**，于是 `seed:oa` 把数据写进了开发库
  //    `data/app.db`，而 `test:oa` 打在空实例上（症状是「分组 OA-*：共 0 条」+ m9/m10 全红）。
  //    「隔离环境」要隔离的不只是服务，还有所有直接读写那个库的脚本。
  //
  // 子脚本都从环境变量认「打哪个平台 / 打哪个 OA」：
  // PLATFORM_BASE 是正名（lib/cdp.mjs 的 platformBase()、run-oa-suite.mjs 都认它），
  // OA_BASE 同时喂给 seed:oa（它据此建「当前环境」）与 m9/m10（它们据此断言），三处必须一致。
  const childEnv = { ...process.env, DB_PATH: DB, PLATFORM_BASE: BASE, OA_BASE: OA }

  // 守卫：给「隔离库」做一次「确实动过」的核对。上面的坑之所以能跑出几十行红字才被发现，
  // 就是因为没有任何一处去问「这一步真的写进隔离库了吗」。用 mtime 而不是查表 ——
  // 不依赖任何表结构，且恰好只能抓住「写到了别的库」这一类错误。
  const dbMtime = () => {
    try {
      return fs.statSync(DB).mtimeMs
    } catch {
      return 0
    }
  }

  const failed = []
  try {
    for (const { script, what, touchesDb } of STEPS) {
      console.log(`\n[closure] ▶ ${script} —— ${what}`)
      const before = dbMtime()
      const code = await runInherit([script], childEnv)
      if (code !== 0) failed.push(`${script}(退出码 ${code})`)
      if (touchesDb && dbMtime() === before) {
        failed.push(`${script}(隔离库没被动过 —— 它多半写到别的库去了，检查 DB_PATH 有没有传下去)`)
      }
    }
  } catch (e) {
    cleanup()
    throw e
  }
  cleanup()

  if (failed.length) {
    console.error(`\n[closure] 闭环未通过：${failed.join('、')}`)
    process.exit(1)
  }
  console.log(`\n[closure] ✅ 闭环通过（${STEPS.length} 个环节：84 条接口用例 + 24 条真机断言）`)
}

main().catch((e) => {
  console.error('[closure] 失败：' + e.message)
  process.exit(1)
})
