// E2E 公共操作。抽出来的原因：登录 / 等页面就绪 / 行级点按钮 每条用例都要用，
// 各写一遍的话「就绪条件」迟早写歪 —— 写歪的后果是随机假失败（见下面 waitCaseListReady 注释）。
import { test as base, expect } from '@playwright/test'

/**
 * 带「收尾拆连接」的 test —— 本项目所有 spec 都从这里引它，而不是直接引 @playwright/test。
 *
 * ⚠️ 为什么必须要这一步（实测踩出来的坑）：
 *   登录后 App.vue 会挂一条 SSE(EventSource) 长连接。在无头 Chrome 下这条流会让浏览器
 *   收尾阶段挂住：Playwright 跑完最后一个登录用例后**既不打印汇总也不退出** ——
 *   表现为「用例全绿但命令一直不结束」，非常容易被误判成测试挂死而去瞎改断言。
 *
 *   隔离实验（可复现）：
 *     · 不登录的用例            → 正常退出；
 *     · 登录 + 删掉 EventSource → 正常退出；
 *     · 登录（带 SSE）          → 挂住。
 *   收尾导航到 about:blank 会把文档连同它持有的连接一起拆掉，上下文于是能干净关闭。
 *
 *   （应用侧也加了「退出登录 / pagehide 时主动 close」——那本身是应该做的清理，
 *     但它依赖浏览器是否触发 pagehide，无头自动化下并不保证，所以这里必须有兜底。）
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await use(page)
    // 拆掉页面上残留的长连接（SSE / WebSocket 之类），再交给 Playwright 关上下文
    await page.goto('about:blank').catch(() => {})
  },
})

export { expect }

export const ADMIN = { username: 'admin', password: 'admin123' }

/** E2E 服务端口（与 playwright.config.js 的 E2E_PORT 保持同一个来源） */
export const E2E_PORT = Number(process.env.E2E_PORT || 3400)
export const SELF_BASE = `http://127.0.0.1:${E2E_PORT}`

/**
 * 等路由变成指定值。
 * ⚠️ 这个项目用的是 createWebHashHistory，**路由在 location.hash 里，不在 pathname**：
 *    '/#/login' 和 '/#/' 的 pathname 都是 '/'，按 pathname 判会「什么都通过」。
 */
export async function expectRoute(page, route) {
  await expect
    .poll(() => new URL(page.url()).hash.replace(/^#/, '') || '/', { timeout: 15_000 })
    .toBe(route)
}

/**
 * 跳到某个路由。
 * ⚠️ 一定要用 hash 形式（'/#/reports'）而不是 path 形式（'/reports'）：
 *    这个项目是 hash 路由，`goto('/reports')` 会被后端 SPA 兜底成 index.html，
 *    而 router 从 URL 里只能读到「没有 hash」→ 停在 '/'，于是「跳转看似成功、其实没跳」。
 */
export async function gotoRoute(page, route) {
  await page.goto('/#' + route)
}

/**
 * 等用例列表的**数据真的到位**。
 * ⚠️ 别只 goto 就断言：SPA 框架渲染完 ≠ 异步 fetch 的用例回来了，
 *    表头/工具栏的字数就够骗过「页面有内容」这种粗判据。不等数据到位，断言会随机器快慢随机假失败。
 *    空态（暂无用例）也算「到位」，否则空库时永远等不到。
 */
export async function waitCaseListReady(page) {
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('[data-t=case-table] tbody tr')
    return rows.length > 0 || document.body.innerText.includes('暂无用例')
  })
}

/**
 * 用**真实表单**登录。
 * ⚠️ 刻意不往 localStorage 塞 token 抄近道 —— 抄近道会漏掉登录本身的 bug（路由守卫、表单校验、错误提示）。
 */
export async function login(page, { username = ADMIN.username, password = ADMIN.password } = {}) {
  await page.goto('/login')
  await expect(page.locator('[data-t=username]')).toBeVisible()
  await page.locator('[data-t=username]').fill(username)
  await page.locator('[data-t=password]').fill(password)
  await page.locator('[data-t=submit]').click()
}

/** 登录并等到列表页数据就绪（大多数用例的开场） */
export async function loginAndWaitList(page) {
  await login(page)
  await expectRoute(page, '/')
  await waitCaseListReady(page)
}

/**
 * 按名称定位列表里的一行。
 * ⚠️ 每行都有一个叫「运行」的按钮，**不能全局点第一个** —— 那样点到的是别的用例，脚本还「看起来通过」。
 */
export function caseRow(page, name) {
  return page.locator('[data-t=case-table] tbody tr').filter({ hasText: name })
}

/** 在指定行里点按钮（先按名称定位到行，再在行内找按钮） */
export async function clickRowAction(page, name, btnText) {
  await caseRow(page, name).first().getByRole('button', { name: btnText }).click()
}

/** 在工具栏的分组下拉里选中某个分组（Element Plus 的选项是 teleport 到 body 的） */
export async function selectGroup(page, group) {
  await page.locator('[data-t=group-select]').click()
  await page.locator('.el-select-dropdown__item').filter({ hasText: group }).first().click()
}
