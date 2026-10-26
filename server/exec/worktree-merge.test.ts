import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import type { Task } from '../../shared/schema.ts'
import { childHoldText, childHolds, childHoldsOf } from '../../shared/task.ts'
import {
  branchesOverlap,
  branchAlive,
  createWorktree,
  ensureWorktree,
  git,
  gitEnv,
  isolateDeps,
  mergeOverlap,
  mergeSides,
  mergeSidesText,
  mergeWorktree,
  missingDeps,
  project,
  releaseWorktree,
  removeWorktree,
  resetSharedDeps,
  sharedDepsDir,
  tid,
  tmp,
  WORKTREES_DIR,
  worktreeStatus,
} from './worktree-test-kit.ts'

/**
 * 独立分支的状态、合并与冲突、彻底完成后才回收、依赖共用的正常路径。
 *
 * 和 worktree.test.ts 拆开是因为这一批只是慢（要跑真实的 git），不靠真实时钟判定：
 * 放在并发批里和别的文件一起跑，计时批只剩少数几个真正对 CPU 抢占敏感的用例。
 * 两边一共 42 例，和拆分前一样多；公共准备在 worktree-test-kit.ts。
 */

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
    const { into } = await mergeWorktree(repo, wt, '合并', repo, true)
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

test('两边都改了同一个文件的不同位置：合并不报冲突，但要把重叠文件交出来', async () => {
  const repo = project()
  // 起点两行，两个分支各改一行：git 能自动合上，trialMerge 不会报冲突
  writeFileSync(path.join(repo, 'README.md'), '# 标题\n\n正文\n')
  git(repo, 'commit', '-qam', '两行')
  const wt = await createWorktree(repo, tid(), '重叠')
  try {
    writeFileSync(path.join(wt.path, 'README.md'), '# 分支改的标题\n\n正文\n')
    git(wt.path, 'commit', '-qam', '分支改标题')
    writeFileSync(path.join(repo, 'README.md'), '# 标题\n\n原目录改的正文\n')
    git(repo, 'commit', '-qam', '原目录改正文')
    // 合并前就能比出两边都动过 README.md
    assert.deepEqual(await mergeOverlap(repo, wt.branch), ['README.md'])
    assert.deepEqual(await branchesOverlap(repo, 'HEAD', wt.branch), ['README.md'])
    const r = await mergeWorktree(repo, wt, '合并', repo, true)
    assert.equal(r.into, wt.baseBranch)
    assert.deepEqual(r.overlap, ['README.md'], '合并成功也把重叠文件带出来')
    // 自动合上也要把双方的提交记录交出来：接手核对的人要知道各自为什么这么改
    assert.ok(r.sides, '合并成功也带上双方提交记录')
    assert.ok(
      r.sides!.into.commits.some((c) => c.includes('原目录改正文')),
      '原分支的提交记录 ' + JSON.stringify(r.sides),
    )
    assert.ok(
      r.sides!.by.commits.some((c) => c.includes('分支改标题')),
      '独立分支的提交记录 ' + JSON.stringify(r.sides),
    )
    assert.match(mergeSidesText(r.sides!), /必须逐文件核对/, '重叠但没冲突也要逐文件核对')
    // 确实没有冲突、两边改动都在，但同一个文件被两边改过
    assert.match(readFileSync(path.join(repo, 'README.md'), 'utf8'), /分支改的标题[\s\S]*原目录改的正文/)
    // 都合完了，共同基点变成分支自己的提交，再比就没有重叠
    assert.deepEqual(await mergeOverlap(repo, wt.branch), [])
  } finally {
    await removeWorktree(repo, wt, true).catch(() => {})
  }
})

test('两边改的是不同文件时不算重叠', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '不同文件')
  try {
    writeFileSync(path.join(wt.path, 'a.txt'), 'a\n')
    git(wt.path, 'add', '-A')
    git(wt.path, 'commit', '-qm', 'a')
    writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'b')
    assert.deepEqual(await mergeOverlap(repo, wt.branch), [])
    assert.deepEqual((await mergeWorktree(repo, wt, '合并', repo, true)).overlap, [])
  } finally {
    await removeWorktree(repo, wt, true).catch(() => {})
  }
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

