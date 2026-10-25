/**
 * 跨端联调：真实后端 server/library.ts 的读写逻辑 + 真实文件系统 + 前端 library-tree 的还原。
 *
 * 为什么需要它：前端界面检查跑的是演示数据（mock），后端单测不经过前端；
 * 两边分开都验过，但「后端返回的字段组合」与「前端据此做的分支」只在真实数据上才能确认：
 *   - 二进制文件后端返回 binary=true + 空 content，前端要显示提示而不是空编辑器
 *   - 1 MiB 上限由真实字节数触发，mock 造不出来
 *   - 真实多文件技能（两级目录、深层文件）的树形状与前端 toTree 的还原
 *   - 1100 个文件时 tree 截断到 1000 并带 truncated
 * HTTP 层由 `scripts/e2e/07-local.mjs` 在 WSL 里覆盖（同一组 /library/entry* 接口）。
 *
 * 所有文件都造在临时 HOME 里，跑完删掉，不碰本机 ~/.claude。
 * 手动跑：npx tsx --test server/library-interop.test.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// 必须在 import 后端模块之前设好：模块加载时就读 HOME / AGENT_PANEL_DATA
const home = mkdtempSync(path.join(tmpdir(), 'interop-home-'))
const data = mkdtempSync(path.join(tmpdir(), 'interop-data-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.AGENT_PANEL_DATA = data

const { readLibrary, readLibraryEntry, writeLibraryEntry, renameLibraryEntry, deleteLibraryEntry } =
  await import('./library.ts')
const { toTree, visibleRows, countFiles } = await import('../web/src/lib/library-tree.ts')

const skillRoot = path.join(home, '.claude', 'skills')
const demoDir = path.join(skillRoot, 'interop-demo')
const manyDir = path.join(skillRoot, 'interop-many')

/** 上限 + 2048 字节：真实触发后端的 1 MiB 判断 */
const BIG_BYTES = 1024 * 1024 + 2048

// 造一个真实技能：两级子目录、深层文件、真二进制 png、超限文本
mkdirSync(path.join(demoDir, 'references', 'deep'), { recursive: true })
writeFileSync(
  path.join(demoDir, 'SKILL.md'),
  '---\nname: interop-demo\ndescription: 联调用的真实技能\n---\n\n正文。\n',
  'utf8',
)
writeFileSync(path.join(demoDir, 'references', 'a.md'), '# a\n', 'utf8')
writeFileSync(path.join(demoDir, 'references', 'deep', 'b.md'), '# b\n', 'utf8')
writeFileSync(path.join(demoDir, 'notes.txt'), 'notes\n', 'utf8')
// 真 PNG 头（含 \0）：后端按内容里有没有 \0 判二进制
writeFileSync(
  path.join(demoDir, 'pic.png'),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
)
writeFileSync(path.join(demoDir, 'big.txt'), 'x'.repeat(BIG_BYTES), 'utf8')

// 1100 个文件：验树截断（上限 1000）
mkdirSync(manyDir, { recursive: true })
writeFileSync(path.join(manyDir, 'SKILL.md'), '---\nname: interop-many\ndescription: 验树截断\n---\n\n正文。\n', 'utf8')
for (let i = 0; i < 1100; i++) writeFileSync(path.join(manyDir, `f${String(i).padStart(4, '0')}.md`), 'x')

