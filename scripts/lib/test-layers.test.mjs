import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LAYER_SAMPLES } from './test-layers.samples.mjs'
import {
  INTEGRATION_MARKERS,
  LAYERS,
  countCases,
  countLines,
  countSteps,
  integrationMarkers,
  isE2eShard,
  layerOf,
  listE2eShards,
  listUnitTestFiles,
} from './test-layers.mjs'

/** 仓库根：枚举函数的用例要对着真实目录跑一遍，确认后缀和跳过目录的口径没漂 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('分层：起服务、监听端口的测试归集成层', () => {
  const { layer, markers } = layerOf('server/tasks.test.ts', LAYER_SAMPLES.httpServer)
  assert.equal(layer, LAYERS.integration)
  assert.deepEqual(markers, ['http-server'])
})

test('分层：建临时目录、读写真实文件的测试归集成层', () => {
  const { layer, markers } = layerOf('server/task-store.test.ts', LAYER_SAMPLES.tempDir)
  assert.equal(layer, LAYERS.integration)
  assert.deepEqual(markers, ['temp-dir', 'real-files'])
  // fs/promises 的异步版（readFile / rm，不带 Sync 后缀）同样算真实文件读写
  const asyncFs = layerOf('server/exec/system-prompt.test.ts', LAYER_SAMPLES.asyncFs)
  assert.equal(asyncFs.layer, LAYERS.integration)
  assert.deepEqual(asyncFs.markers, ['real-files'])
})

test('分层：执行 git、开子进程的测试归集成层', () => {
  const { layer, markers } = layerOf('server/exec/worktree-merge.test.ts', LAYER_SAMPLES.gitAndChild)
  assert.equal(layer, LAYERS.integration)
  assert.deepEqual(markers, ['git', 'child-process'])
})

test('分层：只做内存计算的测试归纯函数层，正则 exec 不算开子进程', () => {
  const { layer, markers } = layerOf('server/p4-split.test.ts', LAYER_SAMPLES.pureLogic)
  assert.equal(layer, LAYERS.pure)
  assert.deepEqual(markers, [])
  assert.deepEqual(integrationMarkers(''), [])
})

test('分层：e2e 只认 scripts/e2e 下被总入口调度的分片，其余仍按运行时特征判', () => {
  for (const file of ['scripts/e2e/03-chat.mjs', 'scripts/e2e/10-spawn-server.mjs'])
    assert.deepEqual(layerOf(file, '// 分片内容'), { layer: LAYERS.e2e, markers: [] })
  // harness、辅助脚本、它们自己的单测都不是分片；带集成特征就按集成层，没有就是纯函数层
  for (const file of ['scripts/e2e/harness.mjs', 'scripts/e2e/spawn-server.test.mjs', 'scripts/e2e/read-log.mjs'])
    assert.equal(isE2eShard(file), false, file)
  assert.equal(layerOf('scripts/e2e/spawn-server.test.mjs', LAYER_SAMPLES.gitAndChild).layer, LAYERS.integration)
  assert.equal(layerOf('scripts/e2e/read-log.test.mjs', LAYER_SAMPLES.pureLogic).layer, LAYERS.pure)
})

test('分层：特征表每条都有唯一 id、文案和可执行的判据', () => {
  const ids = INTEGRATION_MARKERS.map((m) => m.id)
  assert.equal(new Set(ids).size, ids.length, '特征 id 不能重复')
  for (const m of INTEGRATION_MARKERS) {
    assert.ok(m.label, `${m.id} 缺少文案`)
    assert.ok(m.test instanceof RegExp, `${m.id} 的判据必须是正则`)
  }
})

test('分层：单测枚举只收各目录自己的后缀，跳过依赖和生成物，e2e 分片单独枚举', () => {
  const files = listUnitTestFiles(root)
  assert.ok(files.length > 200, `枚举到的单测文件太少：${files.length}`)
  assert.ok(files.includes('server/exec/worktree-merge.test.ts'))
  assert.ok(files.includes('scripts/lib/test-layers.test.mjs'))
  for (const file of files) {
    assert.match(file, /\.test\.(ts|mjs)$/, file)
    assert.ok(!file.includes('node_modules/'), file)
  }
  assert.ok(!files.includes('scripts/e2e/03-chat.mjs'), 'e2e 分片不归单测枚举')

  const shards = listE2eShards(root)
  assert.ok(shards.includes('scripts/e2e/03-chat.mjs'))
  assert.ok(shards.length >= 10, `e2e 分片太少：${shards.length}`)
  for (const file of ['scripts/e2e/harness.mjs', 'scripts/e2e/read-log.test.mjs'])
    assert.ok(!shards.includes(file), `${file} 不是分片`)
})

test('分层：用例数 / 步骤数按行首调用静态统计，行数按 LF 切', () => {
  const source = ["test('a', () => {})", "  it('b', () => {})", "test.skip('c', () => {})", "obj.test('d')"].join('\n')
  assert.equal(countCases(source), 2, 'test.skip 和行内调用不算')
  assert.equal(countSteps(["await step('a')", "step('b')", '// step(不是调用)'].join('\n')), 2)
  assert.equal(countLines('a\nb\n'), 3)
  assert.equal(countCases(''), 0)
})
