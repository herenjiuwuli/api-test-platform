// 真机验证：环境变量集的界面行为 + **页头环境徽标不会撒谎**
//
// 为什么必须真机跑一遍：M9 开发过程中抓到一个只有真机才看得见的缺陷 ——
//   徽标画在 App.vue（外壳），切环境发生在 Environments.vue（子页面），
//   最初靠「路由变化时重取」对齐，而**在同一页里切环境根本不引起路由变化**，
//   于是徽标一直显示上一个环境。这个脚本把那条回归钉死：
//   每一次「切环境 / 取消环境 / 删掉当前环境」之后，都必须马上核对页头徽标。
//
// 用法：node scripts/m9-env-ui-check.mjs
// 前提：平台已在 3001 上跑（且 web/dist 是最新构建）、office-oa 已在 3200 上跑。
//
// 凭据：现场注册临时账号（密码运行时随机生成），不读也不写死任何既有凭据。
// 副作用：会临时建一个名为「M9 真机验证（临时）」的环境，收尾删掉并把当前环境还原。

import { checks, loginByToken, oaBase, PAGE_HELPERS, platformBase, tempPlatformToken, withBrowser } from './lib/cdp.mjs'

// base 一律走 lib/cdp.mjs 的 platformBase() / oaBase()：一处认环境变量，别在各脚本里各写一种
const BASE = platformBase()
const OA = oaBase()
const ENV_NAME = process.env.OA_ENV_NAME || 'office-oa（本地）'
const TEMP_ENV = 'M9 真机验证（临时）'

// 本页专属的两条页面内查询（通用工具在 PAGE_HELPERS 里）
const PAGE_EXTRA = `
window.__h.badge = () => { const e = document.querySelector('.env-tag'); return e ? e.innerText.trim() : '(没有徽标元素)'; };
window.__h.hasNoActiveHint = () => !!document.querySelector('.no-active-hint');
'ok';
`

const { check, finish } = checks()

async function audit(cdp) {
  const { token, username } = await tempPlatformToken(BASE, 'm9ui')
  console.log('临时账号:', username)
  console.log('平台     :', BASE)
  console.log('目标环境 :', ENV_NAME, '→', OA, '\n')

  await loginByToken(cdp, BASE, token, { hash: '/#/environments' })
  await cdp.eval(PAGE_HELPERS)
  await cdp.eval(PAGE_EXTRA)
  try {
    await cdp.waitFor(`window.__h.rows().length > 0`, '环境列表加载完成')
  } catch (e) {
    await cdp.dump('现场快照（环境列表没渲染出来）')
    console.error('token 在? :', await cdp.eval(`!!localStorage.getItem('atp_token')`))
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

  const hasHint = await cdp.eval('window.__h.hasNoActiveHint()')
  check('页内出现「当前没有选中环境」的提示', hasHint === true, String(hasHint))

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
  check(`收尾：当前环境已还原为「${ENV_NAME}」`, badge4.includes(ENV_NAME), `徽标=「${badge4}」`)

  // ⑧ 收尾核对「没有留下副作用」：用接口直接对一次状态
  const after = await fetch(`${BASE}/api/environments`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json())
  const names = (after.items || []).map((e) => e.name)
  const active = (after.items || []).find((e) => e.id === after.activeId)
  check('收尾：临时环境已删除，列表只剩原本那个', !names.includes(TEMP_ENV), names.join(' ／ '))
  check(`收尾：当前环境 = ${ENV_NAME}`, active && active.name === ENV_NAME, active ? active.baseUrl : '(无)')
}

withBrowser(audit, { port: 9334 })
  .then(() => finish())
  .catch((e) => {
    console.error('脚本异常:', e.message)
    process.exitCode = 2
  })
