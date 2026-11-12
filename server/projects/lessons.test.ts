/**
 * 项目教训存进项目文档目录的 lessons/，一条一个文件：路径规则、Markdown 往返、新旧合并（旧 lessons.md、旧 JSON）、
 * 格式不对的文件不覆盖、并发写入不丢条、删掉旧 JSON 条目后不复活；P4 / SVN 放各分支共用的文档根。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 数据目录换成临时的：P4 / SVN 项目的教训位置要用文档组记录（server/doc-group.ts），不能碰真正的 ~/.agent-panel
process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'panel-lessons-data-'))

const { DOC_PLACE_INSIDE } = await import('../../shared/doc-root.ts')
const { setLang } = await import('../../shared/i18n.ts')
const { AgentInput, Project, ProjectInput, ProjectLesson } = await import('../../shared/schema.ts')
const { projectLessons } = await import('../lessons.ts')
const {
  loadProjectLessons,
  mergeProjectLessons,
  parseProjectLessons,
  projectLessonsDir,
  renderProjectLesson,
  renderProjectLessons,
  saveProjectLessons,
} = await import('./lessons.ts')
type Agent = import('../../shared/schema.ts').Agent
type LessonReviewItem = import('../../shared/lesson-review.ts').LessonReviewItem

setLang('zh')

const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'panel-lessons-'))
  // 有 .git 就按 Git 项目算，不去探测 P4（探测要起进程，测试里不需要）
  mkdirSync(path.join(dir, '.git'))
  return dir
}

/** 教训目录里所有教训文件的内容（按文件名），断言「写没写进去」用 */
const dirText = (dir: string) => {
  const d = path.join(dir, 'docs', 'lessons')
  if (!existsSync(d)) return ''
  return readdirSync(d)
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .sort()
    .map((n) => readFileSync(path.join(d, n), 'utf8'))
    .join('\n')
}

const project = (dir: string, extra: Partial<import('../../shared/schema.ts').Project> = {}) =>
  Project.parse({ id: 'p1', name: '项目', path: dir, createdAt: '', updatedAt: '', ...extra })

const lesson = (id: string, title: string, extra: Partial<import('../../shared/schema.ts').ProjectLesson> = {}) =>
  ProjectLesson.parse({ id, title, rule: `${title}的规则`, ...extra })

const docsAgent = (): Agent => ({
  ...AgentInput.parse({ name: '文档', origin: 'builtin:docsync' }),
  id: 'docs-1',
  createdAt: '',
  updatedAt: '',
})

