// 写入示例用例，方便首次打开平台就有「可跑的东西」（截图 / 演示用）。
// 设计：
//  - 幂等：先删除旧的「示例-*」用例，再插入，可反复执行不重复。
//  - 用例混合「平台自检（离线必绿）」+ 两个公开接口（展示真实 JSONPath 断言）。
// 运行：npm run seed  （依赖后端默认端口 3001；改了 PORT 需同步改下方 URL）
import { getDb } from './src/db.js'

// 后端默认端口，保持与 index.js / npm run dev 一致
const PORT = process.env.PORT || 3001

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
    name: '示例-公开接口(Postman Echo)',
    method: 'GET',
    url: 'https://postman-echo.com/get',
    expected: {
      status: 200,
      jsonChecks: [{ path: '$.url', op: 'contains', value: 'postman-echo' }],
    },
  },
  {
    name: '示例-公开接口(JSONPlaceholder)',
    method: 'GET',
    url: 'https://jsonplaceholder.typicode.com/todos/1',
    expected: {
      status: 200,
      jsonChecks: [
        { path: '$.id', op: 'eq', value: 1 },
        { path: '$.completed', op: 'eq', value: false },
      ],
    },
  },
]

const db = getDb()
const deleted = db.prepare(`DELETE FROM test_cases WHERE name LIKE '示例-%'`).run().changes
const stmt = db.prepare(
  `INSERT INTO test_cases (name, method, url, headers_json, body_json, expected_json)
   VALUES (?, ?, ?, ?, ?, ?)`,
)
for (const d of demos) {
  stmt.run(d.name, d.method.toUpperCase(), d.url, '{}', '', JSON.stringify(d.expected))
}
console.log(`已写入示例用例 ${demos.length} 条（清理旧示例 ${deleted} 条）。`)
