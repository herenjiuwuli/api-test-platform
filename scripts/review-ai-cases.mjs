#!/usr/bin/env node
// 人机 Review 分析器：读「一次评测结果」+「人工标注」，把失败拆成「模型的错」和「系统的错」。
//
// 为什么不塞进 eval-ai-cases.mjs：那个脚本每次都会重新调模型、生成不同的用例，
// 而标注是绑在某一次结果上的。分析和生成分开，才谈得上「可复现」——
// 生成要花钱，分析不用，改标注也不该逼你重新花一次钱。
//
// 用法：
//   node scripts/review-ai-cases.mjs                                  # 默认 eval/ 下两个文件
//   node scripts/review-ai-cases.mjs --run a.json --review b.json
//   node scripts/review-ai-cases.mjs --json

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const getArg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const runPath = getArg('--run', 'eval/ai-cases-last-run.json')
const reviewPath = getArg('--review', 'eval/ai-cases-review.json')
const asJson = argv.includes('--json')

const run = JSON.parse(fs.readFileSync(path.resolve(runPath), 'utf8'))
const review = JSON.parse(fs.readFileSync(path.resolve(reviewPath), 'utf8'))

// 用例集合指纹：同一批用例，不管隔多久跑、跑几次，指纹都一样。
// 比 runAt 稳 —— 拿旧标注套新一批用例，是最容易得出「幻觉率 0%」的假结论。
const fingerprint = (rows) =>
  rows
    .map((r) => `${r.target}|${r.name}`)
    .sort()
    .join('\u0000')

const sameSet = review.caseSetFingerprint
  ? review.caseSetFingerprint === fingerprint(run.rows)
  : review.runAt === run.ranAt

const KINDS = ['hallucination', 'framework', 'design', 'over-strict', 'real-bug']
const tally = Object.fromEntries(KINDS.map((k) => [k, 0]))
const labeled = []
const unlabeled = []

for (const r of run.rows) {
  const key = `${r.target}|${r.name}`
  if (r.pass) continue
  const hit = review.verdicts?.[key]
  if (!hit) {
    unlabeled.push(key)
    continue
  }
  tally[hit.verdict] = (tally[hit.verdict] || 0) + 1
  labeled.push({ key, ...hit })
}

const failed = run.rows.filter((r) => !r.pass).length
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0)

const out = {
  runAt: run.ranAt,
  model: run.model,
  total: run.total,
  passed: run.passed,
  failed,
  passRate: run.passRate,
  byTarget: run.byTarget,
  setMatch: sameSet,
  tally,
  unlabeled,
  // 两个分母都给：只看一个会被误读
  hallucinationRateOfAll: pct(tally.hallucination, run.total),
  hallucinationRateOfFailed: pct(tally.hallucination, failed),
  details: labeled,
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

console.log(`评测时间 ${run.ranAt}｜模型 ${run.model}`)
console.log(`用例 ${run.total}｜通过 ${run.passed}｜失败 ${failed}｜通过率 ${run.passRate}%`)
for (const b of run.byTarget) console.log(`  - ${b.target.padEnd(6)} ${b.passed}/${b.total}  (${b.passRate}%)`)

if (!sameSet) {
  console.log('\n⚠️ 标注和这份结果不是同一批用例，下面的分类不可信。')
  console.log('   （模型每次生成的内容不同 —— 标注必须绑在它实际看过的那一批上）')
}

console.log('\n== 失败原因分类（人工标注）==')
const LABEL_TEXT = {
  hallucination: '模型自己编的（假 token / 编造结构 / 编造文案）',
  framework: '框架或实现语义差异（404 vs 405、鉴权先于方法）',
  design: '设计权衡的必然结果（如 SPA 回退）',
  'over-strict': '断言选窄了，实际行为可接受',
  'real-bug': '被测系统的真缺陷 ← 这才是 AI 用例的价值',
}
for (const k of KINDS) {
  if (tally[k]) console.log(`  ${String(tally[k]).padStart(2)}  ${k.padEnd(13)} ${LABEL_TEXT[k]}`)
}

console.log('\n== 幻觉率 ==')
console.log(`  占全部用例  ${out.hallucinationRateOfAll}%  (${tally.hallucination}/${run.total})`)
console.log(`  占失败用例  ${out.hallucinationRateOfFailed}%  (${tally.hallucination}/${failed})`)
console.log('  ⚠️ 两个口径都要报：只说「占失败 X%」会显得很高，只说「占全部 Y%」会显得很低。')

if (unlabeled.length) {
  console.log(`\n⚠️ 还有 ${unlabeled.length} 条失败没标注：`)
  for (const k of unlabeled) console.log(`   · ${k}`)
} else if (failed) {
  console.log('\n✅ 所有失败都已人工标注')
}
