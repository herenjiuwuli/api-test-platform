// ============================================================================
// 把 E2E 专用库重置成**确定态**（Playwright 跑之前调用，见 package.json 的 test:e2e）
//
// 为什么不直接 `DB_PATH=... node seed.js`：
//   npm scripts 在 Windows 上走 cmd.exe，`VAR=x cmd` 这种前置赋值语法不通用。
//   所以这里用 Node 先设好环境变量，再动态 import——不重造轮子。
//
// 为什么不删库文件重造：
//   本机可能还留着上一轮 E2E 的 server 进程（配置里 reuseExistingServer=true），
//   文件被占用时删不掉；而批量删文件又会撞上 WorkBuddy 的 safe-delete shim。
//   「清表 + 重新灌种子」既避开这两个坑，又同样能从任意脏状态回到确定态。
//
// ⚠️ 为什么还要自己补两条用例：
//   平台真实的 seed.js 里有 4 条打**公网**的示例（jsonplaceholder / httpbin）。
//   联网与否、对方限流与否，结果都会变——拿它们做断言 = E2E 随机假失败。
//   所以另外补两条**只打本机 /health** 的用例（一条必绿、一条必红），
//   并打上同一个分组，用于「按分组运行」的确定性断言。
// ============================================================================
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.E2E_PORT || 3400)
process.env.DB_PATH = fileURLToPath(new URL('../data/e2e.db', import.meta.url))
// 必须在 import seed.js 之前设好：seed.js 里「自检-*」用例的 URL 用它拼 /health
process.env.PORT = String(PORT)

const { getDb, closeDb, dbPath } = await import('../src/db.js')

const db = getDb()

// 1) 清表回到空态。顺序 = 子表 → 父表（runs / schedules 引用 test_cases；notifications 独立）。
//    注意：代码里写在 BEGIN 之后的 `PRAGMA foreign_keys = OFF` 是空操作（事务内不生效），
//    所以这里只能靠顺序，不能指望临时关外键。
for (const t of ['notifications', 'runs', 'schedules', 'test_cases', 'environments', 'settings', 'users']) {
  db.exec(`DELETE FROM ${t}`)
}

// 2) 复用真实的 seed.js —— E2E 就打用户在首开时真正看到的那份示例数据
await import('../seed.js')

// 2.5) 显式保证有可用账号。默认管理员本该由服务首次启动时创建，但这里不能依赖那个时机：
//      配置里 reuseExistingServer=true 时，可能复用一个「早就启动好、库里用户已被清空」的 server，
//      那台 server 不会重新跑 initDefaultUser，登录就会平白失败。让库自带账号，两种情形都稳。
const { initDefaultUser } = await import('../src/users.js')
const ADMIN = initDefaultUser() || { username: 'admin' }

// 3) 补两条「离线必绿 / 必红」的确定性用例，并归到同一个分组下
const BASE = `http://127.0.0.1:${PORT}`
const E2E_GROUP = 'e2e-离线'
const insert = db.prepare(
  `INSERT INTO test_cases (name, method, url, headers_json, body_json, expected_json, "group")
   VALUES (?, 'GET', ?, '{}', '', ?, ?)`,
)
const extra = [
  {
    name: 'E2E-自检必绿(/health)',
    url: `${BASE}/health`,
    // 状态码 + 文本包含 + JSONPath 三档一起验，跑一次就能看出断言引擎没坏
    expected: {
      status: 200,
      contains: 'ok',
      jsonChecks: [{ path: '$.ok', op: 'eq', value: true }],
    },
  },
  {
    name: 'E2E-状态码必红',
    url: `${BASE}/health`,
    // 本机 /health 恒返回 200，期望 418 —— 永远失败。用它证明「失败会被如实报出来」，
    // 而不是只证明「全绿」（只会报通过的工具比没有工具更危险）。
    expected: { status: 418 },
  },
]
for (const c of extra) insert.run(c.name, c.url, JSON.stringify(c.expected), E2E_GROUP)

const counts = {}
for (const t of ['test_cases', 'schedules', 'users', 'environments']) {
  counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
}

console.log('[e2e] E2E 库已重置 →', process.env.DB_PATH)
console.log('[e2e] 行数：', counts, `（其中分组「${E2E_GROUP}」2 条：1 必绿 + 1 必红）`)
console.log('[e2e] 账号：', ADMIN.username, '/ admin123（本脚本直接种入，不依赖服务重启）')

closeDb()
