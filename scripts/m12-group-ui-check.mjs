// M12 真机验证：用例分组（group）。
//
// 分两层（只查接口就宣布「界面能看到」是反复吃过的亏）：
//   接口层 —— group 的写 / 读 / 筛选 / 报告聚合 / 套件往返，外加 run-all 的按组过滤；
//   真机层 —— 列表真有「分组」列与筛选下拉、选中分组后列表真的只剩那一组、
//            「运行该分组」真的只跑这一组、报告页出现「按业务分组汇总」、编辑器有「分组」输入框。
//
// ⚠️ 收尾必须不留副作用：为了验证「运行该分组」这条 UI → API 链路，本脚本会**真的跑一次**自己的临时用例；
//    而平台的 deleteCase **不级联删 runs**、也没有「删执行记录」的接口 —— 只删用例的话，
//    报告里会永远留着一个指向已删除用例的 `用例#id` 和一个「(未分组)」计数。
//    所以收尾走一步「直连 SQLite 删掉这几条执行记录」（seed 脚本同样直接读写库，是既有做法）。
//
// 跑法：node scripts/m12-group-ui-check.mjs   （需要平台在 3001 跑着）
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withBrowser, checks, PAGE_HELPERS, sleep, tempPlatformToken, loginByToken } from './lib/cdp.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://127.0.0.1:3001'
const STAMP = Date.now().toString(36)
const c = checks()

// 只打印状态码 / 长度，不打 token 本身（否则会被敏感信息审批拦下）
const { token } = await tempPlatformToken(BASE, 'm12')

// 本脚本占用 `M12UI-` 这个命名前缀；收尾按前缀清场，不会碰到主人的真实数据
const OWN_PREFIX = 'M12UI-'
const GROUP_A = `M12UI组-${STAMP}`
const GROUP_B = `M12UI组B-${STAMP}`
const NO_SUCH_GROUP = `M12UI查无此组-${STAMP}`

