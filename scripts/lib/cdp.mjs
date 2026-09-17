// 真机检查脚本的公共底座：零依赖 CDP（系统已装的 Chrome + Node 内置 WebSocket）。
//
// 为什么抽成模块：`m9-env-ui-check.mjs` 和 `m10-report-env-check.mjs` 都要「起浏览器 / 登录 / 断言」，
// 复制两遍 100 行脚手架是这类脚本最容易腐烂的地方。
//
// 用法：
//   import { withBrowser, checks, PAGE_HELPERS } from './lib/cdp.mjs'
//   const c = checks();...
//   await withBrowser(async (cdp) => { ... }, { port: 9335 })

import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p
  throw new Error('没找到 Chrome，试过：\n' + CHROME_CANDIDATES.join('\n'))
}

async function waitJson(url, timeout = 25000) {
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.json()
      last = 'HTTP ' + r.status
    } catch (e) {
      last = e.message
    }
    await sleep(300)
  }
  throw new Error('等待超时 ' + url + ' :: ' + last)
}

export class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error('CDP error: ' + JSON.stringify(m.error)))
        else resolve(m.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }

  /** 导航并轮询「业务就绪」——不要等 Page.loadEventFired，SPA 里它早于框架渲染完成 */
  async nav(url, readyExpr = 'document.body && document.body.innerText.length > 50', timeout = 20000) {
    await this.send('Page.navigate', { url })
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval('!!(' + readyExpr + ')')) return true
      } catch {}
      await sleep(250)
    }
    throw new Error('页面渲染超时: ' + url)
  }

  /** 等一个页面内的条件成立（比如「列表加载完成」这种页面专属的异步条件） */
  async waitFor(expr, label, timeout = 8000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval('!!(' + expr + ')')) return true
      } catch {}
      await sleep(200)
    }
    throw new Error(`等待「${label}」超时：${expr}`)
  }

  /** 失败时把现场打出来 —— 只报「超时」的脚本是没法排障的 */
  async dump(label = '现场快照') {
    console.error(`\n--- ${label} ---`)
    console.error('location :', await this.eval('location.href'))
    console.error('正文     :', (await this.eval('document.body.innerText')).slice(0, 400).replace(/\n/g, ' | '))
  }
}

/**
 * 起一个一次性的无头 Chrome，跑完必关、必删临时 profile。
 * @param {(cdp:CDP)=>Promise<any>} fn
 * @param {{port?:number, mobile?:{width:number,height:number}}} opts
 */
export async function withBrowser(fn, { port = 9336, mobile } = {}) {
  const CHROME = findChrome()
  const userDataDir = path.join(os.tmpdir(), 'cdp-' + Date.now())
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + port,
      '--remote-allow-origins=*', // 必须：否则 WS 握手 403
      '--user-data-dir=' + userDataDir, // 必须：临时隔离，用完删
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  )
  let ws = null
  try {
    const ver = await waitJson(`http://127.0.0.1:${port}/json/version`)
    console.log('Chrome:', ver.Browser)
    // 新版 Chrome 要求 PUT
    const tgt = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json())
    ws = new WebSocket(tgt.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', rej)
    })
    const cdp = new CDP(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    if (mobile) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: mobile.width,
        height: mobile.height,
        deviceScaleFactor: 2,
        mobile: true,
      })
    }
    return await fn(cdp)
  } finally {
    try { if (ws) ws.close() } catch {}
    try { child.kill() } catch {} // 异常路径也要 kill，否则留一堆 chrome
    await sleep(500)
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  }
}

/**
 * 注入页面内的通用工具函数（`window.__h`）。
 * ⚠️ 判可见性不要用 `offsetParent === null`：规范规定 position:fixed 元素的 offsetParent 就是 null，
 *    会把抽屉 / 弹窗 / Modal / Toast 全部误判成「不可见」而点不到。
 */
