// M11 真机验证：套件导出 / 导入。
//
// 分两层（只查接口就宣布「界面能看到」是反复吃过的亏）：
//   接口层 —— 导出 JSON 的形状、脱敏对不对、三种冲突策略、坏文件 400；
//   真机层 —— 用例页真有按钮、弹窗真能开、选了文件真有预览、点「开始导入」结果区真的出现。
//
// ⚠️ 收尾必须不留副作用：真机导入会**真的写库**（用例 + 环境），
//    所以脚本末尾按本次唯一后缀把造出来的东西全删掉。
//
// 跑法：node scripts/m11-suite-ui-check.mjs   （需要平台在 3001 跑着）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withBrowser, checks, PAGE_HELPERS, platformBase, sleep, tempPlatformToken, loginByToken } from './lib/cdp.mjs'

// base 一律走 lib/cdp.mjs 的 platformBase()：一处认环境变量，别在各脚本里各写一种
const BASE = platformBase()
const STAMP = Date.now().toString(36)
const c = checks()

// 只打印状态码 / 长度，不打 token 本身（否则会被敏感信息审批拦下）
const { token } = await tempPlatformToken(BASE, 'm11')

// 本脚本占用 `M11UI-` 这个命名前缀；收尾按前缀清场，不会碰到主人的真实数据
const OWN_PREFIX = 'M11UI-'

const j = async (p, opt = {}) => {
  const headers = { Authorization: 'Bearer ' + token, ...(opt.headers || {}) }
  // ⚠️ 只在**真的有 body** 时才带 Content-Type：
  //    Fastify 收到「Content-Type: application/json 但 body 为空」的请求会直接 400
  //    （FST_ERR_CTP_EMPTY_JSON_BODY），于是 DELETE 全部静默失败 —— 收尾清理就是这么漏掉的。
  if (opt.body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(BASE + p, { ...opt, headers })
  const text = await r.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: r.status, body, text }
}

// ---------------------------------------------------------------------------
// 接口层
// ---------------------------------------------------------------------------

const envName = `M11UI-环境-${STAMP}`
const caseName = `M11UI-用例-${STAMP}`

const created = await j('/api/environments', {
  method: 'POST',
  body: JSON.stringify({
    name: envName,
    baseUrl: 'http://127.0.0.1:9',
    headers: { Authorization: 'Bearer literal-secret-AAA', 'X-Env': 'gray' },
    vars: {},
  }),
})
c.check(
  '准备数据：临时环境建好了',
  created.status === 201,
  `status=${created.status} ${created.body?.error || ''}`,
)

const createdCase = await j('/api/cases', {
  method: 'POST',
  body: JSON.stringify({
    name: caseName,
    method: 'GET',
    url: '{{base}}/x',
    headers: { 'X-Token': '{{token}}' },
    expected: { status: 200 },
  }),
})
c.check('准备数据：临时用例建好了', createdCase.status === 201, `status=${createdCase.status}`)

const exp = await j('/api/suite/export')
const suiteEnv = exp.body?.environments?.find((e) => e.name === envName)
const suiteCase = exp.body?.cases?.find((x) => x.name === caseName)

c.check(
  'GET /api/suite/export 返回 200 且是套件格式（带 kind/version）',
  exp.status === 200 && exp.body?.kind === 'api-test-platform-suite' && exp.body?.version === 1,
  `status=${exp.status} kind=${exp.body?.kind} v=${exp.body?.version}`,
)

c.check(
  '★ 导出文件里搜不到字面凭据（Authorization 值被抹成空串）',
  suiteEnv?.headers?.Authorization === '' && !exp.text.includes('literal-secret-AAA'),
  `Authorization="${suiteEnv?.headers?.Authorization}" 全文含凭据=${exp.text.includes('literal-secret-AAA')}`,
)

c.check(
  '★ 值是 {{token}} 的敏感头原样保留（它是变量引用，不是藏在文件里的凭据）',
  suiteCase?.headers?.['X-Token'] === '{{token}}',
  `X-Token="${suiteCase?.headers?.['X-Token']}"`,
)

c.check(
  '脱敏的头在文件里有名有姓（redactedHeaders），使用者知道该补什么',
  Array.isArray(suiteEnv?.redactedHeaders) && suiteEnv.redactedHeaders.includes('Authorization'),
  JSON.stringify(suiteEnv?.redactedHeaders),
)

c.check(
  '非敏感头照常导出（否则导入后环境就不完整了）',
  suiteEnv?.headers?.['X-Env'] === 'gray',
  `X-Env="${suiteEnv?.headers?.['X-Env']}"`,
)

