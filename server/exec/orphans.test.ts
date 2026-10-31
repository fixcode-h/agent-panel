import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { mock } from 'node:test'

// 登记文件在 DATA_DIR 下，必须在 import 之前指到临时目录
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'orphans-data-'))

const {
  cleanStaleCliProcesses,
  clearTrackedClis,
  killTaskClis,
  looksLikePanelCli,
  looksLikePanelServer,
  reapSettledTaskClis,
  trackCliProcess,
  untrackCliProcess,
} = await import('./orphans.ts')

/**
 * 等子进程真的起来：spawn 事件在 exec 成功之后才发，这时 ps 看到的已经是它自己的命令行。
 * 以前固定等 500–800ms，慢机器上不够、快机器上白等
 */
const started = (...cs: ChildProcess[]) => Promise.all(cs.map((c) => (c.pid ? once(c, 'spawn') : Promise.resolve())))
/** 结束子进程并等它真的退出（被 SIGKILL 过的就只等 exit）：以前固定等 300ms 赌它退了 */
const ended = (...cs: ChildProcess[]) =>
  Promise.all(
    cs.map((c) => {
      if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve()
      const exit = once(c, 'exit')
      try {
        c.kill()
      } catch {}
      return exit
    }),
  )
/** 每个实例一份登记文件，文件名就是面板 pid：本实例那份是 process.pid */
const DIR = path.join(process.env.AGENT_PANEL_DATA!, 'run', 'cli-pids')
const OWN = path.join(DIR, `${process.pid}.json`)

type Saved = { pid: number; panelPid?: number }[]
const readOf = (file: string): Saved => {
  try {
    return (JSON.parse(readFileSync(file, 'utf8')).processes ?? []) as Saved
  } catch {
    return []
  }
}
/** 本实例的登记（空了文件会被删掉） */
const saved = () => readOf(OWN)
/** 盘上所有实例的登记合在一起 */
const allSaved = () => {
  try {
    return readdirSync(DIR).flatMap((f) => readOf(path.join(DIR, f)))
  } catch {
    return []
  }
}
/** 清掉测试里造的所有登记文件（分文件后 clearTrackedClis 只删自己那份） */
const resetFiles = () => rmSync(DIR, { recursive: true, force: true })
/** 只删自己的文件，保留刚写进去的别实例文件 */
const resetFilesOwn = () => rmSync(OWN, { force: true })
/** 直接往「另一个面板实例」的文件里塞登记：文件名就是它的面板 pid */
function pushForeign(panelPid: number, entries: Record<string, unknown>[]) {
  resetFilesOwn()
  mkdirSync(DIR, { recursive: true })
  writeFileSync(
    path.join(DIR, `${panelPid}.json`),
    JSON.stringify({ processes: entries.map((x) => ({ cwd: '/tmp', startedAt: Date.now(), panelPid, ...x })) }),
  )
}

test('认得出面板起的 CLI 命令行', () => {
  const panelCli = [
    // Pi 的桥接扩展：面板自己的临时目录
    'pi -e /home/u/.agent-panel/cache/cli-run/ab12cd34ef56/panel-ext.mjs',
    'C:\\Users\\u\\AppData\\Local\\pi\\pi.exe -e C:\\Users\\u\\.agent-panel\\cache\\cli-run\\9f8e7d6c5b4a\\bridge.mjs',
    // 参数里直接带 MCP 配置的 CLI：桥接地址 + panel 名字
    'claude --mcp-config {"mcpServers":{"panel":{"url":"http://127.0.0.1:51234/mcp"}}}',
  ]
  for (const argv of panelCli) assert.equal(looksLikePanelCli(argv), true, argv)

  const notPanel = [
    'pi',
    'pi --resume',
    'codex --model gpt-5 --full-auto',
    'C:\\Program Files\\nodejs\\node.exe node_modules\\vite\\bin\\vite.js',
    // 项目目录里有 agent-panel 也不算：只认面板的临时目录和桥接参数
    'node F:\\Project\\agent-panel\\node_modules\\typescript\\bin\\tsc --noEmit',
    // 用户自己配的 MCP 服务不叫 panel
    'claude --mcp-config {"mcpServers":{"docs":{"url":"http://127.0.0.1:9000/mcp"}}}',
  ]
  for (const argv of notPanel) assert.equal(looksLikePanelCli(argv), false, argv)
  assert.equal(looksLikePanelCli(''), false)
})

