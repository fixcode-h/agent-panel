import assert from 'node:assert/strict'
import test from 'node:test'
import { setLang } from '../i18n.ts'
import { BugCase } from './diagnosis-schema.ts'
import { droppedFields } from './dropped.ts'
import { submitDiagnosis, updateBugCase, type DiagnosisInput } from './diagnosis.ts'
import type { Task } from '../schema.ts'

setLang('zh')

const ref = (i: number) => ({ id: `C${i}`, file: 'a.lua', start: i, end: i + 1 })

// 实跑 2026-11-18：codeRefs 写了 8 条（上限 6），整组被丢，退回的话却是「stack 里的 C1… 在 codeRefs 里没有」
test('写了却被 schema 丢掉的字段：按路径和上限说清楚', () => {
  const over = droppedFields(BugCase.shape, { codeRefs: Array.from({ length: 8 }, (_, i) => ref(i + 1)) })
  assert.match(over, /codeRefs：最多 6 条，交了 8 条，整组没收下/)
  // 某一项缺必填：整组丢，指出是第几项哪个字段
  const broken = droppedFields(BugCase.shape, { codeRefs: [ref(1), { id: 'C2', file: 'a.lua' }] })
  assert.match(broken, /codeRefs：第 2 项的 start/)
  // 嵌套的数组（每跳的 refs 最多 10 个）
  const refs = Array.from({ length: 11 }, (_, i) => `Q${i}`)
  const nested = droppedFields(BugCase.shape, { stack: [{ id: 'S1', file: 'a', fn: 'f', refs }] })
  assert.match(nested, /stack\[0\]\.refs：最多 10 条/)
  // 字符串超长变成空串
  assert.match(droppedFields(BugCase.shape, { levelNote: 'x'.repeat(1001) }), /levelNote：最多 1000 字/)
  // 都收下了、没写的不算
  assert.equal(droppedFields(BugCase.shape, { codeRefs: [ref(1)], quotes: [], symptom: '' }), '')
})

const bugTask = () =>
  ({ bug: { kind: 'report', diagnoses: [] }, requests: [], messages: [], changes: [] }) as unknown as Task

const cause = (over: Partial<DiagnosisInput> = {}): DiagnosisInput => ({
  phase: 'cause',
  level: 'quick',
  symptom: '切回任务后 NPC 不跟随',
  repro: '切追踪再切回',
  rootCause: '新实例没人调 StartCompanion',
  confirmed: true,
  evidence: '日志里切回后没有 StartFollow',
  stack: [
    { id: 'S1', file: 'a.lua', line: 1, fn: 'f', refs: ['C1'] },
    { id: 'S2', parent: 'S1', role: 'fault', file: 'a.lua', line: 2, fn: 'g', cond: { text: 'x', took: '假' } },
  ],
  hypotheses: [{ id: 'H1', text: '实例被销毁', status: 'confirmed', hop: 'S1 → S2' }],
  ...over,
})

test('交报告：几组问题一次说完，丢掉的字段排最前面', () => {
  const tk = bugTask()
  const r = submitDiagnosis(tk, cause({ codeRefs: Array.from({ length: 8 }, (_, i) => ref(i + 1)) }), () => 'x')
  assert.equal(r.ok, false)
  assert.match(r.info, /这一版有 \d+ 处要改，一次改完再交/)
  assert.match(r.info, /1\. 这些字段写了但没收下[\s\S]*codeRefs：最多 6 条/)
  assert.match(r.info, /一项只写一个编号（S2），不写范围或箭头/)
  assert.match(r.info, /第 1 次被退回/)
})

test('记档案：会被丢掉的字段不记，免得冲掉原来那一组', () => {
  const tk = bugTask()
  assert.equal(updateBugCase(tk, { codeRefs: [ref(1)] }).ok, true)
  const r = updateBugCase(tk, { codeRefs: Array.from({ length: 8 }, (_, i) => ref(i + 1)) })
  assert.equal(r.ok, false)
  assert.equal(tk.bug?.case?.codeRefs.length, 1)
})
