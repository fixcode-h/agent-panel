/**
 * 教训、经验的事件推送（一期）：命令、路径、报错、搜索的粗匹配和预算。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectLesson } from '../schema.ts'
import { ProjectExperience } from '../experience.ts'
import {
  PUSH_RULES,
  budgetHits,
  commandLessons,
  commandWords,
  errorLessons,
  errorPrint,
  lessonCommands,
  pathLessons,
  pushText,
  searchExperience,
  searchText,
  searchWords,
  wordsOf,
} from './push.ts'

const lesson = (o: Partial<ProjectLesson>) =>
  ProjectLesson.parse({ id: 'l1', title: 't', rule: '', createdAt: '', ...o })
const exp = (o: Partial<ProjectExperience>) =>
  ProjectExperience.parse({ id: 'e1', kind: 'locate', title: 't', keywords: [], createdAt: '', ...o })

test('检索词：驼峰、下划线拆开并保留整词，中文两字一组，停用词不算', () => {
  const w = wordsOf('UDropTable 掉落表 DT_ItemRow src')
  for (const x of ['udroptable', 'drop', 'table', '掉落', '落表', 'itemrow', 'item']) assert.ok(w.includes(x), x)
  assert.ok(!w.includes('src'))
  assert.deepEqual(searchWords('DT_\\w+Row'), wordsOf('DT Row'))
})

test('命令的「目的」：去掉环境变量、env -u、sudo、npx 前缀', () => {
  assert.deepEqual(commandWords('FOO=1 env -u ANTHROPIC_BASE_URL npm run test:e2e'), ['npm', 'run', 'test:e2e'])
  assert.deepEqual(commandWords('sudo npx tsx a.ts'), ['tsx', 'a.ts'])
  assert.deepEqual(commandWords('C:\\UE\\UnrealBuildTool.exe Game Win64'), ['unrealbuildtool', 'Game', 'Win64'])
})

test('教训里反引号写的命令：路径、单个通用程序名不算命令', () => {
  const l = lesson({
    rule: '沙箱里跑 `npm run test:e2e` 要先 `env -u ANTHROPIC_BASE_URL npm run test:e2e`；改 `shared/clis/pi.json`；别直接 `git`',
  })
  assert.deepEqual(lessonCommands(l), [['npm', 'run', 'test:e2e']])
})

test('跑命令前：按段比，cd 前缀、管道、多余参数不影响；无关的命令不推', () => {
  const ls = [lesson({ id: 'a', title: 'e2e 在 WSL 里跑', rule: '`npm run test:e2e` 放到 WSL 里跑' })]
  assert.equal(commandLessons(ls, 'cd proj && npm run test:e2e -- --failed 2>&1 | tail').length, 1)
  assert.equal(commandLessons(ls, 'npm run test:unit').length, 0)
  assert.equal(commandLessons(ls, 'npm run').length, 0)
  assert.equal(commandLessons([{ ...ls[0], enabled: false }], 'npm run test:e2e').length, 0)
})

test('改文件前：路径对上 paths 的推，没写 paths 的不在这里推', () => {
  const ls = [lesson({ id: 'a', paths: ['shared/clis/**'] }), lesson({ id: 'b' })]
  assert.deepEqual(
    pathLessons(ls, 'shared/clis/pi.json').map((h) => h.id),
    ['a'],
  )
  assert.equal(pathLessons(ls, 'web/src/App.tsx').length, 0)
})

test('报错特征：挑报错行，路径只留文件名，抽错误码，数字不算词', () => {
  const p = errorPrint(
    'ok line\n/home/u/proj/src/a.ts(12,3): error TS2589: Type instantiation is excessively deep and possibly infinite.\n',
  )
  assert.deepEqual(p.codes, ['TS2589'])
  assert.ok(p.words.includes('instantiation'))
  assert.ok(!p.words.some((w) => /\d/.test(w) && w.length < 3))
  assert.ok(!p.words.includes('home'), '绝对路径只留文件名')
})

test('报错后：错误码或足够多的词对上才推，泛泛的报错不推', () => {
  const ls = [
    lesson({
      id: 'zod',
      title: 'zod 深推断超限时拆开 schema',
      rule: '报 TS2589 Type instantiation is excessively deep 时，把大 schema 拆成几段再合并',
    }),
    lesson({ id: 'other', title: '注释用中文', rule: '写为什么' }),
  ]
  const out = 'src/a.ts(1,1): error TS2589: Type instantiation is excessively deep and possibly infinite.'
  assert.deepEqual(
    errorLessons(ls, out).map((h) => h.id),
    ['zod'],
  )
  assert.equal(errorLessons(ls, 'Error: something went wrong').length, 0)
  // 没有错误码时靠词：401 Unauthorized + ANTHROPIC_BASE_URL
  const env = lesson({
    id: 'env',
    title: '沙箱里跑 e2e 要去掉 ANTHROPIC_BASE_URL',
    rule: '否则 fake CLI 请求被代理拦下，报 401 Unauthorized invalid api key',
  })
  assert.equal(errorLessons([env], 'Error: 401 Unauthorized: invalid api key (ANTHROPIC_BASE_URL)').length, 1)
})

test('搜索：从搜索工具参数、搜索命令里取搜索词；不是搜索返回 null', () => {
  assert.equal(searchText('read', { pattern: 'DropTable', path: 'Source' }), 'DropTable')
  assert.equal(searchText('read', { file_path: 'a.ts' }), null)
  assert.equal(searchText('shell', { command: 'cd x && rg -n --type ts "UDropTable" Source' }), 'UDropTable')
  assert.equal(searchText('shell', { command: 'git grep -e LootTable' }), 'LootTable')
  assert.equal(searchText('shell', { command: 'find . -name "*Drop*.h"' }), '*Drop*.h')
  assert.equal(searchText('shell', { command: 'npm test' }), null)
})

test('搜索前：关键词整词对上就推经验，已经在经验位置里搜的不推', () => {
  const list = [
    exp({
      id: 'drop',
      title: '掉落表的代码和数据在哪',
      body: '代码在 Loot，数据在 DataTables/Drop',
      keywords: ['掉落表', 'UDropTable'],
      paths: ['Source/Game/Loot/**'],
    }),
    exp({ id: 'net', title: '网络同步', keywords: ['Replication'] }),
  ]
  assert.deepEqual(
    searchExperience(list, 'UDropTable').map((h) => h.id),
    ['drop'],
  )
  assert.match(searchExperience(list, 'UDropTable')[0].line, /位置：Source\/Game\/Loot/)
  assert.equal(searchExperience(list, 'UDropTable', 'Source/Game/Loot').length, 0)
  assert.equal(searchExperience(list, 'Table').length, 0, '只沾一个泛词不推')
})

test('预算：最多几条、合计字数有上限，第一条再长也给', () => {
  const hit = (i: number, n: number) => ({
    kind: 'lesson' as const,
    id: `l${i}`,
    title: '',
    why: 'command' as const,
    line: 'x'.repeat(n),
  })
  assert.equal(budgetHits([hit(1, 900)]).length, 1)
  assert.equal(budgetHits([hit(1, 500), hit(2, 200)]).length, 1)
  assert.equal(budgetHits([1, 2, 3, 4, 5].map((i) => hit(i, 10))).length, PUSH_RULES.maxItems)
  assert.match(pushText([hit(1, 10)], 'error', ''), /以前遇到过类似的报错/)
})
