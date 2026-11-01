/**
 * CLI 进程生命周期：程序退出时还在跑的子进程要能统一结束。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { getCli } from '../../shared/clis.ts'
import { t } from '../../shared/i18n.ts'
import { earlyExitError, exitReason, killAllProcesses, runProcess, stderrTail, taskCliAlive } from './process.ts'

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

test('taskCliAlive：只在这个对话的 CLI 进程真的活着时为真，进程退出就撤掉', async () => {
  let spawned!: () => void
  const ready = new Promise<void>((r) => (spawned = r))
  const ac = new AbortController()
  const run = runProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    env: process.env,
    signal: ac.signal,
    owner: { taskId: 'cli-alive-t', rootTaskId: 'cli-alive-t', title: '' },
    onSpawn: () => spawned(),
  })
  await ready
  assert.equal(taskCliAlive('cli-alive-t'), true)
  assert.equal(taskCliAlive('other'), false)
  ac.abort()
  await run
  // 进程树没被很快杀掉时，runProcess 会在 5 秒后先结束等待，这时进程可能真的还活着（Windows 上 taskkill 偶发慢）。
  // 这条用例验的是「进程退出后撤掉登记」，不是「几毫秒内退出」：等它退完再断言，别把「还没退」误判成「没撤登记」
  for (let i = 0; i < 100 && taskCliAlive('cli-alive-t'); i++) await sleep(100)
  assert.equal(taskCliAlive('cli-alive-t'), false)
})

// 实测：kill -9 子对话的 Claude Code，失败原因只剩 stderr 里每次都有的 unrecognized_model 提示，
// 父对话据此说成「模型识别问题」。原因要先写信号，常驻提示行不算原因
const NOISE = '[claude-code:unrecognized_model] {"model":"deepseek-v4.1-flash"}'

test('进程被信号结束：结果里带上信号，失败原因先写它', { skip: process.platform === 'win32' }, async () => {
  const r = await runProcess({
    command: process.execPath,
    args: ['-e', `process.stderr.write(${JSON.stringify(NOISE + '\n')}, () => process.kill(process.pid, 'SIGKILL'))`],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 30_000,
  })
  assert.equal(r.killed, null)
  assert.equal(r.code, null)
  assert.equal(r.exitSignal, 'SIGKILL')
  const claude = getCli('claude')!
  const msg = earlyExitError(claude, r, r.stderr)
  assert.ok(msg.includes(t('进程被外部结束，信号 {signal}', { signal: 'SIGKILL' })), msg)
  assert.ok(!msg.includes('unrecognized_model'), `无害提示行不进失败原因：${msg}`)
  assert.ok(!msg.includes(t('stderr 最后几行：')), `只有提示行时不附 stderr 尾巴：${msg}`)
})

test('stderr 尾巴去掉 CLI 定义里登记的无害提示行，真的报错照样保留', () => {
  const noise = getCli('claude')!.stderrNoise
  assert.ok(noise?.length, 'Claude Code 的定义里登记了 unrecognized_model 提示')
  assert.equal(stderrTail(`${NOISE}\nError: boom\n  ${NOISE}\n`, 3, noise), 'Error: boom')
  // 没登记的 CLI 原样保留
  assert.equal(stderrTail(`${NOISE}\nError: boom`, 3), `${NOISE}\nError: boom`)
  assert.equal(exitReason({ code: 2, exitSignal: null }), t('退出码 {code}', { code: 2 }))
  assert.equal(exitReason({ code: 0, exitSignal: null }), '')
  const msg = earlyExitError({ name: 'X' }, { code: 1, exitSignal: null }, 'Error: boom')
  assert.ok(msg.includes(t('退出码 {code}', { code: 1 })) && msg.includes('Error: boom'), msg)
})
