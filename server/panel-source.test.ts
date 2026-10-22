import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPanelSource } from './panel-source.ts'

test('面板源代码项目：包名和分析代码都对得上才算', async () => {
  assert.equal(await isPanelSource(path.resolve(fileURLToPath(import.meta.url), '../..')), true)
  const dir = await mkdtemp(path.join(tmpdir(), 'panel-src-'))
  try {
    assert.equal(await isPanelSource(dir), false, '没有 package.json')
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-panel' }))
    assert.equal(await isPanelSource(dir), false, '同名的别的包')
    await mkdir(path.join(dir, 'shared'))
    await writeFile(path.join(dir, 'shared', 'task-export.ts'), '')
    assert.equal(await isPanelSource(dir), true)
    assert.equal(await isPanelSource(''), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
