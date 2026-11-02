import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentCall, AgentResult, EngineHost } from './engine.ts'
import type { Task, TaskStep } from './schema.ts'
import { HELPER_DRIVE_MAX, SUMMARY_NUDGE, helperState, missingSummary, runWithSummary } from './helper-summary.ts'

const step = { id: 'h1', startedAt: '2026-11-02T00:00:00.000Z' } as TaskStep
const msg = (text: string, at = '2026-11-02T00:00:05.000Z') => ({ role: 'agent', step: 'h1', text, at })

/** 假的 host：每次 runAgent 往对话里写一条回复（replies 依次取），记下发过去的提示词 */
function fakeHost(replies: string[]) {
  const task = { messages: [] as unknown[] } as unknown as Task
  const prompts: string[] = []
  const notes: string[] = []
  const host = {
    task,
    async runAgent(call: AgentCall): Promise<AgentResult> {
      prompts.push(call.prompt)
      const text = replies.shift() ?? ''
      task.messages.push(msg(text) as Task['messages'][number])
      return { ok: true, text }
    },
  } as unknown as EngineHost
  const system = (_h: EngineHost, text: string) => void notes.push(text)
  return { host, prompts, notes, system }
}

test('子任务按最后的总结判定：最后一条回复没有「## 总结」才算没交，看不到对话记录时不判', () => {
  const task = (texts: string[]) => ({ messages: texts.map((x) => msg(x)) }) as unknown as Task
  assert.equal(missingSummary(task(['先读一下文件', '继续读操作原语与快照/选择器。']), step), true)
  assert.equal(missingSummary(task(['读完了', '## 总结\n- 结论：可以用']), step), false)
  assert.equal(missingSummary(task(['## Summary\nok']), step), false)
  // 正文里提到「已完成」不算总结：只认总结那一行标题，不按字眼猜
  assert.equal(missingSummary(task(['已完成，全部合并']), step), true)
  assert.equal(missingSummary(task([]), step), false, '没有对话记录（单测里的假执行）不判')
  const old = { messages: [msg('上一轮的回复', '2026-11-01T00:00:00.000Z')] } as unknown as Task
  assert.equal(missingSummary(old, step), false, '上一轮的回复不算这一轮的')
})

test('子任务没交总结就结束：在同一个会话里推一次，补上总结后两次的输出一起交回', async () => {
  const f = fakeHost(['继续读操作原语与快照/选择器。', '## 总结\n- 原语有 3 个'])
  const r = await runWithSummary(f.host, step, { prompt: '做事' } as AgentCall, () => {}, f.system)
  assert.deepEqual(f.prompts, ['做事', SUMMARY_NUDGE])
  assert.deepEqual(r, { ok: true, text: '继续读操作原语与快照/选择器。\n\n## 总结\n- 原语有 3 个' })
  assert.deepEqual(f.notes, [])
})

test('子任务交了总结不推；推满还是没有总结就照常交回并留一行警告，不来回推', async () => {
  const done = fakeHost(['## 总结\n做完了'])
  await runWithSummary(done.host, step, { prompt: '做事' } as AgentCall, () => {}, done.system)
  assert.equal(done.prompts.length, 1)

  const stuck = fakeHost(['接着查', '还在查', '再查', '还没完'])
  const r = await runWithSummary(stuck.host, step, { prompt: '做事' } as AgentCall, () => {}, stuck.system)
  assert.equal(stuck.prompts.length, 1 + HELPER_DRIVE_MAX, '推满上限就停')
  assert.ok(r.ok)
  assert.equal(stuck.notes.length, 1, '留一行警告给用户看')

  // 被单独终止的不推
  const ac = new AbortController()
  ac.abort()
  const aborted = fakeHost(['接着查'])
  await runWithSummary(aborted.host, step, { prompt: '做事', signal: ac.signal } as AgentCall, () => {}, aborted.system)
  assert.equal(aborted.prompts.length, 1)
})

test('子任务总结的状态行：未完成接着推，卡住原样交回不推，没有状态行按做完算', async () => {
  const task = (text: string) => ({ messages: [msg(text)] }) as unknown as Task
  assert.deepEqual(helperState(task('## 总结\n状态：卡住：缺数据库密码\n- 查了配置'), step), {
    state: 'stuck',
    note: '缺数据库密码',
  })
  assert.equal(helperState(task('## 总结\n- 状态：未完成，还差第 3 个文件'), step)?.state, 'unfinished')
  assert.equal(helperState(task('## 总结\n状态：完成'), step)?.state, 'done')
  assert.equal(helperState(task('## 总结\n旧格式，没有状态行'), step)?.state, 'done')
  // 正文里（总结之前）写的「状态：未完成」不算：只看总结那一段
  assert.equal(helperState(task('状态：未完成\n## 总结\n状态：完成'), step)?.state, 'done')

  const unfinished = fakeHost(['## 总结\n状态：未完成：还差第 3 个文件', '## 总结\n状态：完成'])
  await runWithSummary(unfinished.host, step, { prompt: '做事' } as AgentCall, () => {}, unfinished.system)
  assert.equal(unfinished.prompts.length, 2)
  assert.match(unfinished.prompts[1], /未完成[\s\S]*还差第 3 个文件[\s\S]*直接调用工具/)

  const blocked = fakeHost(['## 总结\n状态：卡住：缺数据库密码'])
  const r = await runWithSummary(blocked.host, step, { prompt: '做事' } as AgentCall, () => {}, blocked.system)
  assert.equal(blocked.prompts.length, 1, '卡住的交回派它的一方，不推')
  assert.ok(r.ok && /卡住：缺数据库密码/.test(r.text))
  assert.deepEqual(blocked.notes, [])
})
