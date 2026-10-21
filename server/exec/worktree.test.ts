import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createWorktree, removeWorktree } from './worktree.ts'

const tmp = mkdtempSync(path.join(tmpdir(), 'agent-panel-wt-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' })
/** 独立目录按任务 id 建在共享的数据目录下：每次用新 id，避免上一次失败的残留挡住 */
const tid = () => `test-${Math.random().toString(36).slice(2, 10)}`

/** 一个 git 仓库项目，带 node_modules 和环境文件 */
function project(): string {
  const dir = path.join(tmp, `p${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.env*\n')
  writeFileSync(path.join(dir, 'README.md'), '# demo\n')
  mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  writeFileSync(path.join(dir, '.env'), 'TOKEN=dev\n')
  writeFileSync(path.join(dir, '.env.local'), 'SECRET=real\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

test('独立目录接上项目的依赖和环境文件，不复制密钥', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '测试任务')
  try {
    // 依赖用链接，不复制一份
    assert.ok(existsSync(path.join(wt.path, 'node_modules', 'dep', 'index.js')), '依赖能读到')
    // .env 复制，含密钥的 .env.local 不复制
    assert.equal(readFileSync(path.join(wt.path, '.env'), 'utf8').trim(), 'TOKEN=dev', '环境文件复制过去')
    assert.ok(!existsSync(path.join(wt.path, '.env.local')), '含密钥的环境文件不复制')
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('删掉独立目录时不会顺着链接删掉项目的依赖', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '测试任务')
  await removeWorktree(repo, wt, true)
  assert.ok(!existsSync(wt.path), '独立目录删掉了')
  assert.ok(existsSync(path.join(repo, 'node_modules', 'dep', 'index.js')), '项目的依赖还在')
})

test('不是 git 仓库或还没有提交时明确报错', async () => {
  const plain = path.join(tmp, 'plain')
  mkdirSync(plain, { recursive: true })
  await assert.rejects(() => createWorktree(plain, tid(), 'x'), /不是 git 仓库/)
  const empty = path.join(tmp, 'empty')
  mkdirSync(empty, { recursive: true })
  git(empty, 'init', '-q')
  await assert.rejects(() => createWorktree(empty, tid(), 'x'), /还没有任何提交/)
})