const j = async (p, opt = {}) => {
  const headers = { Authorization: 'Bearer ' + token, ...(opt.headers || {}) }
  // ⚠️ 只在**真的有 body** 时才带 Content-Type：Fastify 收到「声明 JSON 但 body 为空」会直接 400
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

const caseName = `${OWN_PREFIX}用例-${STAMP}`

const created = await j('/api/cases', {
  method: 'POST',
  body: JSON.stringify({
    name: caseName,
    method: 'GET',
    url: '{{base}}/health', // 打当前环境自己的 /health：离线、瞬时、必过 —— 只验证「跑的是哪一组」
    group: GROUP_A,
    expected: { status: 200 },
  }),
})
const caseId = created.body?.id
c.check('createCase 收 group 并落库', created.status === 201 && created.body?.group === GROUP_A, `status=${created.status} group=${created.body?.group}`)

const got = await j(`/api/cases/${caseId}`)
c.check('normalize 把 group 带回来（列表/详情都读得到）', got.body?.group === GROUP_A, `group=${got.body?.group}`)

const filtered = await j(`/api/cases?group=${encodeURIComponent(GROUP_A)}`)
c.check(
  'GET /api/cases?group= 只返回该组（服务器端过滤）',
  filtered.status === 200 && Array.isArray(filtered.body) && filtered.body.length === 1 && filtered.body[0].id === caseId,
  `返回 ${filtered.body?.length} 条`,
)

const noHit = await j(`/api/cases?group=${encodeURIComponent(NO_SUCH_GROUP)}`)
c.check('查一个不存在的分组 → 0 条（不是把全部返回回来）', noHit.status === 200 && noHit.body?.length === 0, `返回 ${noHit.body?.length} 条`)

const upd = await j(`/api/cases/${caseId}`, { method: 'PUT', body: JSON.stringify({ group: GROUP_B }) })
c.check('updateCase 能改 group（部分更新）', upd.status === 200 && upd.body?.group === GROUP_B, `group=${upd.body?.group}`)
// 改回来，后面真机用 GROUP_A
await j(`/api/cases/${caseId}`, { method: 'PUT', body: JSON.stringify({ group: GROUP_A }) })

// ★ 负向对照：run-all 传一个查无此组的分组，必须「一条都不跑」。
//   如果 group 过滤被忽略（比如参数名写错），这里会跑库里全部用例（几十条），
//   total 立刻从 0 变成几十 —— 这条断言就是用来钉住「过滤真的生效」的。
const runNone = await j('/api/run-all', { method: 'POST', body: JSON.stringify({ group: NO_SUCH_GROUP }) })
c.check(
  '★ run-all 传查无此组 → total 0（过滤真的生效，而不是把全部跑一遍）',
  runNone.status === 200 && runNone.body?.total === 0 && runNone.body?.filter === NO_SUCH_GROUP,
  `total=${runNone.body?.total} filter=${runNone.body?.filter}`,
)
c.check('空结果也说得清「用的哪个环境」（env 快照不因空结果缺席）', !!runNone.body?.env?.name, `env=${runNone.body?.env?.name || '(无)'}`)

const summary = await j('/api/reports/summary')
c.check('报告接口有 byGroup（与 byEnv 同一个聚合套路）', Array.isArray(summary.body?.byGroup), `byGroup 长度=${summary.body?.byGroup?.length}`)

// 套件往返：导出带 group，导入写回 group
const exp = await j('/api/suite/export')
const suiteCase = exp.body?.cases?.find((x) => x.name === caseName)
c.check('导出套件时带上 group（资产带走不丢结构）', suiteCase?.group === GROUP_A, `group=${suiteCase?.group}`)

const miniText = JSON.stringify({
  kind: 'api-test-platform-suite',
  version: 1,
  exportedAt: new Date().toISOString(),
  environments: [],
  cases: [suiteCase], // ⚠️ 只用本次造的这一条：拿全量套件去 rename 会把 52 条 OA 用例整份复制一遍
})
const imp = await j('/api/suite/import?onConflict=rename', { method: 'POST', body: miniText })
const allAfterImport = (await j('/api/cases')).body || []
const importedCopy = allAfterImport.find((x) => String(x.name).startsWith(caseName) && x.id !== caseId)
c.check(
  '导入 rename 出来的副本保留原分组',
  imp.status === 201 && importedCopy?.group === GROUP_A,
  `status=${imp.status} 副本 group=${importedCopy?.group}`,
)

// 真机断言要用的「这组到底有几条」：不要写死 1 —— 上面刚导入过一个同组副本，
// 写死数字会让「功能正确」被误报成 FAIL（第一版就是这么假红的）。
const expectedInGroup = ((await j(`/api/cases?group=${encodeURIComponent(GROUP_A)}`)).body || []).length
c.check('准备：组内条数从接口读回来（真机断言以它为准，不写死）', expectedInGroup >= 1, `组内 ${expectedInGroup} 条`)

// ---------------------------------------------------------------------------
// 真机层
// ---------------------------------------------------------------------------

await withBrowser(
  async (cdp) => {
    await loginByToken(cdp, BASE, token)
    // ⚠️ 用例列表的路由是 `/`（不是 `/cases`）—— `/cases/new` 与 `/cases/:id/edit` 才是编辑器。
    //    走错路径 router-view 会是空的，现象是「页面看着正常、但控件全找不到」。
    await cdp.nav(BASE + '/#/', `document.querySelector('.toolbar') !== null`)
    await cdp.eval(PAGE_HELPERS)
    await sleep(400)

    const btnTexts = await cdp.eval('[...document.querySelectorAll("button")].map(b=>b.textContent.trim())')
    c.check('用例页工具栏有「运行该分组」按钮', btnTexts.includes('运行该分组'), btnTexts.filter((t) => t.includes('分组')).join(' / ') || '(没找到)')

    const hasSelect = await cdp.eval(`!!document.querySelector('.toolbar .el-select')`)
    c.check('工具栏有「按分组筛选」下拉', hasSelect, hasSelect ? '找到了' : '没有 .toolbar .el-select')

    const headers = await cdp.eval(`[...document.querySelectorAll('.el-table__header th')].map(e=>e.innerText.trim())`)
    c.check('表格多了一列「分组」', headers.includes('分组'), headers.join(' / '))

    const rowsAll = await cdp.eval('window.__h.rows()')
    c.check(
      '★ 未筛选时，我的用例带着分组标签出现在列表里',
      rowsAll.some((r) => r.includes(caseName) && r.includes(GROUP_A)),
      rowsAll.find((r) => r.includes(caseName)) || '(没找到我的用例)',
    )

    const disabledBefore = await cdp.eval(`window.__h.btn('运行该分组')?.disabled === true`)
    c.check('未选分组时「运行该分组」是禁用的（避免误点成「跑全部」）', disabledBefore === true, `disabled=${disabledBefore}`)

    // 打开下拉并选中我的分组（Element Plus 的下拉是 teleport 到 body 的 .el-select-dropdown）
    const opened = await cdp.eval(
      `(() => {
         const sel = document.querySelector('.toolbar .el-select');
         if (!sel) return 'NO_SELECT';
         const t = sel.querySelector('.el-select__wrapper') || sel.querySelector('input') || sel;
         t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         t.click();
         return 'OPENED';
       })()`,
    )
    await cdp.waitFor(`document.querySelectorAll('.el-select-dropdown__item').length > 0`, '分组下拉展开')
    const opts = await cdp.eval(`[...document.querySelectorAll('.el-select-dropdown__item')].map(e=>e.innerText.trim())`)
    c.check(
      '下拉里列出了现有分组（含 OA 的八个组与我这次造的组）',
      opts.includes(GROUP_A) && opts.length >= 2,
      `共 ${opts.length} 个：` + opts.slice(0, 6).join(' / ') + (opts.length > 6 ? ' …' : ''),
    )

    const picked = await cdp.eval(
      `(() => {
         const it = [...document.querySelectorAll('.el-select-dropdown__item')]
           .find(e => e.innerText.trim() === ${JSON.stringify(GROUP_A)});
         if (!it) return 'OPTION_NOT_FOUND';
         it.click();
         return 'PICKED';
       })()`,
    )
    await sleep(600)
    const rowsPicked = await cdp.eval('window.__h.rows()')
    c.check(
      '★ 选中分组后列表只剩这一组（其他用例被滤掉）',
      opened === 'OPENED' &&
        picked === 'PICKED' &&
        rowsPicked.length === expectedInGroup &&
        rowsPicked.every((r) => r.includes(GROUP_A)) &&
        !rowsPicked.some((r) => r.includes('OA-')),
      `${picked} → 剩 ${rowsPicked.length} 行（预期 ${expectedInGroup}，应全带分组标签且不含 OA 行）`,
    )

    // ★ 这条会真的执行这一组（每条都是 {{base}}/health：离线、瞬时、必过），执行记录在收尾被清掉
    await cdp.eval(`window.__h.click('运行该分组')`)
    await cdp.waitFor(
      `[...document.querySelectorAll('.el-dialog')].some(d => window.__h.vis(d) && d.innerText.includes('通过'))`,
      '运行结果弹窗',
    )
    const dlgText = await cdp.eval(
      `[...document.querySelectorAll('.el-dialog')].filter(d => window.__h.vis(d)).map(d => d.innerText).join(' || ')`,
    )
    const dlgRows = await cdp.eval(
      `(() => {
         const d = [...document.querySelectorAll('.el-dialog')].find(x => window.__h.vis(x));
         return d ? d.querySelectorAll('tbody tr').length : -1;
       })()`,
    )
    c.check(
      '★ 点「运行该分组」→ 汇总弹窗写明筛选的分组，且结果表条数 = 组内条数（只跑了这一组）',
      dlgText.includes('筛选：分组：' + GROUP_A) && dlgRows === expectedInGroup,
      `表格行数=${dlgRows}（预期 ${expectedInGroup}） / ${(dlgText.match(/通过 \d+ \/ \d+/) || ['(没读到通过数)'])[0]}`,
    )

    // 报告页：按业务分组汇总
    await cdp.nav(BASE + '/#/reports', `document.body.innerText.includes('按业务分组汇总')`)
    await cdp.eval(PAGE_HELPERS)
    await sleep(400)
    const cardTitles = await cdp.eval('window.__h.cardTitles()')
    c.check(
      '报告页出现「按业务分组汇总」卡片',
      cardTitles.some((t) => t.includes('按业务分组汇总')),
      cardTitles.join(' / ') || '(没读到卡片标题)',
    )
    const repText = await cdp.eval('document.body.innerText')
    c.check(
      '★ 报告按分组汇总里能看到我的分组与它的执行次数（分组是报告可读的维度）',
      repText.includes(GROUP_A),
      repText.includes(GROUP_A) ? '在表里' : `没找到 ${GROUP_A}`,
    )

    // 编辑器：分组输入项
    await cdp.nav(BASE + '/#/cases/new', `document.body.innerText.includes('新建用例')`)
    await cdp.eval(PAGE_HELPERS)
    await sleep(400)
    const labels = await cdp.eval(`[...document.querySelectorAll('.el-form-item__label')].map(e=>e.innerText.trim())`)
    c.check('用例编辑器多了「分组」输入项', labels.includes('分组'), labels.join(' / '))
  },
  { port: 9340 },
)

// ---------------------------------------------------------------------------
// 收尾：用例 + 执行记录，一条都不留
// ---------------------------------------------------------------------------

const allCases = (await j('/api/cases')).body || []
// 按前缀（而不是 STAMP）清场：上一次跑到一半失败留下的残骸也一并收掉 ——
// 否则「测试脚本自己脏了库」会一直被忽略。M12UI- 是脚本专属命名空间。
const mineCases = allCases.filter((x) => String(x.name).includes(OWN_PREFIX))
const mineIds = mineCases.map((x) => x.id)
for (const x of mineCases) await j(`/api/cases/${x.id}`, { method: 'DELETE' })

const leftCases = ((await j('/api/cases')).body || []).filter((x) => String(x.name).includes(OWN_PREFIX))
c.check('收尾：本次造的用例全部删净', leftCases.length === 0, `删了 ${mineCases.length} 条，剩 ${leftCases.length}`)

// 执行记录：deleteCase 不级联删 runs，也没有删 runs 的接口 —— 直接对着库删。
// DB_PATH 显式指向项目下的 data/app.db，避免「脚本从别的目录跑起来、连到另一个库」。
process.env.DB_PATH = path.resolve(ROOT, 'data', 'app.db')
let orphanLeft = -1
let runDeleted = 0
try {
  const { getDb } = await import('../src/db.js')
  const db = getDb()
  for (const id of mineIds) runDeleted += db.prepare(`DELETE FROM runs WHERE case_id = ?`).run(id).changes
  orphanLeft = db
    .prepare(
      mineIds.length
        ? `SELECT COUNT(*) n FROM runs WHERE case_id IN (${mineIds.map(() => '?').join(',')})`
        : `SELECT 0 n`,
    )
    .get(...mineIds).n
} catch (e) {
  console.error('  （清理执行记录失败：' + e.message + '）')
}
c.check(
  '收尾：本次跑出来的执行记录也删净（报告里不会留「用例#id」这种孤儿）',
  orphanLeft === 0,
  `删了 ${runDeleted} 条执行记录，剩 ${orphanLeft}${orphanLeft < 0 ? '（查询没跑成）' : ''}`,
)

// 顺手把「坏掉的孤儿记录」数一遍，供排查用（不参与判定）
try {
  const { getDb } = await import('../src/db.js')
  const orphans = getDb()
    .prepare(`SELECT COUNT(*) n FROM runs WHERE case_id IS NOT NULL AND case_id NOT IN (SELECT id FROM test_cases)`)
    .get().n
  console.log(`\n  （信息）库里指向已删除用例的执行记录：${orphans} 条`)
} catch {}

c.finish()
