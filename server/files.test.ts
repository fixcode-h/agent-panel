import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { listDir, listLevel, searchNameInDir } from './files.ts'

const tmp = mkdtempSync(path.join(tmpdir(), 'agent-panel-files-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' })

/** 一个 git 仓库项目：几个目录、一个改过的文件、一个未跟踪的文件 */
function project(): string {
  const dir = path.join(tmp, `p${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(path.join(dir, 'src/api'), { recursive: true })
  mkdirSync(path.join(dir, 'docs'), { recursive: true })
  writeFileSync(path.join(dir, 'README.md'), '# demo\n')
  writeFileSync(path.join(dir, 'src/app.ts'), 'export {}\n')
  writeFileSync(path.join(dir, 'src/api/cart.ts'), 'cart\n')
  writeFileSync(path.join(dir, 'docs/guide.md'), 'guide\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '.')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  // 改一个、加一个未跟踪的
  writeFileSync(path.join(dir, 'src/app.ts'), 'export const a = 1\n')
  writeFileSync(path.join(dir, 'src/new.ts'), 'new\n')
  return dir
}

test('根目录只列一层：目录在前，不展开子项', async () => {
  const dir = project()
  const level = await listLevel(dir, '')
  assert.equal(level.path, '')
  assert.equal(level.dir, dir)
  assert.deepEqual(
    level.entries.map((e) => [e.name, e.kind]),
    [
      ['docs', 'dir'],
      ['src', 'dir'],
      ['README.md', 'file'],
    ],
  )
  // 子目录里的文件不在这一层
  assert.ok(!level.entries.some((e) => e.path.includes('/')))
})

test('展开子目录时只读它这一层，并带上 git 状态', async () => {
  const dir = project()
  const level = await listLevel(dir, 'src')
  assert.deepEqual(
    level.entries.map((e) => [e.path, e.kind, e.status]),
    [
      ['src/api', 'dir', ''],
      ['src/app.ts', 'file', 'M'],
      ['src/new.ts', 'file', '?'],
    ],
  )
  // 别的目录的改动不会漏进来
  assert.ok(!level.entries.some((e) => e.path.startsWith('docs/')))
})

test('根信息只有目录和分支，不再返回全量文件', async () => {
  const dir = project()
  const info = await listDir(dir)
  assert.equal(info.dir, dir)
  assert.equal(info.isGit, true)
  // 分支名跟环境里的默认分支走（main 或 master）
  assert.equal(info.branch, git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim())
  assert.deepEqual(Object.keys(info).sort(), ['branch', 'dir', 'isGit'])
})

test('目录不存在时给错误，不是空列表', async () => {
  const dir = project()
  await assert.rejects(() => listLevel(dir, 'nope'), /目录已经不在了/)
})

test('路径不能逃出项目目录', async () => {
  const dir = project()
  await assert.rejects(() => listLevel(dir, '..'), /只能查看项目目录里的文件/)
  await assert.rejects(() => listLevel(dir, 'src/../../..'), /只能查看项目目录里的文件/)
  await assert.rejects(() => listLevel(dir, tmp), /只能查看项目目录里的文件/)
  await assert.rejects(() => listLevel(dir, path.resolve(tmp, 'x')), /只能查看项目目录里的文件/)
})

test('按文件名搜索能找到还没展开的深层文件', async () => {
  const dir = project()
  const r = await searchNameInDir(dir, 'cart')
  assert.deepEqual(
    r.files.map((f) => f.path),
    ['src/api/cart.ts'],
  )
  assert.equal(r.truncated, false)
  // 文件名命中的排在路径命中的前面
  const s = await searchNameInDir(dir, 'guide')
  assert.equal(s.files[0].path, 'docs/guide.md')
})

test('大目录不截断：一次列出全部项', async () => {
  const dir = path.join(tmp, `big${Math.random().toString(36).slice(2, 8)}`)
  const count = 5_000
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < count; i++) writeFileSync(path.join(dir, `f${i}.txt`), '')
  const level = await listLevel(dir, '')
  assert.equal(level.entries.length, count)
})

test('不是 git 仓库时没有状态，产物目录不列', async () => {
  const dir = path.join(tmp, `plain${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true })
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, 'src/a.ts'), 'a\n')
  writeFileSync(path.join(dir, 'README.md'), '# x\n')
  const level = await listLevel(dir, '')
  assert.deepEqual(
    level.entries.map((e) => [e.name, e.kind, e.status]),
    [
      ['src', 'dir', ''],
      ['README.md', 'file', ''],
    ],
  )
  const sub = await listLevel(dir, 'src')
  assert.deepEqual(
    sub.entries.map((e) => [e.path, e.kind]),
    [['src/a.ts', 'file']],
  )
})

test('项目是仓库的子目录时，状态按项目里的相对路径算', async () => {
  const repo = path.join(tmp, `mono${Math.random().toString(36).slice(2, 8)}`)
  const dir = path.join(repo, 'app')
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'root.txt'), 'root\n')
  writeFileSync(path.join(dir, 'src/a.ts'), 'a\n')
  git(repo, 'init', '-q')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  writeFileSync(path.join(dir, 'src/a.ts'), 'changed\n')
  writeFileSync(path.join(repo, 'root.txt'), 'changed too\n')
  const level = await listLevel(dir, 'src')
  assert.deepEqual(
    level.entries.map((e) => [e.path, e.status]),
    [['src/a.ts', 'M']],
  )
  // 仓库根上的改动不属于这个项目
  const root = await listLevel(dir, '')
  assert.ok(!root.entries.some((e) => e.name === 'root.txt'))
})

test('重命名的文件带 R 状态和原路径', async () => {
  const dir = path.join(tmp, `ren${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'old.ts'), 'x'.repeat(200))
  git(dir, 'init', '-q')
  git(dir, 'add', '.')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  git(dir, 'mv', 'old.ts', 'new.ts')
  const level = await listLevel(dir, '')
  const entry = level.entries.find((e) => e.path === 'new.ts')
  assert.equal(entry?.status, 'R')
  assert.equal(entry?.from, 'old.ts')
})
