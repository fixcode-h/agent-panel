import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Task } from '../../shared/schema.ts'

/** 补排查的服务端（server/tasks/bug-probe.ts）：真的文件、真的快照，数据目录放在系统临时目录 */
process.env.AGENT_PANEL_DATA ??= mkdtempSync(path.join(os.tmpdir(), 'probe-data-'))
const { afterTurnProbe, removeProbes, snapshotBeforeEdit } = await import('./bug-probe.ts')
const { startProbe } = await import('../../shared/bug/probe-start.ts')

const before = ['export function remove(id) {', '  items.delete(id)', '  notify()', '}', ''].join('\n')
const withProbe = [
  'export function remove(id) {',
  '  items.delete(id)',
  "  console.log('[排查-P1] left=', items.size)",
  '  notify()',
  '}',
  '',
].join('\n')

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'probe-wt-'))
  writeFileSync(path.join(dir, 'store.ts'), before)
  const task = {
    id: `probe-${Math.random().toString(36).slice(2)}`,
    working: false,
    bug: { kind: 'report', diagnoses: [{ version: 1, rev: 1, status: 'pending', phase: 'plan', logPlan: [] }] },
  } as unknown as Task
  const saved: Task[] = []
  const sc = {
    taskDir: async () => dir,
    store: { update: async (_id: string, t: Task) => (saved.push(t), t) },
    deps: { projects: { get: async () => null } },
  } as unknown as Parameters<typeof afterTurnProbe>[0]
  return { dir, task, sc, saved, entry: { task, rev: 0 }, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('补排查：改之前拍快照，这一轮结束核对通过记成刚加好，不修了的清理也认得这个文件', async () => {
  const s = setup()
  try {
    const r = startProbe(s.task, { kind: 'log', ask: '打出 left', targets: [], workspace: false, remind: false })
    assert.ok(r.ok)
    await snapshotBeforeEdit(s.task, s.dir, [path.join(s.dir, 'store.ts')])
    writeFileSync(path.join(s.dir, 'store.ts'), withProbe)
    await afterTurnProbe(s.sc, s.entry)
    const p = s.task.bug!.probes![0]
    assert.equal(p.state, 'added')
    assert.deepEqual(p.spots, [{ file: 'store.ts', line: 3, lines: 1 }])
    assert.ok(s.task.bug!.logBase?.['store.ts'], '补排查动过的文件记进 logBase，不修了时按它核对')
    assert.equal(s.entry.rev, 1)

    // 撤掉：点的那一刻拍一份，删干净了记成撤掉
    const rm = await removeProbes(s.task, s.dir, ['P1'])
    assert.ok(rm.ok)
    assert.equal(p.state, 'removing')
    writeFileSync(path.join(s.dir, 'store.ts'), before)
    await afterTurnProbe(s.sc, s.entry)
    assert.equal(p.state, 'removed')
  } finally {
    s.done()
  }
})

test('补排查：改了原有的行、没拍到快照都核对不过', async () => {
  const s = setup()
  try {
    startProbe(s.task, { kind: 'code', ask: '跳过通知', targets: [], workspace: false, remind: false })
    await snapshotBeforeEdit(s.task, s.dir, ['store.ts'])
    writeFileSync(path.join(s.dir, 'store.ts'), before.replace('  notify()\n', '  // notify()\n'))
    await afterTurnProbe(s.sc, s.entry)
    const p = s.task.bug!.probes![0]
    assert.equal(p.state, 'bad')
    assert.deepEqual(p.problems.map((x) => x.why).sort(), ['changed', 'unmarked'])

    // 第二条什么都没拍到（用 shell 改的）：记成这一轮没加
    s.task.bug!.probes![0].state = 'removed'
    startProbe(s.task, { kind: 'log', ask: '再看一眼', targets: [], workspace: false, remind: false })
    await afterTurnProbe(s.sc, s.entry)
    assert.deepEqual(
      s.task.bug!.probes![1].problems.map((x) => x.why),
      ['empty'],
    )
  } finally {
    s.done()
  }
})
