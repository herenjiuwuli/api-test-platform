// 一条命令跑完「平台自测的真机断言」：自己准备隔离实例、自己起服务、跑完自己收尾。
//
// 为什么需要它：m11（套件导入导出，19 条）+ m12（用例分组，24 条）这批真机断言
// 此前**既不在 CI 也不在 `verify`** —— 也就是「提交前一条命令复现全部检查」这句话，
// 对这两块是不成立的。而它们恰恰是「套件往返 / 分组」在**真浏览器**里的唯一保护。
// （与 office-oa 当初一模一样的缺口：测试脚本写好了，但没人会记得手动跑。）
//
// 四个刻意的设计（都踩过或见过对应的坑）：
// 1. **独立库 + 独立端口**：固定 data/ui-check.db + 3111，绝不碰正在开发用的 data/app.db。
//    （src/db.js 里 DB_PATH 是「惰性求值」的，所以这里传进去一定生效 —— 那条注释就是
//     为了这个场景留的：写成顶层 const 就会把路径提前快照掉。）
// 2. **谁拉起的服务谁收尾**：3111 上本来就有服务在跑就复用、绝不 kill ——
//    否则「跑个验证」会把用户自己起的服务杀掉。
// 3. **失败也要收尾、退出码原样透传**：try/catch 里显式 cleanup 再 throw，**不写 finally**
//    （写在 finally 里会让报错/输出被吞，见 cdp-browser-check skill）。
// 4. **探活用 node 原生 fetch，不用 curl**：沙箱有透明代理，curl 打 127.0.0.1 会被代理掉
//    （undici 默认不读 HTTP_PROXY）。
//
// 跑什么 / 不跑什么（如实写清，别让人觉得「跑了这个就全绿了」）：
//   ✅ m11 套件导入导出 + m12 用例分组 —— 只依赖平台自己，随时能跑，所以是本脚本的主体。
//   ⏭️ m9 / m10 —— 要**同时**打 office-oa(:3200)，且依赖平台里有 `npm run seed:oa && npm run test:oa`
//      留下的数据（在隔离空库上跑没有意义）。属于「跨系统联调」，故不在这里跑。
//   ⏭️ m13 —— 截图导览，产物 shots/ 刻意不进仓库，它是给人看的图不是断言门禁。
//
// 用法：node scripts/run-ui-check.mjs
//   UI_CHECK_PORT=3112 node scripts/run-ui-check.mjs   # 换端口（3111 被占时）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.UI_CHECK_PORT || 3111)
const BASE = `http://127.0.0.1:${PORT}`
const DB = path.join(ROOT, 'data', 'ui-check.db')
const DIST = path.join(ROOT, 'web', 'dist')

// 本脚本负责的断言（顺序即执行顺序）
const CHECKS = ['scripts/m11-suite-ui-check.mjs', 'scripts/m12-group-ui-check.mjs']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function healthy() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) })
    return r.ok
  } catch {
    return false
  }
}

function runInherit(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env })
    p.on('exit', (c) => resolve(c ?? 1))
    p.on('error', reject)
  })
}

async function main() {
  // 真机检查打的是**构建后的页面**（index.js 只在 web/dist 存在时才托管前端）。
  // 不先拦住的话，症状会是「登录页都打不开」这种离病因很远的报错。
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`没有前端产物 ${path.join('web', 'dist', 'index.html')} —— 先跑 npm run build（真机检查打的是构建后的页面）`)
  }

  fs.mkdirSync(path.dirname(DB), { recursive: true })
  console.log(`[ui-check] 隔离环境：库 data/ui-check.db · 端口 ${PORT} · 不碰 data/app.db`)

  let server = null
  if (await healthy()) {
    console.log(`[ui-check] ${BASE} 已有服务在跑 → 复用（本脚本不负责收尾它）`)
  } else {
    server = spawn(process.execPath, ['index.js'], {
      cwd: ROOT,
      stdio: 'inherit',
      // DEEPSEEK_API_KEY 置空：隔离实例上不希望任何一次误触变成真实的模型调用
      env: { ...process.env, DB_PATH: DB, PORT: String(PORT), DEEPSEEK_API_KEY: '' },
    })
    const t0 = Date.now()
    while (Date.now() - t0 < 40_000) {
      if (await healthy()) break
      if (server.exitCode !== null) throw new Error(`服务进程提前退出（退出码 ${server.exitCode}）`)
      await sleep(300)
    }
    if (!(await healthy())) throw new Error(`服务 40 秒内没就绪：${BASE}/health`)
    console.log('[ui-check] 服务已就绪')
  }

  const cleanup = () => {
    if (server && server.exitCode === null) {
      console.log('[ui-check] 收尾：停掉本脚本拉起的服务')
      server.kill()
    }
  }

  // 子脚本一律通过环境变量拿到打哪个实例（它们内部都走 lib/cdp.mjs 的 platformBase()），
  // 这样「换个端口跑一遍」不会有一半脚本跟不上的问题。
  const childEnv = { ...process.env, PLATFORM_BASE: BASE }

  let failed = []
  try {
    for (const script of CHECKS) {
      console.log(`\n[ui-check] ▶ ${script}`)
      const code = await runInherit([script], childEnv)
      if (code !== 0) failed.push(`${script}(退出码 ${code})`)
    }
  } catch (e) {
    cleanup()
    throw e
  }
  cleanup()

  console.log('[ui-check] 跳过 m9/m10（跨系统：要 office-oa 在 3200，且平台里有 seed:oa 数据，隔离空库上跑无意义）')
  console.log('[ui-check] 跳过 m13（截图导览，产物 shots/ 不进仓库）')

  if (failed.length) {
    console.error(`\n[ui-check] 真机断言未通过：${failed.join('、')}`)
    process.exit(1)
  }
  console.log(`\n[ui-check] ✅ 真机断言通过（${CHECKS.length} 支脚本）`)
}

main().catch((e) => {
  console.error('[ui-check] 失败：' + e.message)
  process.exit(1)
})