export const PAGE_HELPERS = `
window.__h = {
  vis(e) {
    if (!e) return false;
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  },
  text() { return document.body.innerText; },
  btn(t) { return [...document.querySelectorAll('button')].filter(e => window.__h.vis(e)).find(b => b.textContent.trim() === t) || null; },
  click(t) { const b = window.__h.btn(t); if (!b) return 'NOT_FOUND'; b.click(); return 'CLICKED'; },
  rows() { return [...document.querySelectorAll('tbody tr')].filter(e => window.__h.vis(e)).map(r => r.innerText.replace(/\\n/g, ' | ')); },
  rowBtn(rowText, btnText) {
    const rows = [...document.querySelectorAll('tbody tr')].filter(e => window.__h.vis(e));
    const row = rows.find(r => r.textContent.includes(rowText));
    if (!row) return 'ROW_NOT_FOUND';
    const b = [...row.querySelectorAll('button')].find(x => x.textContent.trim().includes(btnText));
    if (!b) return 'BTN_NOT_FOUND';
    b.click();
    return 'CLICKED';
  },
  fill(idx, val) {
    const inputs = [...document.querySelectorAll('.el-dialog input')].filter(e => window.__h.vis(e));
    const el = inputs[idx];
    if (!el) return 'INPUT_NOT_FOUND';
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'FILLED';
  },
  cardTitles() { return [...document.querySelectorAll('.el-card__header')].map(e => e.innerText.trim()); },
  closeMsgBoxConfirm() {
    const btns = [...document.querySelectorAll('.el-message-box button')].filter(e => window.__h.vis(e));
    const ok = btns.find(b => b.textContent.trim() === '确定');
    if (!ok) return 'CONFIRM_NOT_FOUND';
    ok.click();
    return 'CONFIRMED';
  },
  overflow() {
    const de = document.documentElement;
    return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, overflow: de.scrollWidth > de.clientWidth + 1 };
  },
};
'ok';
`

/** 断言收集器：统一打印 + 汇总 + 非 0 退出 */
export function checks() {
  const list = []
  return {
    list,
    check(name, pass, detail) {
      list.push({ name, pass, detail })
      console.log((pass ? '  OK   ' : '  FAIL ') + name + (detail ? '  → ' + detail : ''))
      return pass
    },
    finish() {
      const pass = list.filter((c) => c.pass).length
      console.log(`\n通过 ${pass} / ${list.length}`)
      if (list.some((c) => !c.pass)) process.exitCode = 1
      return pass === list.length
    },
  }
}

/**
 * 现场注册一个临时账号拿 token（**不读也不写死任何既有凭据**）。
 * 直接把 password 生成成随机值，避免脚本里出现任何看起来像凭据的常量。
 */
export async function tempPlatformToken(base, prefix = 'ui') {
  const crypto = await import('node:crypto')
  const username = `${prefix}_${crypto.randomBytes(4).toString('hex')}`
  const password = crypto.randomUUID() + 'Aa1!'
  const post = (p) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
  const reg = await post('/api/auth/register')
  if (reg.ok) {
    const d = await reg.json()
    if (d.token) return { token: d.token, username }
  }
  const lo = await post('/api/auth/login')
  const d = await lo.json().catch(() => ({}))
  if (!d.token) throw new Error(`注册/登录都没拿到 token：register=${reg.status} login=${lo.status}`)
  console.log(`注册/登录：register=${reg.status} login=${lo.status} token长度=${d.token.length}`)
  return { token: d.token, username }
}

/**
 * 在页面里登录：把 token 写进 localStorage 后**必须整页重载**。
 * 坑：前端的 `session` 往往是模块加载时读一次 localStorage 的 —— 只写不重载，
 *     session 还是空的 → axios 拦截器不带 Authorization → 401 → 拦截器顺手 clearSession()
 *     把刚写进去的 token 抹掉。现象是「token 明明写了却不见了」。
 *     另外 Page.reload 是异步的，紧接着 Page.navigate 会跟重载竞态，所以要等一下。
 */
export async function loginByToken(cdp, base, token, { key = 'atp_token', hash = '' } = {}) {
  await cdp.nav(base)
  await cdp.eval(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(token)}); 'set'`)
  await cdp.send('Page.reload')
  await sleep(1200)
  if (hash) await cdp.nav(base + hash)
}
