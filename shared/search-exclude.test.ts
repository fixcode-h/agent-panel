import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SEARCH_EXCLUDE,
  UE_SEARCH_EXCLUDE,
  searchExcludeFindPrune,
  searchExcludeGlobs,
  searchExcludeOf,
  searchExcludePrompt,
  searchExcludeRgConfig,
} from './search-exclude.ts'
import { ProjectInput } from './schema.ts'

test('旧项目没有这个字段时是未设置，实际生效的是内置默认清单', () => {
  const p = ProjectInput.parse({ name: '旧项目' })
  assert.equal(p.searchExclude, undefined)
  assert.deepEqual(searchExcludeOf(p), DEFAULT_SEARCH_EXCLUDE)
  assert.deepEqual(searchExcludeOf(undefined), DEFAULT_SEARCH_EXCLUDE)
})

test('项目的值和内置默认合并：项目值在前，去重、去掉尾部斜杠和空项', () => {
  const list = searchExcludeOf({ searchExclude: ['Saved/', ' Intermediate ', '', '/', 'node_modules', 'Saved'] })
  assert.deepEqual(list.slice(0, 3), ['Saved', 'Intermediate', 'node_modules'])
  // 和内置默认重复的不再出现第二遍，内置默认一项不少
  assert.equal(list.filter((d) => d === 'node_modules').length, 1)
  assert.deepEqual(
    DEFAULT_SEARCH_EXCLUDE.filter((d) => !list.includes(d)),
    [],
  )
})

test('UE 预设接在内置默认前面也能一起生效，大小写不同的目录各留一项', () => {
  const list = searchExcludeOf({ searchExclude: [...UE_SEARCH_EXCLUDE] })
  for (const d of [...UE_SEARCH_EXCLUDE, ...DEFAULT_SEARCH_EXCLUDE]) assert.ok(list.includes(d), d)
  // `Build`（UE 平台产物）和 `build`（前端产物）在 Linux 上是两个目录，合并成一个会漏掉一个
  assert.ok(list.includes('Build') && list.includes('build'))
})

test('提示词里是一行逗号分隔的清单，rg 例子能直接照抄', () => {
  assert.equal(searchExcludePrompt(undefined), `搜索时排除：${DEFAULT_SEARCH_EXCLUDE.join(', ')}`)
  const prompt = searchExcludePrompt({ searchExclude: ['Saved', 'Intermediate'] })
  assert.ok(prompt.startsWith('搜索时排除：Saved, Intermediate, '), prompt)
  assert.ok(!prompt.includes('\n'), '提示词里只占一行')
  // 末尾带斜杠：rg 按 .gitignore 语义只排除目录，叫 build 的脚本文件不受影响
  assert.equal(
    searchExcludeGlobs({ searchExclude: ['Saved'] }),
    [`-g '!Saved/'`, ...DEFAULT_SEARCH_EXCLUDE.map((d) => `-g '!${d}/'`)].join(' '),
  )
})

test('Git 仓库只给项目自己填的目录：内置默认已经靠 .gitignore 跳过，再列只会误伤叫 build 的源码目录', () => {
  assert.equal(searchExcludeGlobs({ searchExclude: ['Saved', 'node_modules'] }, { onlyProject: true }), `-g '!Saved/'`)
  assert.equal(searchExcludeGlobs(undefined, { onlyProject: true }), '')
})

test('find 的剪枝表达式只剪目录、用整份清单（find 不读 .gitignore）', () => {
  const prune = searchExcludeFindPrune({ searchExclude: ['Saved'] })
  assert.ok(prune.startsWith(`\\( -type d \\( -name 'Saved' -o `), prune)
  assert.ok(prune.endsWith(`\\) \\) -prune -o`), prune)
  for (const d of DEFAULT_SEARCH_EXCLUDE) assert.ok(prune.includes(`-name '${d}'`), d)
})

test('搜索排除配置能存进项目并读回来（序列化往返）', () => {
  const input = { name: '项目', searchExclude: ['Saved', 'Intermediate', 'DerivedDataCache'] }
  const saved = ProjectInput.parse(input)
  assert.deepEqual(saved.searchExclude, input.searchExclude)
  const reread = ProjectInput.parse(JSON.parse(JSON.stringify(saved)))
  assert.deepEqual(reread.searchExclude, input.searchExclude)
})

test('rg 配置：只排除目录；Git 仓库里只给项目自己填的', () => {
  const p = { searchExclude: ['Saved', 'Intermediate/'] }
  const all = searchExcludeRgConfig(p)
  assert.deepEqual(all.slice(0, 2), ['--glob=!Saved/', '--glob=!Intermediate/'])
  assert.ok(all.includes('--glob=!node_modules/'))
  assert.deepEqual(searchExcludeRgConfig(p, { onlyProject: true }), ['--glob=!Saved/', '--glob=!Intermediate/'])
  assert.deepEqual(searchExcludeRgConfig({}, { onlyProject: true }), [])
})
