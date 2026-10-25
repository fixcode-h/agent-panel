import assert from 'node:assert/strict'
import test from 'node:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { t } from '../shared/i18n.ts'
import {
  LIBRARY_DIR_MAX_DELETE_ENTRIES,
  LIBRARY_FILE_MAX_BYTES,
  LIBRARY_FILE_MAX_KIB,
  LIBRARY_TREE_MAX_ENTRIES,
} from '../shared/library.ts'

// 数据目录和用户目录都换成临时的：HOME 在导入时就定了，所以先设环境变量再动态导入
const home = mkdtempSync(path.join(tmpdir(), 'library-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.AGENT_PANEL_DATA = path.join(home, '.agent-panel')
const { deleteLibraryEntry, readLibrary, readLibraryEntry, renameLibraryEntry, writeLibrary, writeLibraryEntry } =
  await import('./library.ts')

const CLI = 'claude'
const NAME = 'demo'
const skillDir = path.join(home, '.claude', 'skills', NAME)
const tree = (e: { type: string; path: string }) => `${e.type}:${e.path}`
const tooLarge = () => t('文件太大，最多 {kb} KB', { kb: LIBRARY_FILE_MAX_KIB })

/** 建一个带 SKILL.md 的技能目录 */
async function skill(name = NAME, dir = path.join(home, '.claude', 'skills', name)) {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: demo\ndescription: 测试技能\n---\n\n步骤\n', 'utf8')
  return dir
}

/** 每个用例一个干净的技能目录：用例前后都不串状态 */
async function fresh() {
  rmSync(skillDir, { recursive: true, force: true })
  return skill()
}

/** Windows 上普通用户建不了文件软链接（要开发者模式），这类用例跳过；Linux / macOS 上正常跑 */
function fileSymlinksBlocked() {
  const dir = mkdtempSync(path.join(tmpdir(), 'symlink-probe-'))
  try {
    symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file')
    return false
  } catch {
    return true
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 建不了目录链接的环境（受限容器 / 少见 Windows 配置）跳过：用 junction 探测 */
function dirSymlinksBlocked() {
  const dir = mkdtempSync(path.join(tmpdir(), 'symlink-probe-'))
  try {
    mkdirSync(path.join(dir, 'target'))
    linkDir(path.join(dir, 'target'), path.join(dir, 'link'))
    return false
  } catch {
    return true
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 目录链接：Windows 上普通用户建不了目录符号链接（要开发者模式），junction 不需要特权 */
const linkDir = (target: string, link: string) =>
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')

test('文件树：目录在前、按名字排，父目录排在子项前面，不列主文件、node_modules 和 .DS_Store', async () => {
  await fresh()
  mkdirSync(path.join(skillDir, 'references'), { recursive: true })
  mkdirSync(path.join(skillDir, 'scripts'), { recursive: true })
  writeFileSync(path.join(skillDir, 'references', 'api.md'), '# API\n')
  writeFileSync(path.join(skillDir, 'scripts', 'run.sh'), 'echo hi\n')
  writeFileSync(path.join(skillDir, 'notes.md'), '笔记\n')
  mkdirSync(path.join(skillDir, 'node_modules', 'x'), { recursive: true })
  writeFileSync(path.join(skillDir, 'node_modules', 'x', 'index.js'), 'x\n')
  writeFileSync(path.join(skillDir, '.DS_Store'), 'x')

  const file = await readLibrary(CLI, 'skill', 'demo')
  assert.deepEqual(file.tree?.entries.map(tree), [
    'dir:references',
    'dir:scripts',
    'file:notes.md',
    'file:references/api.md',
    'file:scripts/run.sh',
  ])
  // files 是旧字段：等于树里所有文件的路径（扁平），两个字段不能打架
  assert.deepEqual(file.files, ['notes.md', 'references/api.md', 'scripts/run.sh'])
  assert.equal(file.tree?.truncated, undefined)
  assert.equal(file.tree?.entries.find((e) => e.path === 'notes.md')?.size, Buffer.byteLength('笔记\n'))
})

test('文件树：条目太多时截断，留下的是浅层并标 truncated', async () => {
  const dir = await skill('many')
  // 造到超过上限：每层只放一层文件，超过上限的部分被截掉
  for (let i = 0; i <= LIBRARY_TREE_MAX_ENTRIES; i++) writeFileSync(path.join(dir, `f${i}.md`), 'x')
  const file = await readLibrary(CLI, 'skill', 'many')
  assert.equal(file.tree?.truncated, true)
  assert.equal(file.tree?.entries.length, LIBRARY_TREE_MAX_ENTRIES)
  // 截断后 files 和 tree 仍然一致
  assert.deepEqual(
    file.files,
    file.tree!.entries.filter((e) => e.type === 'file').map((e) => e.path),
  )
})

test('读附件：文本给内容，不存在的文件给 exists:false', async () => {
  await fresh()
  mkdirSync(path.join(skillDir, 'references'), { recursive: true })
  writeFileSync(path.join(skillDir, 'references', 'api.md'), '# API\n')

  const text = await readLibraryEntry(CLI, 'skill', 'demo', 'references/api.md')
  assert.equal(text.exists, true)
  assert.equal(text.content, '# API\n')
  assert.equal(text.size, Buffer.byteLength('# API\n'))
  assert.equal(text.binary, undefined)

  assert.deepEqual(await readLibraryEntry(CLI, 'skill', 'demo', 'references/nope.md'), {
    path: 'references/nope.md',
    exists: false,
    content: '',
    size: 0,
  })
})

test('读附件：二进制不返回内容，但带上大小', async () => {
  await fresh()
  writeFileSync(path.join(skillDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))

  const bin = await readLibraryEntry(CLI, 'skill', 'demo', 'logo.png')
  assert.equal(bin.binary, true)
  assert.equal(bin.content, '')
  assert.equal(bin.exists, true)
  assert.ok(bin.size > 0, 'binary 时也要返回 size，前端要显示大小')
})

test('读附件：超过上限报错，不截断', async () => {
  await fresh()
  writeFileSync(path.join(skillDir, 'big.txt'), 'a'.repeat(LIBRARY_FILE_MAX_BYTES + 1))
  await assert.rejects(readLibraryEntry(CLI, 'skill', 'demo', 'big.txt'), (e: Error) => e.message === tooLarge())
})

test('写附件：新建、覆盖、自动建子目录，返回写入字节数', async () => {
  await fresh()
  const first = await writeLibraryEntry(CLI, 'skill', 'demo', 'references/新增.md', '第一版\n')
  assert.equal(first.path, 'references/新增.md')
  assert.equal(first.bytes, Buffer.byteLength('第一版\n'))
  assert.equal((await readLibraryEntry(CLI, 'skill', 'demo', 'references/新增.md')).content, '第一版\n')

  await writeLibraryEntry(CLI, 'skill', 'demo', 'references/新增.md', '第二版\n')
  assert.equal((await readLibraryEntry(CLI, 'skill', 'demo', 'references/新增.md')).content, '第二版\n')

  // 反斜杠也当分隔符，写的是同一份
  await writeLibraryEntry(CLI, 'skill', 'demo', 'scripts\\run.sh', 'echo hi\n')
  assert.equal((await readLibraryEntry(CLI, 'skill', 'demo', 'scripts/run.sh')).content, 'echo hi\n')

  // 主文件不走附件接口
  await assert.rejects(
    writeLibraryEntry(CLI, 'skill', 'demo', 'SKILL.md', 'x'),
    new RegExp(t('SKILL.md 用主文件的内容读写')),
  )
})

test('写附件：内容超上限报错', async () => {
  await fresh()
  await assert.rejects(
    writeLibraryEntry(CLI, 'skill', 'demo', 'big.txt', 'a'.repeat(LIBRARY_FILE_MAX_BYTES + 1)),
    (e: Error) => e.message === tooLarge(),
  )
  assert.equal(existsSync(path.join(skillDir, 'big.txt')), false)
})

test('路径穿越一律被拒：../、绝对路径、盘符、穿插的 ..', async () => {
  await fresh()
  const outside = path.join(home, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(outside, 'secret.txt'), 'secret')

  const bad = [
    '../outside/secret.txt',
    'a/../../outside/secret.txt',
    '..',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'C:/Windows/win.ini',
    'references/../../outside/secret.txt',
    './x.md',
    '',
  ]
  for (const p of bad) {
    for (const [what, fn] of [
      ['读', () => readLibraryEntry(CLI, 'skill', 'demo', p)],
      ['写', () => writeLibraryEntry(CLI, 'skill', 'demo', p, 'x')],
      ['删', () => deleteLibraryEntry(CLI, 'skill', 'demo', p)],
      ['改名', () => renameLibraryEntry(CLI, 'skill', 'demo', p, 'ok.md', false)],
    ] as const)
      await assert.rejects(fn, (e: Error) => {
        // 报错文案必须是路径校验的，不能是「没有这一项」这类顺带的失败
        const wanted = [
          t('路径只能填 Skill 目录里的相对路径'),
          t('要填文件路径'),
          t('路径里不能有 {chars}', { chars: '< > : " | ? *' }),
        ]
        assert.ok(wanted.includes(e.message), `${what} ${p} 的报错不对：${e.message}`)
        return true
      })
  }
  // 外面的文件没被写、删
  assert.equal(readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret')
})

test('软链接：技能目录里的软链接指到外面时读写都被拒', async () => {
  await fresh()
  const outside = path.join(home, 'outside-link')
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  linkDir(outside, path.join(skillDir, 'link'))

  const denied = new RegExp(t('路径只能填 Skill 目录里的相对路径'))
  await assert.rejects(readLibraryEntry(CLI, 'skill', 'demo', 'link/secret.txt'), denied)
  await assert.rejects(writeLibraryEntry(CLI, 'skill', 'demo', 'link/new.txt', 'x'), denied)
  assert.equal(existsSync(path.join(outside, 'new.txt')), false, '外面的目录没被写')
})

test('软链接的 Skill 目录：附件读写落到链接指向的原文件夹，删文件不动原文件夹', async () => {
  const real = path.join(home, 'real-skill')
  rmSync(real, { recursive: true, force: true })
  await skill('real', real)
  const linkRoot = path.join(home, '.claude', 'skills')
  mkdirSync(linkRoot, { recursive: true })
  rmSync(path.join(linkRoot, 'linked'), { recursive: true, force: true })
  linkDir(real, path.join(linkRoot, 'linked'))

  assert.deepEqual(await writeLibraryEntry(CLI, 'skill', 'linked', 'notes.md', '写了\n'), {
    path: 'notes.md',
    bytes: Buffer.byteLength('写了\n'),
  })
  assert.equal(readFileSync(path.join(real, 'notes.md'), 'utf8'), '写了\n')
  assert.equal((await readLibraryEntry(CLI, 'skill', 'linked', 'notes.md')).content, '写了\n')

  await deleteLibraryEntry(CLI, 'skill', 'linked', 'notes.md')
  assert.equal(existsSync(path.join(real, 'notes.md')), false)
  assert.equal(existsSync(real), true, '原文件夹还在')
})

test('改名：目标存在时默认报错，overwrite 才覆盖；目录不能盖目录、不能移进自己', async () => {
  await fresh()
  writeFileSync(path.join(skillDir, 'a.md'), 'A')
  writeFileSync(path.join(skillDir, 'b.md'), 'B')

  await assert.rejects(
    renameLibraryEntry(CLI, 'skill', 'demo', 'a.md', 'b.md', false),
    new RegExp(t('「{name}」已经有了', { name: 'b.md' })),
  )
  assert.deepEqual(await renameLibraryEntry(CLI, 'skill', 'demo', 'a.md', 'dir/a.md', false), {
    from: 'a.md',
    to: 'dir/a.md',
  })
  assert.equal((await readLibraryEntry(CLI, 'skill', 'demo', 'dir/a.md')).content, 'A')

  await renameLibraryEntry(CLI, 'skill', 'demo', 'b.md', 'dir/a.md', true)
  assert.equal((await readLibraryEntry(CLI, 'skill', 'demo', 'dir/a.md')).content, 'B')

  mkdirSync(path.join(skillDir, 'd1'), { recursive: true })
  mkdirSync(path.join(skillDir, 'd2'), { recursive: true })
  await assert.rejects(
    renameLibraryEntry(CLI, 'skill', 'demo', 'd1', 'd2', true),
    new RegExp(t('「{name}」是个目录，不能覆盖', { name: 'd2' })),
  )
  await assert.rejects(
    renameLibraryEntry(CLI, 'skill', 'demo', 'd1', 'd1/sub', false),
    new RegExp(t('不能把目录移到它自己里面')),
  )
})

test('删附件：文件直接删，目录递归删，删不存在的算成功', async () => {
  await fresh()
  writeFileSync(path.join(skillDir, 'a.md'), 'A')
  mkdirSync(path.join(skillDir, 'refs', 'deep'), { recursive: true })
  writeFileSync(path.join(skillDir, 'refs', 'deep', 'x.md'), 'X')

  assert.deepEqual(await deleteLibraryEntry(CLI, 'skill', 'demo', 'a.md'), { path: 'a.md', deleted: true })
  assert.equal(existsSync(path.join(skillDir, 'a.md')), false)
  assert.deepEqual(await deleteLibraryEntry(CLI, 'skill', 'demo', 'refs'), { path: 'refs', deleted: true })
  assert.equal(existsSync(path.join(skillDir, 'refs')), false)
  assert.deepEqual(await deleteLibraryEntry(CLI, 'skill', 'demo', 'nope.md'), { path: 'nope.md', deleted: false })
})

test('删目录：条目太多时拒绝，免得一次删掉整个技能', async () => {
  await fresh()
  mkdirSync(path.join(skillDir, 'many'), { recursive: true })
  for (let i = 0; i <= LIBRARY_DIR_MAX_DELETE_ENTRIES; i++) writeFileSync(path.join(skillDir, 'many', `${i}.md`), 'x')
  await assert.rejects(
    deleteLibraryEntry(CLI, 'skill', 'demo', 'many'),
    new RegExp(t('这个目录里有 {n} 项以上，不能一次删，先清掉里面的文件', { n: LIBRARY_DIR_MAX_DELETE_ENTRIES })),
  )
  assert.equal(existsSync(path.join(skillDir, 'many')), true, '没删')
})

test('命令没有附件：只有 Skill 能带附件', async () => {
  await writeLibrary(CLI, 'command', 'demo-cmd', '---\ndescription: 命令\n---\n做事\n', true)
  await assert.rejects(readLibraryEntry(CLI, 'command', 'demo-cmd', 'x.md'), new RegExp(t('只有 Skill 能带附件')))
  const file = await readLibrary(CLI, 'command', 'demo-cmd')
  assert.deepEqual(file.files, [])
  assert.equal(file.tree, undefined)
})

test('往返：改主文件后附件和文件树都还在', async () => {
  await fresh()
  await writeLibraryEntry(CLI, 'skill', 'demo', 'references/api.md', '# API\n')
  const before = await readLibrary(CLI, 'skill', 'demo')
  await writeLibrary(CLI, 'skill', 'demo', before.content.replace('步骤', '改过的步骤'), false)
  const after = await readLibrary(CLI, 'skill', 'demo')
  assert.match(after.content, /改过的步骤/)
  assert.deepEqual(after.files, ['references/api.md'])
  assert.deepEqual(after.tree?.entries, before.tree?.entries)
})

test('断链的软链接：不能顺着它把附件写到 Skill 目录外', { skip: fileSymlinksBlocked() }, async () => {
  await fresh()
  // 一条终点不存在的文件软链接：existsSync 跟随它会报「不存在」，只有 lstat 看得出这里有个链接
  const outside = path.join(home, 'broken-target')
  mkdirSync(outside, { recursive: true })
  symlinkSync(path.join(outside, 'evil.txt'), path.join(skillDir, 'notes.md'), 'file')

  // 链接本身一律不给写（不管终点在不在）：拦在写入口，比靠 realpath 判断断链更直接
  await assert.rejects(
    writeLibraryEntry(CLI, 'skill', 'demo', 'notes.md', 'payload'),
    new RegExp(t('这是个链接，不能直接改内容')),
  )
  assert.equal(existsSync(path.join(outside, 'evil.txt')), false, '外面的文件没被创建')
  // 链接还在，没被这次失败的写入改坏
  assert.equal(lstatSync(path.join(skillDir, 'notes.md')).isSymbolicLink(), true)
})

test('主文件保护大小写无关：skill.md / SKILL.MD 不能写也不能删', async () => {
  await fresh()
  for (const p of ['skill.md', 'SKILL.MD', 'Skill.md'])
    for (const fn of [
      () => writeLibraryEntry(CLI, 'skill', 'demo', p, '覆盖'),
      () => deleteLibraryEntry(CLI, 'skill', 'demo', p),
      () => readLibraryEntry(CLI, 'skill', 'demo', p),
    ])
      await assert.rejects(fn, new RegExp(t('SKILL.md 用主文件的内容读写')), p)
  // 主文件还在，技能还能列出来
  assert.equal((await readLibrary(CLI, 'skill', 'demo')).content.includes('测试技能'), true)
})

test('改名只改大小写：内容不丢，且目标名字真的生效', async () => {
  await fresh()
  writeFileSync(path.join(skillDir, 'Notes.md'), '内容\n')
  await renameLibraryEntry(CLI, 'skill', 'demo', 'Notes.md', 'notes.md', true)
  assert.equal((await readLibraryEntry(CLI, 'skill', 'demo', 'notes.md')).content, '内容\n')
  // 目标名字真的落到磁盘上：Linux 上必须把旧名字换掉，不能是个「返回成功但什么都没做」的空操作
  const names = readdirSync(skillDir)
  assert.ok(names.includes('notes.md'), `目录里应该有 notes.md，实际：${names.join(', ')}`)
  if (process.platform !== 'win32' && process.platform !== 'darwin')
    assert.equal(names.includes('Notes.md'), false, 'Linux 上改名要真的把旧名字换掉')
})

test('改名覆盖失败时目标内容不丢：留底文件会被改回去', async () => {
  await fresh()
  writeFileSync(path.join(skillDir, 'a.md'), 'A')
  writeFileSync(path.join(skillDir, 'b.md'), 'B')
  // 源不存在时覆盖分支不能已经把 b.md 删掉
  await assert.rejects(renameLibraryEntry(CLI, 'skill', 'demo', 'nope.md', 'b.md', true))
  assert.equal((await readLibraryEntry(CLI, 'skill', 'demo', 'b.md')).content, 'B', 'b.md 还在')
  // 正常覆盖后目标内容变成源的，且不留 .old-* 残留
  await renameLibraryEntry(CLI, 'skill', 'demo', 'a.md', 'b.md', true)
  assert.equal((await readLibraryEntry(CLI, 'skill', 'demo', 'b.md')).content, 'A')
  const left = readdirSync(skillDir).filter((n) => n.includes('.old-'))
  assert.deepEqual(left, [], '不留临时留底文件')
})

test('文件树：logs / build 这类目录是内容要列出来，node_modules 和 .DS_Store 不列', async () => {
  await fresh()
  mkdirSync(path.join(skillDir, 'logs'), { recursive: true })
  writeFileSync(path.join(skillDir, 'logs', 'sample.log'), 'example\n')
  mkdirSync(path.join(skillDir, 'build'), { recursive: true })
  writeFileSync(path.join(skillDir, 'build', 'notes.md'), '内容\n')
  // 同名的「文件」也要列出来，排除规则只管目录
  writeFileSync(path.join(skillDir, 'venv'), '这其实是个文本文件\n')
  mkdirSync(path.join(skillDir, 'node_modules'), { recursive: true })
  writeFileSync(path.join(skillDir, '.DS_Store'), 'x')

  const file = await readLibrary(CLI, 'skill', 'demo')
  const paths = file.tree!.entries.map((e) => e.path)
  assert.deepEqual(paths, ['build', 'logs', 'venv', 'build/notes.md', 'logs/sample.log'])
})

test(
  '指向目录的软链接：树里标成 link，读接口不否认它存在，写被拒并说明是链接',
  { skip: dirSymlinksBlocked() },
  async () => {
    await fresh()
    const outside = path.join(home, 'assets-target')
    mkdirSync(outside, { recursive: true })
    linkDir(outside, path.join(skillDir, 'assets'))

    const file = await readLibrary(CLI, 'skill', 'demo')
    assert.deepEqual(
      file.tree?.entries.find((e) => e.path === 'assets'),
      { path: 'assets', type: 'link' },
    )
    // files 只放普通文件，链接不算（旧实现把链接当文件，这里是有意改掉的）
    assert.deepEqual(file.files, [])

    const got = await readLibraryEntry(CLI, 'skill', 'demo', 'assets')
    assert.equal(got.exists, true, '树里有的条目，读接口不能说不存在')
    assert.equal(got.link, true)
    assert.equal(got.content, '')

    await assert.rejects(
      writeLibraryEntry(CLI, 'skill', 'demo', 'assets', 'x'),
      new RegExp(t('这是个链接，不能直接改内容')),
    )

    // 删目录链接：链接消失、目标目录还在（Windows 上目录重解析点不能走 unlink，这里锁住那段）
    assert.deepEqual(await deleteLibraryEntry(CLI, 'skill', 'demo', 'assets'), { path: 'assets', deleted: true })
    assert.equal(existsSync(path.join(skillDir, 'assets')), false, '链接被删掉')
    assert.equal(existsSync(outside), true, '目标目录还在')
  },
)

test('指向 Skill 内部的软链接文件：可见但不可编辑，文案说明是链接', { skip: fileSymlinksBlocked() }, async () => {
  await fresh()
  mkdirSync(path.join(skillDir, 'docs'), { recursive: true })
  writeFileSync(path.join(skillDir, 'docs', 'real.md'), '真身\n')
  symlinkSync(path.join('docs', 'real.md'), path.join(skillDir, 'reference.md'), 'file')

  const got = await readLibraryEntry(CLI, 'skill', 'demo', 'reference.md')
  assert.equal(got.exists, true)
  assert.equal(got.link, true)
  assert.equal(got.content, '', '链接不给内容，不给前端一份编辑完又存不回去的正文')
  await assert.rejects(
    writeLibraryEntry(CLI, 'skill', 'demo', 'reference.md', '改'),
    new RegExp(t('这是个链接，不能直接改内容')),
  )
  assert.equal(readFileSync(path.join(skillDir, 'docs', 'real.md'), 'utf8'), '真身\n', '目标文件没被改')
  // 删链接本身可以，目标不动
  await deleteLibraryEntry(CLI, 'skill', 'demo', 'reference.md')
  assert.equal(existsSync(path.join(skillDir, 'docs', 'real.md')), true)
})

test('改名到只差大小写的名字时，同目录的其它文件不受牵连', async () => {
  await fresh()
  writeFileSync(path.join(skillDir, 'a.md'), 'A')
  writeFileSync(path.join(skillDir, 'b.md'), 'B')
  await renameLibraryEntry(CLI, 'skill', 'demo', 'a.md', 'A2.md', false)
  assert.equal((await readLibraryEntry(CLI, 'skill', 'demo', 'A2.md')).content, 'A')
  const names = readdirSync(skillDir)
  assert.ok(names.includes('b.md') || names.includes('B.md'), `b.md 不能丢：${names.join(', ')}`)
})

test('读一个目录：不当成二进制文件报它的大小', async () => {
  await fresh()
  mkdirSync(path.join(skillDir, 'docs'), { recursive: true })
  const got = await readLibraryEntry(CLI, 'skill', 'demo', 'docs')
  assert.equal(got.exists, true)
  assert.equal(got.content, '')
  assert.equal(got.size, 0, '目录的元数据大小不能当成文件大小给前端')
})

test('超限的链接：报「这是个链接」，不报「文件太大」', { skip: fileSymlinksBlocked() }, async () => {
  await fresh()
  const outside = path.join(home, 'big-target')
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(outside, 'big.txt'), 'a'.repeat(LIBRARY_FILE_MAX_BYTES + 1))
  symlinkSync(path.join(outside, 'big.txt'), path.join(skillDir, 'big.txt'), 'file')
  // 链接判断要在大检查之前：否则用户会以为要删内容，其实问题是这是个链接
  await assert.rejects(
    writeLibraryEntry(CLI, 'skill', 'demo', 'big.txt', 'x'),
    new RegExp(t('这是个链接，不能直接改内容')),
  )
})
