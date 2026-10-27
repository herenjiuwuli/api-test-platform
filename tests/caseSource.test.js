// 用例来源（manual / ai）+ 按来源的报告聚合。
// 为什么值得单独一个测试文件：这两个数字是「AI 生成的用例靠不靠谱」的唯一证据，
// 而它最容易在两种地方悄悄失真 —— ① 脏值混进来源字段 ② 事后把 AI 用例改成 manual。
// 所以这里既测「写对了」，也测「改不掉」。
import { describe, it, expect, beforeEach } from 'vitest'
import { createCase, updateCase, getCase, listCases, saveRun } from '../src/cases.js'
import { getReportSummary } from '../src/reports.js'
import { getDb } from '../src/db.js'

function clearAll() {
  const db = getDb()
  db.exec('DELETE FROM runs')
  db.exec('DELETE FROM test_cases')
}

beforeEach(() => clearAll())

describe('用例来源：写入与归一化', () => {
  it('不传 source 时默认 manual（老调用方不用改）', () => {
    expect(createCase({ name: 'a', url: '/x' }).source).toBe('manual')
  })

  it('source=ai 时如实记录', () => {
    expect(createCase({ name: 'a', url: '/x', source: 'ai' }).source).toBe('ai')
  })

  it('大小写不敏感（AI / Ai 都算 ai），但不认近似词', () => {
    expect(createCase({ name: 'a', url: '/x', source: 'AI' }).source).toBe('ai')
    expect(createCase({ name: 'a', url: '/x', source: ' Ai ' }).source).toBe('ai')
    for (const bad of ['auto', '', null, undefined, 'x-ai', 1, 'ai-generated']) {
      expect(createCase({ name: 'b', url: '/x', source: bad }).source).toBe('manual')
    }
  })

  it('列表与详情都带 source', () => {
    const c = createCase({ name: 'ai-1', url: '/x', source: 'ai' })
    expect(listCases()[0].source).toBe('ai')
    // ⚠️ 不要用 getCase(1)：DELETE 不清 sqlite_sequence，id 会一直累加
    expect(getCase(c.id).source).toBe('ai')
  })

  it('updateCase 改不了 source —— 否则 AI 用例跑红就能手动改成人工，统计立刻自欺欺人', () => {
    const c = createCase({ name: 'a', url: '/x', source: 'ai' })
    const updated = updateCase(c.id, { name: 'a2', source: 'manual' })
    expect(updated.name).toBe('a2')
    expect(updated.source).toBe('ai')
  })
})

describe('报告：按来源聚合', () => {
  it('没有用例时两个来源都返回 0 行（前端不必写空值分支）', () => {
    const bySource = getReportSummary().bySource
    expect(bySource).toHaveLength(2)
    expect(bySource.map((x) => x.source)).toEqual(['manual', 'ai'])
    for (const s of bySource) {
      expect(s).toMatchObject({ cases: 0, runs: 0, passed: 0, failed: 0, passRate: 0 })
    }
  })

  it('AI 与人工的通过率分开算', () => {
    const ai1 = createCase({ name: 'ai-1', url: '/x', source: 'ai' })
    const ai2 = createCase({ name: 'ai-2', url: '/x', source: 'ai' })
    const man = createCase({ name: 'm-1', url: '/x' })

    // AI：跑 3 次过 1 次（33%）；人工：跑 2 次全过（100%）
    saveRun({ caseId: ai1.id, pass: true, status: 200, durationMs: 10, detail: [] })
    saveRun({ caseId: ai1.id, pass: false, status: 500, durationMs: 10, detail: [] })
    saveRun({ caseId: ai2.id, pass: false, status: 400, durationMs: 10, detail: [] })
    saveRun({ caseId: man.id, pass: true, status: 200, durationMs: 10, detail: [] })
    saveRun({ caseId: man.id, pass: true, status: 200, durationMs: 10, detail: [] })

    const bySource = getReportSummary().bySource
    const ai = bySource.find((x) => x.source === 'ai')
    const manual = bySource.find((x) => x.source === 'manual')

    expect(ai).toMatchObject({ cases: 2, runs: 3, passed: 1, failed: 2, passRate: 33 })
    expect(manual).toMatchObject({ cases: 1, runs: 2, passed: 2, failed: 0, passRate: 100 })
  })

  it('生成但一次没跑的 AI 用例也要进用例数（否则「生成 20 条只跑 3 条」会被算成 100%）', () => {
    for (let i = 0; i < 4; i++) createCase({ name: `ai-${i}`, url: '/x', source: 'ai' })
    const ai = getReportSummary().bySource.find((x) => x.source === 'ai')
    expect(ai.cases).toBe(4)
    expect(ai.runs).toBe(0)
    expect(ai.passRate).toBe(0)
  })

  it('总数与各来源的用例数对得上（不会因为 join 丢行）', () => {
    createCase({ name: 'ai-1', url: '/x', source: 'ai' })
    createCase({ name: 'm-1', url: '/x' })
    createCase({ name: 'm-2', url: '/x' })
    const s = getReportSummary()
    const sum = s.bySource.reduce((acc, x) => acc + x.cases, 0)
    expect(sum).toBe(s.totalCases)
    expect(s.totalCases).toBe(3)
  })
})