// ⚠️ 导入测试**只能用本次造的那几条**组成的子集：
//    拿全量导出的套件去跑 rename，会把库里 44 条 OA 用例整份复制一遍，
//    而收尾按 STAMP 清理又删不掉这些副本 —— 直接污染主人的库。
const miniSuite = {
  kind: 'api-test-platform-suite',
  version: 1,
  exportedAt: new Date().toISOString(),
  environments: [suiteEnv],
  cases: [suiteCase],
}
const miniText = JSON.stringify(miniSuite)

// 三种冲突策略
const impRename = await j('/api/suite/import?onConflict=rename', { method: 'POST', body: miniText })
c.check(
  '导入 rename：重名不覆盖也不丢，新增副本',
  impRename.status === 201 && impRename.body?.renamed === 2,
  `status=${impRename.status} created=${impRename.body?.created} renamed=${impRename.body?.renamed}`,
)

c.check(
  '导入时把脱敏留下的空凭据头丢掉，并给出一条可读的 warning',
  (impRename.body?.warnings || []).some((w) => w.includes('Authorization')),
  (impRename.body?.warnings || []).join(' | ') || '(没有 warning)',
)

const impSkip = await j('/api/suite/import?onConflict=skip', { method: 'POST', body: miniText })
c.check(
  '导入 skip：一条都没动',
  impSkip.status === 201 && impSkip.body?.created === 0 && impSkip.body?.skipped === 2,
  `created=${impSkip.body?.created} skipped=${impSkip.body?.skipped}`,
)

const impBad = await j('/api/suite/import', { method: 'POST', body: JSON.stringify({ hello: 'world' }) })
c.check(
  '拿错文件导入 → 400 且带可读原因（不是 500，也不是静默成功）',
  impBad.status === 400 && typeof impBad.body?.error === 'string',
  `status=${impBad.status} error=${impBad.body?.error}`,
)

// ---------------------------------------------------------------------------
// 真机层
// ---------------------------------------------------------------------------

// 写一个「只有 1 条用例 + 1 个环境」的最小套件到临时文件，供真机弹窗选择
const mini = {
  kind: 'api-test-platform-suite',
  version: 1,
  exportedAt: new Date().toISOString(),
  environments: [{ name: `M11UI-真机环境-${STAMP}`, baseUrl: 'http://127.0.0.1:9', headers: {}, vars: {} }],
  cases: [{ name: `M11UI-真机用例-${STAMP}`, method: 'GET', url: '{{base}}/x', headers: {}, expected: { status: 200 } }],
}
const miniPath = path.join(os.tmpdir(), `m11-suite-${STAMP}.json`)
fs.writeFileSync(miniPath, JSON.stringify(mini, null, 2), 'utf8')
const wrongPath = path.join(os.tmpdir(), `m11-wrong-${STAMP}.json`)
fs.writeFileSync(wrongPath, JSON.stringify({ hello: 'world' }), 'utf8')

