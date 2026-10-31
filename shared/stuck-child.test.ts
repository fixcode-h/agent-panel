import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Task, TaskMessage, TaskPlan } from './schema.ts'
import { CHILD_IDLE_ASK_MAX } from './task.ts'
import {
  CHILD_TOOL_REPLY_FACTOR,
  agentOutputSince,
  childAskUnanswered,
  childToolRunning,
  rebindChildWait,
  restartOutcome,
  takeoverBrief,
  takeoverTitle,
} from './stuck-child.ts'

/** 一分钟按 1 秒算 */
const unitMs = 1000
const at = (ms: number) => new Date(ms).toISOString()
const now = 100_000
const unanswered = (x: Partial<Parameters<typeof childAskUnanswered>[0]>) =>
  childAskUnanswered({ minutes: 3, working: true, unitMs, ...x }, now)

test('问过状态、到时间还没回复才算卡住：有输出、能解释的等待、跑前台工具、没交出去的都不算', () => {
  const autoAsk = { at: at(now - 3000), count: 1 }
  assert.equal(unanswered({ autoAsk, lastActivityAt: autoAsk.at }), true)
  // 还没到时间
  assert.equal(unanswered({ autoAsk: { at: at(now - 2900), count: 1 }, lastActivityAt: at(now - 2900) }), false)
  // 问过之后有了输出：回复了
  assert.equal(unanswered({ autoAsk: { at: at(now - 5000), count: 1 }, lastActivityAt: at(now - 1000) }), false)
  // 没问过、关闭、没在执行、在等能解释的东西
  const ask9 = { at: at(now - 9000), count: 1 }
  const lastActivityAt = at(now - 9000)
  assert.equal(unanswered({ lastActivityAt }), false)
  assert.equal(unanswered({ autoAsk: ask9, lastActivityAt, minutes: 0 }), false)
  assert.equal(unanswered({ autoAsk: ask9, lastActivityAt, working: false }), false)
  assert.equal(unanswered({ autoAsk: ask9, lastActivityAt, wait: { kind: 'background', n: 1 } }), false)
  assert.equal(unanswered({ autoAsk: ask9, lastActivityAt, wait: { kind: 'answer', n: 1 } }), false)
  // 正在跑前台工具：多等几倍，不把长命令当成卡住
  assert.equal(unanswered({ autoAsk, lastActivityAt: autoAsk.at, toolRunning: true }), false)
  const long = { at: at(now - 3000 * CHILD_TOOL_REPLY_FACTOR), count: 1 }
  assert.equal(unanswered({ autoAsk: long, lastActivityAt: long.at, toolRunning: true }), true)
  // 没交出去的询问不算问过，连着几次都收不下才算
  const held = { at: at(now - 9000), count: 1, held: true }
  assert.equal(unanswered({ autoAsk: held, lastActivityAt: at(now - 20_000) }), false)
  const maxed = { ...held, count: CHILD_IDLE_ASK_MAX }
  assert.equal(unanswered({ autoAsk: maxed, lastActivityAt: at(now - 20_000) }), true)
})

const msg = (x: Partial<TaskMessage>): TaskMessage =>
  ({
    id: Math.random().toString(36),
    role: 'agent',
    agentId: '',
    step: '',
    text: '',
    tools: [],
    at: at(0),
    ...x,
  }) as TaskMessage

test('最近一条回复里有还在跑的工具；重启后的输出只认重启之后 Agent 说的话', () => {
  const tool = { id: 't', kind: 'bash', name: 'Bash', label: 'npm test', running: true }
  assert.equal(childToolRunning({ messages: [msg({ tools: [tool] as unknown as TaskMessage['tools'] })] }), true)
  assert.equal(
    childToolRunning({ messages: [msg({ tools: [{ ...tool, running: false }] as unknown as TaskMessage['tools'] })] }),
    false,
  )
  assert.equal(childToolRunning({ messages: [] }), false)
  const tk = { messages: [msg({ at: at(10) }), msg({ role: 'system', at: at(30) })] }
  assert.equal(agentOutputSince(tk, at(20)), false)
  assert.equal(agentOutputSince({ messages: [...tk.messages, msg({ at: at(40) })] }, at(20)), true)
})

