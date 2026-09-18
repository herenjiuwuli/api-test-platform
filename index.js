// API 测试平台 · M3 后端（Fastify）
// 路由：
//   GET  /health                  健康检查
//   GET  /api/cases               列出全部用例
//   GET  /api/cases/:id           查询单个用例
//   POST /api/cases               新建用例 {name,method,url,headers,body,expected,extract}
//   PUT  /api/cases/:id           更新用例（部分更新）
//   DELETE /api/cases/:id         删除用例
//   POST /api/cases/:id/run       执行单个用例（持久化结果；不参与用例链）
//   POST /api/run-all             执行全部用例（按创建顺序组成用例链，共享变量袋，持久化 + 返回汇总）
//   GET  /api/schedules           定时任务列表
//   POST /api/schedules           新建定时任务 {caseId, group?, cron}（caseId 与 group 二选一）
//   PUT  /api/schedules/:id       更新定时任务（cron/enabled/group/caseId）
//   DELETE /api/schedules/:id     删除定时任务
//   GET  /api/runs                执行记录（?caseId=&limit=）
//   GET  /api/reports/summary     报告汇总
//   GET  /api/environments        环境变量集列表（含当前环境 activeId）
//   POST /api/environments        新建环境 {name,baseUrl,headers,vars}
//   PUT  /api/environments/active 切换当前环境 {id}（id 传 null = 取消当前环境）
//   PUT  /api/environments/:id    更新环境（部分更新）
//   DELETE /api/environments/:id  删除环境（删的是当前环境则当前环境清空）
//   GET  /api/suite/export        导出套件（用例 + 环境，敏感头已脱敏，直接下载成 JSON）
//   POST /api/suite/import        导入套件（body = 套件文件；?onConflict=skip|overwrite|rename）
//   POST /api/auth/register       注册（免鉴权）
//   POST /api/auth/login          登录（免鉴权）
//   GET  /api/auth/me             当前用户
//   POST /api/auth/change-password 修改密码（需鉴权）
//   /*（生产）                     托管前端 web/dist（仅构建后存在时注册）
// 先加载 .env（不覆盖已有环境变量），再导入其他模块——auth.js 等在 import 时就读 process.env
import 'dotenv/config'
import Fastify from 'fastify'
import path from 'node:path'
import fs from 'node:fs'
import { createCase, listCases, getCase, updateCase, deleteCase } from './src/cases.js'
import { BODY_TYPES } from './src/bodyTypes.js'
import { FIXTURES, fixtureNames } from './src/fixtures.js'
import {
  createEnvironment,
  deleteEnvironment,
  getActiveEnvironment,
  getActiveId,
  getEnvironment,
  listEnvironments,
  setActiveEnvironment,
  updateEnvironment,
} from './src/environments.js'
import { envSnapshot, runCase, runAll } from './src/runner.js'
import { exportSuite, importSuite } from './src/suite.js'
import { createSchedule, listSchedules, getSchedule, updateSchedule, deleteSchedule } from './src/schedules.js'
import { refreshJob, startScheduler } from './src/scheduler.js'
import { listRuns, getReportSummary } from './src/reports.js'
import { signToken, verifyToken } from './src/auth.js'
import { createUser, verifyLogin, initDefaultUser, changePassword } from './src/users.js'
import { generateCases } from './src/aiCases.js'

// 鉴权守卫：除健康检查、登录/注册外，所有 /api 路由必须带有效 Bearer token。
// 注意：静态资源与前端的 SPA 页面（/、/reports、/cases/... 等非 /api 路径）一律公开，
// 否则部署后登录页自身都打不开（会吃 401）。测试旁路：API_AUTH_DISABLED==='1' 全放行。
async function authGuard(req, reply) {
  if (process.env.API_AUTH_DISABLED === '1') return
  if (!req.url.startsWith('/api')) return // 静态资源 / 前端页面公开
  if (req.url === '/health') return
  if (req.url.startsWith('/api/auth/login') || req.url.startsWith('/api/auth/register')) return
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return reply.code(401).send({ error: '未登录或缺少 token' })
  try {
    req.user = verifyToken(m[1])
  } catch (e) {
    return reply.code(401).send({ error: 'token 无效或已过期：' + e.message })
  }
}

