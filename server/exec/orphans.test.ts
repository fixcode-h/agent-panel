import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 登记文件在 DATA_DIR 下，必须在 import 之前指到临时目录
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'orphans-data-'))

const { cleanStaleCliProcesses, clearTrackedClis, looksLikePanelCli, trackCliProcess, untrackCliProcess } =
  await import('./orphans.ts')

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const FILE = path.join(process.env.AGENT_PANEL_DATA, 'run', 'cli-pids.json')
const saved = () => JSON.parse(readFileSync(FILE, 'utf8')).processes as { pid: number }[]

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

test('登记文件：记下来、结束时去掉、正常退出清空', () => {
  clearTrackedClis()
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
  await wait(500)

  clearTrackedClis()
  trackCliProcess(panel.pid!, `node -e setTimeout ${panelArg} ${panelJson}`, '/tmp')
  trackCliProcess(userPi.pid!, 'node -e setTimeout', '/tmp')

  const killed: number[] = []
  await cleanStaleCliProcesses((pid) => killed.push(pid))

  assert.deepEqual(killed, [panel.pid], '只清理认得出是面板起的那个')
  assert.deepEqual(saved(), [], '清理后登记清空，不会下次再杀一遍')

  for (const child of [panel, userPi]) {
    try {
      child.kill()
    } catch {}
  }
  await wait(300)
})
