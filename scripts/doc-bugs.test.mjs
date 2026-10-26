// scripts/lib/doc-bugs.mjs 的测试：bugs.md 由 bugs/*.md 的元数据生成，脚本和生成物必须一致
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  checkBugIndex,
  checkBugIndexesInRoot,
  bugIndexFile,
  bugTable,
  parseBugDoc,
  syncBugIndexesInRoot,
} from './lib/doc-bugs.mjs'

const bugDoc = ({
  title = '侧栏行有一圈虚线边框',
  status = '已修复（`npm run lint` 通过）',
  symptom = '侧栏普通对话行四周有一圈虚线边框',
  entry = '`web/src/components/layout/SidebarTasks.tsx` 的 `TaskRow`',
  rootType = '保活状态被画成整行边框',
  keywords = '侧栏、虚线边框、TaskRow',
  module = '`web`（`web/src/components/layout/SidebarTasks.tsx` 的 `TaskRow`）',
} = {}) =>
  [
    `# ${title}`,
    '',
    `- 状态：${status}`,
    `- 症状：${symptom}`,
    `- 入口：${entry}`,
    `- 根因类型：${rootType}`,
    `- 模块：${module}`,
    `- 关键词：${keywords}`,
    '',
    '## 现象',
    '',
    '正文里出现 `- 状态：不是元数据` 也不算。',
    '',
  ].join('\n')

const moduleOf = (docs) => ({ module: 'web', docs })

test('解析详情文件的元数据头，正文里的同名字段不算', () => {
  const bug = parseBugDoc(bugDoc(), 'sidebar-chat-row-dashed')
  assert.equal(bug.title, '侧栏行有一圈虚线边框')
  assert.equal(bug.status, '已修复（`npm run lint` 通过）')
  assert.equal(bug.symptom, '侧栏普通对话行四周有一圈虚线边框')
  assert.equal(bug.entry, '`web/src/components/layout/SidebarTasks.tsx` 的 `TaskRow`')
  assert.equal(bug.rootType, '保活状态被画成整行边框')
  assert.equal(bug.keywords, '侧栏、虚线边框、TaskRow')
  assert.deepEqual(bug.problems, [])
})

test('字段顺序变了照样解析', () => {
  const text = [
    '# 标题',
    '',
    '- 关键词：甲、乙',
    '- 根因类型：判定逻辑',
    '- 入口：`a.ts`',
    '- 症状：表现',
    '- 状态：已修复',
    '',
  ].join('\n')
  const bug = parseBugDoc(text, 'x')
  assert.deepEqual(
    [bug.keywords, bug.rootType, bug.entry, bug.symptom, bug.status],
    ['甲、乙', '判定逻辑', '`a.ts`', '表现', '已修复'],
  )
  assert.deepEqual(bug.problems, [])
})

test('症状缺字段时回落到标题，其余关键字段缺了要报出来', () => {
  const noSymptom = parseBugDoc(bugDoc().replace(/- 症状：.*\n/, ''), 'x')
  assert.equal(noSymptom.symptom, '侧栏行有一圈虚线边框')
  assert.deepEqual(noSymptom.problems, [])

  const missing = parseBugDoc(['# 标题', '', '- 状态：已修复', '- 关键词：甲'].join('\n'), 'x')
  assert.equal(missing.problems.length, 2)
  assert.match(missing.problems[0], /入口/)
  assert.match(missing.problems[1], /根因类型/)
})

test('状态带补充说明时整段保留，不截断', () => {
  const status = '已修复（交互语义后来按用户要求改成「点项目名进主页、只有箭头折叠」，见 design-project-home）'
  assert.equal(parseBugDoc(bugDoc({ status }), 'x').status, status)
})

test('一条详情文件生成一行，文档列指向 bugs/<id>.md', () => {
  const file = bugIndexFile('web', [
    { id: 'b-bug', ...parseBugDoc(bugDoc({ symptom: '乙症状' }), 'b-bug') },
    { id: 'a-bug', ...parseBugDoc(bugDoc({ symptom: '甲症状' }), 'a-bug') },
  ])
  const rows = file.split('\n').filter((l) => /^\| (a|b)-bug/.test(l))
  assert.equal(rows.length, 2)
  // 按 ID 字母序，不按传入顺序
  assert.match(rows[0], /a-bug/)
  assert.match(rows[1], /b-bug/)
  assert.match(rows[0], /\[详情\]\(bugs\/a-bug\.md\)/)
  assert.match(file, /不要手工编辑/)
})

test('表格里的竖线转义，不破坏列数', () => {
  const file = bugIndexFile('web', [{ id: 'x', ...parseBugDoc(bugDoc({ symptom: '甲 | 乙' }), 'x') }])
  const row = file.split('\n').find((l) => l.startsWith('| x '))
  assert.match(row, /甲 \\\| 乙/)
})

test('同样的详情文件重复生成结果完全一致（顺序稳定、幂等）', () => {
  const docs = [
    { id: 'b', text: bugDoc() },
    { id: 'a', text: bugDoc() },
  ]
  const once = bugIndexFile(
    'web',
    docs.map((d) => ({ id: d.id, ...parseBugDoc(d.text, d.id) })),
  )
  const twice = bugIndexFile(
    'web',
    docs.map((d) => ({ id: d.id, ...parseBugDoc(d.text, d.id) })),
  )
  assert.equal(once, twice)
  assert.equal(bugTable([]), '')
})

