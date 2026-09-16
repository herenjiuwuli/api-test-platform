// 请求体类型的单一事实来源（M8）。
// 放在单独一个文件里而不是塞进 runner：用例的**存储层**（cases.js）也要用它做规范化，
// 而 cases.js 不该反过来依赖 runner（会形成环）。
//
//   json       默认。JS 值 → JSON.stringify，Content-Type 由用户自己写
//   raw        原样发字符串。适合 XML / CSV / GraphQL 之类的文本体
//   form-data  手搓 multipart/form-data（见 multipart.js）。Content-Type 由执行器接管
export const BODY_TYPES = ['json', 'raw', 'form-data']

export function normalizeBodyType(t) {
  const v = String(t || '')
    .trim()
    .toLowerCase()
  return BODY_TYPES.includes(v) ? v : 'json'
}