export function buildApp() {
  const app = Fastify({ logger: false })

  // 全局 onRequest 守卫（在所有 /api 路由之前生效）
  app.addHook('onRequest', authGuard)

  app.get('/health', async () => ({ ok: true, service: 'api-test-platform', ts: Date.now() }))

  // —— 鉴权（M4）——
  app.post('/api/auth/register', async (req, reply) => {
    try {
      const { username, password } = req.body || {}
      if (!username || !password) return reply.code(400).send({ error: '用户名和密码必填' })
      if (String(password).length < 6) return reply.code(400).send({ error: '密码至少 6 位' })
      const u = createUser({ username, password })
      const token = signToken({ sub: u.id, username: u.username, role: u.role })
      return reply.code(201).send({ token, user: { id: u.id, username: u.username, role: u.role } })
    } catch (e) {
      return reply.code(400).send({ error: e.message })
    }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body || {}
    const u = verifyLogin(username, password)
    if (!u) return reply.code(401).send({ error: '用户名或密码错误' })
    const token = signToken({ sub: u.id, username: u.username, role: u.role })
    return { token, user: { id: u.id, username: u.username, role: u.role } }
  })

  app.get('/api/auth/me', async (req) => ({
    user: { id: req.user.sub, username: req.user.username, role: req.user.role },
  }))

  app.post('/api/auth/change-password', async (req, reply) => {
    try {
      const { oldPassword, newPassword } = req.body || {}
      changePassword(req.user.sub, oldPassword, newPassword)
      return { ok: true }
    } catch (e) {
      return reply.code(400).send({ error: e.message })
    }
  })

  // ?group= 可选：只返回该分组下的用例（M12）。不传或为空则返回全部。
  app.get('/api/cases', async (req) => listCases(req.query.group))

  // M8：前端要渲染「请求体类型」和「文件夹具」的选择器。
  // 这里把可选值吐给前端，而不是在前端再抄一份 —— 夹具只有一份事实来源（src/fixtures.js）。
  app.get('/api/meta/body-options', async () => ({
    bodyTypes: BODY_TYPES,
    fixtures: fixtureNames().map((name) => {
      const f = FIXTURES[name]
      return { name, label: f.label, filename: f.filename, contentType: f.contentType }
    }),
  }))

  app.post('/api/cases', async (req, reply) => {
    try {
      const created = createCase(req.body || {})
      return reply.code(201).send(created)
    } catch (e) {
      return reply.code(400).send({ error: e.message })
    }
  })

  app.get('/api/cases/:id', async (req, reply) => {
    const c = getCase(Number(req.params.id))
    if (!c) return reply.code(404).send({ error: '用例不存在' })
    return c
  })

  app.put('/api/cases/:id', async (req, reply) => {
    try {
      const updated = updateCase(Number(req.params.id), req.body || {})
      if (!updated) return reply.code(404).send({ error: '用例不存在' })
      return updated
    } catch (e) {
      return reply.code(400).send({ error: e.message })
    }
  })

  app.delete('/api/cases/:id', async (req, reply) => {
    const r = deleteCase(Number(req.params.id))
    if (!r.deleted) return reply.code(404).send({ error: '用例不存在' })
    // ⚠️ 删库行不会自动停 cron：用例没了，挂在上面的定时任务必须一起停掉，
    //    否则内存里留着一个「每次触发都打向空用例」的任务（现在只是靠 runCase 里的 `if (c)` 兜着）。
    for (const sid of r.scheduleIds) refreshJob({ id: sid, enabled: false })
    // 连带删掉了什么，如实回给调用方（前端据此提示「已删除（连带 3 条执行记录）」），不静默
    return { deleted: true, runsDeleted: r.runsDeleted, schedulesDeleted: r.scheduleIds.length }
  })

  app.post('/api/cases/:id/run', async (req) => {
    const c = getCase(Number(req.params.id))
    if (!c) return { error: '用例不存在' }
    return runCase(c)
  })

  app.post('/api/run-all', async (req) => {
    // 用例链按「创建顺序」跑（id 升序）：登录抽 token → 后面带 token 的用例才能用上。
    // listCases() 是「新的在前」（给界面看的），这里必须翻过来，否则链会被打乱。
    // 两种「只跑一部分」的过滤（M12 起两者并存）：
    //   - prefix:'OA-'  按名字前缀切（跑「OA-」这一坨，跨语义）
    //   - group:'审批引擎' 按语义分组标签切（跑「审批引擎」这一主题）
    //   - ids:[1,2,3]    显式指定
    // 注意：单个 group 不一定是「自包含链」—— 比如 OA 的「审批引擎」依赖前面登录/建单抽出的变量，
    //   单独跑会红。这是链式设计的固有特性，分组主要用于「组织 + 报告按组看」，不是替你切链。
    const { prefix, ids, group } = req.body || {}
    let cases = listCases()
      .slice()
      .sort((a, b) => a.id - b.id)
    if (prefix) cases = cases.filter((c) => String(c.name).startsWith(prefix))
    if (group) cases = cases.filter((c) => (c.group || '') === group)
    if (Array.isArray(ids) && ids.length) {
      const want = new Set(ids.map(Number))
      cases = cases.filter((c) => want.has(c.id))
    }
    const results = await runAll(cases)
    const passed = results.filter((r) => r.pass).length
    return {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      filter: prefix || group || (ids?.length ? 'ids' : null),
      // 整轮用的哪个环境 —— 空结果（没有匹配的用例）时也要说得出来，所以从当前环境直接取
      env: envSnapshot(getActiveEnvironment()),
      results,
    }
  })

  // —— 环境变量集（M9）——
  // 「这次打的是哪个环境」必须是**一处可查、一处可切**的状态：
  //   它既影响手动运行，也影响 run-all 和定时任务（三者都走 runner，环境在那里统一生效）。
  app.get('/api/environments', async () => ({
    items: listEnvironments(),
    activeId: getActiveId(),
  }))

  app.post('/api/environments', async (req, reply) => {
    try {
      return reply.code(201).send(createEnvironment(req.body || {}))
    } catch (e) {
      return reply.code(400).send({ error: e.message })
    }
  })

  // 切换当前环境。静态段 /active 必须在 /:id 之前声明（可读性，也免得靠框架的优先级规则过活）。
  app.put('/api/environments/active', async (req, reply) => {
    const { id } = req.body || {}
    if (id !== null && id !== undefined && !getEnvironment(id)) {
      return reply.code(404).send({ error: '环境不存在' })
    }
    const env = setActiveEnvironment(id === undefined ? null : id)
    return { activeId: env ? env.id : null, active: env }
  })

  app.put('/api/environments/:id', async (req, reply) => {
    try {
      const updated = updateEnvironment(Number(req.params.id), req.body || {})
      if (!updated) return reply.code(404).send({ error: '环境不存在' })
      return updated
    } catch (e) {
      return reply.code(400).send({ error: e.message })
    }
  })

  app.delete('/api/environments/:id', async (req, reply) => {
    const r = deleteEnvironment(Number(req.params.id))
    if (!r) return reply.code(404).send({ error: '环境不存在' })
    return r
  })

  // —— 套件导出 / 导入（M11）——
  // 导出：把「用例 + 环境」打成一个能带走的 JSON（敏感头的值已脱敏，见 src/suite.js）。
  // 用例按创建顺序输出 —— 那就是串链顺序，乱了链条会静默断。
  app.get('/api/suite/export', async (req, reply) => {
    const suite = exportSuite()
    const stamp = new Date().toISOString().slice(0, 10)
    reply.header('Content-Type', 'application/json; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="api-test-suite-${stamp}.json"`)
    return suite
  })

  // 导入：请求体就是套件文件本身。冲突策略走 ?onConflict=（skip | overwrite | rename，默认 rename）。
  // 坏文件 400；文件里的**坏条目**不 400 —— 进 result.failed 并继续导入其余的。
  app.post('/api/suite/import', async (req, reply) => {
    const onConflict = req.query?.onConflict ?? req.body?.onConflict
    const result = importSuite(req.body, { onConflict })
    if (!result.ok) return reply.code(400).send({ error: result.error })
    return reply.code(201).send(result)
  })

  // —— 定时任务（M3）——
  app.get('/api/schedules', async () => listSchedules())

  app.post('/api/schedules', async (req, reply) => {
    try {
      const s = createSchedule(req.body || {})
      refreshJob(s) // 同步注册 cron
      return reply.code(201).send(s)
    } catch (e) {
      return reply.code(400).send({ error: e.message })
    }
  })

  app.put('/api/schedules/:id', async (req, reply) => {
    try {
      const s = updateSchedule(Number(req.params.id), req.body || {})
      if (!s) return reply.code(404).send({ error: '定时任务不存在' })
      refreshJob(s)
      return s
    } catch (e) {
      return reply.code(400).send({ error: e.message })
    }
  })

  app.delete('/api/schedules/:id', async (req, reply) => {
    const id = Number(req.params.id)
    const ok = deleteSchedule(id)
    if (!ok) return reply.code(404).send({ error: '定时任务不存在' })
    refreshJob({ id, enabled: false }) // 停掉对应 cron
    return { deleted: true }
  })

  // —— 执行记录与报告（M3）——
  app.get('/api/runs', async (req) =>
    listRuns({ caseId: req.query.caseId ? Number(req.query.caseId) : undefined, limit: req.query.limit }),
  )

  app.get('/api/reports/summary', async () => getReportSummary())

  // —— AI 生成用例 ——
  app.post('/api/ai/generate-cases', async (req, reply) => {
    const { method, url, headers, body, description } = req.body || {}
    if (!url || !String(url).trim()) return reply.code(400).send({ error: '接口 url 必填' })
    try {
      const cases = await generateCases({ method, url, headers, body, description })
      return { cases }
    } catch (e) {
      // DeepSeek 失败 / JSON 解析失败统一给友好提示，细节留在服务端日志
      console.error('[ai/generate-cases]', e.message)
      return reply.code(502).send({ error: 'AI 生成失败，请稍后重试' })
    }
  })

  // —— 生产静态托管（M5）——
  // 构建前端后由后端同源托管，实现单端口部署（Docker / 云服务器 / PM2）。
  // 仅当 web/dist 存在时注册；本地 dev 模式不走这里（前端由 Vite dev server 提供）。
  const distDir = path.resolve(process.cwd(), 'web', 'dist')
  if (fs.existsSync(distDir) && fs.statSync(distDir).isDirectory()) {
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
      '.woff': 'font/woff',
    }
    app.get('/*', async (req, reply) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
      // /api 与 /health 已由上面的具体路由处理；此处兜底未命中文件时回退 index.html
      if (urlPath.startsWith('/api')) return reply.code(404).send({ error: 'Not Found' })
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
      const target = path.resolve(distDir, rel)
      // 防目录穿越 + 文件缺失 → SPA 回退
      if (!target.startsWith(distDir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        const idx = fs.readFileSync(path.join(distDir, 'index.html'))
        return reply.type('text/html; charset=utf-8').send(idx)
      }
      const ext = path.extname(target).toLowerCase()
      return reply.type(MIME[ext] || 'application/octet-stream').send(fs.readFileSync(target))
    })
  }

  return app
}

// 直接运行（node index.js）才监听端口。
// 注意：必须用 pathToFileURL 正规化——Windows 下 process.argv[1] 是反斜杠路径，
// 直接 `file://${argv[1]}` 与 import.meta.url 永远不等，会导致「静默不监听直接退出」。
import { pathToFileURL } from 'node:url'
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const app = buildApp()
  const port = Number(process.env.PORT) || 3001
  app.listen({ port, host: '0.0.0.0' }).then(() => {
    // 首次启动种入默认管理员（库里没用户时才建）
    initDefaultUser()
    // 直接运行时启动定时调度器（测试里不启动，保证隔离）
    startScheduler()
    console.log(`✅ API 测试平台 M11 已启动：http://localhost:${port}（定时任务已恢复）`)
  }).catch((e) => {
    console.error('启动失败：', e.message)
    process.exit(1)
  })
}
