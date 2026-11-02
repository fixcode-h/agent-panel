/**
 * 推送授权（ask_push）的回答记在哪：只在用户点「允许 / 拒绝」时（answerRequest）写 task.remotePush，
 * 关掉卡片、停止、「提问」关着的自动作答都不写。c5e5c5d8 加了这个字段却一直没有写入点。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import type { Task } from '../../shared/schema.ts'
import { NO_PUSH_ANSWER, pushAnswerCut } from '../../shared/push-auth.ts'
import { wrapUpFrom } from '../tasks/helpers.ts'
import { askPushRequest } from './panel-requests.ts'
import { answerRequest, autoAnswerQuestions, dropRequests } from './requests.ts'

setLang('zh')

test('推送授权卡：不被「提问」开关自动作答，点了才记进任务，关掉卡片和停止都不记；收尾按回答现算', async () => {
  const task = { id: 'push', mode: 'chat', projectId: 'p', messages: [], steps: [], requests: [] } as unknown as Task
  let n = 0
  const abort = new AbortController()
  const ctx = { task, signal: abort.signal, newId: () => `r${++n}`, changed: () => {} }
  // 还没回答：项目设置「问一次」时没有推送收尾，回答之后才有（server/tasks/run.ts 把它写成 getter 现算）
  const probe = { p4: false, git: true }
  assert.equal(wrapUpFrom(task, probe, 'ask'), undefined)

  // 用户关掉卡片（终止对话）：不算拒绝
  const closed = askPushRequest(ctx, { branch: 'dev', summary: '修好登录' })
  const [req] = task.requests
  assert.equal(req.kind, 'tool')
  assert.equal(req.purpose, 'push')
  assert.match(req.detail, /分支：dev\n修好登录\n这个对话里只问这一次/)
  autoAnswerQuestions(task)
  assert.equal(task.requests.length, 1, '「提问」关着时的自动作答只管问题，授权卡还在等用户')
  dropRequests(task)
  assert.match((await closed)!.message ?? '', /终止了对话/)
  assert.equal(task.remotePush, undefined, '关掉卡片不记成拒绝')

  // 停止任务：作废，返回 null，也不记
  const stopped = askPushRequest(ctx, {})
  abort.abort()
  assert.equal(await stopped, null)
  assert.equal(task.requests.length, 0)
  assert.equal(task.remotePush, undefined)

  // 点「允许」：同步写进任务（和回答消息一起落盘），收尾马上变成推送
  const live = { ...ctx, signal: new AbortController().signal }
  const allowed = askPushRequest(live, {})
  assert.ok(answerRequest(task, task.requests[0].id, { allow: true }, () => 'm1'))
  assert.equal(task.remotePush, 'allowed')
  assert.ok(task.remotePushAt)
  assert.equal((await allowed)?.allow, true)
  assert.match(task.messages.at(-1)!.text, /你允许了：推送到远端并合并主干/)
  assert.equal(wrapUpFrom(task, probe, 'ask'), 'push')

  // 点「拒绝」：记成拒绝，推送收尾去掉
  const denied = askPushRequest(live, {})
  answerRequest(task, task.requests[0].id, { allow: false }, () => 'm2')
  assert.equal((await denied)?.allow, false)
  assert.equal(task.remotePush, 'denied')
  assert.equal(wrapUpFrom(task, probe, 'ask'), 'none')

  // 撤回：回答在被撤掉的那段里才清；分叉一律清（NO_PUSH_ANSWER 浅合并盖掉旧值）
  const at = task.remotePushAt!
  assert.equal(pushAnswerCut(task, '2000-01-01T00:00:00.000Z'), true)
  assert.equal(pushAnswerCut(task, '2999-01-01T00:00:00.000Z'), false)
  assert.equal(pushAnswerCut({ remotePush: 'allowed' }, at), true, '没记时间的旧回答偏保守，重新问')
  assert.equal(pushAnswerCut({}, at), false)
  assert.deepEqual({ ...task, ...NO_PUSH_ANSWER }.remotePush, undefined)
})