test('路径：Git 项目放 <项目>/docs/lessons/，没有目录时返回 undefined', async () => {
  const dir = temp()
  try {
    const p = project(dir)
    assert.equal(await projectLessonsDir(p, []), path.join(dir, 'docs', 'lessons'))
    // 没有路径的项目没有文件可写，返回 undefined 由调用方回退旧 JSON
    assert.equal(await projectLessonsDir(project(''), []), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有教训、目录也还没有时不建目录：保存项目设置不在用户仓库里留一个空的 lessons/', async () => {
  const dir = temp()
  try {
    const p = project(dir)
    const r = await saveProjectLessons(p, [], [])
    assert.equal(r.ok, true)
    assert.equal(existsSync(path.join(dir, 'docs', 'lessons')), false)
    // 有教训照常写：一条一个文件
    await saveProjectLessons(p, [], [lesson('l1', '新的')])
    assert.equal(existsSync(path.join(dir, 'docs', 'lessons', 'l1.md')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('路径：P4 固定在各分支共用的文档根（第一次是上一级的 ProjectDoc/docs），选「项目内 docs」也不变', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'panel-lessons-p4-'))
  const dir = path.join(root, 'game')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'p4config.txt'), '')
  try {
    const agent = docsAgent()
    const p = project(dir, { agentParams: { [agent.id]: { docRoot: DOC_PLACE_INSIDE } } })
    assert.equal(await projectLessonsDir(p, [agent]), path.join(root, 'ProjectDoc', 'docs', 'lessons'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('路径：SVN 按文档根，默认项目外层，旧设置选了项目内时跟着变', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'panel-lessons-svn-'))
  const dir = path.join(root, 'game')
  mkdirSync(path.join(dir, '.svn'), { recursive: true })
  try {
    const agent = docsAgent()
    assert.equal(await projectLessonsDir(project(dir), [agent]), path.join(root, 'ProjectDoc', 'docs', 'lessons'))
    const inside = project(dir, { agentParams: { [agent.id]: { docRoot: DOC_PLACE_INSIDE } } })
    assert.equal(await projectLessonsDir(inside, [agent]), path.join(dir, 'docs', 'lessons'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Markdown 写出去再读回来，所有字段都不丢', () => {
  const list = [
    lesson('l1', '同一指标只保留一处口径', {
      rule: '第一行\n\n第二行，带 `代码` 和 - 列表',
      cause: '用户指出用量页同一个数字出现两处口径',
      paths: ['web/src/components/usage/**', 'shared/pricing.ts'],
      tags: ['测试', '界面'],
      enabled: false,
      source: 'agent',
      taskId: 't1',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      history: [
        {
          title: '旧标题',
          rule: '旧规则\n第二行',
          why: '用户要求改口径',
          at: '2026-11-01T00:00:00.000Z',
        },
      ],
    }),
    lesson('l2', '不带任何可选字段的'),
  ]
  const parsed = parseProjectLessons(renderProjectLessons(list))
  assert.equal(parsed.error, undefined)
  assert.deepEqual(parsed.lessons, list)
})

test('标记之外有手写内容时按解析失败处理：跳过这个文件，不覆盖、不删', async () => {
  const dir = temp()
  try {
    const p = project(dir)
    const file = path.join(dir, 'docs', 'lessons', 'hand.md')
    mkdirSync(path.dirname(file), { recursive: true })
    const hand = '# 我的教训\n\n手写的内容\n'
    writeFileSync(file, hand)
    const parsed = parseProjectLessons(hand)
    assert.match(parsed.error ?? '', /标记之外/)
    assert.match((await loadProjectLessons(p, [])).error ?? '', /hand\.md/)
    const saved = await saveProjectLessons(p, [], [lesson('l1', '新的')])
    assert.equal(saved.ok, true)
    assert.match(saved.error ?? '', /格式不对/)
    assert.equal(readFileSync(file, 'utf8'), hand)
    assert.equal(existsSync(path.join(dir, 'docs', 'lessons', 'l1.md')), true)
    // 面板自己生成的空文件（只有维护说明）能正常读成 0 条
    assert.deepEqual(parseProjectLessons(renderProjectLessons([])), { lessons: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('项目设置整份保存：队列内核对版本，旧快照不会覆盖 Agent 刚记的', async () => {
  const dir = temp()
  try {
    let tick = 0
    let p = project(dir, { updatedAt: 'v0' })
    const store = {
      get: async () => p,
      update: async (_id: string, input: import('../../shared/schema.ts').ProjectInput) => {
        tick++
        p = { ...p, ...input, updatedAt: `v${tick}` }
        return p
      },
    }
    const { record, replace } = projectLessons(store, { agents: { list: async () => [] } })
    const added = await record('p1', { title: 'Agent 刚记的' })
    assert.equal(added.ok, true)
    const before = dirText(dir)
    const snapshot = ProjectInput.parse({ name: '项目', path: dir, lessons: [lesson('x', '旧快照')] })
    const stale = await replace('p1', snapshot, 'v0')
    assert.equal(stale.ok, false)
    assert.equal(stale.status, 409)
    assert.equal(dirText(dir), before, '版本过期时不写文件')
    const fresh = await replace('p1', snapshot, p.updatedAt)
    assert.equal(fresh.ok, true)
    assert.deepEqual(
      fresh.project!.lessons.map((l) => l.title),
      ['旧快照'],
    )
    assert.doesNotMatch(dirText(dir), /Agent 刚记的/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('旧的 lessons.md 解析失败时不删它，把错误返回', async () => {
  const dir = temp()
  try {
    const p = project(dir)
    const file = path.join(dir, 'docs', 'lessons.md')
    mkdirSync(path.dirname(file), { recursive: true })
    const broken = '# 项目教训\n\n<!-- lesson -->\ntitle: |\n  坏的\n'
    writeFileSync(file, broken)
    const r = await saveProjectLessons(p, [], [lesson('l1', '新的')])
    assert.equal(r.ok, true)
    assert.equal(r.inFile, true)
    assert.match(r.error ?? '', /没有改动/)
    assert.equal(readFileSync(file, 'utf8'), broken)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('新旧合并：同 id 或同标题以文件为准，其余旧条目保留', () => {
  const file = [lesson('a', '同名规则', { rule: '文件里的新规则' }), lesson('c', '只有文件')]
  const json = [lesson('a', '同名规则', { rule: '旧规则' }), lesson('d', '同名规则'), lesson('e', '只有旧 JSON')]
  assert.deepEqual(
    mergeProjectLessons(file, json).map((l) => [l.id, l.rule]),
    [
      ['a', '文件里的新规则'],
      ['c', '只有文件的规则'],
      ['e', '只有旧 JSON的规则'],
    ],
  )
})

test('几个对话同时记：排队写文件，条目一条不丢，旧 JSON 同时被清空', async () => {
  const dir = temp()
  try {
    let p = project(dir)
    const store = {
      get: async () => p,
      update: async (_id: string, input: import('../../shared/schema.ts').ProjectInput) => {
        p = { ...p, ...input }
        return p
      },
    }
    const { record } = projectLessons(store, { agents: { list: async () => [] } })
    const rs = await Promise.all([
      record('p1', { title: '一' }),
      record('p1', { title: '二' }),
      record('p1', { title: '三' }),
    ])
    assert.ok(
      rs.every((r) => r.ok),
      JSON.stringify(rs),
    )
    // 一条一个文件：三条各在自己的文件里，谁也没盖掉谁
    assert.deepEqual((await loadProjectLessons(p, [])).lessons.map((l) => l.title).sort(), ['一', '三', '二'].sort())
    assert.equal(readdirSync(path.join(dir, 'docs', 'lessons')).filter((n) => n !== 'README.md').length, 3)
    assert.deepEqual(p.lessons, [], '新写入不再存项目 JSON')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('旧 JSON 里的条目删除后不会复活：先迁进文件，再删就真的没了', async () => {
  const dir = temp()
  try {
    let p = project(dir, { lessons: [lesson('old-a', '旧的 A'), lesson('old-b', '旧的 B')] })
    const store = {
      get: async () => p,
      update: async (_id: string, input: import('../../shared/schema.ts').ProjectInput) => {
        p = { ...p, ...input }
        return p
      },
    }
    const { record, review } = projectLessons(store, { agents: { list: async () => [] } })
    const added = await record('p1', { title: '新的 C' })
    assert.equal(added.ok, true)

    let loaded = await loadProjectLessons(p, [])
    assert.deepEqual(
      loaded.lessons.map((l) => l.id),
      ['old-a', 'old-b', added.project!.lessons.at(-1)!.id],
      '第一次写入把旧条目一起写进文件',
    )

    const item: LessonReviewItem = {
      id: 'old-a',
      action: 'delete',
      problems: [],
      why: '',
      title: '',
      rule: '',
      merge: [],
    }
    const removed = await review('p1', item)
    assert.equal(removed.ok, true)
    loaded = await loadProjectLessons(p, [])
    assert.deepEqual(
      loaded.lessons.map((l) => l.id),
      ['old-b', added.project!.lessons.at(-1)!.id],
      '删掉的旧条目不再从项目 JSON 冒出来',
    )
    assert.doesNotMatch(dirText(dir), /旧的 A/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('旧的整份 lessons.md：读的时候合进来，下一次保存拆成一条一个文件后删掉', async () => {
  const dir = temp()
  try {
    const p = project(dir)
    const legacy = path.join(dir, 'docs', 'lessons.md')
    mkdirSync(path.dirname(legacy), { recursive: true })
    writeFileSync(legacy, renderProjectLessons([lesson('a', '旧 A'), lesson('b', '旧 B')]))
    const loaded = await loadProjectLessons(p, [])
    assert.deepEqual(
      loaded.lessons.map((l) => l.id),
      ['a', 'b'],
    )
    await saveProjectLessons(p, [], [...loaded.lessons, lesson('c', '新 C')])
    assert.equal(existsSync(legacy), false)
    for (const id of ['a', 'b', 'c']) assert.equal(existsSync(path.join(dir, 'docs', 'lessons', `${id}.md`)), true)
    assert.match(readFileSync(path.join(dir, 'docs', 'lessons', 'README.md'), 'utf8'), /一条教训一个文件/)
    // 删掉一条：它的文件跟着删，别的不动
    await saveProjectLessons(p, [], [lesson('a', '旧 A'), lesson('c', '新 C')])
    assert.equal(existsSync(path.join(dir, 'docs', 'lessons', 'b.md')), false)
    assert.equal(existsSync(path.join(dir, 'docs', 'lessons', 'a.md')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同一条教训在两个文件里（合并分支时另存的）：取更新的那份，保存后旧副本删掉', async () => {
  const dir = temp()
  try {
    const p = project(dir)
    const d = path.join(dir, 'docs', 'lessons')
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, 'a.md'), renderProjectLesson(lesson('a', '老的', { updatedAt: '2026-11-01' })))
    writeFileSync(path.join(d, 'a.from-Dev.md'), renderProjectLesson(lesson('a', '新的', { updatedAt: '2026-11-04' })))
    const loaded = await loadProjectLessons(p, [])
    assert.deepEqual(
      loaded.lessons.map((l) => l.title),
      ['新的'],
    )
    await saveProjectLessons(p, [], loaded.lessons)
    assert.deepEqual(readdirSync(d).sort(), ['README.md', 'a.from-Dev.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P4 各分支共用教训：Main 记的教训在 Dev 分支也读得到', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'panel-lessons-branches-'))
  const main = path.join(root, 'Main', 'Game')
  const dev = path.join(root, 'Dev', 'Game')
  for (const d of [main, dev]) {
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, 'p4config.txt'), '')
  }
  try {
    await saveProjectLessons(project(main), [], [lesson('m1', 'Main 上记的')])
    assert.equal(await projectLessonsDir(project(dev), []), path.join(root, 'Main', 'ProjectDoc', 'docs', 'lessons'))
    assert.deepEqual(
      (await loadProjectLessons(project(dev), [])).lessons.map((l) => l.title),
      ['Main 上记的'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
