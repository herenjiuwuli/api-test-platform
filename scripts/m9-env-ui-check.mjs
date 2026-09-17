// M9 真机验证：环境变量集的界面行为 + **页头环境徽标不会撒谎**
//
// 为什么必须真机跑一遍：M9 开发过程中抓到过一个只有真机才看得见的缺陷 ——
//   徽标画在 App.vue（外壳），切环境发生在 Environments.vue（子页面），
//   最初靠「路由变化时重取」对齐，而**在同一页里切环境根本不引起路由变化**，
//   于是徽标一直显示上一个环境。这个脚本把那条回归钉死：
//   每一次「切环境 / 取消环境 / 删掉当前环境」之后，都必须马上核对页头徽标。
//
// 用法：node scripts/m9-env-ui-check.mjs
// 前提：平台已在 3001 上跑（且 web/dist 是最新构建）、office-oa 已在 3200 上跑。
//
// 凭据：脚本自己**现场注册一个临时账号**（密码运行时随机生成），不去读任何既有密码。
// 副作用：会临时建一个名为「M9 真机验证（临时）」的环境，收尾删掉并把当前环境还原。

import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

const BASE = process.env.PLATFORM_BASE || 'http://127.0.0.1:3001'
const OA = process.env.OA_BASE || 'http://127.0.0.1:3200'
const ENV_NAME = process.env.OA_ENV_NAME || 'office-oa（本地）'
const TEMP_ENV = 'M9 真机验证（临时）'

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function findChrome() {
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

class CDP {
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
}

// 注入页面内的工具函数。判可见性不用 offsetParent（fixed 元素的 offsetParent 就是 null）。
const HELPERS = `
window.__h = {
  vis(e) {
    if (!e) return false;
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  },
  badge() { const e = document.querySelector('.env-tag'); return e ? e.innerText.trim() : '(没有徽标元素)'; },
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
  // el-input 的 v-model 认 input 事件；直接改 .value 不派发事件 Vue 收不到
  fill(idx, val) {
    const inputs = [...document.querySelectorAll('.el-dialog input')].filter(e => window.__h.vis(e));
    const el = inputs[idx];
    if (!el) return 'INPUT_NOT_FOUND';
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'FILLED';
  },
  dialogText() { const d = document.querySelector('.el-dialog'); return d ? d.innerText.replace(/\\n/g, ' | ') : ''; },
  closeMsgBoxConfirm() {
    const btns = [...document.querySelectorAll('.el-message-box button')].filter(e => window.__h.vis(e));
    const ok = btns.find(b => b.textContent.trim() === '确定');
    if (!ok) return 'CONFIRM_NOT_FOUND';
    ok.click();
    return 'CONFIRMED';
  },
};
'ok';
`

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log((pass ? '  OK   ' : '  FAIL ') + name + (detail ? '  → ' + detail : ''))
  return pass
}

// ---------------------------------------------------------------------------
// 拿一个临时账号的 token（现场注册，密码运行时随机 —— 不读也不写死任何既有凭据）
// ---------------------------------------------------------------------------
async function tempToken() {
  const username = 'm9ui_' + crypto.randomBytes(4).toString('hex')
  const password = crypto.randomUUID() + 'Aa1!'
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (reg.ok) {
    const data = await reg.json()
    if (data.token) return { token: data.token, username }
  }
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const data = await login.json().catch(() => ({}))
  if (!login.ok) {
    throw new Error(`注册/登录都失败：register=${reg.status} login=${login.status} body=${JSON.stringify(data).slice(0, 200)}`)
  }
  // 只打状态码和长度，不打 token 本身
  console.log(`注册/登录：register=${reg.status} login=${login.status} token长度=${(data.token || '').length}`)
  if (!data.token) throw new Error(`登录成功但响应里没有 token：${JSON.stringify(data).slice(0, 200)}`)
  return { token: data.token, username }
}

async function withBrowser(fn) {
  const CHROME = findChrome()
  const PORT = 9334
  const userDataDir = path.join(os.tmpdir(), 'cdp-m9-' + Date.now())
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--remote-allow-origins=*',
      '--user-data-dir=' + userDataDir,
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
    const ver = await waitJson(`http://127.0.0.1:${PORT}/json/version`)
    console.log('Chrome:', ver.Browser)
    const tgt = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json())
    ws = new WebSocket(tgt.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', rej)
    })
    const cdp = new CDP(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    return await fn(cdp)
  } finally {
    try { if (ws) ws.close() } catch {}
    try { child.kill() } catch {}
    await sleep(500)
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  }
}

