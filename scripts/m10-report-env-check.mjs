// M10 证据脚本：跑完闭环之后，从**报告**里读回「这一轮跑在哪个环境」。
//
// 分两层，缺一不可：
//   ① 接口层：`/api/reports/summary` 的 byEnv 分组 + 每条记录里的环境快照；
//   ② 真机层：报告**页面**上真的出现了「按运行环境汇总」这张卡、地址和通过率是对的
//      （只查接口就宣布「界面能看到」，正是这个项目里反复吃过的亏）。
//
// 顺带核对一条快照语义：run 记录里的地址是**执行当时**的地址，不该被后来的编辑改写。
//
// 用法：先 `npm run seed:oa && npm run test:oa`，再 `node scripts/m10-report-env-check.mjs`
// 前提：平台已在 3001 上跑（web/dist 是最新构建）。
// 凭据：现场注册临时账号（密码运行时随机），不读也不写死任何既有凭据。

import { checks, loginByToken, oaBase, PAGE_HELPERS, platformBase, tempPlatformToken, withBrowser } from './lib/cdp.mjs'

// base 一律走 lib/cdp.mjs 的 platformBase() / oaBase()：一处认环境变量，别在各脚本里各写一种
const BASE = platformBase()
const EXPECT_NAME = process.env.OA_ENV_NAME || 'office-oa（本地）'
const EXPECT_BASE = oaBase()

// 找到「按运行环境汇总」那张卡，把它的正文取出来 —— 断言要打在**页面真的渲染出的文字**上
const PAGE_EXTRA = `
window.__h.reportCard = (title) => {
  const cards = [...document.querySelectorAll('.el-card')];
  const hit = cards.find(c => (c.querySelector('.el-card__header') || {}).innerText?.includes(title));
  return hit ? hit.innerText.replace(/\\n/g, ' | ') : '';
};
'ok';
`

const { check, finish } = checks()

async function apiLayer(token) {
  const get = async (p) => {
    const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) throw new Error(`GET ${p} → ${r.status}`)
    return r.json()
  }
  const summary = await get('/api/reports/summary')

  console.log('\n--- 接口层：按运行环境汇总 ---')
  for (const e of summary.byEnv || []) {
    console.log(`  「${e.name}」→ ${e.baseUrl || '(未记录地址)'}  执行 ${e.runs} 次 / 通过率 ${e.passRate}%`)
  }

  const group = (summary.byEnv || []).find((e) => e.name === EXPECT_NAME)
  check(`报告里有「${EXPECT_NAME}」这一组`, !!group, group ? `${group.runs} 次执行` : (summary.byEnv || []).map((e) => e.name).join(' / '))
  check(
    `这一组的地址是执行当时的 ${EXPECT_BASE}`,
    !!group && (group.baseUrl || '').replace(/\/+$/, '') === EXPECT_BASE,
    group ? group.baseUrl : '(无)',
  )
  // 标签里刻意**不写死条数**：套件从 44 → 60 → 84 长过几轮，写死的标签会一直在撒谎，
  // 而断言本身（passRate === 100）跟条数无关。真要报数就把实际值打出来。
  check(
    '这一组全是通过的（闭环没有红条）',
    !!group && group.passRate === 100,
    group ? `执行 ${group.runs} 次 / 通过率 ${group.passRate}%` : '(无)',
  )

  const recent = (summary.recentRuns || []).filter((r) => String(r.caseName || '').startsWith('OA-'))
  check(
    '最近执行明细里的 OA 用例带得出运行环境',
    recent.length > 0 && recent.every((r) => r.env),
    recent.slice(0, 2).map((r) => `${r.caseName}→${r.env ? r.env.name : 'null'}`).join('；'),
  )

  // 快照语义：老记录（M10 之前跑的）没有这三个字段，必须如实显示「未记录」，不能编一个出来
  const unknown = (summary.byEnv || []).find((e) => e.name === '(未记录环境)')
  console.log(`\n  （信息）标为「(未记录环境)」的历史记录：${unknown ? unknown.runs + ' 条' : '无'}`)
  check('老记录归到「(未记录环境)」，没有把缺失编成某个真实环境名', !unknown || unknown.baseUrl === '', unknown ? `baseUrl=「${unknown.baseUrl}」` : '无老记录')
}

async function uiLayer(cdp, token) {
  await loginByToken(cdp, BASE, token, { hash: '/#/reports' })
  await cdp.eval(PAGE_HELPERS)
  await cdp.eval(PAGE_EXTRA)
  try {
    await cdp.waitFor(`window.__h.reportCard('按运行环境汇总').length > 0`, '「按运行环境汇总」卡片渲染出来')
  } catch (e) {
    await cdp.dump('现场快照（报告页没出现那张卡）')
    throw e
  }

  console.log('\n--- 真机层：报告页面 ---')
  const cardTitles = await cdp.eval('window.__h.cardTitles()')
  check('报告页有「按运行环境汇总」这张卡', cardTitles.some((t) => t.includes('按运行环境汇总')), cardTitles.join(' ／ '))

  const cardText = await cdp.eval(`window.__h.reportCard('按运行环境汇总')`)
  check('卡里列出了当前环境名', cardText.includes(EXPECT_NAME), cardText.slice(0, 200))
  check('卡里列出了执行当时的地址', cardText.includes(EXPECT_BASE), cardText.slice(0, 200))
  check('卡里能看到通过率是 100', /\b100\b/.test(cardText), cardText.slice(0, 200))

  const detailText = await cdp.eval(`window.__h.reportCard('最近执行明细')`)
  check('「最近执行明细」表里有环境列且显示得出环境名', detailText.includes(EXPECT_NAME), detailText.slice(0, 220))

  // 正文里也要能一眼看到「这次打的是谁」——报告不再是「只有通过率」的
  const body = await cdp.eval('window.__h.text()')
  check('整页正文里能读到环境名与地址', body.includes(EXPECT_NAME) && body.includes(EXPECT_BASE), `正文长度=${body.length}`)
}

withBrowser(async (cdp) => {
  const { token, username } = await tempPlatformToken(BASE, 'm10chk')
  console.log('临时账号:', username)
  console.log('平台     :', BASE, '\n')
  await apiLayer(token)
  await uiLayer(cdp, token)
}, { port: 9335 })
  .then(() => finish())
  .catch((e) => {
    console.error('脚本异常:', e.message)
    process.exitCode = 2
  })
