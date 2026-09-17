// 清理「孤儿执行记录」：`runs` 里指向**已删除用例**的行。
//
// 为什么会有孤儿：`runs.case_id` 不是外键。历史上三条删用例的路径都不管派生数据 ——
// ① `deleteCase()` 只 `DELETE FROM test_cases`；② `npm run seed` 与 ③ `npm run seed:oa`
// 也各自直接 `DELETE FROM test_cases`（每次重跑都会把上一批执行记录变成孤儿）。
// 表现是报告页「按用例汇总」里冒出一堆连名字都没有的「用例#id」，且越跑越多（本机实测积到 791 条）。
//
// 三条路径现在都已在删除时连带清理（见 src/cases.js 的 deleteCase 与两个 seed 脚本），
// 这个脚本负责**扫尾历史遗留**，顺便可以当体检工具常跑。
//
// 用法（默认只看不动）：
//   node scripts/clean-orphan-runs.mjs           # 只报告
//   node scripts/clean-orphan-runs.mjs --yes     # 真的删
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 显式指向项目下的 data/app.db：否则从别的目录跑起来会连到另一个库（发现时不报错，只是「没效果」）
process.env.DB_PATH = process.env.DB_PATH || path.resolve(ROOT, 'data', 'app.db')
const { getDb } = await import('../src/db.js')

const db = getDb()
const WHERE = `case_id IS NOT NULL AND case_id NOT IN (SELECT id FROM test_cases)`

const total = db.prepare(`SELECT COUNT(*) n FROM runs WHERE ${WHERE}`).get().n
const groups = db
  .prepare(`SELECT case_id, COUNT(*) n, MAX(ran_at) last FROM runs WHERE ${WHERE} GROUP BY case_id ORDER BY n DESC`)
  .all()

console.log(`数据库：${process.env.DB_PATH}`)
console.log(`孤儿执行记录：${total} 条，涉及 ${groups.length} 个已不存在的用例 id`)
for (const g of groups.slice(0, 10)) console.log(`  用例#${g.case_id}：${g.n} 条（最后一次 ${g.last}）`)
if (groups.length > 10) console.log(`  …还有 ${groups.length - 10} 个`)

if (!process.argv.includes('--yes')) {
  console.log('\n（以上只是报告，未改动任何数据。确实要删除请加 --yes）')
  process.exit(0)
}

const removed = db.prepare(`DELETE FROM runs WHERE ${WHERE}`).run().changes
const left = db.prepare(`SELECT COUNT(*) n FROM runs WHERE ${WHERE}`).get().n
const remain = db.prepare(`SELECT COUNT(*) n FROM runs`).get().n
console.log(`\n已删除 ${removed} 条孤儿记录；复查剩余 ${left} 条。`)
console.log(`库里现有执行记录共 ${remain} 条（都还能对上活着的用例）。`)
// 删完必须复查「还剩几条」—— 清理步骤静默失败过太多次了（详见 skill 的坑清单）
if (left !== 0) process.exitCode = 1