test('认得出面板服务自己的命令行：面板 pid 被复用时不能当成「那个面板还活着」', () => {
  for (const argv of [
    'node C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\agent-panel\\server.mjs',
    'node --import=tsx server/index.ts',
    '/usr/bin/node /home/u/agent-panel/server.mjs',
    // 发布包的两种启动写法：包目录里 `./` 开头、托盘用带空格的绝对路径（带引号）
    'node ./server.mjs --prod',
    'node "C:\\Program Files\\agent-panel\\server.mjs" --prod',
    'node "server.mjs"',
  ])
    assert.equal(looksLikePanelServer(argv), true, argv)
  // 面板起的 CLI、无关的 node 进程都不算面板
  for (const argv of [
    'pi -e /home/u/.agent-panel/cache/cli-run/x/panel.mjs',
    'node -e setTimeout',
    'node C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js run test:unit',
    // 数据目录 / worktree 路径里都带 .agent-panel：不能只凭路径就当它是面板服务
    'node C:\\Users\\u\\.agent-panel\\worktrees\\x\\scripts\\foo.mjs',
    'node /home/u/.agent-panel/tasks/projects/p/scripts/build.mjs',
  ])
    assert.equal(looksLikePanelServer(argv), false, argv)
  assert.equal(looksLikePanelServer(''), false)
})

test('登记文件：记下来、结束时去掉、正常退出只删自己那份', () => {
  resetFiles()
  trackCliProcess(11111, 'pi -e /home/u/.agent-panel/cache/cli-run/x/panel.mjs', '/tmp')
  trackCliProcess(22222, 'codex --foo', '/tmp')
  assert.deepEqual(
    saved()
      .map((x) => x.pid)
      .sort(),
    [11111, 22222],
  )

  untrackCliProcess(11111)
  assert.deepEqual(
    saved().map((x) => x.pid),
    [22222],
  )

  // 不在登记里的 pid：不写盘也不报错
  untrackCliProcess(33333)
  assert.deepEqual(
    saved().map((x) => x.pid),
    [22222],
  )

  clearTrackedClis()
  assert.deepEqual(saved(), [])
  assert.deepEqual(
    readdirSync(DIR).filter((f) => f.endsWith('.json')),
    [],
    '自己没有登记了，文件也删掉',
  )
})

test('启动清理：只杀命令行还带面板痕迹的，pid 被复用的不碰', async () => {
  const panelArg = '--mcp-config'
  const panelJson = '{"mcpServers":{"panel":{"url":"http://127.0.0.1:51234/mcp"}}}'
  // 上个面板留下的 CLI（命令行带桥接参数）；用 `--` 把 --mcp-config 交给子进程，不让 node 当成自己的选项
  const panel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', panelArg, panelJson], {
    stdio: 'ignore',
  })
  // 同一个 pid 现在跑的是用户自己起的 pi（模拟 pid 复用）：命令行没有面板痕迹
  const userPi = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  assert.ok(panel.pid && userPi.pid)
  await started(panel, userPi)

  resetFiles()
  trackCliProcess(panel.pid!, `node -e setTimeout ${panelArg} ${panelJson}`, '/tmp')
  trackCliProcess(userPi.pid!, 'node -e setTimeout', '/tmp')

  const killed: number[] = []
  await cleanStaleCliProcesses((pid) => {
    killed.push(pid)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  })

  assert.deepEqual(killed, [panel.pid], '只清理认得出是面板起的那个')
  assert.deepEqual(saved(), [], '确认退了才丢登记，不会下次再杀一遍')

  await ended(panel, userPi)
})

test('登记按面板实例分账：一个实例退出不清掉另一个的登记', () => {
  resetFiles()
  trackCliProcess(11111, 'pi -e /home/u/.agent-panel/cache/cli-run/a/panel.mjs', '/tmp')
  pushForeign(999999, [{ pid: 22222, argv: 'pi -e /home/u/.agent-panel/cache/cli-run/b/panel.mjs' }])

  // 本实例正常退出（killAllProcesses → clearTrackedClis）：只删自己那份文件
  clearTrackedClis()
  assert.deepEqual(saved(), [], '自己那份清空')
  assert.deepEqual(
    allSaved().map((x) => x.pid),
    [22222],
    '另一个面板实例还在跑，它的登记不能被这个实例的退出清掉',
  )
  resetFiles()
})

