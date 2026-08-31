// 用户服务（M4）
//  - createUser / getUserByUsername / verifyLogin
//  - initDefaultUser：首次启动（无任何用户时）种入默认管理员，避免平台被锁死
import { getDb } from './db.js'
import { hashPassword, verifyPassword } from './auth.js'

export function createUser({ username, password, role = 'user' }) {
  const db = getDb()
  if (!username || !password) throw new Error('用户名和密码必填')
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (exists) throw new Error('用户名已存在')
  const stored = hashPassword(password)
  const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
    username,
    stored,
    role,
  )
  return { id: Number(info.lastInsertRowid), username, role }
}

export function getUserByUsername(username) {
  const db = getDb()
  return db.prepare('SELECT id, username, role, password_hash, created_at FROM users WHERE username = ?').get(username) || null
}

export function verifyLogin(username, password) {
  const u = getUserByUsername(username)
  if (!u) return null
  if (!verifyPassword(password, u.password_hash)) return null
  return { id: u.id, username: u.username, role: u.role }
}

// 仅首次启动时调用：库里一个用户都没有才建默认 admin。
export function initDefaultUser() {
  const db = getDb()
  const n = db.prepare('SELECT count(*) c FROM users').get().c
  if (n === 0) {
    const u = createUser({ username: 'admin', password: 'admin123', role: 'admin' })
    console.log('✅ 已创建默认管理员：admin / admin123（请尽快修改密码）')
    return u
  }
  return null
}