await withBrowser(async (cdp) => {
  await loginByToken(cdp, BASE, token)
  // ⚠️ 用例列表的路由是 `/`（不是 `/cases`）—— 这个平台上 `/cases/new` 和 `/cases/:id/edit`
  //    是编辑器，列表页就是根路径。走错路径 router-view 会是空的，现象是「页面正常但按钮全无」。
  await cdp.nav(BASE + '/#/', `document.querySelector('.toolbar') !== null`)
  await cdp.eval(PAGE_HELPERS)
  await sleep(400)

  const btnTexts = await cdp.eval('[...document.querySelectorAll("button")].map(b=>b.textContent.trim())')
  const hasBtns = btnTexts.includes('导出套件') && btnTexts.includes('导入套件')
  if (!hasBtns) {
    // 只在失败时打现场：能看出「停在哪一页 / 加载的是哪份产物」，否则只剩一句「按钮没找到」。
    // （这条诊断是有来历的：第一次跑时按钮全无，真因是路由写成了 /#/cases —— 列表页其实是 /。）
    const scene = await cdp.eval(
      `JSON.stringify({href: location.href, scripts: [...document.querySelectorAll('script[src]')].map(s=>s.getAttribute('src')), buttons: [...document.querySelectorAll('button')].map(b=>b.textContent.trim()).slice(0,12)})`,
    )
    console.error('  现场:', scene)
  }
  c.check(
    '用例页上有「导出套件」「导入套件」两个按钮',
    hasBtns,
    btnTexts.filter((t) => t.includes('套件')).join(' / ') || `一个都没找到（按钮共 ${btnTexts.length} 个）`,
  )

  const opened = await cdp.eval('window.__h.click("导入套件")')
  await cdp.waitFor('document.querySelector(".el-dialog")', '导入弹窗出现')
  await sleep(400)
  const dlgText = await cdp.eval('document.querySelector(".el-dialog").innerText')
  c.check(
    '点「导入套件」弹出弹窗，里面能读到「选择套件文件」的入口',
    opened === 'CLICKED' && dlgText.includes('选择套件文件'),
    dlgText.split('\n').slice(0, 3).join(' | '),
  )

  // 先塞一个错文件：应当当场给出可读提示，而不是等点了导入才报 400
  await cdp.send('DOM.enable')
  const pick = async (file) => {
    // 每次都重新取一次 document —— el-dialog 是懒渲染的，弹窗内容一变，旧的 nodeId 就失效了
    const d = await cdp.send('DOM.getDocument', { depth: -1 })
    const q = await cdp.send('DOM.querySelector', { nodeId: d.root.nodeId, selector: 'input[type=file]' })
    if (!q.nodeId) throw new Error('弹窗里没找到 input[type=file]')
    await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: q.nodeId })
    await sleep(700)
  }
  await pick(wrongPath.replace(/\\/g, '/'))
  const afterWrong = await cdp.eval('document.querySelector(".el-dialog").innerText')
  c.check(
    '选到不是本平台的文件 → 弹窗里当场提示（不用等点导入）',
    afterWrong.includes('不像本平台') || afterWrong.includes('kind'),
    afterWrong.split('\n').filter((l) => l.includes('不是') || l.includes('不像')).join(' | ') || '(没提示)',
  )

  // 再塞正确的套件：应当出现「N 条用例 / M 个环境」的预览
  await pick(miniPath.replace(/\\/g, '/'))
  const afterRight = await cdp.eval('document.querySelector(".el-dialog").innerText')
  c.check(
    '★ 选到真套件 → 弹窗里出现「1 条用例、1 个环境」的预览与导出时间',
    afterRight.includes('1 条用例') && afterRight.includes('1 个环境'),
    afterRight.split('\n').filter((l) => l.includes('用例') || l.includes('环境')).slice(0, 2).join(' | '),
  )

  const strategies = await cdp.eval(
    '[...document.querySelectorAll(".el-dialog .el-radio")].map(e=>e.innerText.trim())',
  )
  c.check(
    '三种冲突策略都能选（两个都留 / 覆盖 / 不动）',
    strategies.length === 3,
    strategies.join(' ｜ '),
  )

  await cdp.eval('window.__h.click("开始导入")')
  await cdp.waitFor('document.querySelector(".el-dialog").innerText.includes("导入完成")', '导入结果出现')
  const resultText = await cdp.eval('document.querySelector(".el-dialog").innerText')
  c.check(
    '★ 点「开始导入」→ 弹窗里真的读出「导入完成：新增 … · 更新 … · 跳过 …」',
    /导入完成：新增 \d+/.test(resultText),
    resultText.split('\n').find((l) => l.startsWith('导入完成')) || '(没读到)',
  )

  // 导入真的写进了库吗？回列表页确认新增条目可见
  await cdp.eval('window.__h.click("关闭")')
  await sleep(400)
  const listText = await cdp.eval('document.body.innerText')
  c.check(
    '导入后列表页能看到新进来的用例',
    listText.includes(`M11UI-真机用例-${STAMP}`),
    listText.includes(`M11UI-真机用例-${STAMP}`) ? '在列表里' : '列表里没有',
  )
}, { port: 9338 })

// ---------------------------------------------------------------------------
// 收尾：把本次污染删干净（一条都不留）
// ---------------------------------------------------------------------------

const allCases = (await j('/api/cases')).body || []
const allEnvs = (await j('/api/environments')).body?.items || []
// 按前缀（而不是 STAMP）清场：上一次跑到一半失败时留下的残骸也一并收掉，
// 否则「测试脚本自己脏了库」会一直被忽略。M11UI- 是脚本专属命名空间。
const mineCases = allCases.filter((x) => String(x.name).includes(OWN_PREFIX))
const mineEnvs = allEnvs.filter((x) => String(x.name).includes(OWN_PREFIX))
for (const x of mineCases) await j(`/api/cases/${x.id}`, { method: 'DELETE' })
for (const x of mineEnvs) await j(`/api/environments/${x.id}`, { method: 'DELETE' })

const leftCases = ((await j('/api/cases')).body || []).filter((x) => String(x.name).includes(OWN_PREFIX))
const leftEnvs = ((await j('/api/environments')).body?.items || []).filter((x) =>
  String(x.name).includes(OWN_PREFIX),
)
c.check(
  '收尾不留副作用：本次造的用例与环境全部删净',
  leftCases.length === 0 && leftEnvs.length === 0,
  `清理了 ${mineCases.length} 条用例 / ${mineEnvs.length} 个环境，剩 ${leftCases.length}/${leftEnvs.length}`,
)

try {
  fs.rmSync(miniPath, { force: true })
  fs.rmSync(wrongPath, { force: true })
} catch {}

c.finish()
