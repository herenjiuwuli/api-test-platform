// 自写迷你 JSONPath 求值器（不引第三方库——贴简历、可控、好讲）。
// 支持语法（覆盖常见断言场景）：
//   $              根
//   .field         对象属性
//   ['field']      对象属性（引号形式）
//   [0]            数组下标
//   [*]            数组通配（展开所有元素）
//   .length        数组长度（返回数字）
// 求值返回「匹配值数组」；路径无匹配返回 []。
// 不支持的（明确不做）：过滤器 [?()]、递归 ..、切片 [1:3]、当前节点 @。

/**
 * 按 JSONPath 取匹配值数组。
 * @param {*} root 根值（通常为解析后的 JSON）
 * @param {string} pathStr 如 $.data.list[0].name / $.items[*].id / $.data.list.length
 * @returns {*[]}
 */
export function jsonPathGet(root, pathStr) {
  if (pathStr == null) return []
  const p = String(pathStr).trim()
  if (!p) return [] // 空路径视为无匹配
  const steps = parsePath(p)
  let cur = [root]
  for (const step of steps) {
    const next = []
    for (const v of cur) {
      applyStep(v, step, next)
    }
    cur = next
    if (cur.length === 0) return [] // 提前终止
  }
  return cur
}

/** 取第一个匹配值（无匹配返回 undefined） */
export function jsonPathFirst(root, pathStr) {
  const vals = jsonPathGet(root, pathStr)
  return vals.length ? vals[0] : undefined
}

// —— 内部实现 ——

function parsePath(p) {
  const steps = []
  let i = p[0] === '$' ? 1 : 0
  while (i < p.length) {
    const c = p[i]
    if (c === '.') {
      let j = i + 1
      let name = ''
      while (j < p.length && p[j] !== '.' && p[j] !== '[') {
        name += p[j]
        j++
      }
      steps.push({ type: 'field', name })
      i = j
    } else if (c === '[') {
      let j = i + 1
      let inner = ''
      while (j < p.length && p[j] !== ']') {
        inner += p[j]
        j++
      }
      const s = inner.trim()
      if (s[0] === "'" || s[0] === '"') {
        steps.push({ type: 'field', name: s.slice(1, -1) })
      } else if (s === '*') {
        steps.push({ type: 'wild' })
      } else {
        steps.push({ type: 'index', index: Number(s) })
      }
      i = j + 1
    } else {
      i++ // 容错：跳过未知字符
    }
  }
  return steps
}

function applyStep(v, step, out) {
  if (v == null) return
  switch (step.type) {
    case 'field':
      if (step.name === 'length' && Array.isArray(v)) {
        out.push(v.length)
      } else if (typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, step.name)) {
        out.push(v[step.name])
      }
      break
    case 'index':
      if (Array.isArray(v) && Number.isInteger(step.index) && step.index >= 0 && step.index < v.length) {
        out.push(v[step.index])
      }
      break
    case 'wild':
      if (Array.isArray(v)) {
        for (const x of v) out.push(x)
      }
      break
  }
}
