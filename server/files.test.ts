import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_FILE_FORMAT } from '../shared/schema.ts'
import { setLang } from '../shared/i18n.ts'
import {
  createInDir,
  deleteInDir,
  diffInDir,
  listDir,
  listLevel,
  mkdirInDir,
  readInDir,
  renameInDir,
  revealInDir,
  searchInDir,
  searchNameInDir,
  writeInDir,
} from './files.ts'

// 这里的断言都是中文报错文案：固定语言，Linux / CI 上 LANG 是英文时也能过
setLang('zh')

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

/**
 * 越权路径的几种写法在各平台都要拒绝。
 * 尤其是 POSIX 绝对路径：以前先剥掉开头的 / 会让它变成项目里的相对路径，校验被绕过。
 */
const OUTSIDE = [
  ['POSIX 绝对路径', '/tmp/agent-panel-outside'],
  ['根目录', '/'],
  ['Windows 盘符（反斜杠）', 'C:\\Windows\\System32'],
  ['Windows 盘符（正斜杠）', 'C:/Windows/System32'],
  ['UNC 路径', '\\\\server\\share\\x'],
  ['上一级', '..'],
  ['绕出去', 'src/../../..'],
  ['上一级的写法', '../outside'],
]

test('列目录拒绝各种绝对路径和越权路径', async () => {
  const dir = project()
  for (const [label, bad] of OUTSIDE) await assert.rejects(() => listLevel(dir, bad), /只能查看项目目录里的文件/, label)
})

test('在系统里打开时同样拒绝绝对路径和越权路径', async () => {
  const dir = project()
  // 校验在 stat 和打开文件管理器之前就失败，不会真的弹出窗口
  for (const [label, bad] of OUTSIDE)
    await assert.rejects(() => revealInDir(dir, bad), /只能查看项目目录里的文件/, label)
  await assert.rejects(() => revealInDir(dir, `${dir}/src`), /只能查看项目目录里的文件/)
})

