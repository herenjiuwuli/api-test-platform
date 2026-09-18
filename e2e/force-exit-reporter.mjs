// 强制退出 reporter（M21 配套，只在本机非 CI 生效——见 playwright.config.js reporter 条件）。
//
// 背景：这台 Windows 机器上 Playwright 的「跑完之后」有 flaky 挂死（同代码 4 跑 2 挂），
// 且挂点不固定——一次挂在 reporter onEnd 之后，一次挂在「最后一条测试结束 → worker/浏览器
// 收尾」之间（连 `N passed` 汇总都没打出来）。根因在 runner 自身 teardown，不在测试。
//
// 对策：onTestEnd 里数到「最后一条用例结束」就 process.exit——此刻所有测试已跑完、
// trace/截图已落盘，唯一被跳过的是浏览器进程回收，由 run-e2e.mjs 的 taskkill /T 兜底。
// 退出码如实传达通过/失败；onEnd 里再兜一层（如果哪天挂点后移了也能拦住）。
export default class ForceExitReporter {
  total = 0
  done = 0
  failed = false

  onBegin(_config, suite) {
    this.total = suite.allTests().length
  }

  onTestEnd(_test, result) {
    this.done++
    if (result.status !== 'passed' && result.status !== 'skipped') this.failed = true
    if (this.done >= this.total && this.total > 0) {
      const code = this.failed ? 1 : 0
      console.log(`[force-exit] ${this.done}/${this.total} 条用例已全部结束，200ms 后强制退出——绕开本机 flaky 收尾`)
      setTimeout(() => process.exit(code), 200)
      return new Promise(() => {}) // 不再等 Playwright 做任何收尾
    }
  }

  onEnd(result) {
    const code = result.status === 'passed' ? 0 : 1
    console.log(`[force-exit] onEnd 兜底触发（status=${result.status}），200ms 后强制退出`)
    setTimeout(() => process.exit(code), 200)
    return new Promise(() => {})
  }
}
