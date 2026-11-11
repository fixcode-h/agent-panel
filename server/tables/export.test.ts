/** 导表：占位换成真实路径后用 shell 执行，输出逐行推回；一条失败后面的不跑 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TablesConfig } from '../../shared/tables.ts'
import type { ExportEvent } from '../../shared/table-export.ts'
import { runExport } from './export.ts'

const setup = (command: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-table-export-'))
  mkdirSync(path.join(dir, 'Config'))
  writeFileSync(path.join(dir, 'Config/A b.csv'), 'ID\n1\n')
  writeFileSync(path.join(dir, 'Config/C.csv'), 'ID\n1\n')
  const cfg = TablesConfig.parse({ dirs: ['Config'], exports: [{ name: 'x', command }] })
  return { dir, cfg }
}

test('每张表执行一次，路径带空格也能原样传进去', { skip: process.platform === 'win32' }, async () => {
  const { dir, cfg } = setup('echo "got:{name}" && test -f {file}')
  const ev: ExportEvent[] = []
  await runExport(dir, cfg, { script: 0, paths: ['Config/A b.csv', 'Config/C.csv'] }, (e) => void ev.push(e))
  assert.deepEqual(
    ev.filter((e) => e.type === 'out').map((e) => (e as { text: string }).text),
    ['got:A b', 'got:C'],
  )
  assert.deepEqual(ev.at(-1), { type: 'done', ok: true })
})

test('失败就停，后面的不跑', { skip: process.platform === 'win32' }, async () => {
  const { dir, cfg } = setup('exit 3')
  const ev: ExportEvent[] = []
  await runExport(dir, cfg, { script: 0, paths: ['Config/A b.csv', 'Config/C.csv'] }, (e) => void ev.push(e))
  assert.equal(ev.filter((e) => e.type === 'start').length, 1)
  assert.equal((ev.find((e) => e.type === 'end') as { code: number }).code, 3)
  assert.deepEqual(ev.at(-1), { type: 'done', ok: false })
  await assert.rejects(
    runExport(dir, cfg, { script: 5, paths: ['Config/C.csv'] }, () => {}),
    /找不到这个导表脚本|not found/,
  )
})
