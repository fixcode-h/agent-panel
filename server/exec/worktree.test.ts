import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import { createWorktree, ensureWorktree, mergeWorktree, removeWorktree, worktreeStatus } from './worktree.ts'

// 断言的是 worktree.ts 里 t() 出来的报错文案：显式固定语言，不跟着 LANG 走
setLang('zh')

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

test('独立分支的状态：没合并时标出提交和没提交的文件，合并后分支留着、算作已合并', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), 'merge')
  try {
    // 刚开出来什么都没改：算作已经在原分支里
    assert.deepEqual(await worktreeStatus(repo, wt), { exists: true, branch: true, ahead: 0, dirty: 0, merged: true })
    writeFileSync(path.join(wt.path, 'b.txt'), 'b\n')
    let st = await worktreeStatus(repo, wt)
    assert.equal(st.dirty, 1)
    assert.equal(st.merged, false)
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-qm', 'b')
    st = await worktreeStatus(repo, wt)
    assert.equal(st.ahead, 1)
    assert.equal(st.merged, false)
    // 合并时保留：分支和目录都在，状态变成已合并
    const into = await mergeWorktree(repo, wt, '合并', repo, true)
    assert.equal(into, wt.baseBranch)
    assert.ok(existsSync(wt.path))
    st = await worktreeStatus(repo, wt)
    assert.equal(st.merged, true)
    assert.ok(existsSync(path.join(repo, 'b.txt')))
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('用手动 git merge 合进原分支、分支还留着时也算作已合并', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), 'manual')
  try {
    writeFileSync(path.join(wt.path, 'b.txt'), 'b\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-qm', 'b')
    assert.equal((await worktreeStatus(repo, wt)).merged, false)
    // 用户自己在原目录合，不删分支
    git(repo, 'merge', '--no-ff', '--no-edit', '-m', '手动合并', wt.branch)
    assert.deepEqual(await worktreeStatus(repo, wt), { exists: true, branch: true, ahead: 0, dirty: 0, merged: true })
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('分支已经删掉时：状态还停在 active 也算已合并，主动丢弃的算没合并', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), 'deleted')
  writeFileSync(path.join(wt.path, 'b.txt'), 'b\n')
  git(wt.path, 'add', '-A')
  git(wt.path, 'commit', '-qm', 'b')
  git(repo, 'merge', '--no-ff', '--no-edit', '-m', '合并', wt.branch)
  // 面板合并（或者用户自己）把目录和分支清掉了，任务记录里的 state 还停在 active：
  // 不能报成 ahead=0 / dirty=0 / merged=false，那样界面上会出现「未合并到「…」：」后面空着加一个没用的合并按钮
  await removeWorktree(repo, wt, true)
  assert.deepEqual(await worktreeStatus(repo, wt), { exists: false, branch: false, ahead: 0, dirty: 0, merged: true })
  assert.equal((await worktreeStatus(repo, { ...wt, state: 'merged', note: wt.baseBranch })).merged, true)
  assert.equal((await worktreeStatus(repo, { ...wt, state: 'discarded' })).merged, false)
})

