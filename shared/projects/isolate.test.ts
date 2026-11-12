import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Project } from '../schema.ts'

const base = { id: 'p', name: '项目', createdAt: '', updatedAt: '' }

test('新建对话默认不勾独立分支：新项目默认关', () => {
  assert.equal(Project.parse(base).isolateByDefault, false)
})

test('旧字段 isolateNew 存的 true 只是之前写盘带上的默认值：读进来按新默认关，旧字段剥掉', () => {
  const p = Project.parse({ ...base, isolateNew: true, isolateDefault: false })
  assert.equal(p.isolateByDefault, false)
  assert.equal('isolateNew' in p, false)
  assert.equal('isolateDefault' in p, false)
})

test('用户在项目设置里打开的照样开着', () => {
  assert.equal(Project.parse({ ...base, isolateByDefault: true }).isolateByDefault, true)
})