test('真实多文件技能：树形状、主文件排除、前端还原、深层文件读写', async () => {
  const file = await readLibrary('claude', 'skill', 'interop-demo')
  assert.ok(file.tree) // Skill 要返回文件树
  const entries = file.tree.entries
  // 主文件不在树里（后端按大小写无关排除），它只走 content 字段
  assert.equal(!entries.some((e) => e.path.toLowerCase() === 'skill.md'), true, '主文件不该出现在树里')
  assert.ok(
    entries.some((e) => e.path === 'references' && e.type === 'dir'),
    '一级目录要在树里',
  )
  assert.ok(
    entries.some((e) => e.path === 'references/deep' && e.type === 'dir'),
    '两级目录要在树里',
  )
  assert.ok(
    entries.some((e) => e.path === 'references/deep/b.md' && e.type === 'file'),
    '深层文件要在树里',
  )
  // 后端是广度优先：只在同一层里「目录在前」
  for (const level of new Set(entries.map((e) => e.path.split('/').length))) {
    const row = entries.filter((e) => e.path.split('/').length === level)
    const firstFile = row.findIndex((e) => e.type !== 'dir')
    const lastDir = row.map((e) => e.type).lastIndexOf('dir')
    assert.ok(firstFile < 0 || firstFile > lastDir, `第 ${level} 层里目录要排在文件前`)
  }
  // files 是扁平文件列表，不含目录
  assert.equal(file.files.includes('notes.txt'), true, 'files 要包含文件')
  assert.equal(!file.files.includes('references'), true, 'files 不该包含目录')

  // 前端还原：层级深度对、目录折叠生效
  const rows = toTree(entries)
  const flat = visibleRows(rows, new Set())
  assert.ok(
    flat.some((r) => r.path === 'references/deep/b.md' && r.depth === 2),
    '前端要还原到第二层',
  )
  assert.ok(
    !visibleRows(rows, new Set(['references'])).some((r) => r.path.startsWith('references/')),
    '收起目录后子项不该显示',
  )
  assert.equal(countFiles(rows), 5, '文件数：a.md / b.md / notes.txt / pic.png / big.txt')

  // 保存后重开还在
  await writeLibraryEntry('claude', 'skill', 'interop-demo', 'references/deep/b.md', '# b 联调改过\n')
  const reread = await readLibraryEntry('claude', 'skill', 'interop-demo', 'references/deep/b.md')
  assert.equal(reread.content, '# b 联调改过\n')
})

test('二进制文件：binary=true、content 空、size 有值', async () => {
  const png = await readLibraryEntry('claude', 'skill', 'interop-demo', 'pic.png')
  // 前端 editable 判 !binary，content 空串时不能渲染成空编辑器
  assert.equal(png.binary, true)
  assert.equal(png.content, '')
  assert.equal(png.size > 0, true, '要给出大小，提示里要显示')
})

test('1 MiB 上限：读和写都被拒，文案带 KB', async () => {
  const readErr = await readLibraryEntry('claude', 'skill', 'interop-demo', 'big.txt').then(
    () => '',
    (e: Error) => e.message,
  )
  assert.match(readErr, /KB/, `读超限要报带 KB 的错，实际：${readErr}`)
  const writeErr = await writeLibraryEntry('claude', 'skill', 'interop-demo', 'big.txt', 'y'.repeat(BIG_BYTES)).then(
    () => '',
    (e: Error) => e.message,
  )
  assert.match(writeErr, /KB/, `写超限要报带 KB 的错，实际：${writeErr}`)
})

test('tree 截断：1100 个文件时截到 1000 并标 truncated', async () => {
  const many = await readLibrary('claude', 'skill', 'interop-many')
  assert.ok(many.tree) // Skill 要返回文件树
  assert.ok(many.tree.entries.length <= 1000, `条目数要 ≤1000，实际 ${many.tree.entries.length}`)
  assert.equal(many.tree.truncated, true, 'truncated 要标出来，前端据此提示')
})

test('边界：主文件保护、改名、删除、新建多级目录', async () => {
  // 附件接口不能碰主文件（否则会绕过主文件的 frontmatter 处理）
  const guard = await readLibraryEntry('claude', 'skill', 'interop-demo', 'SKILL.md').then(
    () => '',
    (e: Error) => e.message,
  )
  assert.ok(guard) // 附件接口读主文件要报错

  await renameLibraryEntry('claude', 'skill', 'interop-demo', 'notes.txt', 'notes2.txt', false)
  assert.ok((await readLibrary('claude', 'skill', 'interop-demo')).files.includes('notes2.txt'))
  await deleteLibraryEntry('claude', 'skill', 'interop-demo', 'notes2.txt')
  const gone = await readLibrary('claude', 'skill', 'interop-demo')
  assert.ok(!gone.files.includes('notes2.txt')) // 删掉后不该还在

  // 后端没有单独的建目录接口：前端「新建目录」写 .gitkeep，父目录由后端递归创建
  await writeLibraryEntry('claude', 'skill', 'interop-demo', 'made/up/dir/.gitkeep', '')
  const after = await readLibrary('claude', 'skill', 'interop-demo')
  // 写 .gitkeep 要把多级目录建出来
  assert.ok(after.tree?.entries.some((e) => e.path === 'made/up/dir'))
})

test('清理临时目录', () => {
  rmSync(home, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
  assert.equal(existsSync(home), false)
})
