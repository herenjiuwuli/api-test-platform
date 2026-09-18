// 自写迷你 JSONPath 求值器（不引第三方库——贴简历、可控、好讲）。
// 支持语法（覆盖常见断言场景）：
//   $              根
//   .field         对象属性
//   ['field']      对象属性（引号形式）
//   [0]            数组下标
//   [*]            数组通配（展开所有元素）
//   .length        数组长度（返回数字）
// 求值返回「匹配值数组」；路径无匹配返回 []。
// 不支持的（明确不做）：过滤器 [?()]、递归 ..、切片 [1:3]、当前节点 @、
//   以及 `$.1`（点号后跟数字）这种方言 —— 数组下标统一写 `$[1]`；
//   真被写成 `$.1` 时，断言失败信息会用 pathDialectHint() 提示改写方式。

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

/**
 * 判断路径是不是用了「别的 JSONPath 方言」，给一句改写提示。
 *
 * 为什么需要：`$.1.name`（点号后跟数字）在某些 JSONPath 实现里合法，但本实现只认 `$[1].name`
 * （见文件头的支持清单）。求值会**静默返回 0 个匹配**，断言里显示「匹配 0 个」——
 * 用户很难想到「不是数据不对，是方言不对」。所以失败时主动把改写方式说出来。
 *
 * @param {string} pathStr
 * @returns {string} 提示文案；不是方言问题则返回空串
 */
export function pathDialectHint(pathStr) {
  const p = String(pathStr == null ? '' : pathStr)
  // 「.数字」且后面不是字段名的一部分（如 $.data.list.0 / $.1.name）
  if (/\.\d+(?![\w$])/.test(p)) {
    return `（提示：本平台的数组下标请写 $[1] 形式，不支持 $.1 这种写法）`
  }
  return ''
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
