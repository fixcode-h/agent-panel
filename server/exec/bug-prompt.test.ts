import assert from 'node:assert/strict'
import test from 'node:test'
import { BUG_CMD, BUG_FULL_TEXT, bugCommandPrompt } from '../../shared/builtin/bug-method.ts'
import { bugMethodPrompt, bugSlash } from './bug-prompt.ts'

/** /bug 的展开和用户报的 Bug 第一轮注入的完整流程（ADR 0046） */

test('/bug：父对话派 kind: "bug" 子对话，子对话就地交诊断报告，别的会话在回复里给报告；不是 /bug 不管', () => {
  assert.ok(BUG_CMD.test('/bug 角标不刷新'))
  assert.ok(BUG_CMD.test('/bug'))
  assert.ok(!BUG_CMD.test('/bugs'))
  assert.ok(!BUG_CMD.test('看看 /bug'))
  const parent = bugSlash('/bug 角标不刷新', { parentTaskId: '' }, true)!
  assert.match(parent, /create_conversation 派子对话并写 kind: "bug"/)
  assert.match(parent, /## 用户报的 Bug\n角标不刷新/)
  assert.ok(!parent.includes(BUG_FULL_TEXT), '父对话只派单，不用带完整方法')
  const child = bugSlash('/bug 角标不刷新', { parentTaskId: 'p' }, false)!
  assert.match(child, /submit_diagnosis 分阶段交报告.*每一步用户同意之前不改任何文件/)
  assert.ok(child.includes(BUG_FULL_TEXT))
  assert.match(bugSlash('/bug', { parentTaskId: '' }, false)!, /把诊断报告写在回复里，结束这一轮，等用户回复同意再改/)
  assert.equal(bugSlash('/fix 角标', { parentTaskId: '' }, true), undefined)
  assert.equal(bugCommandPrompt('solo', '', false).includes(BUG_FULL_TEXT), false)
})

test('/bug：有项目的普通对话已经标成 Bug，就地交诊断报告，没有父对话的收尾改成自己提交（分析稿 B10）', () => {
  const inplace = bugSlash('/bug 角标不刷新', { parentTaskId: '', bug: true }, false)!
  assert.match(inplace, /submit_diagnosis 分阶段交报告/)
  assert.match(inplace, /没有父对话.*submit_merge.*本地提交/)
  assert.ok(inplace.includes(BUG_FULL_TEXT))
  // 子对话照旧，不带普通对话的收尾说明
  assert.doesNotMatch(bugSlash('/bug 角标', { parentTaskId: 'p', bug: true }, false)!, /这是普通对话/)
})

test('用户报的 Bug 新会话第一轮带完整流程；续接的会话、不是 Bug、这一轮就是 /bug 时不重复带', () => {
  assert.equal(bugMethodPrompt({ bug: true }, '角标不刷新', true), BUG_FULL_TEXT)
  assert.equal(bugMethodPrompt({ bug: true }, '角标不刷新', false), '')
  assert.equal(bugMethodPrompt({ bug: false }, '角标不刷新', true), '')
  assert.equal(bugMethodPrompt({ bug: true }, '/bug 角标不刷新', true), '')
})

test('父对话刚升级成 Bug 的子对话：续接的会话也补带一次完整流程；没升级、不是 Bug 的不带', () => {
  assert.equal(bugMethodPrompt({ bug: true, bugMethodPending: true }, '父对话交代的话', false), BUG_FULL_TEXT)
  assert.equal(bugMethodPrompt({ bug: false, bugMethodPending: true }, '父对话交代的话', false), '')
  assert.equal(bugMethodPrompt({ bug: true, bugMethodPending: true }, '/bug 角标', false), '')
})
