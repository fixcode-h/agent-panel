/**
 * 「为什么停在这里」和父子协作时间线：从任务事实里拼出来的说法，不另记数据。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { collabEvents } from './collab-timeline.ts'
import { setLang } from './i18n.ts'
import { Task } from './schema.ts'
import { diagnoseTask } from './task-diagnosis.ts'

setLang('zh')
const at = '2026-10-01T00:00:00.000Z'
const now = Date.parse(at) + 15 * 60_000
const msg = (id: string, extra: Record<string, unknown>) => ({
  id,
  role: 'agent',
  agentId: '',
  step: '',
  text: '',
  tools: [],
  at,
  ...extra,
})
const task = (id: string, extra: Record<string, unknown> = {}) =>
  Task.parse({ id, projectId: 'p', title: id, mode: 'chat', status: 'done', createdAt: at, updatedAt: at, ...extra })
const plan = (done: number) => ({
  id: 'pl',
  title: '',
  createdAt: at,
  doneAt: '',
  steps: Array.from({ length: 4 }, (_, i) => ({
    id: `s${i}`,
    title: `第 ${i + 1} 步`,
    status: i < done ? 'done' : 'pending',
  })),
})

test('停住的对话：说清计划还剩几步、下一步是什么，面板推过还停着也标出来', () => {
  const tk = task('a', {
    plans: [plan(2)],
    messages: [msg('n', { role: 'user', text: '【面板】你的计划才做了 2/4，也没有在等任何结果，这一轮却结束了。' })],
  })
  const d = diagnoseTask(tk, [], now)
  assert.equal(d.state, 'unfinished')
  assert.match(d.headline, /计划还没做完/)
  const p = d.items.find((x) => x.kind === 'plan')
  assert.equal(p?.text, '计划 2/4')
  assert.equal(p?.detail, '下一步：第 3 步')
  assert.match(d.items.find((x) => x.kind === 'nudge')?.text ?? '', /还没有回应/)
})

test('在等子对话：列出在动的子对话，很久没输出的标红；停下的对话给出继续的提示', () => {
  const kid = {
    id: 'k',
    title: '改接口',
    status: 'running' as const,
    working: true,
    cliAlive: true,
    startedAt: at,
    lastActivityAt: at,
  }
  const d = diagnoseTask(task('p', { status: 'running' }), [kid], now)
  assert.equal(d.state, 'waiting')
  const row = d.items.find((x) => x.kind === 'child')
  assert.equal(row?.taskId, 'k')
  assert.equal(row?.tone, 'danger')
  assert.match(row?.detail ?? '', /15 分钟没有新输出/)
  const stopped = diagnoseTask(task('s', { status: 'stopped', stopReason: 'restart' }), [], now)
  assert.match(stopped.headline, /面板重启时中断/)
  assert.equal(stopped.items.at(-1)?.kind, 'hint')
})

test('协作时间线：父对话交代、面板推它、子对话汇报、用户直接说的按时间排，分清是谁发的', () => {
  const t = (n: number) => new Date(Date.parse(at) + n * 1000).toISOString()
  const root = task('root', {
    messages: [
      msg('r1', {
        at: t(3),
        role: 'user',
        text: '【子对话状态】做完了',
        panel: 'child',
        child: { id: 'k', title: '改接口', state: 'done' },
      }),
    ],
  })
  const kid = task('k', {
    parentTaskId: 'root',
    title: '改接口',
    messages: [
      msg('k1', { at: t(1), role: 'user', text: '把接口改了', peer: { id: 'root', rel: 'parent', kind: 'task' } }),
      msg('k2', {
        at: t(2),
        role: 'user',
        text: '【面板】你的计划才做了 1/4',
        peer: { id: 'root', rel: 'parent', kind: 'build' },
      }),
      msg('k3', { at: t(4), role: 'user', text: '顺便加个测试' }),
    ],
  })
  const ev = collabEvents(root, [kid])
  assert.deepEqual(
    ev.map((x) => [x.id, x.kind, x.source]),
    [
      ['k1', 'task', 'model'],
      ['k2', 'nudge', 'panel'],
      ['r1', 'report', 'panel'],
      ['k3', 'user', 'user'],
    ],
  )
  assert.equal(ev[0].subject, '把接口改了')
})
