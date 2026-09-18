// node-cron 调度器：把 schedules 表里的定时任务注册进 cron。
// 设计：
//  - startScheduler() 需显式调用（index.js 直接运行时调用；测试里不调，保证隔离）
//  - 路由对 schedules 增删改后调用 refreshJob() 同步注册/停用
//  - 定时触发 = runCase(case) 并落 runs 表（复用执行引擎）
import cron from 'node-cron'
import { listSchedules, validateCron } from './schedules.js'
import { getCase, listCases } from './cases.js'
import { runCase, runAll } from './runner.js'

const jobs = new Map() // scheduleId → cron Task

/**
 * 定时触发时真正跑的东西——抽出来是为了能脱离 cron 直接测（否则只能等 cron 到点）。
 * - 分组定时（schedule.group 非空）：按创建顺序跑该分组下的全部用例（复用 runAll，环境在那一层统一注入）；
 *   和手动 run-all 一样：单个分组未必是自包含链——比如 OA 的「审批引擎」依赖登录/建单抽出的变量，
 *   单独跑会红。这是链式设计的固有特性，分组主要用于「组织 + 报告按组看」。
 * - 单条用例定时：跑这一条。
 */
export async function runScheduledJob(schedule) {
  if (schedule.group) {
    const cases = listCases(schedule.group)
      .slice()
      .sort((a, b) => a.id - b.id)
    if (cases.length) await runAll(cases)
  } else {
    const c = getCase(schedule.caseId)
    if (c) await runCase(c)
  }
}

/** 注册单个定时任务（先停旧的；禁用/表达式非法则只停不启） */
export function registerJob(schedule) {
  stopJob(schedule.id)
  if (!schedule.enabled) return
  if (!validateCron(schedule.cron)) return
  const task = cron.schedule(schedule.cron, () => runScheduledJob(schedule))
  jobs.set(schedule.id, task)
}

export function stopJob(id) {
  const task = jobs.get(id)
  if (task) {
    task.stop()
    jobs.delete(id)
  }
}

/** 路由增删改后调用：重新按最新配置注册 */
export function refreshJob(schedule) {
  if (schedule) registerJob(schedule)
}

/** 启动时恢复全部启用的定时任务 */
export function startScheduler() {
  for (const s of listSchedules()) registerJob(s)
}

/** 测试/关闭时清空全部任务 */
export function stopAllScheduler() {
  for (const id of [...jobs.keys()]) stopJob(id)
}

/** 当前注册的任务数（测试断言用） */
export function jobCount() {
  return jobs.size
}
