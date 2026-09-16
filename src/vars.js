// 变量与用例链（M4）：让「需要登录的接口」也能被平台测到。
//
// 为什么需要它：runner 一次只发一个请求，而真实系统是**有状态**的 ——
// 你得先登录拿到 token，才能测后面的接口。没有变量传递，平台只能测 /health 这类公开接口，
// 「用平台测穿一个真系统」就是空话。
//
// 方案（三步，都在这里落地）：
//   ① 用例的 url / headers / body 里可以写 {{var}} 占位；
//   ② 用例可以声明 extract：从**本用例的响应**里按 JSONPath 抽值，写进变量袋；
//   ③ run-all 按「创建顺序」把用例串成一条链，共享同一个变量袋 → 登录抽的 token 后面的用例直接用。
//
// 设计取舍：
//   - 变量袋是**运行期内存**的，不落库 —— token 这种东西不该进数据库，也不该跨运行复用（容易用过期值假装通过）。
//   - 变量缺失**不直接判失败**，只在 detail 里写明「谁没赋值」。因为缺了变量，请求本身也会失败（大概率 401），
//     两处都报会让人分不清真正原因；写明来源比多一条红更有用。
import { jsonPathGet } from './jsonpath.js'

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g

/**
 * 把值里的 {{var}} 替换成变量袋里的实际值（递归处理字符串/数组/对象）。
 * @returns {{value:*, missing:string[]}} missing = 出现了但没赋值的变量名（去重）
 */
export function renderTemplate(value, vars = {}) {
  const missing = new Set()
  const walk = (v) => {
    if (typeof v === 'string') {
      return v.replace(PLACEHOLDER, (_, name) => {
        const val = vars[name]
        if (val === undefined || val === null) {
          missing.add(name)
          return '' // 缺失替换成空串：请求会如实失败，而不是把 "{{token}}" 当字符串发出去
        }
        return String(val)
      })
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v)) out[k] = walk(v[k])
      return out
    }
    return v
  }
  return { value: walk(value), missing: [...missing] }
}

/**
 * 按 extract 声明从响应体里抽变量。
 * @param {string} text 响应原文
 * @param {Array<{name:string,path:string}>} extractList
 * @returns {Record<string,string>} 抽到的变量（值统一转成字符串，便于塞进 header/body）
 */
export function applyExtract(text, extractList = []) {
  const out = {}
  if (!Array.isArray(extractList) || extractList.length === 0) return out
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return out // 响应不是 JSON，抽不出东西；用例本身的断言会报失败，这里不重复报
  }
  for (const item of extractList) {
    if (!item || !item.name || !item.path) continue
    const vals = jsonPathGet(parsed, item.path)
    if (vals.length === 0) continue
    const v = vals[0]
    out[item.name] = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  return out
}

/** 新建一个变量袋（run-all 每次运行都用新的，避免上次运行的 token 泄漏进这次） */
export function createVarBag(init = {}) {
  return { ...init }
}

/** 变量缺失时的提示文案（写进用例 detail，帮人一眼看出「链上前面没跑到抽取它的用例」） */
export function missingVarNote(missing) {
  if (!missing || missing.length === 0) return null
  return `未赋值变量：${missing.map((m) => `{{${m}}}`).join('、')} —— 请用「全部运行」跑用例链，抽取该变量的用例需排在它前面`
}
