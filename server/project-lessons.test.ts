/**
 * 项目教训改存项目文档目录的 lessons.md：路径规则、Markdown 往返、新旧合并、
 * 解析失败不覆盖、并发写入不丢条、删掉旧 JSON 条目后不复活。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DOC_PLACE_INSIDE } from '../shared/doc-root.ts'
import { setLang } from '../shared/i18n.ts'
import type { LessonReviewItem } from '../shared/lesson-review.ts'
import { AgentInput, Project, ProjectInput, ProjectLesson, type Agent } from '../shared/schema.ts'
import { projectLessons } from './lessons.ts'
import {
  loadProjectLessons,
  mergeProjectLessons,
  parseProjectLessons,
  projectLessonsFile,
  renderProjectLessons,
  saveProjectLessons,
} from './project-lessons.ts'

setLang('zh')

const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'panel-lessons-'))
  // 有 .git 就按 Git 项目算，不去探测 P4（探测要起进程，测试里不需要）
  mkdirSync(path.join(dir, '.git'))
  return dir
}

const project = (dir: string, extra: Partial<Project> = {}) =>
  Project.parse({ id: 'p1', name: '项目', path: dir, createdAt: '', updatedAt: '', ...extra })

const lesson = (id: string, title: string, extra: Partial<ProjectLesson> = {}) =>
  ProjectLesson.parse({ id, title, rule: `${title}的规则`, ...extra })

const docsAgent = (): Agent => ({
  ...AgentInput.parse({ name: '文档', origin: 'builtin:docsync' }),
  id: 'docs-1',
  createdAt: '',
  updatedAt: '',
})

test('路径：Git 项目放 <项目>/docs/lessons.md，没有目录时返回 undefined', async () => {
  const dir = temp()
  try {
    const p = project(dir)
    assert.equal(await projectLessonsFile(p, []), path.join(dir, 'docs', 'lessons.md'))
    // 没有路径的项目没有文件可写，返回 undefined 由调用方回退旧 JSON
    assert.equal(await projectLessonsFile(project(''), []), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('路径：P4 固定在上一级的 ProjectDoc/docs，选「项目内 docs」也不变', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'panel-lessons-p4-'))
  const dir = path.join(root, 'game')
  mkdirSync(dir)
  writeFileSync(path.join(dir, 'p4config.txt'), '')
  try {
    const agent = docsAgent()
    const p = project(dir, { agentParams: { [agent.id]: { docRoot: DOC_PLACE_INSIDE } } })
    assert.equal(await projectLessonsFile(p, [agent]), path.join(root, 'ProjectDoc', 'docs', 'lessons.md'))
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
    assert.equal(await projectLessonsFile(project(dir), [agent]), path.join(root, 'ProjectDoc', 'docs', 'lessons.md'))
    const inside = project(dir, { agentParams: { [agent.id]: { docRoot: DOC_PLACE_INSIDE } } })
    assert.equal(await projectLessonsFile(inside, [agent]), path.join(dir, 'docs', 'lessons.md'))
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

test('标记之外有手写内容时按解析失败处理，不覆盖原文件', async () => {
  const dir = temp()
  try {
    const p = project(dir)
    const file = path.join(dir, 'docs', 'lessons.md')
    mkdirSync(path.dirname(file), { recursive: true })
    const hand = '# 我的教训\n\n手写的内容\n'
    writeFileSync(file, hand)
    const parsed = parseProjectLessons(hand)
    assert.match(parsed.error ?? '', /标记之外/)
    const saved = await saveProjectLessons(p, [], [lesson('l1', '新的')])
    assert.equal(saved.ok, false)
    assert.equal(readFileSync(file, 'utf8'), hand)
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
      update: async (_id: string, input: ProjectInput) => {
        tick++
        p = { ...p, ...input, updatedAt: `v${tick}` }
        return p
      },
    }
    const { record, replace } = projectLessons(store, { agents: { list: async () => [] } })
    const added = await record('p1', { title: 'Agent 刚记的' })
    assert.equal(added.ok, true)
    const file = path.join(dir, 'docs', 'lessons.md')
    const before = readFileSync(file, 'utf8')
    const snapshot = ProjectInput.parse({ name: '项目', path: dir, lessons: [lesson('x', '旧快照')] })
    const stale = await replace('p1', snapshot, 'v0')
    assert.equal(stale.ok, false)
    assert.equal(stale.status, 409)
    assert.equal(readFileSync(file, 'utf8'), before, '版本过期时不写文件')
    const fresh = await replace('p1', snapshot, p.updatedAt)
    assert.equal(fresh.ok, true)
    assert.deepEqual(
      fresh.project!.lessons.map((l) => l.title),
      ['旧快照'],
    )
    assert.doesNotMatch(readFileSync(file, 'utf8'), /Agent 刚记的/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('解析失败时不覆盖原文件，把错误返回', async () => {
  const dir = temp()
  try {
    const p = project(dir)
    const file = path.join(dir, 'docs', 'lessons.md')
    mkdirSync(path.dirname(file), { recursive: true })
    const broken = '# 项目教训\n\n<!-- lesson -->\ntitle: |\n  坏的\n'
    writeFileSync(file, broken)
    const r = await saveProjectLessons(p, [], [lesson('l1', '新的')])
    assert.equal(r.ok, false)
    assert.equal(r.inFile, true)
    assert.match(r.error ?? '', /没有覆盖/)
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
      update: async (_id: string, input: ProjectInput) => {
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
    const parsed = parseProjectLessons(readFileSync(path.join(dir, 'docs', 'lessons.md'), 'utf8'))
    assert.deepEqual(
      parsed.lessons.map((l) => l.title),
      ['一', '二', '三'],
    )
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
      update: async (_id: string, input: ProjectInput) => {
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
    assert.doesNotMatch(readFileSync(path.join(dir, 'docs', 'lessons.md'), 'utf8'), /旧的 A/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
