/** AI 分析表格风格：提示词带上样本，JSON 校验，勾选的几项并进结构文件 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TableSchema } from './tables.ts'
import { applyTablesDraft, buildTablesBody, draftItemIds, resolveTablesProposal } from './tables-assist.ts'

const draft = {
  summary: '5 行表头',
  style: {
    header: { start: 0, roles: ['modifier', 'side', 'type', 'name', 'comment'] },
    key: 'Id',
    listSep: '|',
    exceptions: [{ glob: 'Enum/*.xlsx', header: { start: 0, roles: ['type', 'name'] }, why: '枚举表' }],
  },
  enums: { Size: { values: [{ name: 'S' }, { name: 'M' }] } },
  columns: { 'a.xlsx#*#Role': { ref: 'b.xlsx#ID' } },
}

test('提示词带上样本和对话', () => {
  const p = buildTablesBody({ sample: '### a.xlsx\n1\tID' }, [{ role: 'user', text: '主键是 Id' }])
  assert.match(p, /### a\.xlsx/)
  assert.match(p, /主键是 Id/)
  assert.match(p, /```json/)
})

test('JSON 校验：角色名不对时报错，缺的部分给默认', () => {
  const bad = resolveTablesProposal({ style: { header: { start: 0, roles: ['nope'] } } })
  assert.ok(bad.error?.includes('style.header.roles'))
  const ok = resolveTablesProposal({})
  assert.deepEqual(ok.proposal?.draft.enums, {})
  assert.equal(ok.proposal?.kind, 'tables')
})

test('只并勾上的项：例外按 glob 换，枚举保留原来的取值来源，记下分析时间', () => {
  const d = resolveTablesProposal(draft).proposal!.draft
  assert.deepEqual(draftItemIds(d), ['header', 'key', 'listSep', 'ex:0', 'enum:Size', 'col:a.xlsx#*#Role'])
  const schema = TableSchema.parse({
    style: { key: 'ID', exceptions: [{ glob: 'Enum/*.xlsx', header: { start: 1, roles: ['name'] } }] },
    enums: { Size: { values: [], source: { file: 'e.xlsx', nameCol: 'Name' } } },
  })
  const next = applyTablesDraft(schema, d, new Set(['header', 'ex:0', 'enum:Size']), '2026-11-11T00:00:00Z')
  assert.equal(next.style.key, 'ID')
  assert.equal(next.style.listSep, ';')
  assert.deepEqual(next.style.header?.roles, ['modifier', 'side', 'type', 'name', 'comment'])
  assert.deepEqual(next.style.exceptions, [{ glob: 'Enum/*.xlsx', header: { start: 0, roles: ['type', 'name'] } }])
  assert.equal(next.enums.Size.source?.file, 'e.xlsx')
  assert.deepEqual(
    next.enums.Size.values.map((v) => v.name),
    ['S', 'M'],
  )
  assert.deepEqual(next.columns, {})
  assert.equal(next.analyzedAt, '2026-11-11T00:00:00Z')
  assert.ok(TableSchema.safeParse(next).success)
})
