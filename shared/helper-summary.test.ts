import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentCall, AgentResult, EngineHost } from './engine.ts'
import type { Task, TaskStep } from './schema.ts'
import { RESULT_ASK, resultLine, resultOf, runWithSummary } from './helper-summary.ts'

const at = '2026-11-02T00:00:05.000Z'

/** 假的 host：每次 runAgent 按 replies 依次回复；submit 为真时那一轮调了 submit_result（直接写到这一步上） */
function fakeHost(replies: { text: string; submit?: 'done' | 'unfinished' | 'stuck' }[]) {
  const task = { messages: [] as unknown[] } as unknown as Task
  const step = { id: 'h1', startedAt: '2026-11-02T00:00:00.000Z' } as TaskStep
  const prompts: string[] = []
  const notes: string[] = []
  const host = {
    task,
    async runAgent(call: AgentCall): Promise<AgentResult> {
      prompts.push(call.prompt)
      const r = replies.shift() ?? { text: '' }
      if (r.submit) step.submitted = { state: r.submit, summary: '做了', left: '', blockers: [], at }
      return { ok: true, text: r.text }
    },
  } as unknown as EngineHost
  const system = (_h: EngineHost, text: string) => void notes.push(text)
  return { host, step, prompts, notes, system }
}

test('子任务只按 submit_result 判定：回复里写「## 总结」「已完成」不算交了结果（ADR 0041 第 16 节）', async () => {
  const f = fakeHost([{ text: '## 总结\n已完成，全部做完了' }, { text: '交了', submit: 'done' }])
  const r = await runWithSummary(f.host, f.step, { prompt: '做事' } as AgentCall, () => {}, f.system)
  assert.deepEqual(f.prompts, ['做事', RESULT_ASK], '没调工具：补问一次')
  assert.deepEqual(r, { ok: true, text: '## 总结\n已完成，全部做完了\n\n交了' })
  assert.equal(resultOf(f.step), 'done')
  assert.deepEqual(f.notes, [])
})

test('子任务交了结果不补问；补问一次还不交就照常交回并留一行警告，不来回推', async () => {
  const done = fakeHost([{ text: '好了', submit: 'unfinished' }])
  await runWithSummary(done.host, done.step, { prompt: '做事' } as AgentCall, () => {}, done.system)
  assert.equal(done.prompts.length, 1, '交了「没做完」也不在子任务这一层推：由派它的对话按计划处理')

  const silent = fakeHost([{ text: '接着查' }, { text: '还在查' }])
  const r = await runWithSummary(silent.host, silent.step, { prompt: '做事' } as AgentCall, () => {}, silent.system)
  assert.equal(silent.prompts.length, 2, '只补问一次')
  assert.ok(r.ok)
  assert.equal(silent.notes.length, 1, '留一行警告给用户看')
  assert.match(resultLine(silent.step), /没有用 submit_result 交结果/)

  // 评审（交 submit_verdict）不要求 submit_result；被单独终止的不补问
  const review = fakeHost([{ text: '看完了' }])
  await runWithSummary(review.host, review.step, { prompt: '评审' } as AgentCall, () => {}, review.system, false)
  assert.equal(review.prompts.length, 1)
  const ac = new AbortController()
  ac.abort()
  const aborted = fakeHost([{ text: '接着查' }])
  await runWithSummary(
    aborted.host,
    aborted.step,
    { prompt: '做事', signal: ac.signal } as AgentCall,
    () => {},
    aborted.system,
  )
  assert.equal(aborted.prompts.length, 1)
})

test('交回派它的对话时写明子任务交的状态：做完、没做完还差什么、卡在哪', () => {
  const s = (state: 'done' | 'unfinished' | 'stuck', left = '') =>
    ({ submitted: { state, summary: '', left, blockers: [], at } }) as Pick<TaskStep, 'submitted'>
  assert.equal(resultLine(s('done')), '（交了结果：做完）')
  assert.equal(resultLine(s('unfinished', '还差第 3 个文件')), '（交了结果：没做完：还差第 3 个文件）')
  assert.equal(resultLine(s('stuck', '缺数据库密码')), '（交了结果：卡住：缺数据库密码）')
})
