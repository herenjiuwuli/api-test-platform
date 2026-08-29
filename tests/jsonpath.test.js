// JSONPath 求值器单测
import { describe, it, expect } from 'vitest'
import { jsonPathGet, jsonPathFirst } from '../src/jsonpath.js'

const doc = {
  code: 0,
  msg: 'ok',
  data: {
    list: [
      { id: 1, name: 'a', tags: ['x', 'y'] },
      { id: 2, name: 'b', tags: ['z'] },
    ],
    total: 2,
  },
}

describe('jsonPathGet', () => {
  it('根 $ 返回整体', () => {
    expect(jsonPathGet(doc, '$')).toEqual([doc])
  })

  it('点路径取对象属性', () => {
    expect(jsonPathGet(doc, '$.code')).toEqual([0])
    expect(jsonPathGet(doc, '$.data.total')).toEqual([2])
    expect(jsonPathGet(doc, '$.msg')).toEqual(['ok'])
  })

  it('数组下标 [0]', () => {
    expect(jsonPathGet(doc, '$.data.list[0].name')).toEqual(['a'])
    expect(jsonPathGet(doc, '$.data.list[1].id')).toEqual([2])
  })

  it('引号属性 [\'field\']', () => {
    expect(jsonPathGet(doc, "$['code']")).toEqual([0])
    expect(jsonPathGet(doc, "$.data['list'][0]['name']")).toEqual(['a'])
  })

  it('数组通配 [*] 展开所有元素', () => {
    const ids = jsonPathGet(doc, '$.data.list[*].id')
    expect(ids).toEqual([1, 2])
  })

  it('.length 取数组长度', () => {
    expect(jsonPathGet(doc, '$.data.list.length')).toEqual([2])
    expect(jsonPathGet(doc, '$.data.list[0].tags.length')).toEqual([2])
  })

  it('路径无匹配返回空数组', () => {
    expect(jsonPathGet(doc, '$.data.nope')).toEqual([])
    expect(jsonPathGet(doc, '$.data.list[9]')).toEqual([])
    expect(jsonPathGet(doc, '$.data.list[0].nope')).toEqual([])
  })

  it('空/null 输入容错', () => {
    expect(jsonPathGet(null, '$.a')).toEqual([])
    expect(jsonPathGet(doc, '')).toEqual([])
    expect(jsonPathGet(doc, null)).toEqual([])
  })

  it('jsonPathFirst 取首个匹配', () => {
    expect(jsonPathFirst(doc, '$.data.list[*].id')).toBe(1)
    expect(jsonPathFirst(doc, '$.nope')).toBeUndefined()
  })
})