test('重启后的结论：有输出就恢复，又卡住、失败就换人，被别人停下就放手', () => {
  const t0 = 50_000
  assert.equal(restartOutcome({ output: true, live: true, status: 'running' }, t0), 'ok')
  assert.equal(restartOutcome({ output: false, live: true, status: 'running' }, t0), 'wait')
  // 标「没有响应」的是重启前那一轮：不算
  assert.equal(restartOutcome({ output: false, live: true, status: 'running', stalledSince: t0 - 1 }, t0), 'wait')
  assert.equal(restartOutcome({ output: false, live: true, status: 'running', stalledSince: t0 + 1 }, t0), 'failed')
  assert.equal(restartOutcome({ output: false, live: false, status: 'failed' }, t0), 'failed')
  assert.equal(restartOutcome({ output: false, live: false, status: 'stopped', stopReason: 'stalled' }, t0), 'failed')
  assert.equal(restartOutcome({ output: false, live: false, status: 'stopped', stopReason: 'user' }, t0), 'gone')
  assert.equal(restartOutcome({ output: false, live: false, status: 'stopped', stopReason: 'parent' }, t0), 'gone')
  assert.equal(restartOutcome({ output: false, live: false, status: 'done' }, t0), 'ok')
})

test('接手标题不重复加「（接手）」；父计划里等原子对话的步骤改成等接手的', () => {
  assert.equal(takeoverTitle('修登录页'), '修登录页（接手）')
  assert.equal(takeoverTitle('修登录页（接手）'), '修登录页（接手）')
  const plan = {
    id: 'p',
    title: '',
    steps: [
      {
        id: 's1',
        title: '修登录页',
        status: 'waiting',
        note: '',
        waits: [{ kind: 'child', ref: 'old', label: '修登录页', state: 'waiting' }],
        children: [
          {
            id: 's1.1',
            title: '',
            status: 'waiting',
            note: '',
            waits: [{ kind: 'child', ref: 'old', label: '', state: 'waiting' }],
          },
        ],
      },
      {
        id: 's2',
        title: '已经做完的',
        status: 'done',
        note: '',
        waits: [{ kind: 'child', ref: 'old', label: '', state: 'ok' }],
        children: [],
      },
    ],
  } as unknown as TaskPlan
  const tk = { plans: [plan] }
  assert.equal(rebindChildWait(tk, 'old', 'new', '修登录页（接手）', at(1)), 2)
  assert.equal(plan.steps[0].waits[0].ref, 'new')
  assert.equal(plan.steps[0].waits[0].label, '修登录页（接手）')
  assert.equal(plan.steps[0].children[0].waits[0].ref, 'new')
  // 已经收口的不动
  assert.equal(plan.steps[1].waits[0].ref, 'old')
})

test('接手的派单带上原任务、用户追加的要求、改过的文件和最后的回复', () => {
  const old = {
    id: 'c1',
    title: '修登录页',
    plans: [],
    steps: [],
    worktree: null,
    messages: [
      msg({ role: 'user', text: '登录按钮点了没反应', peer: { rel: 'parent', kind: 'task' } as TaskMessage['peer'] }),
      msg({ role: 'system', panel: 'note', text: '【状态询问】你已经 3 分钟没有输出了' }),
      msg({ role: 'user', text: '顺便把报错文案也改了' }),
      msg({ text: '定位到 src/login.ts 的点击事件没绑上' }),
    ],
    changes: [{ path: 'src/login.ts', add: 1, del: 0 }] as Task['changes'],
  }
  const brief = takeoverBrief(old, '重启后还是没有任何输出')
  assert.ok(brief.startsWith('【接手】子对话「修登录页」（id c1）卡住了：重启后还是没有任何输出'))
  assert.ok(brief.includes('登录按钮点了没反应'))
  assert.ok(brief.includes('顺便把报错文案也改了'))
  assert.ok(!brief.includes('【状态询问】'), '面板的询问不当成任务')
  assert.ok(brief.includes('src/login.ts'))
  assert.ok(brief.includes('定位到 src/login.ts 的点击事件没绑上'))
  assert.ok(brief.includes('已经做完的不用重做'))
})
