#!/usr/bin/env node
// ============================================================================
// E2E 包装器（M19 引入，M21 增强）：自管服务生命周期 + 输出看门狗 + 自动重试。
//
// 为什么不用 playwright.config.js 的 webServer？
//   Windows 实测：Playwright 1.63 测完用 `taskkill /T /F` 收尾，但本机杀不掉
//   它拉起的 node 服务（进程照样活着），导致 npm run 永不退出。
//
// 为什么还要看门狗 + 重试（M21）？
//   本机进程行为有顽固 flake：同代码多次运行，约 1/4 的概率挂在**任意阶段**——
//   收尾挂死（已被 e2e/force-exit-reporter.mjs 的 onTestEnd 强退修掉）、
//   Playwright 启动挂死（spawn 后零输出，连 Running 11 tests 都不打）。
//   挂点不固定、与沙箱无关（关沙箱复现）、与代码无关（M19/M20/M21 都撞过）。
//   对策：60s 无输出 = 判定挂死 → 杀进程树 → 自动重试一次（种子幂等，重跑无副作用）。
//
// 配合 playwright.config.js：本脚本设 E2E_REUSE=1，config 据此允许 reuseExistingServer
// —— Playwright 检测 /health 已通就复用，不再自己起。
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.E2E_PORT || 3400)
const BASE = `http://127.0.0.1:${PORT}`
const E2E_DB = fileURLToPath(new URL('../data/e2e.db', import.meta.url))
const IS_WIN = process.platform === 'win32'

// 看门狗：Playwright 子进程连续这么久没有任何输出即判定挂死。
// 正常运行时每条用例 1-4s 就有一行 ok；最慢的合法安静期（首条用例前）也只有几秒。
const PW_SILENCE_MS = 60_000
const MAX_ATTEMPTS = 2

function killTree(pid) {
  if (!pid) return
  if (IS_WIN) {
    // /T 连进程树一起杀（node 服务 / playwright 可能带浏览器子进程），/F 强制
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(pid, 'SIGTERM') } catch { /* 可能已退出 */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHealthy(ms = 30_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return
    } catch { /* 还没起来，继续等 */ }
    await sleep(300)
  }
  throw new Error(`30s 内 ${BASE}/health 未就绪`)
}

async function runSeed() {
  const r = spawnSync(process.execPath, ['e2e/seed-e2e.mjs'], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('[e2e] 种子失败，终止')
    process.exit(r.status ?? 1)
  }
}

function startServer() {
  const server = spawn(process.execPath, ['index.js'], {
    stdio: 'inherit',
    env: { ...process.env, DB_PATH: E2E_DB, PORT: String(PORT), DEEPSEEK_API_KEY: '' },
  })
  return server
}

/**
 * 跑一轮 Playwright，带输出看门狗。
 * stdout/stderr 走 pipe 由本脚本转发（这样才有「输出活动」可监控），
 * 连续 PW_SILENCE_MS 没有任何输出 → 判定挂死 → 杀树 → 返回 { hung: true }。
 * 返回 Promise 永不 reject（所有失败都进返回值）。
 */
function runPlaywrightWithWatchdog() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], {
      env: { ...process.env, E2E_REUSE: '1' },
    })
    let lastActivity = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > PW_SILENCE_MS) {
        clearInterval(watchdog)
        console.log(`\n[e2e] ⚠️ Playwright 已 ${PW_SILENCE_MS / 1000}s 无输出，判定挂死（本机偶发 flake），杀进程树…`)
        killTree(child.pid)
        resolve({ hung: true, code: 1 })
      }
    }, 5000)
    child.stdout.on('data', (d) => { lastActivity = Date.now(); process.stdout.write(d) })
    child.stderr.on('data', (d) => { lastActivity = Date.now(); process.stderr.write(d) })
    const finish = (code) => { clearInterval(watchdog); resolve({ hung: false, code: code ?? 1 }) }
    child.on('exit', finish)
    child.on('error', () => finish(1))
  })
}

let testCode = 1
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  await runSeed()
  const server = startServer()
  try {
    await waitHealthy()
    console.log(`[e2e] 服务就绪 ${BASE}（DB=${E2E_DB}，第 ${attempt}/${MAX_ATTEMPTS} 次尝试）`)
    const res = await runPlaywrightWithWatchdog()
    testCode = res.code
    if (!res.hung) break // 正常结束（通过或真实失败都算「跑完」），不重试
    if (attempt < MAX_ATTEMPTS) console.log('[e2e] 挂死已处理，自动重试一次（种子幂等，重跑无副作用）…')
  } catch (e) {
    console.error('[e2e] 本轮失败：' + e.message)
    testCode = 1
    break
  } finally {
    killTree(server.pid) // 成败都杀服务；force-exit 强退后 playwright 的浏览器孤儿也一并由 /T 收掉
    await sleep(500)
  }
}

process.exit(testCode)
