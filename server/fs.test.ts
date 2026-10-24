import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { inspectDir } from './fs.ts'

test('inspectDir：带文档地图的 AGENTS.md 算初始化过，手写的、没有的都不算', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-panel-fs-'))
  try {
    assert.equal((await inspectDir(dir)).initialized, false)
    writeFileSync(path.join(dir, 'AGENTS.md'), '# 项目\n\n手写的说明\n')
    assert.equal((await inspectDir(dir)).initialized, false)
    writeFileSync(path.join(dir, 'AGENTS.md'), '# 项目\n\n## 文档地图\n\n- docs/README.md\n- docs/MODULE-MAP.md\n')
    assert.equal((await inspectDir(dir)).initialized, true)
    assert.equal((await inspectDir(path.join(dir, 'AGENTS.md'))).initialized, false)
    assert.equal((await inspectDir(path.join(dir, 'missing'))).initialized, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
