/**
 * 文件改动什么时候算数（file-events.ts）：被钩子拦下、失败的写入不算，临时目录里的不算。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { FileChange, ToolUse } from '../../shared/schema.ts'

const data = mkdtempSync(path.join(tmpdir(), 'agent-panel-files-'))
process.env.AGENT_PANEL_DATA = data
const { createFileEvents, projectChanges, scratchPath } = await import('./file-events.ts')

const proj = path.join(tmpdir(), 'proj-files')
const tool = (): ToolUse => ({ kind: 'edit', label: 'a.lua' }) as ToolUse
const file = (p: string): FileChange => ({ path: p, add: 4, del: 0 })

test('写入等结果：成功才记，被钩子拦下（失败）的不记', () => {
  const got: string[] = []
  const ev = createFileEvents(proj, (f) => got.push(f.path))
  const ok = tool()
  const denied = tool()
  ev.track(ok, file('a.lua'), true)
  ev.track(denied, file('b.lua'), true)
  assert.deepEqual(got, [], '结果没到之前不记')
  denied.failed = true
  ev.settle(denied)
  ev.settle(ok)
  assert.deepEqual(got, ['a.lua'])
  ev.settle(ok)
  assert.deepEqual(got, ['a.lua'], '同一次调用只记一次')
})

test('不用等结果的调用按调用本身记；临时目录、数据目录里的不记，项目在临时目录下照常算', () => {
  const got: string[] = []
  const ev = createFileEvents(proj, (f) => got.push(f.path))
  ev.track(tool(), file('c.lua'), false)
  ev.track(tool(), file(path.join(data, 'tasks/files/x/tmp/build_editor.bat')), false)
  ev.track(tool(), file(path.join(proj, 'd.lua')), false)
  assert.deepEqual(got, ['c.lua', path.join(proj, 'd.lua')])
  assert.equal(scratchPath(path.join(tmpdir(), 'other/x.bat'), proj), true)
  assert.equal(scratchPath('src/a.ts', proj), false)
  assert.deepEqual(
    projectChanges([file('a.lua'), file(path.join(data, 'tasks/files/x/tmp/b.bat'))], proj).map((c) => c.path),
    ['a.lua'],
  )
})
