// scripts/lib/doc-modules.mjs 的测试：模块表和模块文档目录双向对得上
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { checkModuleDocs, checkModuleDocsInRoot, moduleDocPath, moduleRows } from './lib/doc-modules.mjs'

const MAP = `# 模块地图

| 模块    | 路径       | 职责   | 入口              | 文档                                     | 状态     |
| ------- | ---------- | ------ | ----------------- | ---------------------------------------- | -------- |
| shared  | \`shared/\`  | 共享   | \`shared/schema.ts\` | [modules/shared](modules/shared/README.md) | inferred |
| server  | \`server/\`  | 服务端 | \`server/index.ts\`  | [modules/server](modules/server/README.md) | analyzed |

## 不容易发现位置的改动

| 要做的事     | 落在哪        |
| ------------ | ------------- |
| 改界面文案   | \`web/src\`     |
`

const ok = () => true

test('只解析模块表，不把后面的其它表格当成模块行', () => {
  assert.deepEqual(
    moduleRows(MAP).map((r) => r.name),
    ['shared', 'server'],
  )
  assert.equal(moduleDocPath(moduleRows(MAP)[0]), 'modules/shared/README.md')
})

test('表里每个模块都有模块文档时通过', () => {
  assert.deepEqual(checkModuleDocs({ mapText: MAP, dirs: ['shared', 'server'], exists: ok }), [])
})

test('表里列了模块但文档不存在时报告缺文档', () => {
  const errors = checkModuleDocs({
    mapText: MAP,
    dirs: ['shared', 'server'],
    exists: (p) => p !== 'modules/server/README.md',
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /docs\/modules\/server\/README\.md 不存在/)
})

test('模块删了、文档目录留着时报告孤立目录', () => {
  const errors = checkModuleDocs({ mapText: MAP, dirs: ['shared', 'server', 'retired-module'], exists: ok })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /docs\/modules\/retired-module\//)
  assert.match(errors[0], /MODULE-MAP\.md/)
})

test('文档列没写链接或指向别处时报告写错', () => {
  const broken = MAP.replace('[modules/server](modules/server/README.md)', '待补')
  // 只放 shared 一个目录：这次只看文档列写错的提示
  const errors = checkModuleDocs({ mapText: broken, dirs: ['shared'], exists: ok })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /「server」的文档列没有指向 modules\/<模块>\/README\.md/)
})

test('文档列列名写成「关联文档」也认', () => {
  const renamed = MAP.replace('| 文档 ', '| 关联文档 ')
  assert.deepEqual(
    moduleRows(renamed).map((r) => r.name),
    ['shared', 'server'],
  )
  assert.equal(moduleDocPath(moduleRows(renamed)[1]), 'modules/server/README.md')
})

test('找不到模块表时点明表没找到，不把所有目录报成孤立', () => {
  for (const dirs of [['shared', 'server'], []]) {
    const errors = checkModuleDocs({ mapText: '# 模块地图\n\n没有表格\n', dirs, exists: ok })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /没找到模块表/)
    assert.doesNotMatch(errors[0], /不在 docs\/MODULE-MAP\.md 的模块表里/)
  }
})

test('模块表后面紧跟列数不同的表时不把它当成模块行', () => {
  const adjacent = `| 模块 | 路径 | 文档 |\n| --- | --- | --- |\n| shared | \`shared/\` | [d](modules/shared/README.md) |\n| 要做的事 | 落在哪 |\n| --- | --- |\n| 改文案 | \`web/src\` |\n`
  assert.deepEqual(
    moduleRows(adjacent).map((r) => r.name),
    ['shared'],
  )
})

test('MODULE-MAP.md 不存在时不算错（项目可能没建文档树）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-modules-empty-'))
  assert.deepEqual(checkModuleDocsInRoot(root), [])
})

test('在真实目录上跑：读地图、列目录、拼路径三处接线都对', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-modules-'))
  mkdirSync(path.join(root, 'docs/modules/shared'), { recursive: true })
  mkdirSync(path.join(root, 'docs/modules/ghost'), { recursive: true })
  writeFileSync(path.join(root, 'docs/MODULE-MAP.md'), MAP)
  // shared / server 的 README 都没建，ghost 是地图里没有的目录
  const errors = checkModuleDocsInRoot(root)
  assert.equal(errors.length, 3)
  assert.ok(errors.some((e) => e.includes('docs/modules/shared/README.md 不存在')))
  assert.ok(errors.some((e) => e.includes('docs/modules/server/README.md 不存在')))
  assert.ok(errors.some((e) => e.includes('docs/modules/ghost/')))
  writeFileSync(path.join(root, 'docs/modules/shared/README.md'), '# shared')
  mkdirSync(path.join(root, 'docs/modules/server'), { recursive: true })
  writeFileSync(path.join(root, 'docs/modules/server/README.md'), '# server')
  const left = checkModuleDocsInRoot(root)
  assert.equal(left.length, 1)
  assert.match(left[0], /docs\/modules\/ghost\//)
})
