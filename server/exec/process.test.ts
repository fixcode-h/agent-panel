/**
 * CLI 进程生命周期：程序退出时还在跑的子进程要能统一结束。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { killAllProcesses, runProcess } from './process.ts'

test('统一清理还在跑的 CLI 进程，runProcess 能正常收尾', async () => {
  let spawned!: () => void
  const ready = new Promise<void>((r) => (spawned = r))
  const run = runProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    env: process.env,
    onSpawn: () => spawned(),
  })
  await ready
  killAllProcesses()
  const r = await run
  assert.equal(r.spawnError, undefined)
  assert.ok(r.code === null || typeof r.code === 'number')
})
