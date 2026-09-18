#!/usr/bin/env node
// ============================================================================
// E2E 包装器（M19）：自管服务生命周期 —— 起 → 等就绪 → 跑 Playwright → 杀。
//
// 为什么不用 playwright.config.js 的 webServer？
//   Windows 实测：Playwright 1.63 测完用 `taskkill /T /F` 收尾，但本机杀不掉
//   它拉起的 node 服务（进程照样活着），导致 npm run 永不退出（对照组实验：
//   手动起服务 + reuseExistingServer → 11 条全绿且干净退出）。
//   与其依赖平台相关的收尾行为，不如起和杀都归我们管 —— 本地/CI 两端一致。
//
// 配合 playwright.config.js：本脚本会设 E2E_REUSE=1，config 据此允许
// reuseExistingServer —— Playwright 检测 /health 已通就复用，不再自己起。
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.E2E_PORT || 3400)
const BASE = `http://127.0.0.1:${PORT}`
const E2E_DB = fileURLToPath(new URL('../data/e2e.db', import.meta.url))
const IS_WIN = process.platform === 'win32'

// 1) 种子：把 E2E 库重置成确定态（5 条示例 + 2 条离线必绿/必红）
{
  const r = spawnSync(process.execPath, ['e2e/seed-e2e.mjs'], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('[e2e] 种子失败，终止')
    process.exit(r.status ?? 1)
  }
}

// 2) 起服务（E2E 专用库 + 端口 + 空置 AI key —— 与 config webServer.env 同一套约定）
const server = spawn(process.execPath, ['index.js'], {
  stdio: 'inherit',
  env: { ...process.env, DB_PATH: E2E_DB, PORT: String(PORT), DEEPSEEK_API_KEY: '' },
})
let serverExit = null
server.on('exit', (code, signal) => { serverExit = { code, signal } })

async function waitHealthy(ms = 30_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (serverExit) throw new Error(`服务在就绪前退出（code=${serverExit.code} signal=${serverExit.signal}）`)
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return
    } catch { /* 还没起来，继续等 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`30s 内 ${BASE}/health 未就绪`)
}

function killServer() {
  if (server.exitCode !== null || server.killed) return
  if (IS_WIN) {
    // /T 连进程树一起杀（node 服务可能有子线程/子进程），/F 强制
    spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    server.kill('SIGTERM')
  }
}

let testCode = 1
try {
  await waitHealthy()
  console.log(`[e2e] 服务就绪 ${BASE}（DB=${E2E_DB}）`)

  // 3) 跑 Playwright（E2E_REUSE=1 → config 允许复用我们刚起的服务）
  //    真实前端产物 web/dist 由这个服务托管 —— 所以跑 E2E 前必须先 npm run build（verify 顺序已保证）。
  testCode = await new Promise((resolve) => {
    const pw = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], {
      stdio: 'inherit',
      env: { ...process.env, E2E_REUSE: '1' },
    })
    pw.on('exit', (code) => resolve(code ?? 1))
    pw.on('error', () => resolve(1))
  })
} finally {
  // 4) 收尾：无论测试成败都杀服务 —— 这就是「npm run 能退出」的关键
  killServer()
  // 给 taskkill 一点时间，避免极少数情况下端口未释放就退出
  await new Promise((r) => setTimeout(r, 500))
}

process.exit(testCode)
