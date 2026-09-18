// 写入「自测」用例组 + 演示定时任务，让平台首次打开就有可跑、可截图的东西。
//
// 为什么叫「自测」而不是「示例」：
//   这组用例的被测对象是**平台自己**（/health、鉴权守卫、SPA 兜底、登录入口），
//   与 `seed:oa` 写入的 OA 业务用例（测试外部被测系统）刻意分成不同分组，
//   报告页的分组汇总里一眼能区分「测平台自己」和「测 OA」。
//
// 幂等：先按分组清掉旧的自测用例（并兜住历史上名字前缀为「示例-」的旧行）及关联定时任务、
//       执行记录，再插入。可反复执行，不重复、不留孤儿 run。
//
// ⭐ 本文件是「自测」组的唯一真源。改自测用例请改这里再 `npm run seed`，
//    不要在界面上改（下次 seed 会把界面上的改动覆盖掉）。
//
// 运行：npm run seed   （依赖后端默认端口 3001；改了 PORT 需同步改下方 URL）
import { getDb } from './src/db.js'

const PORT = process.env.PORT || 3001
const BASE = `http://localhost:${PORT}`
const SELF_GROUP = '自测'

// 清表边界：新分组 + 历史遗留的旧名字前缀都要兜住。
// ⚠️ 只按一个前缀清会漏行——库里曾经因此留下 6 条「无分组」的红用例（「示例-数组断言」用错
//    JSONPath 方言 + 5 条 M1 时代的「健康检查-*」，后者还有一条名字是乱码）。
//    这些行的语义现在全部被下面的自测组覆盖，所以直接清掉即可，不丢覆盖。
//    这段保留在脚本里是让**老库**重新 seed 时能自愈；新库上它匹配 0 行，无副作用。
const LEGACY_WHERE = `name LIKE '示例-%' OR name LIKE '健康检查%' OR name LIKE '?%'`
const STALE_WHERE = `("group" = ? OR ${LEGACY_WHERE})`

// 自测用例：一条尽量只覆盖一个断言维度，红了能立刻定位是哪一类能力出问题。
const demos = [
  // ── 基础断言：状态码 / 包含 / JSONPath ─────────────────────────────
  {
    name: '自检-GET 状态码 + 包含 + JSONPath',
    method: 'GET',
    url: `${BASE}/health`,
    expected: {
      status: 200,
      contains: 'ok',
      jsonChecks: [
        { path: '$.ok', op: 'eq', value: true },
        { path: '$.service', op: 'eq', value: 'api-test-platform' },
      ],
    },
  },
  {
    name: '自检-响应头断言（content-type）',
    method: 'GET',
    url: `${BASE}/health`,
    // M14 能力：expected.headers = [{name, op: exists|eq|contains, value}]
    expected: {
      status: 200,
      headers: [{ name: 'content-type', op: 'contains', value: 'application/json' }],
    },
  },
  {
    name: '自检-耗时上限（性能断言）',
    method: 'GET',
    url: `${BASE}/health`,
    expected: { status: 200, maxTimeMs: 300 }, // /health 是纯内存操作，300ms 足够宽松
  },
  {
    name: '自检-查询参数不影响结果',
    method: 'GET',
    url: `${BASE}/health?foo=bar`,
    expected: { status: 200, contains: 'ok' },
  },

  // ── 鉴权：守卫的边界，以及「鉴权先于路由」这个容易踩的顺序问题 ──────
  {
    name: '鉴权-未带 token 访问受保护接口应 401',
    method: 'GET',
    url: `${BASE}/api/cases`,
    expected: { status: 401, contains: '未登录' },
  },
  {
    name: '鉴权-鉴权先于路由：未带 token 访问不存在的接口也是 401（不是 404）',
    method: 'GET',
    url: `${BASE}/api/health/extra`,
    // ⭐ 这条是把一个坑固化成了用例：authGuard 是 onRequest 钩子，
    //    对任意 /api/* 都先拦，所以「路径不存在」在没有 token 时表现成 401 而非 404。
    //    好处是不泄漏「某个路由是否存在」；坏处是排查时容易误判成鉴权坏了。
    expected: { status: 401, contains: '未登录' },
  },

  // ── 路由语义：未注册方法、SPA 兜底 ────────────────────────────────
  {
    name: '路由-未注册的方法回 404（Fastify 语义，不是 405）',
    method: 'DELETE',
    url: `${BASE}/health`,
    // ⚠️ /health 只注册了 GET；Fastify 对未注册方法默认回 404 而不是 405 Method Not Allowed。
    //    早期这条期望 405，一直是红的——是用例期望写错了，不是平台的问题。
    expected: { status: 404 },
  },
  {
    name: '路由-SPA 兜底：非 /api 的未知路径被前端吞成 200',
    method: 'GET',
    url: `${BASE}/health/extra`,
    // 兜底路由 `GET /*` 对非 /api 前缀的未知路径回 index.html（前端自己的路由会处理）。
    // 所以「路径写错」这类负向用例**必须用 /api 前缀测**，否则永远测不出 404。
    expected: { status: 200, contains: '<div id="app">' },
  },

  // ── 请求体：POST + 嵌套 JSONPath（全程本地，不依赖外网）───────────
  {
    name: '本地-POST + 请求体 + 嵌套 JSONPath（登录取 token）',
    method: 'POST',
    url: `${BASE}/api/auth/login`,
    headers: { 'Content-Type': 'application/json' },
    // ⚠️ 依赖演示账号 admin/admin123；改了默认口令需同步这一条。
    body: { username: 'admin', password: 'admin123' },
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.token', op: 'exists', value: true },
        { path: '$.user.role', op: 'eq', value: 'admin' },
      ],
    },
  },

  // ── 外网：证明「真实的外部 API 也能测」────────────────────────────
  // ⚠️ 下面 4 条打公开接口（JSONPlaceholder / httpbin），**联网才能绿**。
  //    离线时它们会红，那不是平台的问题——名字统一带「外网-」前缀，就是为了红了能一眼分辨。
  {
    name: '外网-GET + JSONPath（JSONPlaceholder）',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/todos/1',
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.id', op: 'eq', value: 1 },
        { path: '$.completed', op: 'eq', value: false },
        { path: '$.userId', op: 'eq', value: 1 },
      ],
    },
  },
  {
    name: '外网-数组长度 + 数组下标（正确方言 $[1]）',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/users',
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.length', op: 'gte', value: 5 }, // 数组长度断言
        // ⭐ 数组下标的正确写法是 $[1]，不是 $.1。
        //    历史上这里写的是 `$.1.name`——本平台的迷你 JSONPath 不认这种方言，
        //    求值会**静默返回 0 个匹配**（不是报错），于是这条用例永远是红的而看不出原因。
        //    现在断言失败会提示方言问题（见 src/jsonpath.js 的 pathDialectHint）。
        { path: '$[1].name', op: 'exists', value: true },
      ],
    },
  },
  {
    name: '外网-POST + 请求体回显（httpbin）',
    method: 'POST',
    url: 'https://httpbin.org/post',
    headers: { 'Content-Type': 'application/json' },
    body: { title: 'apitest', done: false },
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.json.title', op: 'contains', value: 'apitest' }, // 请求体被回显到 $.json
        { path: '$.json.done', op: 'eq', value: false },
      ],
    },
  },
  {
    name: '外网-性能上限（httpbin/get）',
    method: 'GET',
    url: 'https://httpbin.org/get',
    expected: { status: 200, maxTimeMs: 5000 },
  },
]

