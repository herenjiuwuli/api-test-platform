// src/ai.js 单测：DeepSeek 调用层。
// 为什么单独测这 14 行：它是整个「AI 生成用例」唯一的出网点，
// 以前是全项目唯一 0 覆盖的文件 —— 出网失败、回包异常、JSON 不合法
// 这三种情况下用户看到什么，之前没有任何断言保护。
// 这里用 mock fetch，不发真实请求、不烧 token。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatWithDeepSeek, chatJSON } from '../src/ai.js'

const ENV_KEYS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']
let saved

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.DEEPSEEK_API_KEY = 'sk-test'
  delete process.env.DEEPSEEK_BASE_URL
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 造一个 fetch 替身：记录调用参数，返回给定响应 */
function stubFetch(res) {
  const calls = []
  vi.stubGlobal('fetch', async (url, init) => {
    calls.push({ url, init })
    if (typeof res === 'function') return res(url, init)
    return res
  })
  return calls
}

const okBody = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) })

describe('chatWithDeepSeek', () => {
  it('没有 key 时立刻抛错，且不发请求', async () => {
    delete process.env.DEEPSEEK_API_KEY
    const calls = stubFetch(okBody('{}'))
    await expect(chatWithDeepSeek([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'DEEPSEEK_API_KEY not configured'
    )
    expect(calls).toHaveLength(0)
  })

  it('请求体符合 DeepSeek chat 接口（model / JSON 模式 / token 上限）', async () => {
    const calls = stubFetch(okBody('ok'))
    await chatWithDeepSeek([{ role: 'user', content: 'hi' }])

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(calls[0].init.body)
    expect(body.model).toBe('deepseek-chat')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    // 必须有超时，否则上游不回包时请求会一直挂着
    expect(calls[0].init.signal).toBeTruthy()
  })

  it('DEEPSEEK_BASE_URL 可覆盖默认域名', async () => {
    process.env.DEEPSEEK_BASE_URL = 'https://proxy.example.com'
    const calls = stubFetch(okBody('ok'))
    await chatWithDeepSeek([{ role: 'user', content: 'hi' }])
    expect(calls[0].url).toBe('https://proxy.example.com/v1/chat/completions')
  })

  it('非 2xx 时错误信息带上状态码与上游原文', async () => {
    stubFetch({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid api key"}',
    })
    await expect(chatWithDeepSeek([])).rejects.toThrow(/DeepSeek API error \(401\).*invalid api key/)
  })

  it('读取上游错误文本失败时也不吞掉状态码', async () => {
    stubFetch({
      ok: false,
      status: 503,
      text: async () => {
        throw new Error('body already consumed')
      },
    })
    await expect(chatWithDeepSeek([])).rejects.toThrow('DeepSeek API error (503):')
  })

  it('回包里没有 choices 时返回空串，不抛错', async () => {
    stubFetch({ ok: true, status: 200, json: async () => ({}) })
    await expect(chatWithDeepSeek([])).resolves.toBe('')
  })
})

describe('chatJSON', () => {
  it('合法 JSON 直接解析成对象', async () => {
    stubFetch(okBody('{"cases":[{"name":"a"}]}'))
    await expect(chatJSON([])).resolves.toEqual({ cases: [{ name: 'a' }] })
  })

  it('剥掉 ```json 围栏（模型最常见的"不听话"方式之一）', async () => {
    stubFetch(okBody('```json\n{"cases":[]}\n```'))
    await expect(chatJSON([])).resolves.toEqual({ cases: [] })
  })

  it('围栏不带语言标记也能剥', async () => {
    stubFetch(okBody('```\n{"a":1}\n```'))
    await expect(chatJSON([])).resolves.toEqual({ a: 1 })
  })

  it('不是合法 JSON 时抛错，并截断带上原文前 200 字便于排查', async () => {
    stubFetch(okBody('抱歉，我无法完成这个请求。'))
    await expect(chatJSON([])).rejects.toThrow(/不是合法 JSON：抱歉/)
  })

  it('空回包按非法 JSON 处理（不能静默当成 {}）', async () => {
    stubFetch({ ok: true, status: 200, json: async () => ({}) })
    await expect(chatJSON([])).rejects.toThrow('不是合法 JSON')
  })
})