test('启动清理不碰另一个还活着的面板实例的 CLI；那个面板 pid 被复用（不像面板）时按遗留清掉', async () => {
  const panelArg = '--mcp-config'
  const panelJson = '{"mcpServers":{"panel":{"url":"http://127.0.0.1:51234/mcp"}}}'
  const spawnCli = () =>
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', panelArg, panelJson], { stdio: 'ignore' })
  // 另一个面板实例（命令行像面板服务）和它起的 CLI
  const otherPanel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', 'server.mjs'], {
    stdio: 'ignore',
  })
  const otherCli = spawnCli()
  // 一个无关进程占着旧登记里的 panelPid（模拟 pid 复用）
  const reusedPanel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  const orphanCli = spawnCli()
  assert.ok(otherPanel.pid && otherCli.pid && reusedPanel.pid && orphanCli.pid)
  await started(otherPanel, otherCli, reusedPanel, orphanCli)

  resetFiles()
  pushForeign(otherPanel.pid!, [{ pid: otherCli.pid, argv: `node -e setTimeout ${panelArg} ${panelJson}` }])
  pushForeign(reusedPanel.pid!, [{ pid: orphanCli.pid, argv: `node -e setTimeout ${panelArg} ${panelJson}` }])

  const killed: number[] = []
  await cleanStaleCliProcesses((pid) => {
    killed.push(pid)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  })

  assert.deepEqual(killed, [orphanCli.pid], '面板还活着的留着；panelPid 被复用的按遗留清掉')
  assert.deepEqual(
    allSaved().map((x) => x.pid),
    [otherCli.pid],
    '活实例的登记留着；遗留实例的登记清掉',
  )

  await ended(otherPanel, otherCli, reusedPanel, orphanCli)
  resetFiles()
})

test('兜底回收：任务已收口、CLI 还活着的收掉；还在等下一句的不碰', async () => {
  const panelArg = '--mcp-config'
  const panelJson = '{"mcpServers":{"panel":{"url":"http://127.0.0.1:51234/mcp"}}}'
  const spawnCli = () =>
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', panelArg, panelJson], { stdio: 'ignore' })
  const done = spawnCli()
  const waiting = spawnCli()
  assert.ok(done.pid && waiting.pid)
  await started(done, waiting)

  resetFiles()
  trackCliProcess(done.pid!, `node -e setTimeout ${panelArg} ${panelJson}`, '/tmp', {
    taskId: 't-done',
    rootTaskId: 't-done',
    title: '做完了的对话',
  })
  trackCliProcess(waiting.pid!, `node -e setTimeout ${panelArg} ${panelJson}`, '/tmp', {
    taskId: 't-waiting',
    rootTaskId: 't-waiting',
    title: '停在等下一句的对话',
  })

  const killed: number[] = []
  const reaped = await reapSettledTaskClis({
    // 只有 t-done 算收口（判定本身在 shared/task.ts 的 taskSettled，这里只验证进程侧）
    settled: async (id) => id === 't-done',
    kill: (pid) => {
      killed.push(pid)
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    },
  })

  assert.deepEqual(killed, [done.pid], '只收已收口那条')
  assert.deepEqual(
    reaped.map((x) => ({ taskId: x.taskId, title: x.title })),
    [{ taskId: 't-done', title: '做完了的对话' }],
    '回收结果带着任务和标题（日志要用）',
  )
  assert.ok(reaped[0].aliveMs > 0, '要能说出这个进程活了多久')
  assert.deepEqual(
    saved().map((x) => x.pid),
    [waiting.pid],
    '回收掉的那条登记清掉；还在等下一句的留着',
  )

  await ended(done, waiting)
  resetFiles()
})

test('兜底回收不碰另一个活着的面板实例正在用的进程', async () => {
  const panelArg = '--mcp-config'
  const panelJson = '{"mcpServers":{"panel":{"url":"http://127.0.0.1:51234/mcp"}}}'
  const otherPanel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', 'server.mjs'], {
    stdio: 'ignore',
  })
  const otherCli = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', panelArg, panelJson], {
    stdio: 'ignore',
  })
  assert.ok(otherPanel.pid && otherCli.pid)
  await started(otherPanel, otherCli)

  resetFiles()
  // 另一个实例的任务在本实例盘上看起来「已收口」（摘要落后），但它的面板还活着：不能从这边杀
  pushForeign(otherPanel.pid!, [
    {
      pid: otherCli.pid,
      argv: `node -e setTimeout ${panelArg} ${panelJson}`,
      owner: { taskId: 't-other', rootTaskId: 't-other', title: '别的实例在跑的对话' },
    },
  ])

  const killed: number[] = []
  const reaped = await reapSettledTaskClis({
    settled: async () => true,
    kill: (pid) => killed.push(pid),
  })
  assert.deepEqual(killed, [], '别的实例还活着，它的进程由它自己收')
  assert.deepEqual(reaped, [])

  await ended(otherPanel, otherCli)
  resetFiles()
})

