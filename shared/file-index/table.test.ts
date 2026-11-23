import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NameTable, tableFromPaths } from './table.ts'
import { skipDir, skipRule } from './rules.ts'

const PATHS = [
  'README.md',
  'Source/Game/PlayerController.cpp',
  'Source/Game/PlayerController.h',
  'Source/Game/AI/EnemyController.cpp',
  'Content/Maps/Lobby.umap',
  'Content/UI/WBP_Main.uasset',
  'Script/ui/main_panel.lua',
]

test('按名字找：文件名开头命中排最前，所有词都要命中，带 / 的词按路径', () => {
  const t = tableFromPaths(PATHS)
  assert.deepEqual(
    t.find('controller').map((h) => h.path),
    ['Source/Game/PlayerController.h', 'Source/Game/PlayerController.cpp', 'Source/Game/AI/EnemyController.cpp'],
  )
  assert.deepEqual(
    t.find('player cpp').map((h) => h.path),
    ['Source/Game/PlayerController.cpp'],
  )
  assert.deepEqual(
    t.find('ai/ controller').map((h) => h.path),
    ['Source/Game/AI/EnemyController.cpp'],
  )
  assert.equal(t.find('nothing-here').length, 0)
})

test('通配和扩展名过滤、限定目录、找目录', () => {
  const t = tableFromPaths(PATHS)
  assert.deepEqual(
    t.find('*.uasset').map((h) => h.path),
    ['Content/UI/WBP_Main.uasset'],
  )
  assert.deepEqual(
    t.find('controller', { ext: ['h'] }).map((h) => h.path),
    ['Source/Game/PlayerController.h'],
  )
  assert.deepEqual(
    t.find('controller', { under: ['Source/Game/AI'] }).map((h) => h.path),
    ['Source/Game/AI/EnemyController.cpp'],
  )
  assert.deepEqual(
    t
      .find('ui', { dirs: true })
      .filter((h) => h.path.endsWith('/'))
      .map((h) => h.path),
    ['Script/ui/', 'Content/UI/'],
  )
})

test('按文件夹取：一层和整棵子树；size 跟着增删变', () => {
  const t = tableFromPaths(PATHS)
  assert.deepEqual(t.list('Source/Game', false), {
    files: ['Source/Game/PlayerController.cpp', 'Source/Game/PlayerController.h'],
    dirs: ['Source/Game/AI'],
  })
  assert.deepEqual(t.list('Source', true)?.files.length, 3)
  assert.equal(t.list('NoSuch', false), undefined)
  assert.deepEqual(t.size, { files: 7, dirs: 9 })
  // 目录被删：整棵子树的文件都算删除
  const d = t.setDir('Source/Game', 1, ['PlayerController.h'], [])
  assert.deepEqual(d.removed.sort(), ['Source/Game/AI/EnemyController.cpp', 'Source/Game/PlayerController.cpp'])
  assert.equal(t.has('Source/Game/AI'), undefined)
  assert.equal(t.has('Source/Game/PlayerController.h'), 'file')
  assert.equal(t.size.files, 5)
})

test('落盘往返后内容和查询结果不变', () => {
  const t = tableFromPaths(PATHS, 42)
  const back = NameTable.fromLines(t.toLines())
  assert.deepEqual(back.size, t.size)
  assert.deepEqual(back.find('controller'), t.find('controller'))
  assert.equal(back.dir('Content/UI')?.mtime, 42)
})

test('glob：** 跨层、* 不跨层', () => {
  const t = tableFromPaths(PATHS)
  assert.deepEqual(t.glob(['Source/**/*.cpp']), [
    'Source/Game/AI/EnemyController.cpp',
    'Source/Game/PlayerController.cpp',
  ])
  assert.deepEqual(t.glob(['Source/*/*.h']), ['Source/Game/PlayerController.h'])
})

test('排除规则：目录名任意一层都跳，带斜杠的按路径通配，Windows 不分大小写', () => {
  const r = skipRule(['Saved', 'Plugins/*/Intermediate'], true)
  assert.ok(skipDir(r, 'saved', 'Foo/saved'))
  assert.ok(skipDir(r, 'Intermediate', 'Plugins/UELink/Intermediate'))
  assert.ok(!skipDir(r, 'Intermediate', 'Plugins/A/B/Intermediate'))
  assert.ok(skipDir(r, '.git', '.git'), '版本库目录永远不收')
  assert.ok(!skipDir(skipRule(['Saved'], false), 'saved', 'saved'), '别的系统按原样比')
})
