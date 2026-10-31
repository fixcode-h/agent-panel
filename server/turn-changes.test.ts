import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setLang } from '../shared/i18n.ts'
import type { TurnChanges } from '../shared/schema.ts'
import { gitSnapshot, spansFileDiff, undoSpans } from './exec/git.ts'
import { aroundMerge, beginTurnChanges, endTurnChanges } from './turn-changes.ts'
import { taskChanges } from './own-changes.ts'

setLang('zh')
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE
delete process.env.GIT_INDEX_FILE

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString()

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ap-turn-'))
  git(dir, 'init', '-q')
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
  writeFileSync(path.join(dir, 'b.txt'), 'keep\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

const read = (dir: string, f: string) => readFileSync(path.join(dir, f), 'utf8')

/** 一轮：开始、跑 work、结束，返回记下的改动 */
async function turn(id: string, dir: string, work: () => void | Promise<void>, carry = false) {
  let got: TurnChanges | undefined
  await beginTurnChanges(id, dir, [], carry)
  await work()
  await endTurnChanges(id, (c) => (got = c))
  return got
}

test('一轮的改动：只算这一轮开始以后的，撤销后回到开始时的样子', async () => {
  const dir = repo()
  // 上一轮之前用户自己改的不算
  writeFileSync(path.join(dir, 'b.txt'), 'user edit\n')
  const c = await turn('t1', dir, () => {
    writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n')
    writeFileSync(path.join(dir, 'new.txt'), 'n1\nn2\n')
  })
  assert.ok(c)
  assert.deepEqual(c.files.map((f) => `${f.path} +${f.add} -${f.del}`).sort(), ['a.txt +1 -1', 'new.txt +2 -0'])
  assert.match(await spansFileDiff(dir, c.spans, 'a.txt'), /\+TWO/)
  const r = await undoSpans(
    dir,
    c.spans,
    c.files.map((f) => f.path),
  )
  assert.equal(r.ok, true)
  assert.equal(read(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
  assert.equal(existsSync(path.join(dir, 'new.txt')), false, '这一轮新建的文件删掉')
  assert.equal(read(dir, 'b.txt'), 'user edit\n', '这一轮之前的改动不动')
})

test('快照：和暂存区同一秒里改过、大小没变的文件也算改动', async () => {
  // 不靠真实等待：把文件、暂存区条目和暂存区文件的时间都拨到同一个过去的时刻，正是 git 要回头比内容的「可疑」条目。
  // 快照拷出来的暂存区如果用了现在的时间，git 就当这个条目可信、只比时间和大小，改动整个漏掉（CI 上偶发拿不到这一轮的改动）
  const dir = repo()
  const past = new Date(Date.now() - 3600_000)
  const file = path.join(dir, 'a.txt')
  utimesSync(file, past, past)
  // 只刷新暂存区里这个文件的时间戳（内容没变，提交不了）
  git(dir, 'update-index', '--refresh')
  utimesSync(path.join(dir, '.git', 'index'), past, past)
  const before = await gitSnapshot(dir)
  writeFileSync(file, 'one\nTWO\nthree\nfour\nfive\n')
  utimesSync(file, past, past)
  assert.notEqual(await gitSnapshot(dir), before)
})

test('撤销：之后又改了别的地方的保留，改到同一处的算冲突、一个都不写', async () => {
  const dir = repo()
  const c = (await turn('t2', dir, () => {
    writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n')
  }))!
  // 之后用户改了另一行：撤销只撤 TWO，用户的 FIVE 留着
  writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\nFIVE\n')
  const ok = await undoSpans(dir, c.spans, ['a.txt'])
  assert.equal(ok.ok, true)
  assert.equal(read(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nFIVE\n')

  const c2 = (await turn('t2b', dir, () => {
    writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nFOUR\nFIVE\n')
    writeFileSync(path.join(dir, 'x.txt'), 'x\n')
  }))!
  // 同一行后来又被改：冲突，x.txt 也不能先删
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour!!\nFIVE\n')
  const bad = await undoSpans(
    dir,
    c2.spans,
    c2.files.map((f) => f.path),
  )
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.ok ? [] : bad.conflicts.map((x) => x.path), ['a.txt'])
  assert.equal(existsSync(path.join(dir, 'x.txt')), true, '有冲突时一个文件都不动')
  assert.equal(read(dir, 'a.txt'), 'one\ntwo\nthree\nfour!!\nFIVE\n')
})

test('接着做的一轮（子任务、工作流交回）接着上一轮的终点算；用户的新一轮重新拍起点', async () => {
  const dir = repo()
  await turn('t3', dir, () => writeFileSync(path.join(dir, 'a.txt'), 'first\n'))
  // 空档里子任务改的文件
  writeFileSync(path.join(dir, 'helper.txt'), 'h\n')
  const carried = (await turn('t3', dir, () => writeFileSync(path.join(dir, 'b.txt'), 'b2\n'), true))!
  assert.deepEqual(carried.files.map((f) => f.path).sort(), ['b.txt', 'helper.txt'])
  // 空档里用户自己改的，新一轮不算
  writeFileSync(path.join(dir, 'user.txt'), 'u\n')
  const fresh = (await turn('t3', dir, () => writeFileSync(path.join(dir, 'c.txt'), 'c\n')))!
  assert.deepEqual(
    fresh.files.map((f) => f.path),
    ['c.txt'],
  )
})

test('子对话合进来的那一下不算进父对话这一轮', async () => {
  const dir = repo()
  const c = (await turn('t4', dir, async () => {
    writeFileSync(path.join(dir, 'mine.txt'), 'm\n')
    await aroundMerge(dir, async () => {
      writeFileSync(path.join(dir, 'child.txt'), 'from child\n')
    })
    writeFileSync(path.join(dir, 'mine2.txt'), 'm2\n')
  }))!
  assert.deepEqual(c.files.map((f) => f.path).sort(), ['mine.txt', 'mine2.txt'])
  assert.equal(c.spans.length, 2)
  const r = await undoSpans(
    dir,
    c.spans,
    c.files.map((f) => f.path),
  )
  assert.equal(r.ok, true)
  assert.equal(read(dir, 'child.txt'), 'from child\n', '撤销不碰子对话的改动')
  assert.equal(existsSync(path.join(dir, 'mine.txt')), false)
})

test('这一轮里拉代码带进来的文件不算，自己的提交和没提交的改动照算；更改面板只留自己改过的', async () => {
  const up = repo()
  const dir = mkdtempSync(path.join(tmpdir(), 'ap-turn-clone-'))
  git(dir, 'clone', '-q', up, '.')
  // 上游在对话期间又提交了几个文件
  writeFileSync(path.join(up, 'upstream.txt'), 'u\n')
  writeFileSync(path.join(up, 'b.txt'), 'keep\nup\n')
  git(up, 'add', '-A')
  git(up, 'commit', '-qm', 'upstream')
  const c = (await turn('t5', dir, () => {
    writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n')
    git(dir, 'add', 'a.txt')
    git(dir, 'commit', '-qm', 'mine')
    git(dir, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'HEAD')
    writeFileSync(path.join(dir, 'b.txt'), 'keep\nup\nlocal\n')
  }))!
  assert.deepEqual(
    c.files.map((f) => f.path).sort(),
    ['a.txt', 'b.txt'],
    '上游的 upstream.txt 不算，b.txt 自己又改了照算',
  )
  const tk = {
    messages: [{ turnChanges: c, tools: [] }],
    changes: [],
    baseline: {},
    baseRef: git(dir, 'rev-parse', 'HEAD~2').trim(),
    placedAttachments: {},
  } as unknown as Parameters<typeof taskChanges>[1]
  const all = await taskChanges(dir, tk)
  assert.deepEqual(all?.map((f) => f.path).sort(), ['a.txt', 'b.txt'])
})
