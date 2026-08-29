// SQLite 封装（Node 22 内置 node:sqlite，零原生依赖）。
// M1 仅用两张表：test_cases（用例定义）、runs（执行记录）。
// 路径可由 DB_PATH 覆盖（测试用 :memory:），默认 data/app.db。
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'

const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'app.db')

let _db = null

export function getDb() {
  if (_db) return _db
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  _db = new DatabaseSync(DB_PATH)
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
