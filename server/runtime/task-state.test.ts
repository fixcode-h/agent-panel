import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forgetTask, onForgetTask, taskMap, taskSet, taskStateReport } from './task-state.ts'

test('对话彻底删掉时，登记过的按对话记的状态一次清掉，别的对话的不动', () => {
  const m = taskMap<number>('测试.表')
  const s = taskSet('测试.集合')
  const forgot: string[] = []
  onForgetTask('测试.自管', (id) => forgot.push(id))
  m.set('a', 1).set('b', 2)
  s.add('a').add('b')
  forgetTask('a')
  assert.deepEqual([...m.keys()], ['b'])
  assert.deepEqual([...s], ['b'])
  assert.deepEqual(forgot, ['a'])
  const report = taskStateReport().filter((x) => x.owner.startsWith('测试.'))
  assert.deepEqual(report, [
    { owner: '测试.表', size: 1 },
    { owner: '测试.集合', size: 1 },
    { owner: '测试.自管', size: -1 },
  ])
})
