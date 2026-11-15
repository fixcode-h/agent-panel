import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roleSkillDirNote, runSkillNames, runSkillsNote } from './activation.ts'

test('这一轮要带的技能：只算按项目的，项目打开的加角色点名的，去重排序', () => {
  const mode = ['ue-blueprint', 'tables', 'brainstorming']
  assert.deepEqual(runSkillNames(mode, ['tables', 'global-one'], ['brainstorming', 'tables']), [
    'brainstorming',
    'tables',
  ])
  // 没有项目（Chat）时只带角色点名的
  assert.deepEqual(runSkillNames(mode, undefined, ['ue-blueprint']), ['ue-blueprint'])
  assert.deepEqual(runSkillNames([], ['tables'], ['tables']), [])
})

test('不能按会话加载技能的 CLI：提示里列出技能和 SKILL.md 的路径', () => {
  const note = runSkillsNote('/d', [
    { name: 'a', description: '做 A' },
    { name: 'b', description: '' },
  ])
  assert.match(note, /- a：做 A（`\/d\/a\/SKILL\.md`）/)
  assert.match(note, /- b：（没有说明）/)
  assert.equal(runSkillsNote('/d', []), '')
  assert.equal(roleSkillDirNote('/d', []), '')
  assert.match(roleSkillDirNote('/d', ['a', 'b']), /a、b 这一轮放在 `\/d`/)
})
