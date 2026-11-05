/**
 * CLI 发来的确认请求什么时候由面板直接允许：命中这个对话的放行规则，或者权限是「跳过所有确认」这类一档
 * （CLI 定义里标了 autoAllow）。用户选了跳过所有确认，Claude Code 删除工作目录这类自带安全检查仍会发确认，
 * 以前原样弹给用户。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import { getCli } from '../../shared/clis.ts'
import type { Task } from '../../shared/schema.ts'
import { autoAllowed } from './ask-request.ts'

setLang('zh')

const meta = { id: 'm1', step: '', agentId: 'a' }
const newTask = () => ({ id: 't', messages: [], allowRules: [] }) as unknown as Task
const ask = (kind: 'tool' | 'question') => {
  const got: { allow: boolean }[] = []
  return {
    got,
    ev: { type: 'ask', kind, title: '运行命令：rmdir x', detail: '', reply: (r: any) => got.push(r) } as any,
  }
}

test('跳过所有确认：CLI 仍发来的确认直接允许并留一行说明，提问照常弹出', () => {
  const task = newTask()
  const tool = ask('tool')
  assert.equal(autoAllowed(task, tool.ev, meta, '跳过所有确认'), true)
  assert.deepEqual(tool.got, [{ allow: true }])
  assert.match(task.messages.at(-1)!.text, /权限是「跳过所有确认」，自动允许：运行命令：rmdir x/)

  const q = ask('question')
  assert.equal(autoAllowed(task, q.ev, meta, '跳过所有确认'), false)
  assert.equal(q.got.length, 0)
})

test('其他权限：没有放行规则时照常弹审批卡', () => {
  const task = newTask()
  const tool = ask('tool')
  assert.equal(autoAllowed(task, tool.ev, meta), false)
  assert.equal(tool.got.length, 0)
  assert.equal(task.messages.length, 0)
})

test('只有不确认的那一档标了 autoAllow', () => {
  const on = (cli: string) =>
    getCli(cli)!
      .permissions.filter((p) => p.autoAllow)
      .map((p) => p.id)
  assert.deepEqual(on('claude'), ['bypassPermissions'])
  assert.deepEqual(on('codex'), ['danger-full-access'])
  assert.deepEqual(on('commandcode'), ['yolo'])
})
