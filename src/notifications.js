// 通知存储层（M17）。定时任务（runScheduledJob）跑完/失败会落一条通知，前端铃铛展示未读角标。
// 读写模型刻意做薄：只有「新增 / 列出 / 未读计数 / 标记已读」，没有编辑、没有删单条 ——
// 通知是运行日志，被改写会比被漏看更危险（比如「已读」状态被谁改回去，等于伪造历史）。
import { getDb } from './db.js'

// —— M18 实时推送：进程内极简发布/订阅 ——
// 定时任务跑完落库后广播一条，SSE 路由（index.js）把每条转成 text/event-stream 推给前端。
// 刻意不碰 HTTP：存储层只负责「有人订阅我就喊一声」，连谁在听、怎么发都不关心。
// 用 Set 而非 EventEmitter：订阅者天然去重，且取消订阅就是 delete。
const subscribers = new Set()

/**
 * 订阅新通知。返回取消订阅函数（务必在连接关闭时调用，否则内存泄漏）。
 * @param {(n:object)=>void} fn
 * @returns {()=>void}
 */
export function subscribe(fn) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** 广播给所有订阅者；单个订阅者抛错不能连累其他人（更不能连累落库） */
function emit(n) {
  for (const fn of subscribers) {
    try {
      fn(n)
    } catch {
      // 订阅者自己炸了不关我事
    }
  }
}

/**
 * 落一条通知。level 默认 info；title 必填。落库后广播给订阅者（M18）。
 * @param {{level?:'success'|'warn'|'error'|'info', title:string, body?:string, target?:string}} n
 */
export function addNotification({ level = 'info', title, body = '', target = '' }) {
  const db = getDb()
  const res = db
    .prepare(`INSERT INTO notifications (level, title, body, target, "read") VALUES (?, ?, ?, ?, 0)`)
    .run(level, title, body, target)
  const created = getNotification(res.lastInsertRowid)
  emit(created)
  return created
}

/** 列出通知（最新在前，默认最多 50 条） */
export function listNotifications({ limit = 50 } = {}) {
  const db = getDb()
  const rows = db.prepare(`SELECT * FROM notifications ORDER BY id DESC LIMIT ?`).all(Number(limit))
  return { items: rows.map(normalize) }
}

/** 未读条数 */
export function unreadCount() {
  const db = getDb()
  const row = db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE "read" = 0`).get()
  return { count: row.c }
}

/** 标记单条已读 */
export function markRead(id) {
  const db = getDb()
  db.prepare(`UPDATE notifications SET "read" = 1 WHERE id = ?`).run(Number(id))
  return { ok: true }
}

/** 全部标记已读 */
export function markAllRead() {
  const db = getDb()
  db.prepare(`UPDATE notifications SET "read" = 1 WHERE "read" = 0`).run()
  return { ok: true }
}

function getNotification(id) {
  const db = getDb()
  const row = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id)
  return row ? normalize(row) : null
}

function normalize(r) {
  return {
    id: r.id,
    level: r.level,
    title: r.title,
    body: r.body,
    target: r.target,
    read: !!r.read,
    createdAt: r.created_at,
  }
}
