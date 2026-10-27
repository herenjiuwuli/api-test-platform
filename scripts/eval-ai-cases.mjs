#!/usr/bin/env node
// AI 生成用例的质量评测：让模型对真实接口设计用例 → 落库（source=ai）→ 真跑一遍 → 出通过率。
//
// 为什么要有这个脚本：
// 「AI 生成用例」这个功能一直在，但从来没人回答过「生成出来的东西能不能用」。
// 而这个问题的答案不是靠嘴说——要么有数字，要么没有。
// 数字分两层：① 通过率（能自动算）② 幻觉率（要人看失败原因，脚本只负责把证据摆出来）。
//
// 用法：
//   node scripts/eval-ai-cases.mjs                 # 跑内置三组目标接口
//   node scripts/eval-ai-cases.mjs --json          # 只输出 JSON（给别的脚本吃）
//   node scripts/eval-ai-cases.mjs --save x.json   # 同时存一份结果
//
// 注意：会真实调用 DeepSeek（有 token 成本）。库用内存库，不污染 data/app.db。

import 'dotenv/config'
import fs from 'node:fs'
import crypto from 'node:crypto'

// 必须在 import db 之前定 DB_PATH —— 模块加载时就建库，晚了就写到开发库里去了
process.env.DB_PATH = process.env.DB_PATH || ':memory:'
// 鉴权必须真的开着：否则「AI 没带 token」这类失败永远测不出来
delete process.env.API_AUTH_DISABLED

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const saveIdx = argv.indexOf('--save')
const savePath = saveIdx >= 0 ? argv[saveIdx + 1] : null
const reviewIdx = argv.indexOf('--review')
const reviewPath = reviewIdx >= 0 ? argv[reviewIdx + 1] : null

if (!process.env.DEEPSEEK_API_KEY) {
  console.error('缺 DEEPSEEK_API_KEY（放 .env 里）。这个评测必须真调模型，打桩测不出幻觉。')
  process.exit(2)
}

const { buildApp } = await import('../index.js')
const { generateCases } = await import('../src/aiCases.js')
const { createCase } = await import('../src/cases.js')
const { runCase } = await import('../src/runner.js')
const { initDefaultUser } = await import('../src/users.js')

// ⚠️ 内存库是空的：不种用户的话，「正确账号密码登录」必然 401 ——
// 那会把「评测环境没数据」冤枉成「AI 不会写用例」。这一步就是评测的"带干粮"。
initDefaultUser()

// 默认管理员口令（与 src/users.js 的 initDefaultUser 一致）。
// 曾经在参数里写错成别的，导致 login 组 8 条只过 1 条 —— 归因时差点记到 AI 头上。
const ADMIN = { username: 'admin', password: 'admin123' }

// 三组目标接口，刻意覆盖三种"模型容易想歪"的场景：
//   ① 公开 + 语义清楚（login）→ 应该写得好
//   ② 公开 + 太简单（health）→ 容易编出根本不存在的错误行为
//   ③ 需要登录（/api/cases）→ 模型几乎必然编一个假 token，或干脆不带
const TARGETS = [
  {
    id: 'login',
    method: 'POST',
    path: '/api/auth/login',
    body: ADMIN,
    desc: '账号密码登录。正确凭据返回 200 + token；密码错 401；缺字段 400。',
  },
  {
    id: 'health',
    method: 'GET',
    path: '/health',
    desc: '健康检查，永远返回 200 和 {ok:true}。没有参数、没有错误分支。',
  },
  {
    id: 'cases',
    method: 'GET',
    path: '/api/cases',
    desc: '查询全部用例列表。需要登录态：请求头带 Authorization: Bearer <登录拿到的 token>。',
  },
]

const app = buildApp()
await app.listen({ port: 0, host: '127.0.0.1' })
const base = `http://127.0.0.1:${app.server.address().port}`

const rows = []
let genFailed = 0

for (const t of TARGETS) {
  const url = base + t.path
  if (!asJson) console.log(`\n== 生成：${t.method} ${t.path} ==`)
  let cases = []
  try {
    cases = await generateCases({ method: t.method, url, body: t.body, description: t.desc })
  } catch (e) {
    genFailed++
    if (!asJson) console.log(`  ✗ 生成失败：${e.message}`)
    rows.push({ target: t.id, genError: e.message })
    continue
  }

  for (const c of cases) {
    const saved = createCase({ ...c, source: 'ai' })
    const result = await runCase(saved)
    // ⚠️ runner 的 detail 是**字符串数组**（每条一句话说清楚哪条断言不成立），不是对象数组。
    // 第一版按 {name, note} 读，屏幕上全是 undefined —— 连失败原因都读不出来，就别谈人机 review 了。
    const failedChecks = (result.detail || []).map((d) => String(d))
    rows.push({
      target: t.id,
      caseId: saved.id,
      name: saved.name,
      method: saved.method,
      url: saved.url,
      expected: saved.expected,
      pass: result.pass,
      status: result.status,
      durationMs: result.durationMs,
      failedChecks,
      // 模型自己编的断言文本，是判断"幻觉"还是"真缺陷"的原始证据
      expectationText: JSON.stringify(saved.expected),
    })
    if (!asJson) {
      const mark = result.pass ? '✅' : '❌'
      console.log(`  ${mark} ${saved.name}  → 实际 ${result.status}`)
      if (!result.pass) {
        for (const f of failedChecks) console.log(`       · ${f}`)
      }
    }
  }
}

