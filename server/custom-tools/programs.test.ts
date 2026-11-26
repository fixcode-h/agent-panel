// 项目程序位置的存放和 custom_tool action=locate（server/custom-tools/programs.ts、agent.ts）
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'program-paths-'))
const { listPrograms, removeProgram, setProgram } = await import('./programs.ts')
const { customToolsFor } = await import('./agent.ts')

const bin = mkdtempSync(path.join(tmpdir(), 'program-bin-'))
const luac = path.join(bin, 'luac')
writeFileSync(luac, '')

test('登记要本机有这个文件；按项目分开；文件删掉后标成找不到', async () => {
  assert.equal((await setProgram('p1', { name: 'luac', path: path.join(bin, 'nope') })).ok, false)
  assert.equal((await setProgram('p1', { name: 'luac', path: 'relative/luac' })).ok, false)
  assert.equal((await setProgram('p1', { name: 'luac', path: luac, note: 'Lua 检查' })).ok, true)
  assert.deepEqual(await listPrograms('p2'), [])
  const tmp = path.join(bin, 'exporter')
  writeFileSync(tmp, '')
  await setProgram('p1', { name: 'exporter', path: tmp })
  rmSync(tmp)
  const list = await listPrograms('p1')
  assert.deepEqual(
    list.map((p) => [p.name, !!p.missing]),
    [
      ['luac', false],
      ['exporter', true],
    ],
  )
  assert.equal((await removeProgram('p1', 'exporter')).ok, true)
  assert.equal((await removeProgram('p1', 'exporter')).ok, false)
})

test('custom_tool action=locate 登记后对话里记一行，下一轮的清单带上路径；只写 program 查位置', async () => {
  const task = { title: '修背包', messages: [] as unknown[] }
  const ctx = { task, signal: new AbortController().signal, newId: () => 'm1', changed: () => {} } as never
  const api = await customToolsFor(ctx, { projectId: 'p3' }, new Set())
  assert.equal(api.hint, '')
  const r = await api.call({ action: 'locate', program: 'luac', path: luac, note: 'Lua 检查' }, {})
  assert.equal(r.error, undefined, r.text)
  assert.equal(task.messages.length, 1)
  const next = await customToolsFor(ctx, { projectId: 'p3' }, new Set())
  assert.match(next.hint, new RegExp(`luac ${luac.replace(/[\\/.]/g, '\\$&')}`))
  assert.equal((await next.call({ action: 'locate', program: 'luac' }, {})).text, `luac：${luac}`)
  assert.equal((await next.call({ action: 'locate', program: 'texconv' }, {})).error, true)
  assert.equal((await next.call({ action: 'locate', program: 'luac', forget: true }, {})).error, undefined)
  assert.deepEqual(await listPrograms('p3'), [])
})