test('开分支时的原分支后来被删了：和原目录现在的提交比，不当作已合并', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), 'base-gone')
  try {
    writeFileSync(path.join(wt.path, 'b.txt'), 'b\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-qm', 'b')
    git(repo, 'checkout', '-qb', 'other')
    git(repo, 'branch', '-D', wt.baseBranch)
    const st = await worktreeStatus(repo, wt)
    assert.equal(st.branch, true)
    assert.equal(st.ahead, 1)
    assert.equal(st.merged, false)
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('工作区被回收后又继续：分支还在就接回去，分支也没了就按同名分支重新开', async () => {
  const repo = project()
  const id = tid()
  const wt = await createWorktree(repo, id, '重建')
  writeFileSync(path.join(wt.path, 'b.txt'), 'b\n')
  git(wt.path, 'add', '-A')
  git(wt.path, 'commit', '-qm', 'b')
  // 只把目录删掉（分支还在，git 里还登记着这个工作区）：重建后回到同名分支，分支上没合回的提交还在
  rmSync(wt.path, { recursive: true, force: true })
  assert.ok(!existsSync(wt.path))
  assert.ok(existsSync(path.join(repo, 'node_modules', 'dep', 'index.js')), '删目录不会顺着链接删掉项目的依赖')
  let back = await ensureWorktree(repo, wt, id, '重建')
  assert.ok(back.rebuilt, '重建了')
  assert.equal(back.worktree.path, wt.path, '还用原来的目录')
  assert.equal(back.worktree.branch, wt.branch, '分支名沿用原来的')
  assert.equal(back.worktree.state, 'active')
  assert.equal(readFileSync(path.join(wt.path, 'b.txt'), 'utf8').replace(/\r\n/g, '\n'), 'b\n', '接回分支上原来的提交')
  assert.equal((await worktreeStatus(repo, back.worktree)).ahead, 1, '分支上的提交还算没合回原分支')
  // 目录和分支都在：什么都不做，每次都重建会白跑一遍 git
  assert.deepEqual(await ensureWorktree(repo, back.worktree, id, '重建'), { worktree: back.worktree, rebuilt: false })
  await removeWorktree(repo, back.worktree, true)

  // 合并完清理掉目录和分支（标记完成、面板合并后的回收）：继续时按同名分支从当前提交重新开
  const id2 = tid()
  const gone = await createWorktree(repo, id2, '再来一轮')
  writeFileSync(path.join(gone.path, 'c.txt'), 'c\n')
  git(gone.path, 'add', '-A')
  git(gone.path, 'commit', '-qm', 'c')
  git(repo, 'merge', '--no-ff', '--no-edit', '-m', '合并', gone.branch)
  await removeWorktree(repo, gone, true)
  assert.equal(git(repo, 'branch', '--list', gone.branch).toString().trim(), '', '分支已经删掉了')
  back = await ensureWorktree(repo, gone, id2, '再来一轮')
  assert.ok(back.rebuilt, '分支没了也重建')
  assert.equal(back.worktree.branch, gone.branch, '同名分支重新建出来')
  assert.equal(back.worktree.state, 'active', '重建后又能接着改')
  assert.equal(
    readFileSync(path.join(back.worktree.path, 'c.txt'), 'utf8').replace(/\r\n/g, '\n'),
    'c\n',
    '从现在的提交新开，已经合回原分支的改动都在',
  )
  assert.equal((await worktreeStatus(repo, back.worktree)).merged, true, '刚建出来算作已经在原分支里')
  await removeWorktree(repo, back.worktree, true)
})

test('重建不了时给出处理办法，不留半创建的工作区', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '占用')
  // 同名分支已经被另一个工作目录检出：git 不会把它再检出一份
  const elsewhere = path.join(tmp, `busy-${Math.random().toString(36).slice(2, 8)}`)
  const err = await ensureWorktree(repo, { ...wt, path: elsewhere }, 'x', '占用').catch((e: Error) => e)
  assert.ok(err instanceof Error, '建不出来时抛错')
  assert.match(err.message, /重建独立工作区失败/, '说清哪一步失败')
  assert.match(err.message, /已经尝试重建/, '说明已经试过重建')
  assert.match(err.message, /git worktree prune/, '给出下一步怎么处理')
  assert.ok(!existsSync(elsewhere), '失败时不留半创建的工作区')
  assert.ok(existsSync(wt.path), '原来那个工作区不受影响')
  await removeWorktree(repo, wt, true)
})

test('原目录换了分支就不合并，冲突时带上 conflict 标记并撤回', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), 'conflict')
  try {
    writeFileSync(path.join(wt.path, 'README.md'), '# 分支里改的\n')
    git(repo, 'checkout', '-qb', 'other')
    await assert.rejects(mergeWorktree(repo, wt, '合并', repo, true), /没有合并/)
    git(repo, 'checkout', '-q', wt.baseBranch)
    writeFileSync(path.join(repo, 'README.md'), '# 原目录改的\n')
    git(repo, 'commit', '-qam', 'base')
    const err = await mergeWorktree(repo, wt, '合并', repo, true).catch((e) => e as Error & { conflict?: boolean })
    assert.ok(err instanceof Error && err.conflict)
    assert.equal(git(repo, 'status', '--porcelain').toString().trim(), '')
    assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), '# 原目录改的\n')
  } finally {
    await removeWorktree(repo, wt, true)
  }
})
