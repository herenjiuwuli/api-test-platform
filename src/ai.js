// DeepSeek API 封装（AI 生成用例模块）。
// 环境变量：DEEPSEEK_API_KEY 必填；DEEPSEEK_BASE_URL 可选（默认 https://api.deepseek.com）。
// Key 只放后端 .env，不进前端、不提交 Git。
export async function chatWithDeepSeek(messages) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured')

  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      response_format: { type: 'json_object' },
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(60000),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`DeepSeek API error (${res.status}): ${err}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

/** 调 DeepSeek 并解析严格 JSON，解析失败时抛错 */
export async function chatJSON(messages) {
  const content = await chatWithDeepSeek(messages)
  try {
    // 兼容模型偶尔用 ```json 围栏包裹的情况
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    return JSON.parse(cleaned.trim())
  } catch {
    throw new Error('AI 返回内容不是合法 JSON：' + content.slice(0, 200))
  }
}
