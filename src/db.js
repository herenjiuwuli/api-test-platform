// SQLite 封装（Node 22 内置 node:sqlite，零原生依赖）。
// M1 仅用两张表：test_cases（用例定义）、runs（执行记录）。
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
      case_id INTEGER NOT NULL,
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
  `)
  return _db
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
