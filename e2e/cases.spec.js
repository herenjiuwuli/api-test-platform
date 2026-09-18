// M19 · 用例列表 / 运行 / 报告（真浏览器 + 真接口 + 独立库）
//
// 断言的基准是 e2e/seed-e2e.mjs 造的**确定态**：
//   · 分组「e2e-离线」下恰好 2 条：E2E-自检必绿(/health) 恒通过、E2E-状态码必红 恒失败；
//   · 两条都只打本机 /health，**不联网**，所以结果不受网络/对方限流影响。
import {
  test,
  expect,
  loginAndWaitList,
  caseRow,
  clickRowAction,
  expectRoute,
  gotoRoute,
  waitCaseListReady,
  selectGroup,
  SELF_BASE,
} from './helpers.js'

// 同文件内的用例共用同一个库，顺序有意义（第 6 条要看第 5 条跑出来的报告）
test.describe.configure({ mode: 'serial' })

test.describe('M19 · 用例列表与运行', () => {
  test.beforeEach(async ({ page }) => {
    await loginAndWaitList(page)
  })

  test('列表渲染出种子用例（含两条确定性离线用例）', async ({ page }) => {
    await expect(caseRow(page, 'E2E-自检必绿')).toHaveCount(1)
    await expect(caseRow(page, 'E2E-状态码必红')).toHaveCount(1)
    // 平台真实 seed.js 的示例数据也在（E2E 打的就是用户首开看到的那份）
    await expect(caseRow(page, '自检-GET 状态码 + 包含 + JSONPath')).toHaveCount(1)
  })

  test('单条运行「必绿」用例 → 结果弹窗显示 ✓ 通过', async ({ page }) => {
    await clickRowAction(page, 'E2E-自检必绿', '运行')

    const head = page.locator('[data-t=run-result]')
    await expect(head).toBeVisible()
    // 判据只可能出现在「目标状态」里：弹窗里的结果标签，不是列表里任何一处文案
    await expect(head.locator('.el-tag')).toHaveText('✓ 通过')
  })

  test('单条运行「必红」用例 → 结果弹窗显示 ✗ 失败', async ({ page }) => {
    await clickRowAction(page, 'E2E-状态码必红', '运行')

    const head = page.locator('[data-t=run-result]')
    await expect(head).toBeVisible()
    // 只会报「通过」的工具比没有工具更危险 —— 这条专门证明失败会被如实报出来
    await expect(head.locator('.el-tag')).toHaveText('✗ 失败')
  })

  test('按分组筛选 → 只剩该分组的 2 条', async ({ page }) => {
    await selectGroup(page, 'e2e-离线')
    await expect(page.locator('[data-t=case-table] tbody tr')).toHaveCount(2)
    // 分组外的用例必须消失（只断言「有 2 行」不够：万一压根没筛，也有可能恰好 2 行）
    await expect(caseRow(page, '自检-GET 状态码 + 包含 + JSONPath')).toHaveCount(0)
  })

  test('运行该分组 → 汇总「通过 1 / 2」+ 失败 1', async ({ page }) => {
    await selectGroup(page, 'e2e-离线')
    await page.locator('[data-t=run-group]').click()

    const head = page.locator('[data-t=run-summary]')
    await expect(head).toBeVisible()
    await expect(head.locator('.el-tag')).toHaveText('通过 1 / 2')
    await expect(head).toContainText('失败 1')
    // 汇总表里两行结果一对一（一条通过、一条失败），而不是笼统一个总数
    const rows = page.locator('.el-dialog:visible tbody tr')
    await expect(rows).toHaveCount(2)
  })

  test('报告页：分组维度能看到刚才跑出来的分组通过率', async ({ page }) => {
    await gotoRoute(page, '/reports')
    await expectRoute(page, '/reports')

    // 概览卡片渲染完成
    await expect(page.locator('.stat-card').filter({ hasText: '用例总数' })).toHaveCount(1)
    // 「按业务分组汇总」里出现 e2e-离线 —— 把「跑一批 → 报告按组看通过率」闭环端到端串起来
    const groupRows = page
      .locator('.el-card')
      .filter({ hasText: '按业务分组汇总' })
      .locator('tbody tr')
    await expect(groupRows.filter({ hasText: 'e2e-离线' })).toHaveCount(1)
  })

  test('新建用例 → 保存 → 列表出现该行；再删除 → 行消失', async ({ page }) => {
    const name = 'E2E-界面新建待删'

    await page.locator('[data-t=new-case]').click()
    await expectRoute(page, '/cases/new')
    await page.locator('[data-t=name]').fill(name)
    await page.locator('[data-t=url]').fill(`${SELF_BASE}/health`)
    await page.locator('[data-t=expected-status]').fill('200')
    await page.locator('[data-t=save]').click()

    await expectRoute(page, '/')
    await waitCaseListReady(page)
    await expect(caseRow(page, name)).toHaveCount(1)

    // 删除：确认弹窗**必须**出现并说清「连带的也会删掉」
    // （静默毁掉几十条历史比多一句提示危险得多，所以这里连带文案一起断言）
    await clickRowAction(page, name, '删除')
    const box = page.locator('.el-message-box')
    await expect(box).toBeVisible()
    await expect(box).toContainText('执行记录与定时任务会一起删掉')
    await expect(box).toContainText(name)
    await box.locator('.el-button--primary').click()

    await expect(caseRow(page, name)).toHaveCount(0)
  })
})
