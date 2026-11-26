// 项目程序位置（shared/custom-tools/programs.ts）：提示词那一行、登记和删除、登记前检查
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_PROGRAMS,
  programProblem,
  programsHint,
  upsertProgram,
  withoutProgram,
  type ProgramPathView,
} from './programs.ts'

const p = (name: string, extra: Partial<ProgramPathView> = {}): ProgramPathView => ({
  name,
  path: `/tools/${name}`,
  note: '',
  at: '2026-11-26T00:00:00.000Z',
  by: '',
  ...extra,
})

test('对话开头那一行只列文件还在的，一个都没有时为空', () => {
  assert.equal(programsHint([]), '')
  assert.equal(programsHint([p('gone', { missing: true })]), '')
  const h = programsHint([p('luac', { note: 'Lua 语法检查' }), p('gone', { missing: true })])
  assert.match(h, /luac \/tools\/luac（Lua 语法检查）/)
  assert.doesNotMatch(h, /gone/)
})

test('同名（不分大小写）的登记换成新的，超过上限丢最早的；删除说清删没删到', () => {
  const list = upsertProgram([p('luac')], p('LUAC', { path: '/new/luac' }))
  assert.deepEqual(
    list.map((x) => x.path),
    ['/new/luac'],
  )
  const many = Array.from({ length: MAX_PROGRAMS + 2 }, (_, i) => p(`t${i}`)).reduce(
    (l, x) => upsertProgram(l, x),
    [] as ProgramPathView[],
  )
  assert.equal(many.length, MAX_PROGRAMS)
  assert.equal(many[0].name, 't2')
  assert.equal(withoutProgram(list, 'Luac').found, true)
  assert.equal(withoutProgram(list, 'texconv').found, false)
})

test('登记前检查：程序名不带路径和空格，路径要绝对', () => {
  assert.equal(programProblem('luac', 'D:\\Tools\\luac.exe'), '')
  assert.equal(programProblem('luac', '/opt/luac'), '')
  assert.match(programProblem('Tools/luac', '/opt/luac'), /程序名不对/)
  assert.match(programProblem('luac', 'Tools/luac'), /绝对路径/)
})
