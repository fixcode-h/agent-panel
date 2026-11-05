/**
 * end_turn 和面板提醒的显示规则（设计稿 docs/openspec/changes/end-check-signal/design-v2.md）：
 * 交代结束只认 end_turn、提醒不画进对话、end_turn(done) 之后的那次输出默认隐藏、空转保护。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { TaskMessage, ToolUse } from './schema.ts'
import {
  END_REJECTED,
  endTurnCheck,
  endTurnDone,
  idleReminders,
  inputIndex,
  panelTrail,
  pushTurnEnd,
  turnEndSince,
  visibleMessages,
} from './end-turn.ts'

let n = 0
const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 8, 0, s)).toISOString()
const tool = (name: string, extra: Partial<ToolUse> = {}): ToolUse => ({
  kind: name === 'Read' ? 'read' : 'other',
  name,
  label: '',
  detail: '',
  ...extra,
})
const end = (outcome = 'done', extra: Partial<ToolUse> = {}) =>
  tool('mcp__panel-x__end_turn', { input: JSON.stringify({ outcome }), output: '已结束这一轮', ...extra })
const msg = (role: TaskMessage['role'], s: number, x: Partial<TaskMessage> = {}): TaskMessage =>
  ({ id: `m${++n}`, role, agentId: 'a', step: '', text: '', tools: [], at: at(s), ...x }) as TaskMessage
const user = (s: number, text = '查一下') => msg('user', s, { text })
const agent = (s: number, text: string, tools: ToolUse[] = []) => msg('agent', s, { text, tools })
const hook = (s: number) => msg('system', s, { panel: 'hook', text: '【面板】（收尾自检）这次的事做完了吗？' })

test('end_turn(done)：总结照常显示，end_turn 这一行和之后的那句收尾隐藏，原文留给状态面板', () => {
  const msgs = [
    user(0),
    agent(1, '读完了', [tool('Read')]),
    agent(2, '## 结论\n完整的总结'),
    agent(3, '我已经完成了。', [end()]),
  ]
  const v = visibleMessages(msgs)
  assert.deepEqual(
    v.msgs.map((m) => m.text),
    ['查一下', '读完了', '## 结论\n完整的总结'],
  )
  assert.deepEqual(
    v.hidden.map((h) => h.text),
    ['我已经完成了。'],
  )
  // 收尾那句单独成一条（end_turn 那条没有文字）：下一条只有文字的也算「之后的那次输出」
  const split = visibleMessages([user(0), agent(1, '总结'), agent(2, '', [end()]), agent(3, '好的')])
  assert.deepEqual(
    split.msgs.map((m) => m.text),
    ['查一下', '总结'],
  )
  // 之后又动了手：照常显示
  const more = visibleMessages([user(0), agent(1, '', [end()]), agent(2, '再补一下', [tool('Read')])])
  assert.deepEqual(
    more.msgs.map((m) => m.text),
    ['查一下', '再补一下'],
  )
})

test('被拒的、blocked 的 end_turn 不隐藏之后的话；面板提醒不画进对话', () => {
  const rejected = end('done', { failed: true, output: `${END_REJECTED}计划还有 1 步没做完` })
  assert.equal(endTurnDone(rejected), false)
  assert.equal(endTurnDone(end('blocked', { output: '' })), false)
  const v = visibleMessages([user(0), agent(1, '先说明一下'), hook(2), agent(3, '接着做', [rejected])])
  assert.deepEqual(
    v.msgs.map((m) => m.text),
    ['查一下', '先说明一下', '接着做'],
  )
  assert.ok(!v.msgs.some((m) => m.panel === 'hook'))
  assert.equal(v.msgs.at(-1)!.tools.length, 0, 'end_turn 这一行不画')
})

test('交代过的结束只算这条输入以来的；面板提醒、警告行不算新的输入', () => {
  const tk = { messages: [user(0), agent(1, '总结')], turnEnds: [] as never[] }
  assert.equal(turnEndSince(tk), undefined)
  pushTurnEnd(tk, { outcome: 'done' }, at(2))
  assert.equal(turnEndSince(tk)?.outcome, 'done')
  tk.messages.push(hook(3), msg('system', 4, { text: '警告' }))
  assert.equal(inputIndex(tk.messages), 0)
  assert.equal(turnEndSince(tk)?.outcome, 'done')
  tk.messages.push(user(5, '再看看'))
  assert.equal(turnEndSince(tk), undefined, '新的输入要重新交代')
})

test('空转保护：提醒之间一个工具都没调才累计，动了手就清零', () => {
  const msgs = [user(0), agent(1, '', [tool('Read')]), hook(2), agent(3, '好'), hook(4), agent(5, '嗯')]
  assert.equal(idleReminders(msgs), 2)
  msgs.push(hook(6))
  assert.equal(idleReminders(msgs), 3)
  msgs.push(agent(7, '', [tool('Read')]))
  assert.equal(idleReminders(msgs), 0)
  assert.equal(idleReminders([...msgs, hook(8), agent(9, '', [end()])]), 1, 'end_turn 不算动手')
})

test('end_turn 的判定：计划没做完、子对话没请收尾时拒绝；blocked 要写 need', () => {
  const base = { resolved: false, plans: [], steps: [], changes: [] } as unknown as Parameters<typeof endTurnCheck>[0]
  assert.equal(endTurnCheck(base, 'done', '').ok, true)
  assert.equal(endTurnCheck(base, 'maybe', '').ok, false)
  assert.equal(endTurnCheck(base, 'blocked', ' ').ok, false)
  assert.equal(endTurnCheck(base, 'blocked', '缺编辑器路径').end?.need, '缺编辑器路径')
  const plan = {
    id: 'p',
    title: '计划',
    createdAt: at(0),
    doneAt: '',
    summary: '',
    steps: [{ id: 's', title: '跑检查', status: 'pending', note: '', waits: [], createdAt: at(0) }],
  }
  const r = endTurnCheck({ ...base, plans: [plan] } as never, 'done', '')
  assert.equal(r.ok, false)
  assert.match(r.info, /计划还有 1 步没做完.*「跑检查」/)
  const kid = endTurnCheck({ ...base, parentTaskId: 'p1', changes: [{ path: 'a.ts' }] } as never, 'done', '')
  assert.match(kid.info, /submit_merge/)
})

test('状态面板的记录：提醒之后做了什么、结束交代、被隐藏的收尾', () => {
  const tk = {
    messages: [user(0), agent(1, '', [tool('Read')]), hook(2), agent(3, '', [tool('Read'), tool('Read')])],
    turnEnds: [] as never[],
  }
  tk.messages.push(agent(4, '收尾一句', [end()]))
  pushTurnEnd(tk, { outcome: 'done' }, at(5))
  const trail = panelTrail(tk)
  assert.deepEqual(
    trail.map((x) => [x.kind, x.tools ?? x.outcome]),
    [
      ['hook', 2],
      ['end', 'done'],
    ],
  )
  assert.equal(trail[1].hidden, '收尾一句')
})
