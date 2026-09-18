// 通知出口（M21）：把失败侧的站内通知 POST 到一个可配置的 webhook 地址。
//
// 为什么要有这一层：M17/M18/M20 的通知都只活在平台自己页面里（铃铛 / SSE 角标）——
// 人不在电脑前就收不到。监控闭环的最后一环是「升级外呼」：失败侧通知落库后顺带
// POST 出去，指向飞书机器人 webhook / hermes 网关 / 任意能收 JSON 的端点都行。
//
// 设计（延续 M17「通知是额外能力」的容错思路）：
//  - 只转发 warn（断言失败）/ error（没跑成）——success 本来就该静默（M20 同一个理）；
//  - forwardToWebhook **永不抛错**：3s 超时、fetch 异常、HTTP 非 2xx 全部转成返回值，
//    调度器可以放心 await 它——出口挂了绝不能影响调度本体；
//  - 地址存 settings 表（全局 KV，和「当前环境」同一套机制）；
//  - URL 只放行 http/https，且必须是能被 `new URL` 解析的绝对地址。
import { getDb } from './db.js'

const WEBHOOK_KEY = 'notify_webhook'
const FORWARD_LEVELS = new Set(['warn', 'error'])

// settings 表的 KV 读写和 environments.js 里那两行一样——八行代码不值得为此
// 建公共模块或让 webhook 反向依赖 environments，就地复制并留注释说明。
function getSetting(key) {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key)
  return row ? row.value : null
}

function setSetting(key, value) {
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value === null || value === undefined ? '' : String(value))
}

/** 当前 webhook 地址（空串 = 未启用出口） */
export function getWebhookUrl() {
  return getSetting(WEBHOOK_KEY) || ''
}

/**
 * 配置 webhook 地址；传空串/不传 = 关闭出口。
 * 校验失败抛错（路由层转 400），成功返回归一化后的地址。
 */
export function setWebhookUrl(url) {
  const v = String(url ?? '').trim()
  if (v) {
    let u
    try {
      u = new URL(v)
    } catch {
      throw new Error('webhook 地址必须是合法 URL')
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('webhook 只支持 http/https')
    }
  }
  setSetting(WEBHOOK_KEY, v)
  return getWebhookUrl()
}

/**
 * 失败侧通知外呼。调用方（scheduler.js）await 它——确定性靠「永不抛错」保证：
 * 任何失败都变成 { ok:false, ... } 返回值，而不是异常。
 * @param {{level:string,title:string,body?:string,target?:string,createdAt?:string}} n
 */
export async function forwardToWebhook(n) {
  const url = getWebhookUrl()
  if (!url) return { ok: false, skipped: '未配置 webhook' }
  if (!FORWARD_LEVELS.has(n?.level)) return { ok: false, skipped: `level=${n?.level} 不转发（只转 warn/error）` }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 消息体和站内通知同构，外加 type 标识来源——收端（飞书适配器 / hermes）好路由
      body: JSON.stringify({
        type: 'api-test-platform.notify',
        level: n.level,
        title: n.title,
        body: n.body || '',
        target: n.target || '',
        createdAt: n.createdAt || '',
      }),
      signal: AbortSignal.timeout(3000),
    })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    return { ok: false, error: e.message || String(e) }
  }
}
