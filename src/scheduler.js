// node-cron 调度器：把 schedules 表里的定时任务注册进 cron。
// 设计：
//  - startScheduler() 需显式调用（index.js 直接运行时调用；测试里不调，保证隔离）
//  - 路由对 schedules 增删改后调用 refreshJob() 同步注册/停用
//  - 定时触发 = runCase(case) 并落 runs 表（复用执行引擎）
import cron from 'node-cron'
import { listSchedules, validateCron } from './schedules.js'
import { getCase, listCases } from './cases.js'
import { runCase, runAll } from './runner.js'
import { addNotification } from './notifications.js'
import { forwardToWebhook } from './webhook.js'

const jobs = new Map() // scheduleId → cron Task

/**
 * 定时触发时真正跑的东西——抽出来是为了能脱离 cron 直接测（否则只能等 cron 到点）。
 * - 分组定时（schedule.group 非空）：按创建顺序跑该分组下的全部用例（复用 runAll，环境在那一层统一注入）；
 *   和手动 run-all 一样：单个分组未必是自包含链——比如 OA 的「审批引擎」依赖登录/建单抽出的变量，
 *   单独跑会红。这是链式设计的固有特性，分组主要用于「组织 + 报告按组看」。
 * - 单条用例定时：跑这一条。
 *
 * M17 可观察性：跑完（无论成功/失败/异常）都落一条通知，前端铃铛展示未读角标。
 * level 三档：success（全绿）/ warn（跑了但有断言失败）/ error（运行抛异常或用例已删）。
 * 通知是「额外」能力：写失败绝不能让定时任务本体失败，所以单独 try/catch 吞掉。
 */
export async function runScheduledJob(schedule) {
  let target = ''
  let level = 'info'
  let title = ''
  let body = ''
  try {
    if (schedule.group) {
      target = `分组「${schedule.group}」`
      const cases = listCases(schedule.group)
        .slice()
        .sort((a, b) => a.id - b.id)
      if (!cases.length) {
        level = 'warn'
        title = `${target} 定时运行未执行`
        body = '该分组下没有用例（建定时任务时已拦空组，这里是防御）'
      } else {
        const results = await runAll(cases)
        const failed = results.filter((r) => !r.pass).length
        level = failed === 0 ? 'success' : 'warn'
        title = `${target} 定时运行完成`
        body = `共 ${results.length} 条用例，通过 ${results.length - failed}，失败 ${failed}`
      }
    } else {
      const c = getCase(schedule.caseId)
      if (!c) {
        // 用例被删：schedule 对象仍带着 caseName（createSchedule/listSchedules 都透出），用它命名，
        // 比只写「用例#3」更有用——删了的通知也得让人认得出是哪条。
        target = `用例「${schedule.caseName ?? schedule.caseId}」`
        level = 'error'
        title = `${target} 定时运行失败`
        body = '该用例可能已被删除（分组定时用占位 case_id=0，不会中招；单条会）'
      } else {
        target = `用例「${c.name}」`
        const r = await runCase(c)
        level = r.pass ? 'success' : 'warn'
        title = `${target} 定时运行完成`
        body = r.pass ? '全部断言通过' : '断言未通过：' + (r.detail || []).slice(0, 2).join('；')
      }
    }
  } catch (e) {
    level = 'error'
    title = `${target || '定时任务'} 运行异常`
    body = e.message || String(e)
  }
  // M20 降噪：failure 模式下 success 不落通知——每几分钟跑一次的监控任务，
  // 「一切正常」不该是人要逐条划掉的消息；warn/error（跑失败/没跑成）永远落。
  // 注意只在**落库前**拦，运行本体照常执行——降噪 ≠ 不跑。
  if (level === 'success' && schedule.notifyOn === 'failure') return
  try {
    const created = addNotification({ level, title, body, target })
    // M21 通知出口：失败侧（warn/error）顺带 POST 到配置的 webhook（人不在电脑前也能收到）。
    // forwardToWebhook 永不抛错（内部全吞成返回值），所以这里敢直接 await——
    // 站内通知已落库在前，出口失败最多丢外呼，不丢记录、不连累调度本体。
    await forwardToWebhook(created)
  } catch {
    // 通知挂了不能影响调度本体
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
