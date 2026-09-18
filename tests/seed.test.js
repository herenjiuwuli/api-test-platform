// 「自测」种子脚本（seed.js）回归测试（vitest，全离线）
//
// 为什么值得单独测 seed.js：
//   它是「自测」用例组的**唯一真源**，而它自己曾经写错过断言——`示例-数组断言` 用了
//   `$.1.name`（本平台只认 `$[1]`），后续每次 `npm run seed` 都会往库里埋一条**必红**用例，
//   而且失败信息只写「匹配 0 个」，看不出是方言问题。这个 bug 让「全部运行」长期是 68/74。
//   教训：**数据种子也是代码，也会写出错的断言，也该有测试。**
//
// 做法：把 seed.js 当子进程跑，指向临时库文件，再用 node:sqlite 读回来验证。
//      这比在进程内 import 更接近真实用法（npm run seed 就是起一个独立进程）。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathDialectHint } from '../src/jsonpath.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF_GROUP = '自测'

let dir
let dbFile

/** 用独立进程跑一次 seed.js，指向指定库文件 */
function runSeed(file) {
  execFileSync(process.execPath, ['seed.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: file },
    stdio: 'pipe',
  })
}

/** 读出库里全部用例（含解析后的 expected） */
function readCases(file) {
  const db = new DatabaseSync(file)
  const rows = db
    .prepare(`SELECT id, name, method, url, expected_json AS expectedJson, "group" AS grp FROM test_cases`)
    .all()
  db.close()
  return rows.map((r) => ({ ...r, expected: JSON.parse(r.expectedJson || '{}') }))
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'seed-test-'))
  dbFile = path.join(dir, 'seed-test.db')
  runSeed(dbFile)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('seed.js 写入的「自测」用例组', () => {
  it('库文件真的建起来了，且写入了用例', () => {
    expect(existsSync(dbFile)).toBe(true)
    expect(readCases(dbFile).length).toBeGreaterThan(0)
  })

  it('所有用例都归属「自测」分组（不再出现无分组的遗留行）', () => {
    const rows = readCases(dbFile)
    const strays = rows.filter((r) => r.grp !== SELF_GROUP)
    expect(strays.map((r) => `${r.id}:${r.name}`)).toEqual([])
  })

  it('用例名唯一（重名会让报告里两条记录分不清）', () => {
    const names = readCases(dbFile).map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
  })

  // ⭐ 本次 bug 的直接回归：这条挂了就说明 seed 又埋了必红用例
  it('没有任何用例使用 `$.1` 这种不支持的数组下标方言', () => {
    const offenders = []
    for (const r of readCases(dbFile)) {
      for (const chk of r.expected.jsonChecks || []) {
        const hint = pathDialectHint(chk.path)
        if (hint) offenders.push(`${r.name} → ${chk.path}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('期望 405 的用例不存在（Fastify 对未注册方法回 404，写 405 必然红）', () => {
    const offenders = readCases(dbFile)
      .filter((r) => r.expected.status === 405)
      .map((r) => r.name)
    expect(offenders).toEqual([])
  })

  it('断言维度覆盖完整：状态码 / 包含 / 耗时 / JSONPath / 响应头 都有用例', () => {
    const rows = readCases(dbFile)
    const has = (fn) => rows.some(fn)
    expect(has((r) => typeof r.expected.status === 'number')).toBe(true)
    expect(has((r) => typeof r.expected.contains === 'string')).toBe(true)
    expect(has((r) => typeof r.expected.maxTimeMs === 'number')).toBe(true)
    expect(has((r) => (r.expected.jsonChecks || []).length > 0)).toBe(true)
    expect(has((r) => (r.expected.headers || []).length > 0)).toBe(true)
  })

  it('外网依赖单独一眼可辨：打公开接口的用例名都带「外网-」前缀', () => {
    const rows = readCases(dbFile)
    const external = rows.filter((r) => !/^https?:\/\/localhost/.test(r.url))
    expect(external.length).toBeGreaterThan(0)
    const unmarked = external.filter((r) => !r.name.startsWith('外网-')).map((r) => r.name)
    expect(unmarked).toEqual([])
  })

  it('幂等：再跑一次 seed 不会累积用例，只替换自己那一组', () => {
    const before = readCases(dbFile).length
    runSeed(dbFile)
    const after = readCases(dbFile)
    expect(after.length).toBe(before)
    expect(after.every((r) => r.grp === SELF_GROUP)).toBe(true)
  })

  it('幂等清理会兜住历史遗留名字（示例-* / 健康检查-*），不留无分组旧行', () => {
    // 手工塞一条老版本的遗留行，再 seed，应该被清掉
    const db = new DatabaseSync(dbFile)
    db.prepare(
      `INSERT INTO test_cases (name, method, url, headers_json, body_json, expected_json, "group")
       VALUES ('示例-数组断言(JSONPlaceholder/users)', 'GET', 'https://x.invalid/u', '{}', '', '{"status":200}', '')`,
    ).run()
    db.prepare(
      `INSERT INTO test_cases (name, method, url, headers_json, body_json, expected_json, "group")
       VALUES ('健康检查不支持DELETE方法', 'DELETE', 'http://localhost:3001/health', '{}', '', '{"status":405}', '')`,
    ).run()
    expect(readCases(dbFile).length).toBeGreaterThan(0)
    db.close()

    runSeed(dbFile)
    const rows = readCases(dbFile)
    expect(rows.filter((r) => /^示例-|^健康检查/.test(r.name))).toEqual([])
    expect(rows.every((r) => r.grp === SELF_GROUP)).toBe(true)
  })
})
