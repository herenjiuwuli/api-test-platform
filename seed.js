// 写入示例用例 + 演示定时任务，方便首次打开平台就有「可跑、可截图」的东西。
// 设计目标：覆盖平台所有能力（状态码 / 包含 / JSONPath / 数组断言 / POST 请求体 / 性能上限 / 定时任务）。
//  - 幂等：先删旧的「示例-*」用例与关联定时任务，再插入，可反复执行不重复。
//  - 离线必绿：第一条「平台自检」打本机 /health，无需联网即可看到绿结果。
//  - 联网展示真实断言：后四条打公开接口（JSONPlaceholder / httpbin），体现真实 JSONPath 断言。
// 运行：npm run seed  （依赖后端默认端口 3001；改了 PORT 需同步改下方 URL）
import { getDb } from './src/db.js'

// 后端默认端口，保持与 index.js / npm run dev 一致
const PORT = process.env.PORT || 3001

// 示例用例：覆盖所有断言维度
const demos = [
  {
    name: '示例-平台自检(/health)',
    method: 'GET',
    url: `http://localhost:${PORT}/health`,
    expected: {
      status: 200,
      contains: 'ok',
      jsonChecks: [{ path: '$.ok', op: 'eq', value: true }],
    },
  },
  {
    name: '示例-GET+JSONPath(JSONPlaceholder)',
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
    name: '示例-数组断言(JSONPlaceholder/users)',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/users',
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.length', op: 'gte', value: 5 }, // 数组长度断言
        { path: '$.1.name', op: 'exists', value: true }, // 数组下标 + exists
      ],
    },
  },
  {
    name: '示例-POST+请求体(httpbin)',
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
    name: '示例-性能断言(httpbin/get)',
    method: 'GET',
    url: 'https://httpbin.org/get',
    expected: {
      status: 200,
      maxTimeMs: 5000, // 耗时上限断言
    },
  },
]

const db = getDb()

// 1) 清旧的示例定时任务（依赖示例用例，必须先于用例删除）
db.prepare(`DELETE FROM schedules WHERE case_id IN (SELECT id FROM test_cases WHERE name LIKE '示例-%')`).run()
// 2) 清旧的示例执行记录（runs.case_id 不是外键，不删就留成孤儿 → 报告里冒出无名的「用例#id」）
const deletedRuns = db.prepare(`DELETE FROM runs WHERE case_id IN (SELECT id FROM test_cases WHERE name LIKE '示例-%')`).run().changes
// 3) 清旧的示例用例
const deletedCases = db.prepare(`DELETE FROM test_cases WHERE name LIKE '示例-%'`).run().changes

// 4) 插入新示例用例，记录 id 以便挂演示定时任务
const stmt = db.prepare(
  `INSERT INTO test_cases (name, method, url, headers_json, body_json, expected_json)
   VALUES (?, ?, ?, ?, ?, ?)`,
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
  )
  ids[d.name] = info.lastInsertRowid
}

// 5) 演示定时任务：每天 09:00 自动跑「JSONPath 示例」——默认停用，用户可在「报告/定时」页启用查看效果
const schedCase = ids['示例-GET+JSONPath(JSONPlaceholder)']
let schedMsg = '（未挂演示定时任务）'
if (schedCase) {
  db.prepare(`INSERT INTO schedules (case_id, cron, enabled) VALUES (?, '0 9 * * *', 0)`).run(schedCase)
  schedMsg = '，含 1 条演示定时任务（默认停用，可在「报告/定时」页启用）'
}

console.log(`已写入示例用例 ${demos.length} 条（清理旧示例用例 ${deletedCases} 条、旧执行记录 ${deletedRuns} 条）${schedMsg}。`)
