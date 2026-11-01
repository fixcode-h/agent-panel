/**
 * 用户拒绝权限请求后交给模型的提醒：第一次说别原样重试、需要就问；同一个操作第 2 次被拒说停下来问用户。
 * 每次请求照样弹给用户，面板不替用户拒绝。实测（问题 13）同一条 git commit 被拒后 40 秒里又发了 6 次。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import type { Task } from '../../shared/schema.ts'
import type { AskReply, CliEvent } from './parsers.ts'
import { answerRequest } from './runner.ts'
import { replies } from './panel-requests.ts'
import { denyAdvice } from './deny-advice.ts'
import { claudeAdapter } from './rpc/claude.ts'
import { codexAppSession } from './rpc/codex.ts'
import type { RpcContext } from './rpc/types.ts'
import { heldIds, heldMessage, holdForNextTurn, returnHeld, takeHeld } from './delivery.ts'

setLang('zh')

const chat = (id: string) => ({ id, mode: 'chat', messages: [], steps: [], requests: [] }) as unknown as Task

/** 在任务上挂一条等用户回答的请求，返回交回 CLI 的那句 */
function ask(task: Task, id: string, kind: 'command' | 'tool' | 'question', title: string) {
  let got: AskReply | undefined
  replies.set(id, (r) => (got = r))
  task.requests.push({ id, step: '', agentId: '', kind, title, detail: '', options: [], at: '' })
  return () => got
}

test('拒绝同一条命令：第一次提醒别重试，第二次要它停下来问，对话里写明第几次；允许后重新计数', () => {
  const task = chat('deny-1')
  let n = 0
  const id = () => `m${++n}`
  const cmd = '运行命令：git -c user.name=x commit -m fix'

  const first = ask(task, 'r1', 'command', cmd)
  assert.equal(answerRequest(task, 'r1', { allow: false }, id), true)
  assert.match(first()!.advice ?? '', /不要用同样或等价的命令重试/)
  assert.equal(task.messages.at(-1)!.text, `你拒绝了：${cmd}`)

  // 同一条命令再来：卡片照样弹给用户，用户点了拒绝才回 CLI；这次要它停下这一轮问用户
  const second = ask(task, 'r2', 'command', cmd)
  assert.equal(task.requests.length, 1, '面板不替用户拒绝')
  answerRequest(task, 'r2', { allow: false }, id)
  assert.match(second()!.advice ?? '', /已经拒绝了 2 次.*结束这一轮/)
  assert.equal(task.messages.at(-1)!.text, `你拒绝了：${cmd}（第 2 次，已让它停下来问你）`)

  // 别的命令单独数
  const other = ask(task, 'r3', 'command', '运行命令：rm -rf dist')
  answerRequest(task, 'r3', { allow: false }, id)
  assert.match(other()!.advice ?? '', /不要用同样或等价的命令重试/)

  // 用户后来允许了同一条：计数清零
  ask(task, 'r4', 'command', cmd)
  answerRequest(task, 'r4', { allow: true }, id)
  const again = ask(task, 'r5', 'command', cmd)
  answerRequest(task, 'r5', { allow: false }, id)
  assert.doesNotMatch(again()!.advice ?? '', /2 次/)
})

test('提问、节点确认、推送授权卡的拒绝不加提醒', () => {
  const r = { allow: false }
  assert.equal(denyAdvice({ id: 'd2' }, { kind: 'question', title: 'q' }, r).reply.advice, undefined)
  assert.equal(denyAdvice({ id: 'd2' }, { kind: 'confirm', title: 'c' }, r).reply.advice, undefined)
  assert.equal(denyAdvice({ id: 'd2' }, { kind: 'tool', title: 'p', purpose: 'push' }, r).reply.advice, undefined)
})

function fakeCtx() {
  const events: CliEvent[] = []
  const sent: any[] = []
  const ctx = {
    cwd: '/tmp',
    input: '',
    images: [],
    finished: false,
    send: (r: Record<string, unknown>) => sent.push(r),
    request: async () => undefined,
    emit: (e: CliEvent | CliEvent[]) => events.push(...(Array.isArray(e) ? e : [e])),
    finish: async () => false,
    hold: () => {},
  } as unknown as RpcContext
  return { ctx, events, sent }
}

