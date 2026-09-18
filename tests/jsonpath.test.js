// JSONPath 求值器单测
import { describe, it, expect } from 'vitest'
import { jsonPathGet, jsonPathFirst, pathDialectHint } from '../src/jsonpath.js'

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

// 方言陷阱：`$.1.name` 是别的实现里的合法写法，本平台只认 `$[1].name`。
// 直接求值只是「静默 0 个匹配」，光看结果根本看不出是方言问题，所以要有提示（见 pathDialectHint）。
describe('真实用例踩过的方言坑（$.1 vs $[1]）', () => {
  it('$.1.name 在本实现里就是取不到（0 个匹配）', () => {
    expect(jsonPathGet(doc, '$.data.list.1.name')).toEqual([])
    expect(jsonPathGet(doc, '$.1')).toEqual([])
  })

  it('同一个位置用下标方言 $[1] 能取到', () => {
    expect(jsonPathGet(doc, '$.data.list[1].name')).toEqual(['b'])
  })

  it('失败时给出改写提示', () => {
    expect(pathDialectHint('$.data.list.1.name')).toContain('$[1]')
    expect(pathDialectHint('$.1')).toContain('$[1]')
  })

  it('正常路径不给提示（否则每条失败都多一句噪音）', () => {
    expect(pathDialectHint('$.data.list[1].name')).toBe('')
    expect(pathDialectHint('$.data.list.length')).toBe('')
    expect(pathDialectHint('$.code')).toBe('')
    // `$.a1` 这类字段名里含数字，不该被误判成下标方言
    expect(pathDialectHint('$.item2.name')).toBe('')
    expect(pathDialectHint(null)).toBe('')
  })
})
