// M19 · 鉴权与路由守卫（真浏览器）
//
// 这一层专门抓「接口测试看不见」的东西：路由守卫有没有真的拦住、登录失败会不会把人放进去、
// 表单能不能正常提交。之前 office-oa 的实测教训就是——接口层 84 条全绿时，真机上照样能抓出真缺陷。
import { test, expect, login, loginAndWaitList, expectRoute, caseRow } from './helpers.js'

test.describe('M19 · 鉴权与路由守卫', () => {
  test('未登录直接访问首页 → 被挡到登录页', async ({ page }) => {
    await page.goto('/')
    await expectRoute(page, '/login')
    await expect(page.locator('[data-t=submit]')).toBeVisible()
    // 登录页是独立布局：不该出现导航栏（不然就是「进了应用但没登录」的漏网状态）
    await expect(page.locator('.app-header')).toHaveCount(0)
  })

  test('密码错误 → 停在登录页并给出明确错误', async ({ page }) => {
    await login(page, { username: 'admin', password: 'definitely-wrong' })

    // ⚠️ 判据要写成 .el-alert--error：登录页本身就有一个「默认管理员」的 info 提示框，
    //    只写 .el-alert 会匹配到两个，断言要么 strict 报错、要么恰好命中错的那个。
    await expect(page.locator('.el-alert--error')).toContainText('用户名或密码错误')

    // ⚠️ 光断言「有报错」不够：还要断言**没被放进去** —— 否则「报了错但还是跳转了」也会通过
    await expectRoute(page, '/login')
    await expect(page.locator('.app-header')).toHaveCount(0)
  })

  test('admin 真实表单登录 → 进列表页并渲染出种子用例', async ({ page }) => {
    await loginAndWaitList(page)

    await expect(page.locator('.brand-name')).toHaveText('API 自动化测试平台')
    // 种子数据里两条确定性离线用例都该在（它们是后面几条断言的基准）
    await expect(caseRow(page, 'E2E-自检必绿')).toHaveCount(1)
    await expect(caseRow(page, 'E2E-状态码必红')).toHaveCount(1)
  })

  test('退出登录 → 回到登录页，且再访问首页仍被挡', async ({ page }) => {
    await loginAndWaitList(page)

    await page.locator('.who').click() // 头像下拉（trigger="click"）
    await page.locator('.el-dropdown-menu__item').filter({ hasText: '退出登录' }).click()
    await expectRoute(page, '/login')

    // 关键：退出不只是「界面跳走了」，token 必须真的清掉 —— 再访问首页仍要被挡
    await page.goto('/')
    await expectRoute(page, '/login')
  })
})