test('索引和详情文件一致时不报错', () => {
  const docs = [{ id: 'x', text: bugDoc() }]
  const indexText = bugIndexFile(
    'web',
    docs.map((d) => ({ id: d.id, ...parseBugDoc(d.text, d.id) })),
  )
  assert.deepEqual(checkBugIndex({ ...moduleOf(docs), indexText }), [])
})

test('手改索引导致不一致时报错并列出差在哪', () => {
  const docs = [{ id: 'x', text: bugDoc() }]
  const indexText = bugIndexFile(
    'web',
    docs.map((d) => ({ id: d.id, ...parseBugDoc(d.text, d.id) })),
  ).replace('侧栏普通对话行四周有一圈虚线边框', '手改过的症状')
  const errors = checkBugIndex({ ...moduleOf(docs), indexText })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /docs\/modules\/web\/bugs\.md/)
  assert.match(errors[0], /内容不一致 x/)
  assert.match(errors[0], /node scripts\/doc-bugs\.mjs/)
})

test('索引里多出一行、缺一行都指出来', () => {
  const docs = [{ id: 'x', text: bugDoc() }]
  const indexText = bugIndexFile(
    'web',
    docs.map((d) => ({ id: d.id, ...parseBugDoc(d.text, d.id) })),
  )
  const extra = checkBugIndex({ ...moduleOf(docs), indexText: `${indexText}| ghost | 手工加的一行 | | | | | |\n` })
  assert.equal(extra.length, 1)
  assert.match(extra[0], /多出 ghost/)

  const missing = checkBugIndex({ ...moduleOf(docs), indexText: '' })
  assert.equal(missing.length, 1)
  assert.match(missing[0], /bugs\.md 不存在/)
})

test('详情文件缺字段时报错，指出该补哪个字段', () => {
  const docs = [{ id: 'x', text: bugDoc().replace(/- 根因类型：.*\n/, '') }]
  const errors = checkBugIndex({ ...moduleOf(docs), indexText: null })
  assert.ok(errors.some((e) => e.includes('docs/modules/web/bugs/x.md') && e.includes('根因类型')))
})

test('没有 bugs/ 目录的模块不检查也不建空文件', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-bugs-empty-'))
  mkdirSync(path.join(root, 'docs/modules/web'), { recursive: true })
  assert.deepEqual(checkBugIndexesInRoot(root), [])
  assert.deepEqual(syncBugIndexesInRoot(root), [])
})

test('bugs/ 目录建了但还没有详情文件时不算错，也不建空 bugs.md', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-bugs-blank-'))
  const bugsDir = path.join(root, 'docs/modules/web/bugs')
  mkdirSync(bugsDir, { recursive: true })
  // 只有非 md 的附属文件（例如放截图的子目录、临时笔记）时同样按空处理
  writeFileSync(path.join(bugsDir, 'notes.txt'), '不是详情文件')
  assert.deepEqual(checkBugIndexesInRoot(root), [])
  assert.deepEqual(syncBugIndexesInRoot(root), [])
  assert.deepEqual(existsSync(path.join(root, 'docs/modules/web/bugs.md')), false)
})

test('重写索引后缺必填字段仍然报得出来（CLI 默认模式就是「先重写再判定」）', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-bugs-missing-'))
  const bugsDir = path.join(root, 'docs/modules/web/bugs')
  mkdirSync(bugsDir, { recursive: true })
  // 缺入口、根因类型：重写会把索引补出来，但这两列本身取不到值，不能静默当成功
  writeFileSync(path.join(bugsDir, 'x.md'), ['# 标题', '', '- 状态：已修复', '- 关键词：甲'].join('\n'))
  assert.deepEqual(syncBugIndexesInRoot(root), ['web'])
  const errors = checkBugIndexesInRoot(root)
  assert.equal(errors.length, 2)
  assert.ok(errors.some((e) => e.includes('入口')))
  assert.ok(errors.some((e) => e.includes('根因类型')))
})

test('在真实目录上跑：同步后通过，改详情文件后不再通过', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'doc-bugs-'))
  const bugsDir = path.join(root, 'docs/modules/web/bugs')
  mkdirSync(bugsDir, { recursive: true })
  const file = path.join(bugsDir, 'sidebar-chat-row-dashed.md')
  writeFileSync(file, bugDoc())

  const before = checkBugIndexesInRoot(root)
  assert.equal(before.length, 1)
  assert.match(before[0], /bugs\.md 不存在/)

  assert.deepEqual(syncBugIndexesInRoot(root), ['web'])
  assert.deepEqual(checkBugIndexesInRoot(root), [])
  // 内容没变时再同步不算改动：重复跑不产生 diff
  assert.deepEqual(syncBugIndexesInRoot(root), [])

  const index = readFileSync(path.join(root, 'docs/modules/web/bugs.md'), 'utf8')
  assert.ok(index.startsWith('# web · Bug 索引'))
  assert.ok(!index.includes('\r'))

  writeFileSync(file, bugDoc({ symptom: '改过的症状' }))
  const after = checkBugIndexesInRoot(root)
  assert.equal(after.length, 1)
  assert.deepEqual(syncBugIndexesInRoot(root), ['web'])
  assert.deepEqual(checkBugIndexesInRoot(root), [])
})
