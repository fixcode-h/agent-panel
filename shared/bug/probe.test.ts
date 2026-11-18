import assert from 'node:assert/strict'
import test from 'node:test'
import { tempLogLines } from './cleanup.ts'
import {
  checkProbeAdd,
  checkProbeRemove,
  commentOf,
  ledgerRows,
  markerHits,
  nextProbeId,
  probeAddPrompt,
  probeHit,
  probeLineSet,
} from './probe.ts'
import { canOpenProbe, startProbe } from './probe-start.ts'
import type { BugProbe } from './probe-schema.ts'
import type { Task } from '../schema.ts'

const base = ['function draw(badge) {', '  const n = badge.count', '  render(badge, n)', '}'].join('\n')
// 补排查 P2：多行调试绘制用一对标记包起来，前面顺手带了一个空行；P3 是一行日志
const added = [
  'function draw(badge) {',
  '  const n = badge.count',
  '',
  '  // [排查-P2 开始]',
  '  const box = badge.rect()',
  '  drawDebugBox(box, n)',
  '  // [排查-P2 结束]',
  "  console.log('[排查-P3] n=', n)",
  '  render(badge, n)',
  '}',
].join('\n')

test('标记解析：成对标记之间整段算这一条，单行标记只算那一行', () => {
  const lines = added.split('\n')
  assert.deepEqual([...probeLineSet(lines, 'P2')], [3, 4, 5, 6])
  assert.deepEqual([...probeLineSet(lines, 'P3')], [7])
  // P1 不会把 P10、P12 认成自己的
  assert.deepEqual([...probeLineSet(["log('[排查-P12] x')"], 'P1')], [])
})

test('不修了的清理认得多行的临时代码：成对标记之间的行都列出来；只有开始没有结束的不往下吞', () => {
  assert.deepEqual(
    tempLogLines('a.ts', added).map((x) => x.line),
    [4, 5, 6, 7, 8],
  )
  const open = ['a()', '// [排查-P4 开始]', 'b()', 'c()'].join('\n')
  assert.deepEqual(
    tempLogLines('a.ts', open).map((x) => x.line),
    [2],
  )
})

test('加完核对：带标记的新行和挨着的空行都算这一条，记下第一行和加了几行', () => {
  const base3 = base
  const p2Only = added
    .split('\n')
    .filter((l) => !l.includes('P3'))
    .join('\n')
  const r = checkProbeAdd('P2', 'badge.ts', base3, p2Only)
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.spot, { file: 'badge.ts', line: 4, lines: 5 })
})

test('加完核对：没带标记的新行、改了原有的行都退回', () => {
  const bad = ['function draw(badge) {', '  const n = badge.count + 1', '  dump(n)', '  render(badge, n)', '}'].join(
    '\n',
  )
  const r = checkProbeAdd('P5', 'badge.ts', base, bad)
  assert.equal(r.spot, undefined)
  assert.deepEqual(r.problems.map((x) => x.why).sort(), ['changed', 'unmarked', 'unmarked'])
})

test('撤完核对：只删这一条（连空行）通过；别的条和原有的行动了、还留着都报出来', () => {
  const removedP2 = [
    'function draw(badge) {',
    '  const n = badge.count',
    "  console.log('[排查-P3] n=', n)",
    '  render(badge, n)',
    '}',
  ].join('\n')
  assert.deepEqual(checkProbeRemove(['P2'], 'badge.ts', added, removedP2), [])
  // 一起撤 P2、P3：两条的删除都不算删多
  assert.deepEqual(checkProbeRemove(['P2', 'P3'], 'badge.ts', added, base), [])
  // 只撤 P2 却把 P3 也删了：删多了
  assert.deepEqual(
    checkProbeRemove(['P2'], 'badge.ts', added, base).map((x) => x.why),
    ['changed'],
  )
  // 没删干净
  const left = added.replace('  drawDebugBox(box, n)\n', '')
  assert.ok(checkProbeRemove(['P2'], 'badge.ts', added, left).some((x) => x.why === 'left'))
})