async function audit(cdp) {
  const { token, username } = await tempToken()
  console.log('临时账号:', username)
  console.log('平台     :', BASE)
  console.log('目标环境 :', ENV_NAME, '→', OA, '\n')

  // ① 先开一次页面把 token 写进 localStorage，**然后必须整页重载**。
  //    坑：auth.js 的 `session.token` 是**模块加载时**从 localStorage 读一次的。
  //    只写 localStorage 不重载 → 整页不重建 → session.token 还是空的 → axios 拦截器
  //    不带 Authorization → 401 → 拦截器再调 clearSession() 把刚写进去的 token 抹掉并跳登录页。
  //    现象是「明明写了 token，却停在 /#/login 且 token 不见了」。
  await cdp.nav(BASE)
  await cdp.eval(`localStorage.setItem('atp_token', ${JSON.stringify(token)}); 'set'`)
  await cdp.send('Page.reload')
  await sleep(1200)
  // 自检：在页面里拿 token 直接打一次 /api/auth/me，判断「token 本身不认」还是「应用把它清了」
  const selfCheck = await cdp.eval(`(async () => {
    const t = localStorage.getItem('atp_token');
    const r = await fetch('/api/auth/me', { headers: t ? { Authorization: 'Bearer ' + t } : {} });
    return { hasToken: !!t, len: t ? t.length : 0, meStatus: r.status, body: (await r.text()).slice(0, 120) };
  })()`)
  console.log('  本地自检：', JSON.stringify(selfCheck))
  await cdp.nav(BASE + '/#/environments')
  await cdp.eval(HELPERS)
  try {
    await cdp.waitFor(`window.__h.rows().length > 0`, '环境列表加载完成')
  } catch (e) {
    // 失败时先把现场打出来 —— 只报一句「超时」是没法排障的
    console.error('\n--- 现场快照 ---')
    console.error('location :', await cdp.eval('location.href'))
    console.error('token 在? :', await cdp.eval(`!!localStorage.getItem('atp_token')`))
    console.error('徽标     :', await cdp.eval('window.__h.badge()'))
    console.error('行数     :', await cdp.eval('document.querySelectorAll("tbody tr").length'))
    console.error('正文     :', (await cdp.eval('document.body.innerText')).slice(0, 500).replace(/\n/g, ' | '))
    throw e
  }

  const rows0 = await cdp.eval('window.__h.rows()')
  check('环境列表能渲染出至少一条环境', rows0.length > 0, rows0.join(' ／ '))
  check(
    `列表里有「${ENV_NAME}」且标记为「使用中」`,
    rows0.some((r) => r.includes(ENV_NAME) && r.includes('使用中')),
    rows0.join(' ／ '),
  )

  // ② 页头徽标：初始应当显示当前环境名
  const badge0 = await cdp.eval('window.__h.badge()')
  check('页头徽标显示当前环境名', badge0.includes(ENV_NAME), `徽标=「${badge0}」`)

  // ③ ★ 回归断言：在同一页里点「取消当前环境」，徽标必须**马上**变（当年就是这里撒谎）
  await cdp.eval('window.__h.click("取消当前环境")')
  await cdp.waitFor(`window.__h.badge().includes('未选环境')`, '徽标变成「未选环境」')
  const badge1 = await cdp.eval('window.__h.badge()')
  check('★ 点「取消当前环境」后徽标立刻变成「未选环境」（不靠路由变化）', badge1.includes('未选环境'), `徽标=「${badge1}」`)

  // 页面内的提示也要跟着变（局部状态与共享状态一致）
  const hint1 = await cdp.eval(`document.querySelector('.no-active-hint') ? 'HAS_WARN' : 'NO_WARN'`)
  check('页内出现「当前没有选中环境」的提示', hint1 === 'HAS_WARN', hint1)

  // ④ 同一页里点「设为当前」，徽标必须变回去
  await cdp.eval(`window.__h.rowBtn(${JSON.stringify(ENV_NAME)}, "设为当前")`)
  await cdp.waitFor(`window.__h.badge().includes(${JSON.stringify(ENV_NAME)})`, '徽标恢复环境名')
  const badge2 = await cdp.eval('window.__h.badge()')
  check('★ 点同一行「设为当前」后徽标恢复（同一页内切换）', badge2.includes(ENV_NAME), `徽标=「${badge2}」`)

  // ⑤ 新建一个环境 → 设为当前 → 徽标跟着换
  await cdp.eval('window.__h.click("+ 新建环境")')
  await cdp.waitFor(`!!document.querySelector('.el-dialog')`, '新建弹窗出现')
  await cdp.eval(`window.__h.fill(0, ${JSON.stringify(TEMP_ENV)})`)
  await cdp.eval('window.__h.fill(1, "http://127.0.0.1:9999")')
  await cdp.eval('window.__h.click("保存")')
  await cdp.waitFor(`window.__h.rows().some(r => r.includes(${JSON.stringify(TEMP_ENV)}))`, '新环境出现在列表')
  const rows1 = await cdp.eval('window.__h.rows()')
  check('新建环境后列表里能看到它', rows1.some((r) => r.includes(TEMP_ENV)), rows1.join(' ／ '))

  await cdp.eval(`window.__h.rowBtn(${JSON.stringify(TEMP_ENV)}, "设为当前")`)
  await cdp.waitFor(`window.__h.badge().includes(${JSON.stringify(TEMP_ENV)})`, '徽标切到临时环境')
  const badge3 = await cdp.eval('window.__h.badge()')
  check('★ 切到新环境后徽标显示新环境名', badge3.includes(TEMP_ENV), `徽标=「${badge3}」`)

  // ⑥ 删掉「正在使用中」的环境：弹窗确认 → 当前环境被清空，徽标回落
  await cdp.eval(`window.__h.rowBtn(${JSON.stringify(TEMP_ENV)}, "删除")`)
  await cdp.waitFor(`!!document.querySelector('.el-message-box')`, '删除确认框出现')
  const boxText = await cdp.eval(`document.querySelector('.el-message-box').innerText.replace(/\\n/g,' | ')`)
  check('删当前环境时，确认框明说「当前环境会被清空」', boxText.includes('当前环境'), boxText)
  await cdp.eval('window.__h.closeMsgBoxConfirm()')
  await cdp.waitFor(`window.__h.badge().includes('未选环境')`, '徽标回落为「未选环境」')
  const rows2 = await cdp.eval('window.__h.rows()')
  check('★ 删掉当前环境后：列表里没有它，且徽标回落为「未选环境」', !rows2.some((r) => r.includes(TEMP_ENV)), rows2.join(' ／ '))

  // ⑦ 收尾：把当前环境还原成 OA 那个（保证跑完之后 test:oa 依然 44/44）
  await cdp.eval(`window.__h.rowBtn(${JSON.stringify(ENV_NAME)}, "设为当前")`)
  await cdp.waitFor(`window.__h.badge().includes(${JSON.stringify(ENV_NAME)})`, '环境已还原')
  const badge4 = await cdp.eval('window.__h.badge()')
  check('收尾：当前环境已还原为「' + ENV_NAME + '」', badge4.includes(ENV_NAME), `徽标=「${badge4}」`)

  // ⑧ 收尾核对「没有留下副作用」：用接口直接对一次状态
  const after = await fetch(`${BASE}/api/environments`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json())
  const names = (after.items || []).map((e) => e.name)
  const active = (after.items || []).find((e) => e.id === after.activeId)
  check('收尾：临时环境已删除，列表只剩原本那个', !names.includes(TEMP_ENV), names.join(' ／ '))
  check('收尾：当前环境 = ' + ENV_NAME, active && active.name === ENV_NAME, active ? active.baseUrl : '(无)')
}

withBrowser(audit)
  .then(() => {
    const pass = checks.filter((c) => c.pass).length
    console.log(`\n通过 ${pass} / ${checks.length}`)
    if (checks.some((c) => !c.pass)) process.exitCode = 1
  })
  .catch((e) => {
    console.error('脚本异常:', e.message)
    process.exitCode = 2
  })
