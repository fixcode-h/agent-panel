import assert from 'node:assert/strict'
import test from 'node:test'
import type { ModuleDoc } from '../module-docs.ts'
import { MODULE_PUSH_MAX_CHARS, moduleEntryText, moduleOfFile, newPublicFns } from './module-entry.ts'

const doc = (name: string, sources: string[], entry: string[] = []): ModuleDoc => ({
  name,
  title: name,
  status: 'documented',
  role: `${name} 的职责`,
  sources,
  entry,
  keywords: [],
  deps: [],
  updated: '',
  branch: '',
})

test('模块入口：文件按源码项取最长匹配的模块，带说明的整句和对不上的不算', () => {
  const docs = [
    doc('server', ['server/']),
    doc('exec', ['server/exec/']),
    doc('home', ['Source/Game/Home', 'Source/Game/Home 下面的所有东西']),
  ]
  assert.equal(moduleOfFile(docs, 'server/exec/git.ts')?.name, 'exec')
  assert.equal(moduleOfFile(docs, 'server/index.ts')?.name, 'server')
  assert.equal(moduleOfFile(docs, 'Source\\Game\\Home\\HomeLib.cpp')?.name, 'home')
  assert.equal(moduleOfFile(docs, 'Source/Game/HomeX/a.cpp'), undefined)
  assert.equal(moduleOfFile(docs, 'web/src/a.ts'), undefined)
})

test('模块入口：推送写清模块、入口和文档路径，不超过字数上限', () => {
  const text = moduleEntryText(
    doc('home', ['Source/Game/Home/'], ['UHomeLib::GetDecorationActorTopLocation']),
    'Source/Game/Home/A.cpp',
    'docs/modules/home/README.md',
  )
  assert.match(text, /属于模块「home」/)
  assert.match(text, /`UHomeLib::GetDecorationActorTopLocation`/)
  assert.match(text, /docs\/modules\/home\/README\.md/)
  const long = moduleEntryText(doc('x', ['x/'], Array(40).fill('a'.repeat(100))), 'x/a.ts', 'docs/modules/x/README.md')
  assert.ok(long.length <= MODULE_PUSH_MAX_CHARS)
})

test('模块入口：改文件要新增的公开函数按各家参数认（Edit 只算新加的行、Write 整份、apply_patch 补丁）', () => {
  assert.deepEqual(
    newPublicFns(
      { old_string: 'export function kept() {}', new_string: 'export function kept() {}\nexport function fresh() {}' },
      'src/a.ts',
    ),
    ['fresh'],
  )
  assert.deepEqual(newPublicFns({ content: 'function M.Top()\nend' }, 'Script/Home.lua'), ['Top'])
  assert.deepEqual(
    newPublicFns({ edits: [{ old_string: 'a', new_string: 'GAME_API void Execute();' }] }, 'Source/Game/Public/Lib.h'),
    ['Execute'],
  )
  const patch =
    '*** Begin Patch\n*** Update File: src/b.ts\n@@\n-const x = 1\n+export function made() {}\n*** End Patch'
  assert.deepEqual(newPublicFns({ input: patch }, ''), ['made'])
  assert.deepEqual(newPublicFns({ new_string: 'const local = 1' }, 'src/a.ts'), [])
})
