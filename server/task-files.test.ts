import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 数据目录要在 store.ts 加载之前定好：TASK_FILES_DIR 是模块加载时算出来的
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-task-files-'))
process.env.AGENT_PANEL_DATA = dir
const { taskFiles } = await import('./task-files.ts')

test('对话目录：开工前建好 screenshots / tests / tmp，规则写明截图和临时文件只放这里、不另建 temp 文件夹', async () => {
  try {
    const got = await taskFiles('t1')
    assert.equal(got.dir, path.join(dir, 'tasks', 'files', 't1'))
    for (const k of ['screenshots', 'tests', 'tmp']) assert.ok(existsSync(path.join(got.dir, k)), k)
    assert.ok(got.rule.includes(got.dir))
    assert.match(got.rule, /截图放它下面的 screenshots\//)
    assert.match(got.rule, /不要在项目目录里、系统临时目录或别的地方另建 temp、tmp/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
