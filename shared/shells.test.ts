import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickShell, recommendedShell, shellNote, type ShellInfo, type ShellReport } from './shells.ts'
import { stepCommand } from './test-steps.ts'

// Windows 上能检测到的几种：Git Bash、WSL 的发行版、PowerShell、cmd
const gitbash: ShellInfo = { id: 'gitbash', path: 'C:\\Program Files\\Git\\bin\\bash.exe' }
const wsl: ShellInfo = { id: 'wsl', path: 'wsl.exe', distros: ['Ubuntu-24.04', 'Debian'] }
const powershell: ShellInfo = { id: 'powershell', path: 'powershell.exe' }
const cmd: ShellInfo = { id: 'cmd', path: 'cmd.exe' }

const report = (shells: ShellInfo[]): ShellReport => ({ platform: 'win32', shells })

test('Windows 上没选 shell 时默认 Git Bash：Git Bash > WSL > cmd 依次回退', () => {
  // 三种都在：推荐 Git Bash，不再像以前那样优先 WSL
  assert.equal(pickShell(report([gitbash, wsl, powershell, cmd]), { kind: '', wslDistro: '' }).id, 'gitbash')
  assert.equal(recommendedShell(report([wsl, gitbash, powershell, cmd])).id, 'gitbash', '检测结果的顺序不影响推荐')
  // 没有 Git Bash：回退 WSL，带上发行的版本设置
  const onlyWsl = pickShell(report([wsl, powershell, cmd]), { kind: '', wslDistro: 'Debian' })
  assert.equal(onlyWsl.id, 'wsl')
  assert.equal(onlyWsl.distro, 'Debian')
  // 两个都没有：按顺序回退 PowerShell，再没有回退 cmd
  assert.equal(pickShell(report([powershell, cmd]), { kind: '', wslDistro: '' }).id, 'powershell')
  assert.equal(pickShell(report([cmd]), { kind: '', wslDistro: '' }).id, 'cmd')
  assert.equal(pickShell(report([]), { kind: '', wslDistro: '' }).id, 'cmd', '一个都没检测到时用 cmd 兜底')
})

test('设置里显式选的 shell 不被默认顺序改动覆盖，选的那个没装才回退', () => {
  const all = report([gitbash, wsl, powershell, cmd])
  const chosenWsl = pickShell(all, { kind: 'wsl', wslDistro: 'Ubuntu-24.04' })
  assert.equal(chosenWsl.id, 'wsl')
  assert.equal(chosenWsl.distro, 'Ubuntu-24.04')
  assert.equal(pickShell(all, { kind: 'powershell', wslDistro: '' }).id, 'powershell')
  assert.equal(pickShell(all, { kind: 'cmd', wslDistro: '' }).id, 'cmd')
  // 显式选了 WSL，但这台机器没有 WSL：回到新的推荐（Git Bash）
  assert.equal(pickShell(report([gitbash, cmd]), { kind: 'wsl', wslDistro: '' }).id, 'gitbash')
  // 发行版不在检测结果里：用 WSL 的默认发行版
  assert.equal(pickShell(all, { kind: 'wsl', wslDistro: 'Gone' }).distro, '')
})

test('给 Agent 的说明：Git Bash 用 Windows 路径，WSL 才提 /mnt', () => {
  const git = shellNote(gitbash)
  assert.match(git, /Git Bash/)
  assert.match(git, /Windows 路径/)
  assert.doesNotMatch(git, /\/mnt\//, 'Git Bash 里不该提 WSL 的挂载路径')
  const w = shellNote({ ...wsl, distro: 'Ubuntu-24.04' })
  assert.match(w, /WSL（Ubuntu-24\.04）\s+的 bash/)
  assert.match(w, /\/mnt\/<盘符>\/…/)
  assert.equal(shellNote({ id: 'sh', path: 'sh' }), '', '非 Windows 不用提示')
})

test('非 Windows 上一律 sh，不因为推荐的改动换掉', () => {
  const r: ShellReport = { platform: 'linux', shells: [{ id: 'sh', path: 'sh' }] }
  assert.equal(recommendedShell(r).id, 'sh')
  assert.equal(pickShell(r, { kind: '', wslDistro: '' }).id, 'sh')
  assert.equal(pickShell(r, { kind: 'gitbash', wslDistro: '' }).id, 'sh', '其他系统上选了 Windows 的 shell 也回到 sh')
})

test('测试步骤里 env: wsl 的步骤仍走 wsl.exe，不受默认 shell 影响', () => {
  const line = stepCommand({ command: 'npm run test:e2e', env: 'wsl' }, 'win32')
  assert.match(line, /^wsl\.exe -d Ubuntu-24\.04 -- bash -lc "/)
  // 项目指定了发行版时用它
  assert.match(
    stepCommand({ command: 'npm run test:e2e', env: 'wsl' }, 'win32', 'Debian'),
    /^wsl\.exe -d Debian -- bash -lc "/,
  )
  // env: auto（默认环境）的步骤才是按平台的默认 shell 跑，这里只验证命令原样交给 shell
  assert.equal(stepCommand({ command: 'npm run typecheck', env: 'auto' }, 'win32'), 'npm run typecheck')
})
