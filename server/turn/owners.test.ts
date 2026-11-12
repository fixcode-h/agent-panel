/**
 * 每轮改动按文件归属（turn-owners.ts）：同目录别的对话改的文件不进这个对话的卡片、不被它撤销。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setLang } from '../../shared/i18n.ts'
import type { TurnChanges } from '../../shared/schema.ts'
import { undoSpans } from '../exec/git.ts'
import { beginTurnChanges, endTurnChanges } from './changes.ts'
import { closeTurn, namedSince, noteEdit, openTurn, resetTurnOwners, splitOwned } from './owners.ts'

setLang('zh')
delete process.env.GIT_DIR
delete process.env.GIT_WORK_TREE
delete process.env.GIT_INDEX_FILE

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString()

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ap-owners-'))
  git(dir, 'init', '-q')
  for (const f of ['a.txt', 'b.txt', 'gen.txt']) writeFileSync(path.join(dir, f), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}
const write = (dir: string, f: string, text: string) => writeFileSync(path.join(dir, f), text)
const read = (dir: string, f: string) => readFileSync(path.join(dir, f), 'utf8')
const paths = (c?: TurnChanges) => (c?.files ?? []).map((f) => f.path).sort()

test('归属规则：别的对话点名、自己没点名的剔除；自己点名的、谁都没点名的留下', () => {
  const files = ['mine.ts', 'theirs.ts', 'both.ts', 'cmd.ts'].map((p) => ({ path: p }))
  const r = splitOwned(files, { mine: new Set(['mine.ts', 'both.ts']), others: new Set(['theirs.ts', 'both.ts']) })
  assert.deepEqual(
    r.kept.map((f) => f.path),
    ['mine.ts', 'both.ts', 'cmd.ts'],
  )
  assert.deepEqual(
    r.dropped.map((f) => f.path),
    ['theirs.ts'],
  )
  // 没有别的对话在这个目录里报过改动：照旧全算
  assert.equal(splitOwned(files, { mine: new Set(), others: new Set() }).kept.length, 4)
})

test('登记：只算这一轮开始以后的；绝对路径和相对路径认成同一个文件；别的目录不相干；子对话的算父对话的', () => {
  resetTurnOwners()
  const dir = path.join(tmpdir(), 'ap-owners-x')
  noteEdit('B', dir, 'old.ts')
  openTurn('A', dir, false)
  noteEdit('A', dir, path.join(dir, 'src', 'a.ts'))
  noteEdit('B', dir, 'src/b.ts')
  noteEdit('C', path.join(tmpdir(), 'ap-owners-y'), 'src/c.ts')
  noteEdit('kid', dir, 'src/kid.ts', 'A')
  noteEdit('B', dir, path.join(tmpdir(), 'outside.ts'))
  const owner = closeTurn('A')!
  // 交出凭据以后、终点快照拍完之前别的对话报的也要算
  noteEdit('B', dir, 'late.ts')
  const n = namedSince(owner)
  assert.deepEqual([...n.mine].sort(), ['src/a.ts', 'src/kid.ts'])
  assert.deepEqual([...n.others].sort(), ['late.ts', 'src/b.ts'])
  // 接着做的那一轮从上一轮的终点算起：上一轮点名的不再带过来
  openTurn('A', dir, true)
  noteEdit('A', dir, 'src/next.ts')
  assert.deepEqual([...namedSince(closeTurn('A')!).mine], ['src/next.ts'])
})

test('两个对话同目录同时改不同文件：各自的卡片只有自己的文件，撤销互不影响', async () => {
  resetTurnOwners()
  const dir = repo()
  let a: TurnChanges | undefined
  let b: TurnChanges | undefined
  await beginTurnChanges('A', dir, [], false)
  await beginTurnChanges('B', dir, [], false)
  write(dir, 'a.txt', 'from A\n')
  noteEdit('A', dir, 'a.txt')
  write(dir, 'b.txt', 'from B\n')
  noteEdit('B', dir, path.join(dir, 'b.txt'))
  // A 跑命令生成的文件：谁都没点名，两边都留着（规则保守：只剔除确定是别人的）
  write(dir, 'gen.txt', 'generated\n')
  await endTurnChanges('A', (c) => (a = c))
  await endTurnChanges('B', (c) => (b = c))
  assert.deepEqual(paths(a), ['a.txt', 'gen.txt'])
  assert.deepEqual(a?.others, ['b.txt'], '卡片上要说明剔除了 1 个别的对话改的文件')
  assert.deepEqual(paths(b), ['b.txt', 'gen.txt'])
  assert.deepEqual(b?.others, ['a.txt'])
  const r = await undoSpans(dir, a!.spans, ['a.txt'])
  assert.equal(r.ok, true)
  assert.equal(read(dir, 'a.txt'), 'base\n')
  assert.equal(read(dir, 'b.txt'), 'from B\n', '撤销 A 的这一轮不动 B 改的文件')
})

test('没有别的对话同时在改：照旧按快照差全算，卡片不带说明', async () => {
  resetTurnOwners()
  const dir = repo()
  let a: TurnChanges | undefined
  // B 在 A 这一轮开始之前点名过 b.txt：不算同时
  noteEdit('B', dir, 'b.txt')
  await beginTurnChanges('A', dir, [], false)
  write(dir, 'a.txt', 'from A\n')
  noteEdit('A', dir, 'a.txt')
  write(dir, 'b.txt', 'by command\n')
  await endTurnChanges('A', (c) => (a = c))
  assert.deepEqual(paths(a), ['a.txt', 'b.txt'])
  assert.equal(a?.others, undefined)
})

test('这一轮的改动全是别的对话的：不出卡片', async () => {
  resetTurnOwners()
  const dir = repo()
  let a: TurnChanges | undefined
  await beginTurnChanges('A', dir, [], false)
  write(dir, 'b.txt', 'from B\n')
  noteEdit('B', dir, 'b.txt')
  await endTurnChanges('A', (c) => (a = c))
  assert.equal(a, undefined)
})
