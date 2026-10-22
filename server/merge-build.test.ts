import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TestStep } from '../shared/schema.ts'
import { verifyBlock } from '../shared/test-steps.ts'

// 独立分支目录建在数据目录里：测试用临时目录，不碰本机真实的数据
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'merge-build-data-'))
const { abortMerge, commitMerge, commitWorktree, createWorktree, mergeBlocker, trialMerge } =
  await import('./exec/worktree.ts')
const { runShell, shellCommand } = await import('./merge-build.ts')

// 读文本时统一换行符：本机 core.autocrlf 和平台不同，合并、检出写出的是 CRLF
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd }).toString()
const readText = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'merge-build-'))
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}
const step = (o: Partial<TestStep>) => TestStep.parse({ id: 's', name: '编译', command: 'true', merge: true, ...o })

test('子对话分支试合回原目录：撤回后原目录不变，提交后合进原分支', async () => {
  const dir = repo()
  const wt = await createWorktree(dir, 'task-1234abcd', 'fix')
  assert.equal(wt.baseBranch, 'main')
  writeFileSync(path.join(wt.path, 'b.txt'), 'new\n')
  assert.equal(await commitWorktree(wt, '子对话的改动'), true)
  assert.equal(await commitWorktree(wt, '没有改动'), false)

  // 撤回：原目录没有 b.txt，也没有合并中的状态
  let m = await trialMerge(dir, wt.branch)
  assert.ok(m.ok && !m.nothing)
  assert.deepEqual(m.ok && m.files, ['b.txt'])
  await abortMerge(dir)
  assert.ok(!existsSync(path.join(dir, 'b.txt')))
  assert.equal(git(dir, 'status', '--porcelain').trim(), '')

  // 提交进 main
  m = await trialMerge(dir, wt.branch)
  await commitMerge(dir, '合并')
  assert.equal(readText(path.join(dir, 'b.txt')), 'new\n')
  // 再合一次：没有新的改动
  m = await trialMerge(dir, wt.branch)
  assert.ok(m.ok && m.nothing)
})

test('试合并有冲突：撤回，列出冲突的文件', async () => {
  const dir = repo()
  const wt = await createWorktree(dir, 'task-5678abcd', 'conflict')
  writeFileSync(path.join(wt.path, 'a.txt'), 'branch\n')
  await commitWorktree(wt, '分支改 a')
  writeFileSync(path.join(dir, 'a.txt'), 'main\n')
  git(dir, 'commit', '-q', '-am', '原目录也改 a')
  const m = await trialMerge(dir, wt.branch)
  assert.equal(m.ok, false)
  assert.match(!m.ok ? m.error : '', /a\.txt/)
  assert.equal(git(dir, 'status', '--porcelain').trim(), '')
  assert.equal(readText(path.join(dir, 'a.txt')), 'main\n')
})

test('原目录暂存区有别人的改动时不合；没提交的改动和分支改了同一个文件时，合并没开始就停', async () => {
  const dir = repo()
  const wt = await createWorktree(dir, 'task-9abc0def', 'fix')
  writeFileSync(path.join(wt.path, 'a.txt'), 'child\n')
  await commitWorktree(wt, '子对话改 a')
  assert.equal(await mergeBlocker(dir), '')

  // 暂存区里的改动会被合并提交一起带走：先拦下
  writeFileSync(path.join(dir, 'c.txt'), 'parent\n')
  git(dir, 'add', 'c.txt')
  assert.match(await mergeBlocker(dir), /暂存区.*\n.*c\.txt/s)
  git(dir, 'reset', '-q', 'c.txt')

  // 原目录里 a.txt 没提交的改动会被覆盖：git 拒绝，标成 dirty，原目录的改动还在
  writeFileSync(path.join(dir, 'a.txt'), 'parent edit\n')
  const m = await trialMerge(dir, wt.branch)
  assert.ok(!m.ok && m.dirty)
  assert.equal(readText(path.join(dir, 'a.txt')), 'parent edit\n')
})

test('对话的验证说明：按改动大小分开，关掉时一律完整跑', () => {
  const steps = [step({ id: 'tc', name: '类型检查', quick: true }), step({ id: 'e', name: '端到端', merge: false })]
  const on = verifyBlock(steps, { platform: 'linux', scaled: true })
  assert.match(on, /小改动.*只跑标「快速」的步骤（类型检查）/)
  assert.match(on, /类型检查（自动，快速）/)
  const none = verifyBlock([step({ id: 'e', name: '端到端', merge: false })], {
    platform: 'linux',
    scaled: true,
  })
  assert.match(none, /挑一个最快的检查/)
  const off = verifyBlock(steps, { platform: 'linux', scaled: false })
  assert.match(off, /每次改动都跑完整的测试步骤/)
  assert.doesNotMatch(off, /小改动/)
})

test('整行命令交给 shell：Windows 上整行加引号原样交给 cmd，引号里的代码不被转义成字符串', async () => {
  const line = `node -e "setTimeout(()=>console.log('到点'),300)"`
  const win = shellCommand(line, 'win32')
  assert.deepEqual(win.args, ['/d', '/s', '/c', `"${line}"`])
  assert.equal(win.windowsVerbatimArguments, true)
  assert.deepEqual(shellCommand(line, 'linux').args, ['-c', line])
  // 真跑一次：等到定时器到点才退出，不是 0 秒就结束
  const start = Date.now()
  const out: string[] = []
  const r = await runShell(line, tmpdir(), { timeoutMs: 20_000, onLine: (l) => out.push(l) })
  assert.equal(r.code, 0)
  assert.ok(Date.now() - start >= 250, '定时器没等到就退出了')
  assert.deepEqual(out, ['到点'])
})

test('命令行环境：WSL、Git Bash、PowerShell 按各自的方式起，选的不在这台机器上时回到推荐的', async () => {
  const { pickShell } = await import('../shared/shells.ts')
  const line = `echo "a b"`
  assert.deepEqual(shellCommand(line, 'win32', { id: 'wsl', path: 'wsl.exe', distro: 'Debian' }).args, [
    '-d',
    'Debian',
    '-e',
    'bash',
    '-lc',
    line,
  ])
  const git = shellCommand(line, 'win32', { id: 'gitbash', path: 'C:\\Git\\bin\\bash.exe' })
  assert.equal(git.command, 'C:\\Git\\bin\\bash.exe')
  assert.equal(git.env.CHERE_INVOKING, '1')
  assert.equal(shellCommand(line, 'win32', { id: 'powershell', path: 'powershell.exe' }).command, 'powershell.exe')
  assert.equal(shellCommand(line, 'linux', { id: 'wsl', path: 'wsl.exe' }).command, 'sh', '非 Windows 一律 sh')
  const report = {
    platform: 'win32',
    shells: [
      { id: 'gitbash' as const, path: 'bash.exe' },
      { id: 'cmd' as const, path: 'cmd.exe' },
    ],
  }
  assert.equal(pickShell(report, { kind: '', wslDistro: '' }).id, 'gitbash', '没有 WSL 时默认 Git Bash')
  assert.equal(pickShell(report, { kind: 'wsl', wslDistro: '' }).id, 'gitbash', '选的 WSL 没装：回到推荐的')
  assert.equal(pickShell(report, { kind: 'cmd', wslDistro: '' }).id, 'cmd')
  const withWsl = {
    platform: 'win32',
    shells: [{ id: 'wsl' as const, path: 'wsl.exe', distros: ['Ubuntu'] }, ...report.shells],
  }
  assert.equal(pickShell(withWsl, { kind: '', wslDistro: 'Gone' }).distro, '', '发行版不在了用默认的')
})