test('项目里的合法路径照常能用（中文、空格、点开头的约定目录）', async () => {
  const dir = path.join(tmp, `ok${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(path.join(dir, '.github'), { recursive: true })
  mkdirSync(path.join(dir, '我的 目录'), { recursive: true })
  writeFileSync(path.join(dir, '.github/workflow.yml'), 'x\n')
  writeFileSync(path.join(dir, '我的 目录/a.ts'), 'a\n')
  const root = await listLevel(dir, '')
  assert.deepEqual(
    root.entries.map((e) => e.name),
    ['.github', '我的 目录'],
  )
  // 正斜杠、反斜杠、结尾带分隔符都指向同一个目录
  for (const p of ['我的 目录', '我的 目录/', '我的 目录\\']) {
    const level = await listLevel(dir, p)
    assert.deepEqual(
      level.entries.map((e) => e.path),
      ['我的 目录/a.ts'],
      p,
    )
  }
  // 以点开头的文件在列目录时按原有规则隐藏，这里只确认它们的路径不被当成越权
  const inside = await listLevel(dir, '.github')
  assert.deepEqual(
    inside.entries.map((e) => e.path),
    ['.github/workflow.yml'],
  )
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

/**
 * 建一个指向 target 的链接（Windows 上用 junction，其他系统用符号链接）。
 * 建不了（权限、文件系统不支持）时返回 false，由调用方 skip，不让测试失败。
 */
function linkTo(target: string, at: string): boolean {
  try {
    if (process.platform === 'win32') execFileSync('cmd', ['/c', 'mklink', '/J', at, target], { stdio: 'pipe' })
    else symlinkSync(target, at, 'dir')
    return true
  } catch {
    return false
  }
}

/** 项目外的一个目录：里面放一个不该被读到的文件 */
function outsideDir(name: string): string {
  const dir = path.join(tmp, `out${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, name), 'top secret\n')
  return dir
}

test('项目里指向外面的链接：读文件、列目录、往里写都被拒绝', async (t) => {
  const dir = project()
  const outside = outsideDir('secret.txt')
  if (!linkTo(outside, path.join(dir, 'link'))) return t.skip('这个系统建不了链接')
  // 字面路径在项目里，真实位置在项目外
  await assert.rejects(() => readInDir(dir, 'link/secret.txt'), /只能查看项目目录里的文件/)
  await assert.rejects(() => listLevel(dir, 'link'), /只能查看项目目录里的文件/)
  await assert.rejects(() => createInDir(dir, 'link', 'evil.txt', 'x', DEFAULT_FILE_FORMAT), /只能查看项目目录里的文件/)
  await assert.rejects(() => writeInDir(dir, 'link/secret.txt', 'x', DEFAULT_FILE_FORMAT), /只能查看项目目录里的文件/)
  // 项目里自己的文件照常读
  assert.equal((await readInDir(dir, 'README.md')).content, '# demo\n')
})

test('不是 git 仓库时按名字搜索不跟链接，自指的链接也不会绕成环', async (t) => {
  const dir = path.join(tmp, `walk${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, 'src/a.ts'), 'a\n')
  const outside = outsideDir('secret.txt')
  if (!linkTo(outside, path.join(dir, 'link'))) return t.skip('这个系统建不了链接')
  // 再指回项目自己：真的跟着走会一直转下去
  linkTo(dir, path.join(dir, 'src/back'))
  const outsideHit = await searchNameInDir(dir, 'secret')
  assert.deepEqual(outsideHit.files, [])
  const own = await searchNameInDir(dir, 'a.ts')
  assert.deepEqual(
    own.files.map((f) => f.path),
    ['src/a.ts'],
  )
})

test('git 仓库里路径的中间一层被换成链接后，内容搜索不读外面的文件', async (t) => {
  const dir = project()
  const outside = path.join(tmp, `rep${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(outside, 'app.ts'), 'export const secret = 1\n')
  // src 被换成指向外面的链接：git 里仍然记着 src/app.ts，不加判断就会读到外面那份
  rmSync(path.join(dir, 'src'), { recursive: true, force: true })
  if (!linkTo(outside, path.join(dir, 'src'))) return t.skip('这个系统建不了链接')
  const r = await searchInDir(dir, 'secret')
  assert.deepEqual(r.files, [])
  // 项目自己的内容照常搜得到
  const own = await searchInDir(dir, 'guide')
  assert.deepEqual(
    own.files.map((f) => f.path),
    ['docs/guide.md'],
  )
})

test('新建文件、新建目录、改名都不覆盖已有的东西', async () => {
  const dir = project()
  const made = await createInDir(dir, 'docs', 'note.md', 'hi\n', DEFAULT_FILE_FORMAT)
  assert.equal(made.path, 'docs/note.md')
  assert.equal(made.size, 3)
  await assert.rejects(
    () => createInDir(dir, 'docs', 'note.md', 'x', DEFAULT_FILE_FORMAT),
    /已经有一个同名的文件或目录了/,
  )
  await assert.rejects(() => mkdirInDir(dir, 'docs', 'note.md'), /已经有一个同名的文件或目录了/)
  const sub = await mkdirInDir(dir, '', 'assets')
  assert.equal(sub.path, 'assets')
  await assert.rejects(() => mkdirInDir(dir, '', 'assets'), /已经有一个同名的文件或目录了/)
  await assert.rejects(() => renameInDir(dir, 'src/app.ts', 'new.ts'), /已经有一个同名的文件或目录了/)
  const renamed = await renameInDir(dir, 'src/app.ts', 'main.ts')
  assert.equal(renamed.path, 'src/main.ts')
  assert.equal(readFileSync(path.join(dir, 'src/main.ts'), 'utf8').replace(/\r\n/g, '\n'), 'export const a = 1\n')
  await assert.rejects(() => renameInDir(dir, 'src/main.ts', 'nope/missing.ts'), /名字只能是/)
})

test('名字带路径分隔符、.. 或盘符都拒绝', async () => {
  const dir = project()
  for (const bad of ['../evil.txt', 'a/b.txt', 'a\\b.txt', 'C:evil.txt', '..', '.', '   '])
    await assert.rejects(
      () => createInDir(dir, '', bad, 'x', DEFAULT_FILE_FORMAT),
      /名字只能是单个文件名/,
      JSON.stringify(bad),
    )
  writeFileSync(path.join(dir, 'ok.txt'), 'x\n')
  for (const bad of ['../evil.txt', 'a/b.txt', '..'])
    await assert.rejects(() => renameInDir(dir, 'ok.txt', bad), /名字只能是单个文件名/, JSON.stringify(bad))
  // 没建成任何东西：项目里只有原来那两个
  assert.deepEqual(
    (await listLevel(dir, '')).entries.map((e) => e.name),
    ['docs', 'src', 'ok.txt', 'README.md'],
  )
})

test('删除：文件直接删，目录必须空，项目目录不能删', async () => {
  const dir = project()
  await deleteInDir(dir, 'docs/guide.md')
  assert.equal((await readInDir(dir, 'docs/guide.md')).exists, false)
  await deleteInDir(dir, 'docs')
  await assert.rejects(() => deleteInDir(dir, 'src'), /目录里还有内容，不能删除/)
  await assert.rejects(() => deleteInDir(dir, ''), /不能删除项目目录/)
  await assert.rejects(() => deleteInDir(dir, 'nope.txt'), /文件已经不在了/)
})

test('保存时保留原文件的 CRLF，LF 的文件不会被改成 CRLF', async () => {
  const dir = project()
  writeFileSync(path.join(dir, 'crlf.md'), 'a\r\nb\r\n')
  writeFileSync(path.join(dir, 'lf.md'), 'a\nb\n')
  // 读的时候要告诉前端这个文件是 CRLF
  assert.equal((await readInDir(dir, 'crlf.md')).eol, 'crlf')
  assert.equal((await readInDir(dir, 'lf.md')).eol, 'lf')
  // 项目设置是 LF，但原文件是 CRLF：按原样写回
  await writeInDir(dir, 'crlf.md', 'x\ny\n', DEFAULT_FILE_FORMAT)
  assert.equal(readFileSync(path.join(dir, 'crlf.md'), 'utf8'), 'x\r\ny\r\n')
  await writeInDir(dir, 'lf.md', 'x\r\ny\r\n', DEFAULT_FILE_FORMAT)
  assert.equal(readFileSync(path.join(dir, 'lf.md'), 'utf8'), 'x\ny\n')
  // 读回来的大小、修改时间跟文件对得上
  const info = await readInDir(dir, 'lf.md')
  assert.equal(info.size, 4)
  assert.ok(info.mtime && !Number.isNaN(Date.parse(info.mtime)))
})

test('差异：git 仓库给和 HEAD 的对比，不是仓库时给说明', async () => {
  const dir = project()
  const changed = await diffInDir(dir, 'src/app.ts')
  assert.equal(changed.path, 'src/app.ts')
  assert.equal(changed.dir, dir)
  assert.equal(changed.git, true)
  assert.equal(changed.before, true)
  assert.match(changed.diff.replace(/\r\n/g, '\n'), /\+export const a = 1/)
  // 没提交过的文件：给整份内容，git 为 false 并说明
  const fresh = await diffInDir(dir, 'src/new.ts')
  assert.equal(fresh.git, false)
  assert.equal(fresh.before, false)
  assert.ok(fresh.note)
  assert.match(fresh.diff, /new/)
  // 项目外的东西仍然拒绝
  await assert.rejects(() => diffInDir(dir, '../x'), /只能查看项目目录里的文件/)
  // 不是 git 仓库：git 为 false，diff 为空，附说明
  const plain = path.join(tmp, `plain${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(plain, { recursive: true })
  writeFileSync(path.join(plain, 'a.txt'), 'a\n')
  const none = await diffInDir(plain, 'a.txt')
  assert.deepEqual([none.git, none.diff, none.before], [false, '', false])
  assert.ok(none.note)
})
