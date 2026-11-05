import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  branchAlive,
  createWorktree,
  ensureWorktreeDeps,
  git,
  mergeWorktree,
  missingDeps,
  project,
  refillSpareDeps,
  removeWorktree,
  resetWorktrees,
  sweepWorktrees,
  tid,
  tmp,
  WORKTREES_DIR,
} from './worktree-test-kit.ts'

/**
 * 这个文件只留「靠真实时钟或并发窗口判定」的用例：复制被中断留下的锁、过期锁下并发开目录、
 * 清扫按 mtime 判残留、合并时等别的 git 进程放开 index.lock。
 * 它们和别的文件抢 CPU 时会随机失败，由 scripts/unit-tests.mjs 的计时批串行跑。
 *
 * 其余的 git 状态 / 合并 / 回收 / 依赖布局的正常路径在 worktree-merge.test.ts（并发批），
 * 公共准备在 worktree-test-kit.ts。
 */

test('独立目录复制一份自己的依赖和环境文件，不复制密钥', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '测试任务')
  try {
    // 每个 worktree 各有一份真实文件：不靠祖先解析，也不是链接
    const mine = path.join(wt.path, 'node_modules')
    assert.ok(existsSync(path.join(mine, 'dep', 'index.js')), '独立目录里有自己的一份依赖')
    assert.notEqual(realpathSync(mine), realpathSync(path.join(repo, 'node_modules')), '是独立的一份')
    assert.ok(existsSync(path.join(mine, '.agent-panel-deps.json')), '复制记录在（不是半份）')
    // .env 复制，含密钥的 .env.local 不复制
    assert.equal(readFileSync(path.join(wt.path, '.env'), 'utf8').trim(), 'TOKEN=dev', '环境文件复制过去')
    assert.ok(!existsSync(path.join(wt.path, '.env.local')), '含密钥的环境文件不复制')
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('删掉独立目录时连同它的依赖一起删掉，项目的依赖还在', async () => {
  const repo = project()
  const wt = await createWorktree(repo, tid(), '测试任务')
  const mine = path.join(wt.path, 'node_modules')
  assert.ok(existsSync(path.join(mine, 'dep', 'index.js')), '准备好一份自己的依赖')
  await removeWorktree(repo, wt, true)
  assert.ok(!existsSync(wt.path), '独立目录删掉了')
  assert.ok(!existsSync(mine), '它那份依赖跟着目录删了')
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

test('依赖各自一份：同时开多个子对话，每个都复制自己的完整一份', async () => {
  resetWorktrees()
  const repo = project()
  const wts = await Promise.all([1, 2, 3].map((i) => createWorktree(repo, tid(), `并发${i}`)))
  try {
    for (const wt of wts) {
      const mine = path.join(wt.path, 'node_modules')
      assert.ok(existsSync(path.join(mine, 'dep', 'index.js')), '每个目录都有一份完整依赖')
      assert.ok(existsSync(path.join(mine, '.agent-panel-deps.json')), '不是半份')
      assert.notEqual(realpathSync(mine), realpathSync(path.join(repo, 'node_modules')), '各自独立')
      // 复制用的临时 / 换下来的旧副目录不能留在任务目录里
      assert.deepEqual(
        readdirSync(wt.path).filter((n) => n.startsWith('node_modules.')),
        [],
        '不留复制用的临时目录',
      )
    }
  } finally {
    for (const wt of wts) await removeWorktree(repo, wt, true).catch(() => {})
  }
})

test('依赖各自一份：项目没有 node_modules 时跳过复制，开目录照常成功', async () => {
  resetWorktrees()
  const repo = project()
  rmSync(path.join(repo, 'node_modules'), { recursive: true, force: true })
  const wt = await createWorktree(repo, tid(), '没装依赖')
  try {
    assert.ok(!existsSync(path.join(wt.path, 'node_modules')), '没有复制出空的目录')
    assert.ok(existsSync(path.join(wt.path, 'README.md')), '独立目录照常可用')
  } finally {
    await removeWorktree(repo, wt, true)
  }
})

test('依赖各自一份：已经有一份且 lock 没变时不重复复制，缺了会补一份', async () => {
  resetWorktrees()
  const repo = project()
  const wt = await createWorktree(repo, tid(), '准备两次')
  try {
    assert.equal(await ensureWorktreeDeps(wt.path, repo), 'ready', '已经就绪')
    const marker = path.join(wt.path, 'node_modules', '.agent-panel-deps.json')
    const before = statSync(marker).mtimeMs
    assert.equal(await ensureWorktreeDeps(wt.path, repo), 'ready')
    assert.equal(statSync(marker).mtimeMs, before, '没有重新复制一遍')
    // 旧 worktree（或用户自己删掉依赖）准备时补一份
    rmSync(path.join(wt.path, 'node_modules'), { recursive: true, force: true })
    assert.equal(await ensureWorktreeDeps(wt.path, repo), 'copied', '缺了补一份')
    assert.deepEqual(await missingDeps(wt.path), [], '补完依赖能解析')
  } finally {
    await removeWorktree(repo, wt, true)
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

test('守护清理：旧的共用依赖目录不会被当成残留清掉', async () => {
  resetWorktrees()
  const repo = project()
  const wt = await createWorktree(repo, tid(), '清扫共用')
  // 旧版本在项目分组目录下放过一份共用的 node_modules：新版本不再建，但也不能当残留删掉
  const group = path.dirname(wt.path)
  mkdirSync(path.join(group, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(path.join(group, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  const res = await sweepWorktrees({ minAgeMs: 0, taskInfo: async () => doneInfo() })
  assert.ok(existsSync(path.join(group, 'node_modules', 'dep', 'index.js')), '旧的共用依赖还在')
  assert.ok(!res.removed.some((i) => i.taskId === 'node_modules'), '没被当成任务残留')
  await removeWorktree(repo, wt, true).catch(() => {})
})

test('守护清理：清掉已收口的目录时，它那份依赖一起删', async () => {
  resetWorktrees()
  const repo = project()
  const id = tid()
  const wt = await createWorktree(repo, id, '清扫依赖')
  const mine = path.join(wt.path, 'node_modules')
  assert.ok(existsSync(path.join(mine, 'dep', 'index.js')), '先有一份依赖')
  const res = await sweepWorktrees({ minAgeMs: 0, taskInfo: async (taskId) => (taskId === id ? doneInfo() : null) })
  assert.ok(
    res.removed.some((i) => i.taskId === id),
    '已收口的目录被清掉',
  )
  assert.ok(!existsSync(mine), '它那份依赖跟着删了')
  assert.ok(existsSync(path.join(repo, 'node_modules', 'dep', 'index.js')), '项目的依赖还在')
})

test('守护清理：清一个目录时不动别的 worktree 的依赖', async () => {
  resetWorktrees()
  const repo = project()
  const idA = tid()
  const idB = tid()
  const a = await createWorktree(repo, idA, '清掉的')
  const b = await createWorktree(repo, idB, '留下的')
  try {
    const res = await sweepWorktrees({
      minAgeMs: 0,
      taskInfo: async (taskId) =>
        taskId === idB ? doneInfo({ working: true, branch: b.branch }) : doneInfo({ branch: a.branch }),
    })
    assert.ok(
      res.removed.some((i) => i.taskId === idA),
      '已收口的那个被清掉',
    )
    assert.ok(!existsSync(a.path), '清掉的目录没了')
    assert.ok(existsSync(path.join(b.path, 'node_modules', 'dep', 'index.js')), '另一个 worktree 的依赖还在')
  } finally {
    await removeWorktree(repo, b, true).catch(() => {})
    if (existsSync(a.path)) await removeWorktree(repo, a, true).catch(() => {})
  }
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

test('守护清理：git 不可用时一律保留，不把在用的目录当残留删掉', async () => {
  const repo = project()
  const root = mkdtempSync(path.join(tmp, 'sweep-'))
  const { dir } = worktreeAt(root, repo, 'nogit1')
  writeFileSync(path.join(dir, 'work.txt'), '没提交的改动\n')
  // PATH 清空模拟托盘启动时找不到 git、或 git 起不来：rev-parse 返回空，但 .git 链接是好的
  const oldPath = process.env.PATH
  process.env.PATH = mkdtempSync(path.join(tmp, 'empty-path-'))
  let res
  try {
    res = await sweepWorktrees({ root, minAgeMs: 0, taskInfo: async () => doneInfo() })
  } finally {
    process.env.PATH = oldPath
  }
  assert.deepEqual(res.removed, [], '一个都没删')
  assert.ok(existsSync(path.join(dir, 'work.txt')), '未提交的改动还在')
  assert.ok(
    res.kept.some((k) => k.taskId === 'nogit1'),
    '记成保留并写明原因',
  )
})

test('守护清理：注册表外的残留，任务还在执行时也不清', async () => {
  const repo = project()
  const root = mkdtempSync(path.join(tmp, 'sweep-'))
  const { dir } = worktreeAt(root, repo, 'orphanlive')
  git(repo, 'worktree', 'remove', '--force', dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'orphanlive')}\n`)
  const res = await sweepWorktrees({ root, minAgeMs: 0, taskInfo: async () => doneInfo({ working: true }) })
  assert.deepEqual(res.removed, [])
  assert.ok(existsSync(dir), '执行中的目录保留')
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

test('备用依赖副本：先在后台备好一份，开独立目录时直接拿走（真实文件、不是链接），拿走后再补一份', async () => {
  const repo = project()
  await refillSpareDeps(repo)
  const group = readdirSync(WORKTREES_DIR).find((d) => existsSync(path.join(WORKTREES_DIR, d, 'node_modules.spare')))
  assert.ok(group, '分组目录下有一份备用副本')
  const spare = path.join(WORKTREES_DIR, group!, 'node_modules.spare', 'node_modules')
  assert.ok(existsSync(path.join(spare, 'dep', 'index.js')))
  const wt = await createWorktree(repo, tid(), '备用副本')
  try {
    const mine = path.join(wt.path, 'node_modules')
    assert.ok(existsSync(path.join(mine, 'dep', 'index.js')), '独立目录拿到了依赖')
    assert.ok(existsSync(path.join(mine, '.agent-panel-deps.json')), '带着复制记录：lock 没变时不再重复复制')
    assert.notEqual(realpathSync(mine), realpathSync(path.join(repo, 'node_modules')), '是独立的一份')
    // 拿走后后台再补一份给下一个
    await refillSpareDeps(repo)
    assert.ok(existsSync(path.join(spare, 'dep', 'index.js')), '又补好了一份')
    // 清扫不把备用副本当成任务目录残留
    const r = await sweepWorktrees({ minAgeMs: 0 })
    assert.ok(!r.removed.some((x) => x.dir.includes('node_modules.spare')))
    assert.ok(existsSync(spare))
  } finally {
    await removeWorktree(repo, wt, true)
  }
})
