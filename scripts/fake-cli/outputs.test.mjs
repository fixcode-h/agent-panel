/**
 * 假 CLI 输出文件名的唯一事实源：文件名、清理、和注册的 CLI 对齐。
 *
 * 这些名字错了会让 e2e 偶发挂掉（未跟踪的输出文件挡住 git merge），而不是断言失败，
 * 所以单独钉住：新增 CLI 时忘了加进清理列表也要在这里红。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { CLIS } from '../../shared/clis.ts'
import { CLI_OUTPUT_FILES, CLI_OUTPUT_KINDS, clearCliOutputs, cliOutputFile } from './outputs.mjs'

const dirs = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const makeDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-outputs-'))
  dirs.push(dir)
  return dir
}

// custom 是 e2e 在数据目录里注册的测试 CLI（scripts/e2e/fixtures/custom-cli.json），不在内置注册表里，
// 但假 CLI 同样会为它写 custom-output.txt，清理列表必须带上
const TEST_ONLY_KINDS = ['custom']

test('清理列表覆盖注册的每种 CLI：新增 CLI 时漏了它，合并又会被残留文件挡住', () => {
  assert.deepEqual([...CLI_OUTPUT_KINDS].sort(), [...CLIS.map((c) => c.id), ...TEST_ONLY_KINDS].sort())
})

test('每种 CLI 一个不同的输出文件名，统一以 -output.txt 结尾', () => {
  for (const kind of CLI_OUTPUT_KINDS) assert.equal(cliOutputFile(kind), `${kind}-output.txt`)
  assert.equal(new Set(CLI_OUTPUT_FILES).size, CLI_OUTPUT_FILES.length)
})

test('clearCliOutputs 清掉全部输出文件，目录里别的文件不动', () => {
  const dir = makeDir()
  for (const f of CLI_OUTPUT_FILES) writeFileSync(path.join(dir, f), 'x\n')
  writeFileSync(path.join(dir, 'keep.txt'), 'x\n')
  clearCliOutputs(dir)
  for (const f of CLI_OUTPUT_FILES) assert.ok(!existsSync(path.join(dir, f)), `${f} 没清掉`)
  assert.ok(existsSync(path.join(dir, 'keep.txt')), '别的文件不该被删')
})

test('clearCliOutputs 在没有残留的目录上也能跑：重复调用不该报错', () => {
  const dir = makeDir()
  clearCliOutputs(dir)
  clearCliOutputs(dir)
})
