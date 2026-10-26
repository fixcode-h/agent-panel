import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  branchAlive,
  createWorktree,
  git,
  mergeWorktree,
  missingDeps,
  project,
  removeWorktree,
  resetSharedDeps,
  sharedDepsDir,
  sweepWorktrees,
  tid,
  tmp,
} from './worktree-test-kit.ts'

/**
 * 这个文件只留「靠真实时钟或并发窗口判定」的用例：复制被中断留下的锁、过期锁下并发开目录、
 * 清扫按 mtime 判残留、合并时等别的 git 进程放开 index.lock。
 * 它们和别的文件抢 CPU 时会随机失败，由 scripts/unit-tests.mjs 的计时批串行跑。
 *
 * 其余的 git 状态 / 合并 / 回收 / 依赖共用的正常路径在 worktree-merge.test.ts（并发批），
 * 两边一共 42 例，和拆分前一样多；公共准备在 worktree-test-kit.ts。
 */

test('独立目录接上项目的依赖和环境文件，不复制密钥', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '测试任务')
  try {
    // 独立目录里不放依赖：Node / npm 会向上找到 worktrees 下共用的那一份
    assert.ok(!existsSync(path.join(wt.path, 'node_modules')), '独立目录里不再复制一份依赖')
    assert.ok(existsSync(path.join(await sharedDepsDir(repo), 'dep', 'index.js')), '共用依赖准备好了')
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

test('依赖共用：同时开多个子对话只有一个在复制，不互相踩', async () => {
  resetSharedDeps()
  const repo = project()
  const wts = await Promise.all([1, 2, 3].map((i) => createWorktree(repo, tid(), `并发${i}`)))
  try {
    for (const wt of wts) assert.ok(!existsSync(path.join(wt.path, 'node_modules')), '每个目录里都不放依赖')
    assert.ok(existsSync(path.join(await sharedDepsDir(repo), 'dep', 'index.js')), '共用的一份是完整的')
    // 临时目录和锁不能留下：留着的话下一次开对话会被挡住、清扫时会被当成残留
    assert.deepEqual(
      readdirSync(path.dirname(await sharedDepsDir(repo))).filter((n) => n.startsWith('node_modules.')),
      [],
      '不留复制用的临时目录和锁',
    )
  } finally {
    for (const wt of wts) await removeWorktree(repo, wt, true).catch(() => {})
  }
})

test('依赖共用：上次复制被中断留下的锁不会让新子对话干等', async () => {
  resetSharedDeps()
  const repo = project()
  const group = path.dirname(await sharedDepsDir(repo))
  const lock = path.join(group, 'node_modules.lock')
  mkdirSync(lock, { recursive: true })
  // 模拟复制方已经没了：锁很久没有心跳（正常复制每 2 秒更新一次）
  const stale = new Date(Date.now() - 60_000)
  utimesSync(lock, stale, stale)
  const started = Date.now()
  const wt = await createWorktree(repo, tid(), '锁残留')
  try {
    assert.ok(existsSync(path.join(await sharedDepsDir(repo), 'dep', 'index.js')), '自己把依赖准备好了')
    assert.ok(Date.now() - started < 30_000, `没有干等到等待上限（${Date.now() - started}ms）`)
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('依赖共用：有过期的锁时并发开子对话，共用依赖仍然完整', async () => {
  resetSharedDeps()
  const repo = project()
  const group = path.dirname(await sharedDepsDir(repo))
  const lock = path.join(group, 'node_modules.lock')
  mkdirSync(lock, { recursive: true })
  const stale = new Date(Date.now() - 60_000)
  utimesSync(lock, stale, stale)
  // 同时开多个：接管过期锁必须只有一个进程能做到（rename 原子），否则两个都去复制、
  // 换装时互相挪走对方刚放好的那一份，最后可能一个完整的都没有
  const wts = await Promise.all([1, 2, 3].map((i) => createWorktree(repo, tid(), `过期锁并发${i}`)))
  try {
    const shared = await sharedDepsDir(repo)
    assert.ok(existsSync(path.join(shared, 'dep', 'index.js')), '共用依赖是完整的一份')
    assert.ok(existsSync(path.join(shared, '.agent-panel-deps.json')), '复制记录在（不是半份）')
    for (const wt of wts) assert.deepEqual(await missingDeps(wt.path), [], '每个子对话里依赖都能解析')
    // 接替过程不再留锁或换装用的临时目录
    assert.deepEqual(
      readdirSync(group).filter((n) => n.startsWith('node_modules.')),
      [],
      '没留下锁 / 临时目录',
    )
  } finally {
    for (const wt of wts) await removeWorktree(repo, wt, true).catch(() => {})
  }
})

/** 在指定目录下开一个独立工作目录（createWorktree 的位置固定在数据目录，清理用例要自己指定） */
function worktreeAt(root: string, repo: string, name: string) {
  const dir = path.join(root, name)
  const branch = `agent-panel/${name}`
  git(repo, 'worktree', 'add', '-q', '-b', branch, dir, 'HEAD')
  return { dir, branch }
}

/** 任务记录：默认已收口、没在跑，改动都已合回原分支 */
const doneInfo = (over: Partial<{ done: boolean; working: boolean; projectPath: string; branch: string }> = {}) => ({
  done: true,
  working: false,
  projectPath: '',
  branch: '',
  baseBranch: '',
  ...over,
})

test('守护清理：共用依赖目录不会被当成残留清掉', async () => {
  resetSharedDeps()
  const repo = project()
  const wt = await createWorktree(repo, tid(), '清扫共用')
  const res = await sweepWorktrees({ minAgeMs: 0, taskInfo: async () => doneInfo() })
  assert.ok(existsSync(path.join(await sharedDepsDir(repo), 'dep', 'index.js')), '共用依赖还在')
  assert.ok(!res.removed.some((i) => i.taskId === 'node_modules'), '没被当成任务残留')
  await removeWorktree(repo, wt, true).catch(() => {})
})

test('守护清理：git 注册表外的残留目录被清（面板重启、prune 之后留下的）', async () => {
  const repo = project()
  const root = mkdtempSync(path.join(tmp, 'sweep-'))
  const { dir } = worktreeAt(root, repo, 'orphan1')
  // 真实残留长这样：注册记录已经被 prune 掉，目录还在，里面的 .git 指向已经不存在的路径
  git(repo, 'worktree', 'remove', '--force', dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'orphan1')}\n`)
  writeFileSync(path.join(dir, 'README.md'), '# 残留\n')
  // minAgeMs: 0：测试里刚建出来的目录也要参与判定（真实运行默认 10 分钟内不动）
  const res = await sweepWorktrees({ root, minAgeMs: 0, taskInfo: async () => doneInfo() })
  assert.deepEqual(
    res.removed.map((i) => i.taskId),
    ['orphan1'],
    '注册表外的残留清掉了',
  )
  assert.ok(!existsSync(dir), '目录被删掉')
  assert.deepEqual(res.failed, [])
})

test('守护清理：已合并且任务已收口的被清掉目录和分支', async () => {
  const repo = project()
  const root = mkdtempSync(path.join(tmp, 'sweep-'))
  const { dir, branch } = worktreeAt(root, repo, 'merged1')
  const { dir: goneDir, branch: goneBranch } = worktreeAt(root, repo, 'norecord1')
  const res = await sweepWorktrees({
    root,
    minAgeMs: 0,
    // 一个任务已收口，另一个任务记录已经不在了（面板重启、记录被删后没人收）
    taskInfo: async (id) => (id === 'norecord1' ? null : doneInfo({ branch })),
  })
  assert.deepEqual(res.removed.map((i) => i.taskId).sort(), ['merged1', 'norecord1'])
  assert.ok(!existsSync(dir), '已收口的目录被清掉')
  assert.ok(!branchAlive(repo, branch), '对应的 agent-panel 分支也删了')
  assert.ok(!existsSync(goneDir), '记录不在了的目录也清掉')
  assert.ok(!branchAlive(repo, goneBranch))
})

test('守护清理：有未合提交、任务在跑、任务没收口的一律不碰', async () => {
  const repo = project()
  const root = mkdtempSync(path.join(tmp, 'sweep-'))
  const unmerged = worktreeAt(root, repo, 'unmerged1')
  const busy = worktreeAt(root, repo, 'busy1')
  const pending = worktreeAt(root, repo, 'pending1')
  writeFileSync(path.join(unmerged.dir, 'x.txt'), 'x\n')
  git(unmerged.dir, 'add', '-A')
  git(unmerged.dir, 'commit', '-qm', '还没合回原分支的改动')
  const res = await sweepWorktrees({
    root,
    minAgeMs: 0,
    taskInfo: async (id) => {
      if (id === 'unmerged1') return doneInfo({ branch: unmerged.branch })
      if (id === 'busy1') return doneInfo({ working: true, branch: busy.branch })
      return doneInfo({ done: false, branch: pending.branch })
    },
  })
  assert.deepEqual(res.removed, [], '一个都没清')
  assert.ok(existsSync(unmerged.dir), '还有没合回原分支的提交，目录保留')
  assert.ok(branchAlive(repo, unmerged.branch), '分支也保留')
  assert.ok(existsSync(busy.dir), '任务还在跑，目录保留')
  assert.ok(existsSync(pending.dir), '任务还没收口，目录保留')
  for (const [dir] of [unmerged, busy, pending].map((w) => [w.dir])) git(repo, 'worktree', 'remove', '--force', dir)
})

test('守护清理：dry-run 只出清单，目录和分支都不动', async () => {
  const repo = project()
  const root = mkdtempSync(path.join(tmp, 'sweep-'))
  const { dir, branch } = worktreeAt(root, repo, 'dry1')
  const res = await sweepWorktrees({ root, dryRun: true, minAgeMs: 0, taskInfo: async () => doneInfo({ branch }) })
  assert.equal(res.dryRun, true)
  assert.deepEqual(
    res.removed.map((i) => i.taskId),
    ['dry1'],
    '清单里有它',
  )
  assert.ok(existsSync(dir), '目录没删')
  assert.ok(branchAlive(repo, branch), '分支没删')
  git(repo, 'worktree', 'remove', '--force', dir)
})

test('守护清理：core.worktree 被写成别的平台路径时也不误清（走注册文件兜底）', async () => {
  const repo = project()
  const root = mkdtempSync(path.join(tmp, 'sweep-'))
  const { dir, branch } = worktreeAt(root, repo, 'broken1')
  writeFileSync(path.join(dir, 'x.txt'), 'x\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', '还没合回原分支的改动')
  // 本机真实遇到过：WSL 里留下的 core.worktree=/mnt/... 让 git worktree list 和 rev-list 整个失败
  const cfg = readFileSync(path.join(repo, '.git', 'config'), 'utf8')
  writeFileSync(path.join(repo, '.git', 'config'), `${cfg}\n[core]\n\tworktree = /mnt/nope\n`)
  const res = await sweepWorktrees({ root, minAgeMs: 0, taskInfo: async () => doneInfo({ branch }) })
  assert.deepEqual(res.removed, [], '一个都没清')
  assert.ok(existsSync(dir), '还有没合回的提交，目录保留')
  assert.ok(
    res.kept.some((k) => k.taskId === 'broken1' && k.why.includes('没合回原分支')),
    '按注册文件读到分支状态，没把目录当成残留',
  )
})

test('合并时原目录的 index.lock 正被别的 git 进程占着：等锁放开再合，不报成冲突', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), 'lock')
  try {
    writeFileSync(path.join(wt.path, 'c.txt'), 'c\n')
    const lock = path.join(repo, '.git', 'index.lock')
    writeFileSync(lock, '')
    const release = setTimeout(() => rmSync(lock, { force: true }), 300)
    try {
      await mergeWorktree(repo, wt, '合并', repo, true)
    } finally {
      clearTimeout(release)
    }
    assert.ok(existsSync(path.join(repo, 'c.txt')), '锁放开后合进去了')
    // 一直占着：重试几次后照样报错，不会无限等
    writeFileSync(path.join(wt.path, 'd.txt'), 'd\n')
    writeFileSync(lock, '')
    try {
      await assert.rejects(mergeWorktree(repo, wt, '合并', repo, true), /index\.lock|Unable to write index/)
    } finally {
      rmSync(lock, { force: true })
    }
  } finally {
    await removeWorktree(repo, wt, true)
  }
})
