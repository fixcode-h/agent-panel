import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alwaysSkillsNote, runSkillNames, runSkillsNote } from './activation.ts'

test('这一轮要带的技能：角色点名的都带，按项目的技能只在项目打开时带，去重排序', () => {
  const mode = ['ue-blueprint', 'tables', 'brainstorming']
  assert.deepEqual(runSkillNames(mode, ['tables', 'global-one'], ['brainstorming', 'tables']), [
    'brainstorming',
    'tables',
  ])
  // 没有项目（Chat）时只带角色点名的
  assert.deepEqual(runSkillNames(mode, undefined, ['ue-blueprint']), ['ue-blueprint'])
  // 角色自带的不管是不是按项目都带（ADR 0083：启动时只带角色的技能，其余由面板推）；没点名的全局技能不带
  assert.deepEqual(runSkillNames([], ['tables'], ['tables']), ['tables'])
  assert.deepEqual(runSkillNames([], ['tables'], []), [])
})

test('不能按会话加载技能的 CLI：提示里列出技能和 SKILL.md 的路径', () => {
  const note = runSkillsNote('/d', [
    { name: 'a', description: '做 A' },
    { name: 'b', description: '' },
  ])
  assert.match(note, /- a：做 A（`\/d\/a\/SKILL\.md`）/)
  assert.match(note, /- b：（没有说明）/)
  assert.equal(runSkillsNote('/d', []), '')
  assert.match(note, /^## 这一轮带的技能/)
  assert.equal(alwaysSkillsNote('/d', []), '')
  assert.match(alwaysSkillsNote('/d', ['a', 'b']), /`a`、`b`，SKILL\.md 在 `\/d\/<名字>\/SKILL\.md`/)
})