test('冲突时交回双方的提交记录，看清各自为什么这么改再合', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '冲突记录')
  try {
    writeFileSync(path.join(wt.path, 'README.md'), '# 分支里改的标题\n')
    git(wt.path, 'commit', '-qam', '分支：把标题改成新写法')
    writeFileSync(path.join(repo, 'README.md'), '# 原目录改的标题\n')
    git(repo, 'commit', '-qam', '原目录：标题也改了，方向不同')
    // 合并前就能算出来：各有哪些提交、改了哪些文件、哪些两边都动过
    const sides = await mergeSides(repo, wt.branch)
    assert.equal(sides.into.branch, wt.baseBranch)
    assert.equal(sides.into.count, 1)
    assert.ok(
      sides.into.commits.some((c) => c.includes('原目录：标题也改了')),
      '原分支的提交说明',
    )
    assert.equal(sides.by.count, 1)
    assert.ok(
      sides.by.commits.some((c) => c.includes('分支：把标题改成新写法')),
      '独立分支的提交说明',
    )
    assert.deepEqual(sides.overlap, ['README.md'])
    const err = await mergeWorktree(repo, wt, '合并', repo, true).catch((e) => e as Error & { conflict?: boolean })
    assert.ok(err instanceof Error && err.conflict, '带上 conflict 标记')
    assert.match(err.message, /双方的提交记录/, '冲突时把双方的提交记录一起交回')
    assert.match(err.message, /原目录：标题也改了/, '列出原分支的提交说明')
    assert.match(err.message, /分支：把标题改成新写法/, '列出独立分支的提交说明')
    assert.match(err.message, /两边都改过这些文件：README\.md/, '标出两边都动过的文件')
    assert.match(err.message, /必须逐文件核对/, '要求写核对结论')
    // 冲突撤回：目标目录没被改动
    assert.equal(git(repo, 'status', '--porcelain').toString().trim(), '')
    assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), '# 原目录改的标题\n')
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('彻底完成才回收独立分支：计划没做完 / 有提问 / 后台命令在跑时保留目录和分支', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '门禁')
  writeFileSync(path.join(wt.path, 'README.md'), '# 子对话改的\n')
  // 合并回原分支，但目录和分支先留着（keep）
  await mergeWorktree(repo, wt, '合并', repo, true)
  const branchAlive = () => git(repo, 'branch', '--list', wt.branch).toString().trim().length > 0
  try {
    // 合并完成只是分支回去了：计划 5/7 还没做完，这一轮、后台命令还在跑时都不能删
    for (const holds of [
      childHolds({ plan: { done: 5, total: 7 } }),
      childHolds({ asking: 1 }),
      childHolds({ background: 1 }),
      childHolds({ working: true }),
    ]) {
      const why = await releaseWorktree(repo, wt, holds)
      assert.ok(why, '还差条件时说明原因')
      assert.ok(existsSync(wt.path), '独立目录还在，改动不会被删掉')
      assert.ok(branchAlive(), '分支也还在')
    }
    // 全部条件满足（计划做完、后台命令结束、没有问题、已经合回去）
    assert.equal(await releaseWorktree(repo, wt, childHolds({ plan: { done: 7, total: 7 } })), '')
    assert.ok(!existsSync(wt.path), '彻底完成后目录回收了')
    assert.ok(!branchAlive(), '分支也回收了')
  } finally {
    if (existsSync(wt.path)) await removeWorktree(repo, wt, true).catch(() => {})
  }
})

test('没合回原分支时即使别的条件都满足也不删独立分支', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '未合并')
  writeFileSync(path.join(wt.path, 'README.md'), '# 还没合\n')
  writeFileSync(path.join(wt.path, 'new.txt'), 'x\n')
  try {
    const why = await releaseWorktree(repo, wt, [])
    assert.match(why, /独立分支还没合回原分支/, '说清为什么还留着')
    assert.ok(existsSync(wt.path), '有没合回去的改动时目录保留')
    assert.ok(existsSync(path.join(wt.path, 'new.txt')), '改动文件还在')
  } finally {
    await removeWorktree(repo, wt, true).catch(() => {})
  }
})

