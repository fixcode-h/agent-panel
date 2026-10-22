/**
 * CLI 进程生命周期：程序退出时还在跑的子进程要能统一结束。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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

// npm 全局安装的 CLI 是 .cmd 垫片，cross-spawn 要经过 cmd.exe：参数里带换行时它会把命令行截断，
// 后面的参数全部丢掉（Pi 的 -e 桥接扩展就是这样丢的，模型只剩内建工具）
test('Windows 上参数里的换行不会让后面的参数丢掉', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panel-args-'))
  try {
    const out = path.join(dir, 'argv.json')
    await writeFile(
      path.join(dir, 'argv.mjs'),
      "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))\n",
    )
    // 和 npm 生成的垫片一样：参数原样交给真正的程序
    const shim = path.join(dir, 'cli.cmd')
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "%~dp0argv.mjs" %*\r\n`)
    const r = await runProcess({
      command: shim,
      args: [out, '--append-system-prompt', 'line one\n\nline two', '-e', 'bridge.ts'],
      cwd: dir,
      env: process.env,
      timeoutMs: 30_000,
    })
    assert.equal(r.spawnError, undefined)
    const got: string[] = JSON.parse(await readFile(out, 'utf8'))
    // 后面这几个参数还在（换行被压成空格，参数表不会从这里断开）
    assert.deepEqual(got.slice(-2), ['-e', 'bridge.ts'])
    assert.ok(
      got.every((a) => !/[\r\n]/.test(a)),
      `参数里不能有换行：${JSON.stringify(got)}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
