// ============================================================================
// Playwright E2E 配置（M19：平台自己也要被测 —— 接口层 vitest 看不见界面）
//
// ⭐ 关键设计一：channel: 'chrome'
//    直接用系统已装的 Chrome，**不需要 `npx playwright install` 下载几百 MB Chromium**。
//    GitHub Actions 的 ubuntu-latest 镜像自带 Google Chrome stable，所以 CI 里同样免下载。
//
// ⭐ 关键设计二：E2E 用**独立数据库 + 独立端口**
//    否则每跑一次 E2E 就往 data/app.db 里灌数据（还会污染自己平台的用例列表）。
//    独立库 = 每次跑之前由 e2e/seed-e2e.mjs 重置成确定态，断言才可重复。
//
// 与 vitest（tests/）的分工：
//   · vitest  打在进程内（app.inject()），跑得快、覆盖鉴权/断言引擎/边界，看不见界面；
//   · 这里    真起服务 + 真浏览器，覆盖「界面能不能用」——路由守卫、表单、弹窗、异步数据到位。
// ============================================================================
import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.E2E_PORT || 3400)
const BASE_URL = `http://127.0.0.1:${PORT}`

// ⚠️ E2E 专用库：跑 E2E 不会污染 data/app.db（开发自用 + 真机验收脚本用的那份）
const E2E_DB = fileURLToPath(new URL('./data/e2e.db', import.meta.url))

export default defineConfig({
  testDir: './e2e',
  // 单条用例要跑真接口 + 等弹窗，给宽一点；超时短了在慢机器上会假失败
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // 打的是同一个 SQLite 文件，多 worker 并行写会互相干扰（也会让断言互相打架）
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    channel: 'chrome', // ★ 用系统 Chrome，不下载浏览器
    headless: true,
    viewport: { width: 1440, height: 900 },
    // 失败时留证据：trace 可回放、截图可直看
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // 自动拉起后端（这个端口同时托管前端产物 web/dist，所以一个进程就够）
  webServer: {
    command: 'node index.js',
    // 用真实就绪端点比「等端口通」可靠：/health 是平台自己的健康检查
    url: `${BASE_URL}/health`,
    // 本地/CI 都由 scripts/run-e2e.mjs 自己起服务（E2E_REUSE=1 标记）→ 这里直接复用；
    // 直接裸跑 `npx playwright test` 且没现成服务时，才由 Playwright 自己拉起
    //（⚠️ Windows 实测这种模式收尾杀不掉服务进程会挂住，所以正式入口是 run-e2e.mjs）。
    reuseExistingServer: !process.env.CI || process.env.E2E_REUSE === '1',
    timeout: 30_000,
    env: {
      DB_PATH: E2E_DB,
      PORT: String(PORT),
      // ★ DEEPSEEK_API_KEY 显式置空：E2E 必须离线可跑、每次结果一致。
      //   不置空的话，一台本地配了 key 的机器上点「AI 生成用例」会真去调 DeepSeek（花钱 + 输出不稳定 + CI 上还得塞密钥）。
      //   实测确认：环境里已存在（哪怕空串）的变量优先级高于 .env（index.js 用 dotenv 时不覆盖已存在的值），
      //   所以这行能稳稳压住 .env 里那个 key。AI 的真实调用路径由 tests/aiCases.test.js 用 mock fetch 覆盖。
      DEEPSEEK_API_KEY: '',
    },
  },
})