/** 一个已经收口、没在跑的子对话任务：除了合并状态，childHolds 的其他条件都满足 */
const idleChild = () =>
  ({
    status: 'running',
    working: false,
    requests: [],
    parentAsks: [],
    plans: [],
    steps: [],
  }) as unknown as Task

/** 带本地远端的项目：远端先推一次，之后父分支要不要推由用例决定 */
function projectWithRemote() {
  const repo = project()
  const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()
  const tag = Math.random().toString(36).slice(2, 8)
  const remote = path.join(tmp, `remote-${tag}.git`)
  mkdirSync(remote, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'pipe', env: gitEnv() })
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  git(remote, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`)
  return { repo, branch, remote }
}

/** 子对话在自己的分支上提交一个文件，再合回父分支（合完只留着分支，目录先不删） */
async function commitAndMerge(repo: string, name: string, file: string) {
  const wt = await createWorktree(repo, tid(), name)
  writeFileSync(path.join(wt.path, file), 'x\n')
  git(wt.path, 'add', '-A')
  git(wt.path, 'commit', '-qm', file)
  await mergeWorktree(repo, wt, '合并', repo, true)
  return wt
}

/**
 * 完成判定只问一件事：子分支的提交有没有都进父对话所在的分支（worktreeStatus.merged）。
 * 下面三个用例是同一件事的三种现实状态：父分支没推到远端、远端比父分支新、父分支上又合进了别的任务——
 * 推送相关的状态一律不参与，都必须算彻底完成、独立分支可以回收。
 */
test('父分支没推送到远端：合回父分支就算彻底完成，可以回收独立分支', async () => {
  const { repo, branch } = projectWithRemote()
  const wt = await commitAndMerge(repo, '父分支没推', 'a.txt')
  try {
    // 父分支自己往前走一个提交，但不推：origin 上的同名分支落后于它
    writeFileSync(path.join(repo, 'local.txt'), 'local\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', '父分支上的本地提交')
    assert.ok(
      Number(git(repo, 'rev-list', '--count', `origin/${branch}..HEAD`).toString().trim()) > 0,
      '前提成立：父分支有远端没有的提交',
    )
    // ahead 只数「父分支..子分支」：父分支自己走多远都不影响
    assert.deepEqual(await worktreeStatus(repo, wt), { exists: true, branch: true, ahead: 0, dirty: 0, merged: true })
    assert.deepEqual(childHoldsOf(idleChild(), { merged: true }), [], '推送状态不参与完成判定')
    assert.equal(await releaseWorktree(repo, wt, childHoldsOf(idleChild(), { merged: true })), '')
    assert.ok(!existsSync(wt.path), '独立目录回收了')
  } finally {
    if (existsSync(wt.path)) await removeWorktree(repo, wt, true).catch(() => {})
  }
})

test('远端比父分支新：同样算合回父分支，不影响完成判定', async () => {
  const { repo, branch, remote } = projectWithRemote()
  const tag = Math.random().toString(36).slice(2, 8)
  // 另一个 clone 往远端推一个提交：远端有父分支没有的提交，父分支也没跟上
  const other = path.join(tmp, `other-${tag}`)
  execFileSync('git', ['clone', '-q', remote, other], { stdio: 'pipe', env: gitEnv() })
  writeFileSync(path.join(other, 'remote.txt'), 'remote\n')
  git(other, 'add', '-A')
  git(other, 'commit', '-qm', '远端上的提交')
  git(other, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
  const wt = await commitAndMerge(repo, '远端更新', 'b.txt')
  try {
    git(repo, 'fetch', '-q', 'origin')
    assert.ok(
      Number(git(repo, 'rev-list', '--count', `HEAD..origin/${branch}`).toString().trim()) > 0,
      '前提成立：远端有父分支没有的提交',
    )
    assert.deepEqual(await worktreeStatus(repo, wt), { exists: true, branch: true, ahead: 0, dirty: 0, merged: true })
    assert.deepEqual(childHoldsOf(idleChild(), { merged: true }), [], '远端有新提交也不影响完成判定')
    assert.equal(await releaseWorktree(repo, wt, childHoldsOf(idleChild(), { merged: true })), '')
    assert.ok(!existsSync(wt.path), '独立目录回收了')
  } finally {
    if (existsSync(wt.path)) await removeWorktree(repo, wt, true).catch(() => {})
  }
})

test('父分支上又合进了别的任务的提交：子分支仍算已合回，可以回收', async () => {
  const repo = project()
  const wt = await commitAndMerge(repo, '别的任务', 'c.txt')
  try {
    // 合完之后父分支上又有别的子对话的改动合进来：子分支的提交仍在父分支的历史里
    writeFileSync(path.join(repo, 'other.txt'), 'other\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', '别的任务合进来的提交')
    assert.deepEqual(await worktreeStatus(repo, wt), { exists: true, branch: true, ahead: 0, dirty: 0, merged: true })
    assert.deepEqual(childHoldsOf(idleChild(), { merged: true }), [])
    assert.equal(await releaseWorktree(repo, wt, childHoldsOf(idleChild(), { merged: true })), '')
    assert.ok(!existsSync(wt.path), '独立目录回收了')
  } finally {
    if (existsSync(wt.path)) await removeWorktree(repo, wt, true).catch(() => {})
  }
})

test('子分支还有没合回父分支的提交：拦住，原因里不提推送', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '差一个提交')
  writeFileSync(path.join(wt.path, 'x.txt'), 'x\n')
  git(wt.path, 'add', '-A')
  git(wt.path, 'commit', '-qm', '没合回去的提交')
  try {
    const st = await worktreeStatus(repo, wt)
    assert.equal(st.merged, false, '还有没合回父分支的提交')
    assert.equal(st.ahead, 1, 'ahead 只数父分支..子分支，正好一个')
    assert.deepEqual(childHoldsOf(idleChild(), { merged: false }), ['unmerged'], '只差合并这一条')
    const why = await releaseWorktree(repo, wt, childHoldsOf(idleChild(), { merged: false }))
    assert.match(why, /独立分支还没合回原分支/, '说清为什么还留着')
    // 门禁和文案都只针对父对话所在的分支：不出现推送、远端、别的分支
    for (const text of [why, childHoldText(['unmerged'])])
      assert.doesNotMatch(text, /推送|远端|push|remote|origin|其他分支/i)
    assert.ok(existsSync(wt.path), '拦住时目录保留')
    assert.ok(existsSync(path.join(wt.path, 'x.txt')), '改动文件还在')
  } finally {
    await removeWorktree(repo, wt, true).catch(() => {})
  }
})

test('依赖共用：独立目录不放 node_modules，命令从上级那一份解析', async () => {
  resetSharedDeps()
  const repo = project()
  const wt = await createWorktree(repo, tid(), '依赖共用')
  try {
    assert.ok(!existsSync(path.join(wt.path, 'node_modules')), '独立目录里不放 node_modules')
    assert.ok(existsSync(path.join(await sharedDepsDir(repo), 'dep', 'index.js')), '共用的一份在项目分组目录下')
    assert.notEqual(
      realpathSync(await sharedDepsDir(repo)),
      realpathSync(path.join(repo, 'node_modules')),
      '是独立的一份，不是项目那目录、也不是链接',
    )
    // 依赖清单按「向上能找到的那一份」核对：独立目录里没有 node_modules 也不算缺失
    assert.deepEqual(await missingDeps(wt.path), [])
    // 项目那份被人动过也不影响共用的一份（反过来也一样：共用那份不跟着项目目录变）
    rmSync(path.join(repo, 'node_modules', 'dep'), { recursive: true, force: true })
    assert.ok(existsSync(path.join(await sharedDepsDir(repo), 'dep', 'index.js')), '共用的一份还在')
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('依赖共用：只复制一次，后面开的子对话直接用', async () => {
  resetSharedDeps()
  const repo = project()
  const first = await createWorktree(repo, tid(), '第一次')
  try {
    // 没改 lock 时项目里多出来的文件不该再触发一次整份复制
    writeFileSync(path.join(repo, 'node_modules', 'dep', 'later.txt'), 'x\n')
    const second = await createWorktree(repo, tid(), '第二次')
    try {
      assert.ok(existsSync(path.join(await sharedDepsDir(repo), 'dep', 'index.js')), '共用的一份还在')
      assert.ok(!existsSync(path.join(await sharedDepsDir(repo), 'dep', 'later.txt')), '没有又复制一遍')
      assert.ok(!existsSync(path.join(second.path, 'node_modules')), '第二个子对话也直接用上级那份')
    } finally {
      await removeWorktree(repo, second, true)
    }
  } finally {
    await removeWorktree(repo, first, true)
  }
})

test('依赖共用：package-lock 变了才重新复制', async () => {
  resetSharedDeps()
  const repo = project()
  const first = await createWorktree(repo, tid(), '旧依赖')
  try {
    writeFileSync(path.join(repo, 'node_modules', 'dep', 'added.txt'), 'x\n')
    assert.ok(!existsSync(path.join(await sharedDepsDir(repo), 'dep', 'added.txt')), '没改 lock 前不重新复制')
    writeFileSync(
      path.join(repo, 'package-lock.json'),
      '{"name":"demo","lockfileVersion":3,"packages":{"node_modules/dep":{"version":"1.0.0"}}}\n',
    )
    const second = await createWorktree(repo, tid(), '新依赖')
    try {
      assert.ok(existsSync(path.join(await sharedDepsDir(repo), 'dep', 'added.txt')), 'lock 变了重新复制一份')
    } finally {
      await removeWorktree(repo, second, true)
    }
  } finally {
    await removeWorktree(repo, first, true)
  }
})

test('依赖共用：不同项目各自一份，后开的项目不会覆盖前一个的依赖', async () => {
  resetSharedDeps()
  const repoA = project()
  const repoB = project()
  // 乙项目的依赖里多一个文件，用来确认两份共用副本互不影响
  writeFileSync(path.join(repoB, 'node_modules', 'dep', 'only-b.txt'), 'b\n')
  const a = await createWorktree(repoA, tid(), '项目甲')
  const b = await createWorktree(repoB, tid(), '项目乙')
  try {
    assert.notEqual(await sharedDepsDir(repoA), await sharedDepsDir(repoB), '每个项目一份共用依赖')
    assert.ok(existsSync(path.join(await sharedDepsDir(repoA), 'dep', 'index.js')), '甲那份在')
    assert.ok(!existsSync(path.join(await sharedDepsDir(repoA), 'dep', 'only-b.txt')), '甲那份没被乙覆盖')
    assert.ok(existsSync(path.join(await sharedDepsDir(repoB), 'dep', 'only-b.txt')), '乙那份是自己的')
  } finally {
    await removeWorktree(repoA, a, true)
    await removeWorktree(repoB, b, true)
  }
})

test('依赖共用：从父对话的独立目录里再开子对话，仍用同一份共用依赖', async () => {
  resetSharedDeps()
  const repo = project()
  const parent = await createWorktree(repo, tid(), '父对话')
  try {
    // worktreeHome 让子对话从父对话的独立目录里开
    const child = await createWorktree(parent.path, tid(), '子对话')
    try {
      assert.ok(!existsSync(path.join(child.path, 'node_modules')), '子对话目录里也不放依赖')
      assert.deepEqual(await missingDeps(child.path), [], '从共用那份解析得到')
      // 分组按主仓库根算：按父对话目录算的话每层都会再复制一份 682MB
      assert.deepEqual(
        readdirSync(WORKTREES_DIR),
        [path.basename(path.dirname(await sharedDepsDir(repo)))],
        '同一个项目只有一组',
      )
    } finally {
      await removeWorktree(repo, child, true)
    }
  } finally {
    await removeWorktree(repo, parent, true)
  }
})

test('依赖共用：从父对话的独立目录里再开子对话，也会按项目最新的 lock 刷新', async () => {
  resetSharedDeps()
  const repo = project()
  const parent = await createWorktree(repo, tid(), '父对话')
  try {
    // 项目里装了新依赖（lock 变了）：父对话目录里没有 node_modules，刷新要以项目根为准
    writeFileSync(path.join(repo, 'node_modules', 'dep', 'after-install.txt'), 'x\n')
    writeFileSync(
      path.join(repo, 'package-lock.json'),
      '{"name":"demo","lockfileVersion":3,"packages":{"node_modules/dep":{"version":"2.0.0"}}}\n',
    )
    const child = await createWorktree(parent.path, tid(), '子对话')
    try {
      assert.ok(
        existsSync(path.join(await sharedDepsDir(repo), 'dep', 'after-install.txt')),
        '按项目的 lock 刷新了，不是当成「项目没装依赖」跳过',
      )
    } finally {
      await removeWorktree(repo, child, true)
    }
  } finally {
    await removeWorktree(repo, parent, true)
  }
})

test('依赖共用：项目没忽略 node_modules 时，子对话里自己装的依赖不会进提交', async () => {
  resetSharedDeps()
  const repo = project()
  // 新建项目漏写 .gitignore 的情况：prepare 要自己写进独立目录的 exclude
  writeFileSync(path.join(repo, '.gitignore'), '.env*\n')
  git(repo, 'commit', '-qam', '不忽略依赖')
  const wt = await createWorktree(repo, tid(), '没忽略依赖')
  try {
    const rel = git(wt.path, 'rev-parse', '--git-path', 'info/exclude').toString().trim()
    const exclude = readFileSync(path.resolve(wt.path, rel), 'utf8')
    assert.match(exclude, /^\/node_modules$/m, 'node_modules 写进了 exclude')
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('依赖共用：早先开的工作目录里那份依赖（副本或链接）准备时清掉', async () => {
  resetSharedDeps()
  const repo = project()
  const wt = await createWorktree(repo, tid(), '旧布局')
  try {
    const mine = path.join(wt.path, 'node_modules')
    // 旧版本开出来的目录长这样：node_modules 是指向项目的链接（2026-10 事故的来源）
    symlinkSync(path.join(repo, 'node_modules'), mine, process.platform === 'win32' ? 'junction' : 'dir')
    await isolateDeps(wt.path, repo)
    assert.ok(!existsSync(mine), '链接清掉了，改用上级共用的一份')
    assert.ok(existsSync(path.join(repo, 'node_modules', 'dep', 'index.js')), '项目的依赖没被删')
    // 更早的副本也一样清掉，省磁盘
    mkdirSync(path.join(mine, 'dep'), { recursive: true })
    writeFileSync(path.join(mine, 'dep', 'index.js'), 'module.exports = 2\n')
    await isolateDeps(wt.path, repo)
    assert.ok(!existsSync(mine), '旧副本也清掉')
    assert.ok(existsSync(path.join(await sharedDepsDir(repo), 'dep', 'index.js')), '共用的一份还在，命令照常能跑')
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('依赖共用：旧布局的任务目录（不在项目分组下）保留自己那份依赖，不删成不能用', async () => {
  resetSharedDeps()
  const repo = project()
  // 升级前开出来的目录：worktrees/<任务 id>，它向上（worktrees/）没有共用的一份
  const legacy = path.join(WORKTREES_DIR, tid())
  mkdirSync(path.join(legacy, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(path.join(legacy, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  try {
    await isolateDeps(legacy, repo)
    assert.ok(existsSync(path.join(legacy, 'node_modules', 'dep', 'index.js')), '旧目录自己那份依赖留着')
  } finally {
    rmSync(legacy, { recursive: true, force: true })
  }
})

test('依赖隔离：声明了但没装上的包列得出来，好在日志里直接说清少了什么', async () => {
  const repo = project()
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { dep: '1', gone: '1' } }))
  assert.deepEqual(await missingDeps(repo), ['gone'])
  // 没有 package.json 的目录不算异常：别的目录、非 node 项目都这样
  assert.deepEqual(await missingDeps(path.join(tmp, '拿不到')), [])
})

test('删除结果以实际状态为准：目录已经手动删掉时仍算回收成功', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '已手动删')
  // 用户自己删了目录：git worktree remove 会报「不是工作树」，但那不算失败
  rmSync(wt.path, { recursive: true, force: true })
  assert.equal(await removeWorktree(repo, wt, true), '', '目录和分支都清干净了')
  assert.ok(!branchAlive(repo, wt.branch), '分支回收了')
})

test('两个子对话先后改同一个文件：两次合并都成功，两边的内容都在', async () => {
  const repo = project()
  writeFileSync(
    path.join(repo, 'README.md'),
    `# 标题

正文
`,
  )
  git(repo, 'commit', '-qam', '两行')
  const a = await createWorktree(repo, tid(), '甲')
  const b = await createWorktree(repo, tid(), '乙')
  try {
    writeFileSync(
      path.join(a.path, 'README.md'),
      `# 甲改的标题

正文
`,
    )
    git(a.path, 'commit', '-qam', '甲改标题')
    writeFileSync(
      path.join(b.path, 'README.md'),
      `# 标题

乙改的正文
`,
    )
    git(b.path, 'commit', '-qam', '乙改正文')
    // 两次合并都对同一个文件动手：git 能自动合上，合并结果照样把重叠文件交出来
    // 甲合进去时原分支还没动过这个文件，那一侧不算重叠；乙合的时候两边都改过 README.md 了
    assert.deepEqual((await mergeWorktree(repo, a, '合甲', repo, true)).overlap, [])
    assert.deepEqual((await mergeWorktree(repo, b, '合乙', repo, true)).overlap, ['README.md'])
    const merged = readFileSync(path.join(repo, 'README.md'), 'utf8')
    assert.match(merged, /甲改的标题/, '先合进来的一方的改动还在')
    assert.match(merged, /乙改的正文/, '后合进来的一方没有整文件盖掉对方的改动')
  } finally {
    await removeWorktree(repo, a, true).catch(() => {})
    await removeWorktree(repo, b, true).catch(() => {})
  }
})

test('两个子对话改同一段同一行：第二个合并被撤回，冲突交回它处理，原目录不动', async () => {
  const repo = project()
  writeFileSync(
    path.join(repo, 'README.md'),
    `# 标题

正文
`,
  )
  git(repo, 'commit', '-qam', '两行')
  const a = await createWorktree(repo, tid(), '甲')
  const b = await createWorktree(repo, tid(), '乙')
  try {
    writeFileSync(
      path.join(a.path, 'README.md'),
      `# 甲改的标题

正文
`,
    )
    git(a.path, 'commit', '-qam', '甲改标题')
    writeFileSync(
      path.join(b.path, 'README.md'),
      `# 乙改的标题

正文
`,
    )
    git(b.path, 'commit', '-qam', '乙改标题')
    await mergeWorktree(repo, a, '合甲', repo, true)
    const err = await mergeWorktree(repo, b, '合乙', repo, true).catch((e) => e as Error & { conflict?: boolean })
    assert.ok(err instanceof Error && err.conflict, '真冲突时带上 conflict 标记，由面板交回子对话')
    assert.ok(err.message.includes('README.md'), '冲突信息里带上冲突的文件')
    assert.equal(git(repo, 'status', '--porcelain').toString().trim(), '', '没有把半成品留在原目录')
    const kept = readFileSync(path.join(repo, 'README.md'), 'utf8')
    assert.match(kept, /甲改的标题/, '原目录保持合并前的内容')
    assert.ok(!kept.includes('乙改的标题'), '没有把乙的改动强行合进原目录')
    assert.ok(existsSync(b.path), '撤回后它的独立目录还在，可以接着处理冲突')
  } finally {
    await removeWorktree(repo, a, true).catch(() => {})
    await removeWorktree(repo, b, true).catch(() => {})
  }
})
