import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TestStep } from '../shared/schema.ts'

// 独立分支目录建在数据目录里：测试用临时目录，不碰本机真实的数据
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'merge-build-data-'))
const { abortMerge, commitMerge, commitWorktree, createWorktree, trialMerge } = await import('./exec/worktree.ts')
const { runMergeSteps } = await import('./merge-build.ts')

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

test('子对话分支试合回原目录：编译失败撤回，原目录不变；通过才提交', async () => {
  const dir = repo()
  const wt = await createWorktree(dir, 'task-1234abcd', 'fix')
  assert.equal(wt.baseBranch, 'main')
  writeFileSync(path.join(wt.path, 'b.txt'), 'new\n')
  assert.equal(await commitWorktree(wt, '子对话的改动'), true)
  assert.equal(await commitWorktree(wt, '没有改动'), false)

  // 编译失败：撤回，原目录没有 b.txt，也没有合并中的状态
  let m = await trialMerge(dir, wt.branch)
  assert.ok(m.ok && !m.nothing)
  assert.deepEqual(m.ok && m.files, ['b.txt'])
  const failed = await runMergeSteps([step({ command: 'echo 编译报错 && exit 3' })], dir)
  assert.equal(failed.ok, false)
  assert.match(failed.runs[0].tail, /编译报错/)
  await abortMerge(dir)
  assert.ok(!existsSync(path.join(dir, 'b.txt')))
  assert.equal(git(dir, 'status', '--porcelain').trim(), '')

  // 编译通过：提交进 main
  m = await trialMerge(dir, wt.branch)
  // cmd 没有 test -f：用 git 确认合并进来的文件在索引里，两种系统的写法一样
  const ok = await runMergeSteps([step({ command: 'git ls-files --error-unmatch b.txt' })], dir)
  assert.equal(ok.ok, true)
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