await app.close()

// —— 汇总：通过率按目标分组也报一次 ——
const ran = rows.filter((r) => !r.genError)
const passed = ran.filter((r) => r.pass)
const rate = (a, b) => (b ? Math.round((a / b) * 100) : 0)

const byTarget = TARGETS.map((t) => {
  const list = ran.filter((r) => r.target === t.id)
  return {
    target: t.id,
    total: list.length,
    passed: list.filter((r) => r.pass).length,
    passRate: rate(list.filter((r) => r.pass).length, list.length),
  }
})

const summary = {
  ranAt: new Date().toISOString(),
  model: 'deepseek-chat',
  // 用例集合指纹：同一批用例不管隔多久跑都相同，比 ranAt 更适合做「标注绑定」的凭据。
  // 拿旧标注套新一批用例，最容易得出「幻觉率 0%」这种假结论。
  caseSetFingerprint: crypto
    .createHash('sha256')
    .update(ran.map((r) => `${r.target}|${r.name}`).sort().join('\u0000'))
    .digest('hex')
    .slice(0, 16),
  genFailed,
  total: ran.length,
  passed: passed.length,
  failed: ran.length - passed.length,
  passRate: rate(passed.length, ran.length),
  byTarget,
  rows,
}

// —— 人机 Review：读人工标注，把「失败」拆成「模型的错」和「系统的错」——
// 这一步不能自动化。通过率只能回答「能不能跑过」，回答不了「跑不过是谁的问题」。
// 而 JD 里那句「识别 AI 生成用例的幻觉」要的正是后者的比例。
let review = null
if (reviewPath) {
  const raw = JSON.parse(fs.readFileSync(reviewPath, 'utf8'))
  if (raw.runAt !== summary.ranAt) {
    console.error(
      `\n⚠️ 标注对不上这次运行：标注 runAt=${raw.runAt}，本次=${summary.ranAt}\n` +
        '   模型每次生成的内容不同，标注必须绑定同一次运行。重跑就用本次的 --save 结果重新标。'
    )
  }
  const KINDS = ['hallucination', 'framework', 'design', 'over-strict', 'real-bug']
  const tally = Object.fromEntries(KINDS.map((k) => [k, 0]))
  const unlabeled = []
  for (const r of ran.filter((x) => !x.pass)) {
    const hit = raw.verdicts[`${r.target}|${r.name}`]
    if (!hit) unlabeled.push(`${r.target}|${r.name}`)
    else tally[hit.verdict] = (tally[hit.verdict] || 0) + 1
  }
  const hallucination = tally.hallucination || 0
  review = {
    labeledBy: raw.reviewer || '人工',
    runAtMatch: raw.runAt === summary.ranAt,
    tally,
    unlabeled,
    // 两个口径都给：分母不同，单看一个容易被误读
    hallucinationRateOfAll: summary.total ? Math.round((hallucination / summary.total) * 100) : 0,
    hallucinationRateOfFailed: summary.failed ? Math.round((hallucination / summary.failed) * 100) : 0,
  }
  summary.review = review
}

if (savePath) {
  fs.writeFileSync(savePath, JSON.stringify(summary, null, 2))
  if (!asJson) console.log(`\n已存 ${savePath}`)
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log('\n== 汇总 ==')
  console.log(`  生成失败接口：${genFailed} 个`)
  console.log(`  用例 ${summary.total} 条｜通过 ${summary.passed}｜失败 ${summary.failed}｜通过率 ${summary.passRate}%`)
  for (const b of byTarget) {
    console.log(`  - ${b.target.padEnd(6)} ${b.passed}/${b.total}  (${b.passRate}%)`)
  }

  if (review) {
    console.log(`\n== 人机 Review（标注来自 ${reviewPath}）==`)
    if (!review.runAtMatch) console.log('  ⚠️ 标注与本次运行不是同一次，下面的分类仅供参考')
    for (const [k, v] of Object.entries(review.tally)) {
      if (v) console.log(`  ${k.padEnd(14)} ${v}`)
    }
    console.log(
      `  幻觉率：占全部 ${review.hallucinationRateOfAll}%（${review.tally.hallucination}/${summary.total}）` +
        `｜占失败 ${review.hallucinationRateOfFailed}%（${review.tally.hallucination}/${summary.failed}）`
    )
    if (review.unlabeled.length) {
      console.log(`  ⚠️ 还有 ${review.unlabeled.length} 条失败没标注：${review.unlabeled.join(' / ')}`)
    }
  } else {
    console.log('\n⚠️ 失败不等于「AI 不行」—— 逐条看是接口打错（幻觉）/ 断言编的 / 缺鉴权。')
    console.log('   加 --review eval/ai-cases-review.json 可以按人工标注算出幻觉率。')
  }
}

// 失败数 > 0 时不返回非零退出码：这是评测，不是门禁。
process.exit(0)