const db = getDb()

// 1) 清旧的定时任务（依赖用例，必须先于用例删除，否则外键/悬空引用）
db.prepare(
  `DELETE FROM schedules WHERE case_id IN (SELECT id FROM test_cases WHERE ${STALE_WHERE})`,
).run(SELF_GROUP)
// 2) 清旧的执行记录（runs.case_id 不是外键，不删就留成孤儿 → 报告里冒出无名的「用例#id」）
const deletedRuns = db
  .prepare(`DELETE FROM runs WHERE case_id IN (SELECT id FROM test_cases WHERE ${STALE_WHERE})`)
  .run(SELF_GROUP).changes
// 3) 清旧的自测用例
const deletedCases = db
  .prepare(`DELETE FROM test_cases WHERE ${STALE_WHERE}`)
  .run(SELF_GROUP).changes

// 4) 插入新用例（带分组），记录 id 以便挂演示定时任务
const stmt = db.prepare(
  `INSERT INTO test_cases (name, method, url, headers_json, body_json, expected_json, "group")
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
)
const ids = {}
for (const d of demos) {
  const info = stmt.run(
    d.name,
    d.method.toUpperCase(),
    d.url,
    JSON.stringify(d.headers || {}),
    d.body !== undefined ? JSON.stringify(d.body) : '',
    JSON.stringify(d.expected),
    SELF_GROUP,
  )
  ids[d.name] = info.lastInsertRowid
}

// 5) 演示定时任务：每天 09:00 自动跑「外网-GET + JSONPath」——默认停用，
//    用户可在「报告 / 定时」页启用后查看定时触发 → 落通知 → 页面实时弹出的完整链路。
const schedCase = ids['外网-GET + JSONPath（JSONPlaceholder）']
let schedMsg = '（未挂演示定时任务）'
if (schedCase) {
  db.prepare(`INSERT INTO schedules (case_id, cron, enabled) VALUES (?, '0 9 * * *', 0)`).run(schedCase)
  schedMsg = '，含 1 条演示定时任务（默认停用，可在「报告/定时」页启用）'
}

const online = demos.filter((d) => d.url.startsWith('http') && !d.url.startsWith(BASE)).length
console.log(
  `已写入「${SELF_GROUP}」用例 ${demos.length} 条（清理旧用例 ${deletedCases} 条、旧执行记录 ${deletedRuns} 条）${schedMsg}。`,
)
console.log(
  `提示：其中 ${online} 条打公开接口（JSONPlaceholder / httpbin），离线时会红——那不是平台的问题，看名字前缀「外网-」即可分辨。`,
)
