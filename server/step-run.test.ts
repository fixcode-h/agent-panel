/**
 * 面板跑项目测试步骤时按步骤自己的环境直接起进程，不再包一层字符串交给设置里的 shell（server/step-run.ts）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { stepRun } from './step-run.ts'
import { shellCommand } from './merge-build.ts'

const BUILD =
  '"D:/Program Files/Epic Games/UE_5.8/Engine/Build/BatchFiles/Build.bat" X Win64 Development -Project="C:/P/X.uproject"'

test('Windows 上 cmd 步骤直接交给 cmd.exe /d /s /c，命令原文不加转义（用户 2026-11-12 报 request_build 假成功）', async () => {
  const r = await stepRun({ command: BUILD, env: 'cmd' }, 'win32')
  assert.equal(r.command, BUILD)
  assert.equal(r.shell?.id, 'cmd')
  const c = shellCommand(r.command, 'win32', r.shell)
  assert.deepEqual(c.args, ['/d', '/s', '/c', `"${BUILD}"`])
  assert.equal(c.windowsVerbatimArguments, true)
})

test('WSL、PowerShell 步骤也直接起对应的进程；不是 Windows 照旧拼成一行', async () => {
  const w = await stepRun({ command: 'npm test', env: 'wsl' }, 'win32', '')
  assert.deepEqual(w, { command: 'npm test', shell: { id: 'wsl', path: 'wsl.exe', distro: 'Ubuntu-24.04' } })
  const p = await stepRun({ command: 'Get-Date', env: 'powershell' }, 'win32')
  assert.equal(p.command, 'Get-Date')
  assert.equal(p.shell?.id, 'powershell')
  const auto = await stepRun({ command: 'npm test', env: 'auto' }, 'win32')
  assert.deepEqual(auto, { command: 'npm test' })
  assert.deepEqual(await stepRun({ command: 'make', env: 'cmd' }, 'linux'), { command: 'make' })
})
