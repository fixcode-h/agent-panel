/** 文件弹窗的 JSON 树形视图：解析和搜索时自动展开 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isJsonPath, parseJsonFile, revealPaths } from '@/lib/json-tree'

test('解析：json 整份解析，jsonl 一行一条；解析不了给出原因', () => {
  assert.deepEqual(parseJsonFile('﻿{"a":1}', 'a.json'), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseJsonFile('{"a":1}\n\n{"a":2}\n', 'log.jsonl'), { ok: true, value: [{ a: 1 }, { a: 2 }] })
  assert.equal(parseJsonFile('{"a":', 'a.json').ok, false)
  const bad = parseJsonFile('{"a":1}\n{oops}\n', 'log.jsonl')
  assert.ok(!bad.ok && bad.error.startsWith('line 2:'))
  assert.ok(isJsonPath('Game.uproject') && isJsonPath('x.JSON') && !isJsonPath('a.jsonc'))
})

test('revealPaths：命中的节点的每一层上级都要展开，并记下要画到第几个子项', () => {
  const data = { name: 'shop', items: [{ id: 1 }, { id: 2, tag: 'Sword' }], other: { deep: { x: 'none' } } }
  // 值命中：根 → items（第 1 个子项）→ 第 1 项 → tag（第 1 个子项）
  assert.deepEqual(
    [...revealPaths(data, 'sword', false)!],
    [
      ['1/1', 1],
      ['1', 1],
      ['', 1],
    ],
  )
  // 键名命中：只要展开到它的上级
  assert.deepEqual(
    [...revealPaths(data, 'deep', false)!],
    [
      ['2', 0],
      ['', 2],
    ],
  )
  assert.equal(revealPaths(data, 'sword', true)!.size, 0)
  assert.equal(revealPaths(data, '', false)!.size, 0)
  // 命中太多不自动展开
  assert.equal(
    revealPaths(
      Array.from({ length: 3000 }, () => 'a'),
      'a',
      false,
    ),
    null,
  )
})
