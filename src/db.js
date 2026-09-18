// SQLite 封装（Node 22 内置 node:sqlite，零原生依赖）。
// 表：test_cases（用例）/ runs（执行记录）/ schedules（定时任务）/ users（账号）
//     + environments（环境变量集，M9）/ settings（全局单行配置，存「当前环境」）
// 新表一律写成 CREATE TABLE IF NOT EXISTS 放在下面这段 exec 里：它对「已存在的老库」同样生效，
// 所以加表不需要额外的迁移分支（加**列**才需要，见 migrate()）。
// 路径可由 DB_PATH 覆盖（测试用 :memory:），默认 data/app.db。
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'

// 重要：DB_PATH 必须在 getDb() 内部「惰性求值」，不能写成模块顶层 const！
// 原因：测试里 process.env.DB_PATH=':memory:' 在 import 之后才赋值，
// 若顶层 const 提前把路径快照下来，:memory: 就永远不生效，
// 导致测试把用例写成真实 data/app.db（污染生产库 + 跑全部时 fetch 死链）。
function resolveDbPath() {
  return process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'app.db')
}

let _db = null

export function getDb() {
  if (_db) return _db
  const dbPath = resolveDbPath()
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  _db = new DatabaseSync(dbPath)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS test_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      url TEXT NOT NULL,
      headers_json TEXT NOT NULL DEFAULT '{}',
      body_json TEXT NOT NULL DEFAULT '',
      expected_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER,
      pass INTEGER NOT NULL,
      status INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      detail_json TEXT NOT NULL DEFAULT '[]',
      ran_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER,
      "group" TEXT NOT NULL DEFAULT '',
      cron TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS environments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      base_url TEXT NOT NULL,
      headers_json TEXT NOT NULL DEFAULT '{}',
      vars_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- 全局单行配置（目前只放「当前环境」）。
    -- 只有一个全局环境这件事，放在一行 KV 里比在 environments 上加 is_active 列更安全：
    -- 后者迟早会出现「两行都是 active」这种没法自证的状态。
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `)
  migrate(_db)
  return _db
}

// 幂等迁移：老库（已存在）不会走上面的 CREATE TABLE IF NOT EXISTS，所以新列要单独补。
// 用 try/catch 兜「列已存在」，比先查 PRAGMA 再决定更少一次往返，也不依赖 pragma 的返回形状。
function migrate(db) {
  const addColumn = (sql) => {
    try {
      db.exec(sql)
    } catch (e) {
      if (!/duplicate column name/i.test(e.message)) throw e
    }
  }
  // M4：用例链的「从响应抽变量」声明，形如 [{"name":"token","path":"$.token"}]
  addColumn(`ALTER TABLE test_cases ADD COLUMN extract_json TEXT NOT NULL DEFAULT '[]'`)
  // M8：请求体类型（json / raw / form-data）+ form-data 的文件字段声明
  addColumn(`ALTER TABLE test_cases ADD COLUMN body_type TEXT NOT NULL DEFAULT 'json'`)
  addColumn(`ALTER TABLE test_cases ADD COLUMN files_json TEXT NOT NULL DEFAULT '[]'`)
  // M10：执行记录里的「这次跑在哪个环境」——存的是**快照**（名字 + 地址），不只是外键。
  // 理由：环境地址以后被改（比如从本地换到预发），历史记录必须仍然说得出「那次实际打的是哪个地址」。
  // 只存 env_id 的话，改一次地址就把历史全改写成了「它从没打过的地址」。
  addColumn(`ALTER TABLE runs ADD COLUMN env_id INTEGER`)
  addColumn(`ALTER TABLE runs ADD COLUMN env_name TEXT NOT NULL DEFAULT ''`)
  addColumn(`ALTER TABLE runs ADD COLUMN base_url TEXT NOT NULL DEFAULT ''`)
  // M12：用例分组。一个平台里常挂着多个被测系统的用例（如 OA 的 52 条），
  // 需要一个「业务语义」的标签把同主题的用例收拢（鉴权 / 审批 / 附件 / 通知…），
  // 用于列表筛选、按组运行、报告按组看通过率。它和 run-all 的 prefix 过滤互补：
  // prefix 是按名字前缀切（跑「OA-」这一坨），group 是按语义标签切（跑「审批引擎」这一主题）。
  // 注意 group 是 SQL 保留字，建列 / 引用一律加双引号。
  addColumn(`ALTER TABLE test_cases ADD COLUMN "group" TEXT NOT NULL DEFAULT ''`)
  // M15：定时任务也能按「分组」跑（不只单条用例）。分组定时任务的 case_id 用占位 0
  // （SQLite 列仍是 NOT NULL，0 不指向任何真实用例；调度时以 group 为准）。
  addColumn(`ALTER TABLE schedules ADD COLUMN "group" TEXT NOT NULL DEFAULT ''`)
}

export function closeDb() {
  if (_db) {
    try {
      _db.close()
    } catch {
      // 忽略重复关闭
    }
    _db = null
  }
}
