import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Project } from './schema.ts'

const base = { id: 'p', name: '项目', createdAt: '', updatedAt: '' }

test('新建对话默认开独立分支：新项目默认开', () => {
  assert.equal(Project.parse(base).isolateNew, true)
})

test('旧项目存着的 isolateDefault: false 不算用户的选择：读进来按新默认开，旧字段剥掉', () => {
  // isolateDefault 界面从来没能改过，存的 false 只是写盘时带上的默认值
  const p = Project.parse({ ...base, isolateDefault: false })
  assert.equal(p.isolateNew, true)
  assert.equal('isolateDefault' in p, false)
})

test('用户在项目设置里关掉的照样关着', () => {
  assert.equal(Project.parse({ ...base, isolateNew: false }).isolateNew, false)
})