test('注释符号按文件语言取', () => {
  assert.equal(commentOf('Content/Script/ui/Badge.lua'), '--')
  assert.equal(commentOf('tools/run.py'), '#')
  assert.equal(commentOf('Source/Game/Badge.cpp'), '//')
})

test('日志里认出标记：补排查编号、论证日志主题都认', () => {
  assert.deepEqual(markerHits('a [排查-P3] n=2\nb [排查-P2 开始]\n[排查-购物车] left=0'), ['P3', 'P2', '购物车'])
})

const probe = (o: Partial<BugProbe>): BugProbe => ({
  id: 'P1',
  kind: 'log',
  ask: '打出数量',
  at: '2026-11-18T10:00:00.000Z',
  targets: [],
  workspace: false,
  remind: false,
  state: 'added',
  spots: [{ file: 'src/a.ts', line: 3, lines: 1 }],
  problems: [],
  doneAt: '2026-11-18T10:01:00.000Z',
  ...o,
})

test('打出来没有：只看加好之后的复现', () => {
  const p = probe({})
  const r = (at: string, hits: string[]) => ({
    id: 'R1',
    at,
    path: 'a.log',
    startLine: 1,
    endLine: 2,
    related: 1,
    hits,
  })
  assert.equal(probeHit(p, []), undefined)
  assert.equal(probeHit(p, [r('2026-11-18T10:00:30.000Z', ['P1'])]), undefined)
  assert.equal(probeHit(p, [r('2026-11-18T10:02:00.000Z', ['P1'])]), 'hit')
  assert.equal(probeHit(p, [r('2026-11-18T10:02:00.000Z', ['L1'])]), 'miss')
})

test('编号往上数，撤掉的也占着号', () => {
  assert.equal(nextProbeId([]), 'P1')
  assert.equal(nextProbeId([probe({ id: 'P1', state: 'removed' }), probe({ id: 'P2' })]), 'P3')
})

test('清单：论证日志按编号去重，补排查跟在后面', () => {
  const rows = ledgerRows({
    diagnoses: [
      { phase: 'evidence', version: 1, logPlan: [{ id: 'L1', file: 'store.ts:48', line: 48, print: 'id', fn: '' }] },
      { phase: 'evidence', version: 2, logPlan: [{ id: 'L1', file: 'store.ts', line: 48, print: 'id', fn: '' }] },
      { phase: 'plan', version: 3, logPlan: [] },
    ],
    probes: [probe({})],
  })
  assert.deepEqual(
    rows.map((r) => [r.id, r.file, r.from]),
    [
      ['L1', 'store.ts', 'evidence'],
      ['P1', 'src/a.ts', 'probe'],
    ],
  )
})

test('开窗口：报告还没交、关了、它在回复、上一个没结束都不开；开了报告阶段不动', () => {
  const task = {
    working: false,
    bug: { kind: 'report', diagnoses: [{ version: 1, rev: 1, status: 'pending', phase: 'plan' }] },
  } as unknown as Task
  const r = startProbe(task, {
    kind: 'draw',
    ask: '画出角标位置',
    targets: ['S2 remove（store.ts:53）'],
    workspace: false,
    remind: true,
  })
  assert.ok(r.ok)
  assert.equal(task.bug?.probes?.[0].id, 'P1')
  assert.equal(task.bug?.probes?.[0].state, 'adding')
  assert.equal(task.bug?.diagnoses?.[0].status, 'pending')
  assert.match(canOpenProbe(task), /还没结束/)
  assert.match(r.ok ? r.message : '', /\[排查-P1 开始\]/)
  const closed = { bug: { kind: 'report', diagnoses: [{ version: 1, status: 'cancelled' }] } } as unknown as Task
  assert.match(canOpenProbe(closed), /关了/)
})

test('给 Agent 的话：写明标记、只新增、加完就停', () => {
  const s = probeAddPrompt({ id: 'P4', kind: 'log', ask: '打出 left', targets: [] }, 2)
  assert.match(s, /\[排查-P4\]/)
  assert.match(s, /只新增带标记的行/)
  assert.match(s, /不交诊断报告/)
})
