// API 测试平台 · M3 后端（Fastify）
// 路由：
//   GET  /health                  健康检查
//   GET  /api/cases               列出全部用例
//   GET  /api/cases/:id           查询单个用例
//   POST /api/cases               新建用例 {name,method,url,headers,body,expected}
//   PUT  /api/cases/:id           更新用例（部分更新）
//   DELETE /api/cases/:id         删除用例
//   POST /api/cases/:id/run       执行单个用例（持久化结果）
//   POST /api/run-all             执行全部用例（持久化 + 返回汇总）
//   GET  /api/schedules           定时任务列表
//   POST /api/schedules           新建定时任务 {caseId, cron}
//   PUT  /api/schedules/:id       更新定时任务（cron/enabled）
//   DELETE /api/schedules/:id     删除定时任务
//   GET  /api/runs                执行记录（?caseId=&limit=）
//   GET  /api/reports/summary     报告汇总
//   POST /api/auth/register       注册（免鉴权）
//   POST /api/auth/login          登录（免鉴权）
//   GET  /api/auth/me             当前用户
//   POST /api/auth/change-password 修改密码（需鉴权）
//   /*（生产）                     托管前端 web/dist（仅构建后存在时注册）
import Fastify from 'fastify'
import path from 'node:path'
import fs from 'node:fs'
import { createCase, listCases, getCase, updateCase, deleteCase } from './src/cases.js'
import { runCase, runAll } from './src/runner.js'
import { createSchedule, listSchedules, getSchedule, updateSchedule, deleteSchedule } from './src/schedules.js'
import { refreshJob, startScheduler } from './src/scheduler.js'
import { listRuns, getReportSummary } from './src/reports.js'
import { signToken, verifyToken } from './src/auth.js'
import { createUser, verifyLogin, initDefaultUser, changePassword } from './src/users.js'

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

  app.get('/api/cases', async () => listCases())

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
    const ok = deleteCase(Number(req.params.id))
    if (!ok) return reply.code(404).send({ error: '用例不存在' })
    return { deleted: true }
  })

  app.post('/api/cases/:id/run', async (req) => {
    const c = getCase(Number(req.params.id))
    if (!c) return { error: '用例不存在' }
    return runCase(c)
  })

  app.post('/api/run-all', async () => {
    const cases = listCases()
    const results = await runAll(cases)
    const passed = results.filter((r) => r.pass).length
    return {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      results,
    }
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
    console.log(`✅ API 测试平台 M5 已启动：http://localhost:${port}（定时任务已恢复）`)
  }).catch((e) => {
    console.error('启动失败：', e.message)
    process.exit(1)
  })
}
