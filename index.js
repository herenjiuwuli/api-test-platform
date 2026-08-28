// API 测试平台 · M2 后端（Fastify）
// 路由：
//   GET  /health                  健康检查
//   GET  /api/cases               列出全部用例
//   GET  /api/cases/:id           查询单个用例
//   POST /api/cases               新建用例 {name,method,url,headers,body,expected}
//   PUT  /api/cases/:id           更新用例（部分更新）
//   DELETE /api/cases/:id         删除用例
//   POST /api/cases/:id/run       执行单个用例（持久化结果）
//   POST /api/run-all             执行全部用例（持久化 + 返回汇总）
import Fastify from 'fastify'
import { createCase, listCases, getCase, updateCase, deleteCase } from './src/cases.js'
import { runCase, runAll } from './src/runner.js'

export function buildApp() {
  const app = Fastify({ logger: false })

  app.get('/health', async () => ({ ok: true, service: 'api-test-platform', ts: Date.now() }))

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
    console.log(`✅ API 测试平台 M2 已启动：http://localhost:${port}`)
  }).catch((e) => {
    console.error('启动失败：', e.message)
    process.exit(1)
  })
}
