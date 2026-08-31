// 鉴权测试（M4）：本文件启用真实守卫，验证注册/登录/路由保护。
// 覆盖 tests/setup.js 的旁路开关，让 authGuard 真正生效。
process.env.API_AUTH_DISABLED = '0'
process.env.DB_PATH = ':memory:'

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../index.js'

let app

beforeAll(async () => {
  app = buildApp()
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('鉴权（M4）', () => {
  it('注册：成功返回 token 与 user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'secret123' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.token).toBeTruthy()
    expect(body.user.username).toBe('alice')
    expect(body.user.role).toBe('user')
  })

  it('注册：密码过短 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'short', password: '123' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('注册：重复用户名 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'another1' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('登录：正确密码返回 token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret123' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).token).toBeTruthy()
  })

  it('登录：错误密码 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'wrongpw' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('受保护路由：无 token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/cases' })
    expect(res.statusCode).toBe(401)
  })

  it('受保护路由：带有效 token → 200', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret123' },
    })
    const token = JSON.parse(login.body).token
    const res = await app.inject({
      method: 'GET',
      url: '/api/cases',
      headers: { authorization: 'Bearer ' + token },
    })
    expect(res.statusCode).toBe(200)
  })

  it('/api/auth/me：带 token 返回当前用户', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret123' },
    })
    const token = JSON.parse(login.body).token
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer ' + token },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).user.username).toBe('alice')
  })

  it('/health 始终免鉴权', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
  })
})
