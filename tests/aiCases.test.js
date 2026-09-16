// AI 生成用例单测：prompt 构造 + 用例模型校验（mock DeepSeek 调用）
import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock src/ai.js，不真实请求 DeepSeek
vi.mock('../src/ai.js', () => ({
  chatWithDeepSeek: vi.fn(),
  chatJSON: vi.fn(),
}))

import { chatJSON } from '../src/ai.js'
import { buildMessages, normalizeCases, generateCases } from '../src/aiCases.js'

describe('buildMessages', () => {
  it('包含 system prompt 与接口信息（JSON 序列化）', () => {
    const msgs = buildMessages({
      method: 'POST',
      url: '/api/cases',
      body: { name: 'demo' },
      description: '创建用例接口',
    })
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('5-8 条测试用例')
    expect(msgs[1].role).toBe('user')
    const userPayload = JSON.parse(msgs[1].content.replace('接口信息：\n', ''))
    expect(userPayload).toMatchObject({ method: 'POST', url: '/api/cases', body: { name: 'demo' } })
  })

  it('缺省字段有默认值（GET / body null / 空 description）', () => {
    const userPayload = JSON.parse(buildMessages({ url: '/x' })[1].content.replace('接口信息：\n', ''))
    expect(userPayload).toEqual({ method: 'GET', url: '/x', headers: {}, body: null, description: '' })
  })
})

describe('normalizeCases', () => {
  const valid = {
    name: '查询不存在的用例返回 404',
    method: 'GET',
    url: '/api/cases/99999',
    headers: {},
    expected: { status: 404 },
  }

  it('根为对象 { cases: [...] } 时正常归一化', () => {
    const out = normalizeCases({ cases: [valid, { ...valid, name: 'b' }, { ...valid, name: 'c' }] })
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ name: valid.name, method: 'GET', url: '/api/cases/99999', expected: { status: 404 } })
  })

  it('根为数组时也接受', () => {
    const out = normalizeCases([valid, { ...valid, name: 'b' }, { ...valid, name: 'c' }])
    expect(out).toHaveLength(3)
  })

  it('非法 jsonChecks（未知 op / 缺 path）被过滤', () => {
    const c = {
      ...valid,
      expected: {
        status: 200,
        jsonChecks: [
          { path: '$.code', op: 'eq', value: 0 },
          { path: '$.x', op: 'hacker', value: 1 }, // 非法 op
          { op: 'exists', value: 1 }, // 缺 path
        ],
      },
    }
    const out = normalizeCases([c, { ...valid, name: 'b' }, { ...valid, name: 'c' }])
    expect(out[0].expected.jsonChecks).toEqual([{ path: '$.code', op: 'eq', value: 0 }])
  })

  it('用例数过少抛友好错误', () => {
    expect(() => normalizeCases([valid])).toThrow('有效用例过少')
    expect(() => normalizeCases([valid, { ...valid, name: 'b' }])).toThrow('有效用例过少')
  })

  it('缺 name / url / method 非法的用例被跳过', () => {
    const noName = { ...valid, name: ' ' }
    const noUrl = { ...valid, url: '' }
    const badMethod = { ...valid, method: 'HEAD' }
    const junk = 'not-an-object'
    const out = normalizeCases([noName, noUrl, badMethod, junk, valid, { ...valid, name: 'b' }, { ...valid, name: 'c' }])
    expect(out).toHaveLength(3)
    expect(out.every((c) => ['GET', 'POST', 'PUT', 'DELETE'].includes(c.method))).toBe(true)
  })

  it('空 / 非对象输入抛友好错误', () => {
    expect(() => normalizeCases(null)).toThrow('格式不正确')
    expect(() => normalizeCases({})).toThrow('格式不正确')
  })
})

describe('generateCases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('调 chatJSON 并透传归一化结果', async () => {
    const raw = {
      cases: [
        { name: 'a', method: 'GET', url: '/x', headers: {}, expected: { status: 200 } },
        { name: 'b', method: 'POST', url: '/x', headers: {}, body: { k: 1 }, expected: { status: 201 } },
        { name: 'c', method: 'DELETE', url: '/x/1', headers: {}, expected: { status: 204 } },
      ],
    }
    chatJSON.mockResolvedValueOnce(raw)
    const out = await generateCases({ url: '/x' })
    expect(chatJSON).toHaveBeenCalledTimes(1)
    expect(out).toHaveLength(3)
    expect(out[1].body).toEqual({ k: 1 })
  })

  it('chatJSON 抛错时向上传播', async () => {
    chatJSON.mockRejectedValueOnce(new Error('AI 返回内容不是合法 JSON'))
    await expect(generateCases({ url: '/x' })).rejects.toThrow('不是合法 JSON')
  })
})