test('启动清理：进程没结束的条目写回登记，不留成永久僵尸', async () => {
  const panelArg = '--mcp-config'
  const panelJson = '{"mcpServers":{"panel":{"url":"http://127.0.0.1:51234/mcp"}}}'
  const cli = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', panelArg, panelJson], {
    stdio: 'ignore',
  })
  assert.ok(cli.pid)
  await started(cli)

  resetFiles()
  trackCliProcess(cli.pid, `node -e setTimeout ${panelArg} ${panelJson}`, '/tmp')

  // kill 什么都不做（模拟权限不足 / taskkill 失败）：进程还活着，登记不能丢
  const killed: number[] = []
  // 进程不退，清理会等满 KILL_SETTLE_MS（3.5 秒）才认定它没结束：这段换成假时钟推过去，不真等。
  // 只假 setTimeout 和 Date：列进程的 ps 是真实子进程，靠 setImmediate 让出事件循环等它回来
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  try {
    const cleaning = cleanStaleCliProcesses((pid) => killed.push(pid))
    const deadline = performance.now() + 10_000
    // kill 发出之后清理同步走到等待那一步，排上第一个假定时器
    while (!killed.length) {
      assert.ok(performance.now() < deadline, '清理没走到发出停止那一步')
      await new Promise((r) => setImmediate(r))
    }
    // 每次推 100ms（等待里的轮询间隔），让每轮的检查和下一个定时器接上；推过 3.5 秒上限就该放行
    for (let i = 0; i < 40; i++) {
      mock.timers.tick(100)
      await new Promise((r) => setImmediate(r))
    }
    await cleaning
  } finally {
    mock.timers.reset()
  }

  assert.deepEqual(killed, [cli.pid], '发出过停止')
  assert.deepEqual(
    saved().map((x) => x.pid),
    [cli.pid],
    '没结束的进程要留在登记里，下次启动还能认出来',
  )

  await ended(cli)
  resetFiles()
})

test('兜底回收不改写另一个活实例的登记文件：它自己清（R1）', async () => {
  const panelArg = '--mcp-config'
  const panelJson = '{"mcpServers":{"panel":{"url":"http://127.0.0.1:51234/mcp"}}}'
  const cliArgv = `node -e setTimeout ${panelArg} ${panelJson}`
  const otherPanel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', 'server.mjs'], {
    stdio: 'ignore',
  })
  const otherCli = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', panelArg, panelJson], {
    stdio: 'ignore',
  })
  // 已经退出的进程：本实例会想把它从登记里清掉
  const dead = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1)'], { stdio: 'ignore' })
  assert.ok(otherPanel.pid && otherCli.pid && dead.pid)
  // dead 要真的退出并被回收（pid 查不到了），本实例才会想清它那条
  await Promise.all([started(otherPanel, otherCli), once(dead, 'exit')])

  resetFiles()
  pushForeign(otherPanel.pid!, [
    { pid: otherCli.pid, argv: cliArgv, owner: { taskId: 't-live', rootTaskId: 't-live', title: '在跑' } },
    { pid: dead.pid, argv: cliArgv, owner: { taskId: 't-dead', rootTaskId: 't-dead', title: '已退出' } },
  ])

  const killed: number[] = []
  await reapSettledTaskClis({ settled: async () => true, kill: (pid) => killed.push(pid) })
  assert.deepEqual(killed, [], '别的实例还活着，一条都不杀')

  const file = path.join(DIR, `${otherPanel.pid}.json`)
  assert.deepEqual(
    readOf(file)
      .map((x) => x.pid)
      .sort((a, b) => a - b),
    [otherCli.pid, dead.pid].sort((a, b) => a - b),
    '活实例的文件原样保留：已死那条由它自己清，本实例不能读-改-写',
  )

  await ended(otherPanel, otherCli)
  resetFiles()
})

test('收尾后按任务回收：只动这个任务名下的进程', async () => {
  const panelArg = '--mcp-config'
  const panelJson = '{"mcpServers":{"panel":{"url":"http://127.0.0.1:51234/mcp"}}}'
  const mine = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', panelArg, panelJson], {
    stdio: 'ignore',
  })
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', panelArg, panelJson], {
    stdio: 'ignore',
  })
  assert.ok(mine.pid && other.pid)
  await started(mine, other)

  resetFiles()
  trackCliProcess(mine.pid!, `node -e setTimeout ${panelArg} ${panelJson}`, '/tmp', {
    taskId: 'child',
    rootTaskId: 'parent',
    title: '子对话',
  })
  trackCliProcess(other.pid!, `node -e setTimeout ${panelArg} ${panelJson}`, '/tmp', {
    taskId: 'sibling',
    rootTaskId: 'parent',
    title: '兄弟对话',
  })

  const killed = await killTaskClis('child', (pid) => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  })
  assert.deepEqual(killed, [mine.pid])
  assert.deepEqual(
    saved().map((x) => x.pid),
    [other.pid],
    '兄弟对话的进程和登记都不能动',
  )

  await ended(mine, other)
  resetFiles()
})