test('Claude Code：提醒接在拒绝的话后面，作为工具结果交给模型', () => {
  const { ctx, events, sent } = fakeCtx()
  claudeAdapter({ cwd: '/tmp', input: '', parse: () => [] }).request!(ctx, {
    type: 'control_request',
    request_id: 'q1',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git commit -m x' } },
  })
  const ev = events[0]
  if (ev.type !== 'ask') return assert.fail('应该是请求')
  ev.reply({ allow: false, advice: '别重试' })
  assert.deepEqual(sent[0].response.response, { behavior: 'deny', message: '用户拒绝了这个操作\n别重试' })
})

test('Codex：审批只能回 decline，提醒随后插话交给还在跑的这一轮', async () => {
  const sent: any[] = []
  const events: CliEvent[] = []
  const session = codexAppSession({
    cwd: '/work',
    input: '提交',
    model: '',
    effort: '',
    permission: '',
    extraArgs: [],
    platform: 'linux',
    onEvent: (e) => events.push(e),
  })
  const tick = () => new Promise((r) => setTimeout(r, 0))
  session.start({ write: (s) => sent.push(JSON.parse(s)), end: () => {} })
  for (const m of [
    { id: 1, result: {} },
    { id: 2, result: { thread: { id: 'thr' } } },
    { id: 3, result: { turn: { id: 'turn_1', status: 'inProgress' } } },
    { method: 'turn/started', params: { threadId: 'thr', turn: { id: 'turn_1' } } },
    { id: 99, method: 'item/commandExecution/requestApproval', params: { command: 'git commit -m x' } },
  ]) {
    session.handle(m)
    await tick()
  }
  const ev = events.find((e) => e.type === 'ask')
  if (ev?.type !== 'ask') return assert.fail('应该是请求')
  ev.reply({ allow: false, advice: '别重试' })
  await tick()
  assert.deepEqual(sent.find((m) => m.id === 99)?.result, { decision: 'decline' })
  const steer = sent.find((m) => m.method === 'turn/steer')
  assert.equal(steer?.params.input[0].text, '别重试')
  assert.equal(steer?.params.expectedTurnId, 'turn_1')
})

test('子对话执行中父对话接连交代的信排在一起时合成一轮，中间夹着用户消息就不合', () => {
  const id = 'letters'
  const letter = (mid: string, text: string) => ({
    id: mid,
    role: 'user' as const,
    agentId: '',
    step: '',
    text,
    tools: [],
    at: '',
    peer: { id: 'p', title: '', name: '', rel: 'parent' as const, kind: 'task' as const, subject: '' },
  })
  holdForNextTurn(id, letter('a', '先修 A'))
  holdForNextTurn(id, letter('b', '顺便看 B'))
  holdForNextTurn(id, { ...letter('u', '用户的话'), peer: undefined })
  holdForNextTurn(id, letter('c', '再看 C'))
  const first = takeHeld(id)!
  assert.equal(first.id, 'a')
  assert.deepEqual(first.merged, ['b'])
  assert.match(first.text, /先修 A[\s\S]*父对话接着又发来一封[\s\S]*顺便看 B/)
  assert.deepEqual(heldIds(first), ['a', 'b'])
  // 保活的 CLI 停到等下一句时直接交（flushHeld）：交的是合并后的正文，不是第一封的原文
  const got = heldMessage([letter('a', '先修 A')], first)
  assert.equal(got.recorded, true)
  assert.match(got.msg.text, /顺便看 B/)
  // 交不出去放回队首：合并的不拆开，排在用户消息前面
  returnHeld(id, first)
  assert.deepEqual(takeHeld(id)!.merged, ['b'])
  assert.equal(takeHeld(id)!.id, 'u')
  assert.equal(takeHeld(id)!.id, 'c')
  assert.equal(takeHeld(id), undefined)
})
