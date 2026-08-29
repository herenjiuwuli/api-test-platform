// node-cron 调度器：把 schedules 表里的定时任务注册进 cron。
// 设计：
//  - startScheduler() 需显式调用（index.js 直接运行时调用；测试里不调，保证隔离）
//  - 路由对 schedules 增删改后调用 refreshJob() 同步注册/停用
//  - 定时触发 = runCase(case) 并落 runs 表（复用执行引擎）
import cron from 'node-cron'
import { listSchedules, validateCron } from './schedules.js'
import { getCase } from './cases.js'
import { runCase } from './runner.js'

const jobs = new Map() // scheduleId → cron Task

/** 注册单个定时任务（先停旧的；禁用/表达式非法则只停不启） */
export function registerJob(schedule) {
  stopJob(schedule.id)
  if (!schedule.enabled) return
  if (!validateCron(schedule.cron)) return
  const task = cron.schedule(schedule.cron, async () => {
    const c = getCase(schedule.caseId)
    if (c) await runCase(c)
  })
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
