/**
 * 项目教训：按文件命中、提示里的预算、同名去重、记录时排队不丢。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../shared/i18n.ts'
import { GlobalLesson, Project, ProjectLesson, type ProjectInput } from '../shared/schema.ts'
import {
  applyGlobalChanges,
  findLessons,
  globToRegExp,
  lessonMatches,
  lessonsPrompt,
  upsertLesson,
} from '../shared/lessons.ts'
import { resolveLessonChanges } from '../shared/assist.ts'
import { projectLessons } from './lessons.ts'

setLang('zh')

const lesson = (title: string, paths: string[] = [], extra: Partial<ProjectLesson> = {}) =>
  ProjectLesson.parse({ id: title, title, rule: `${title}的说明`, paths, ...extra })

test('glob：** 跨目录，* 不跨，目录名匹配目录下的文件', () => {
  assert.ok(globToRegExp('shared/clis/**').test('shared/clis/pi.json'))
  assert.ok(globToRegExp('server/**/*.test.ts').test('server/exec/a.test.ts'))
  assert.ok(!globToRegExp('server/*.ts').test('server/exec/a.ts'))
  assert.ok(globToRegExp('web/src').test('web/src/App.tsx'))
  assert.ok(!globToRegExp('web/src').test('web/srcx/App.tsx'))
})

test('没写 paths 的对所有改动生效，路径写法（./、反斜杠）不影响命中', () => {
  assert.ok(lessonMatches(lesson('全局'), ['任何文件']))
  const l = lesson('CLI', ['shared/clis/**'])
  assert.ok(lessonMatches(l, ['.\\shared\\clis\\pi.json']))
  assert.ok(!lessonMatches(l, ['web/src/App.tsx']))
})

test('project_lessons：按文件只给命中的全文，不传文件列标题，停用的不出现', () => {
  const ls = [
    lesson('价格用整数分'),
    lesson('支付方式写配置', ['src/payment/**']),
    lesson('停用的', ['src/payment/**'], { enabled: false }),
  ]
  const hit = findLessons(ls, ['src/payment/wechat.ts'])
  assert.match(hit, /### 支付方式写配置/)
  assert.match(hit, /### 价格用整数分/)
  assert.doesNotMatch(hit, /停用的/)
  assert.equal(findLessons([lesson('支付方式写配置', ['src/payment/**'])], ['README.md']), '这些文件没有相关的教训。')
  assert.match(findLessons(ls, []), /- 支付方式写配置（src\/payment\/\*\*）/)
})

test('提示：有工具时按文件的只给标题，没有工具时按预算给全文', () => {
  const ls = [lesson('全局规则'), lesson('按文件的规则', ['src/**'])]
  const withTools = lessonsPrompt(ls, true)
  assert.match(withTools, /### 全局规则/)
  assert.doesNotMatch(withTools, /### 按文件的规则/)
  assert.match(withTools, /- 按文件的规则（src\/\*\*）/)
  assert.match(withTools, /record_lesson/)
  const noTools = lessonsPrompt(ls, false)
  assert.match(noTools, /### 按文件的规则/)
  assert.doesNotMatch(noTools, /record_lesson/)
  // 没有教训：有工具时只提醒怎么记，没工具时不占提示
  assert.equal(lessonsPrompt([], false), '')
  assert.match(lessonsPrompt([], true), /record_lesson/)
})

test('提示有预算：条目再多也只给一部分全文，其余列标题', () => {
  const ls = Array.from({ length: 80 }, (_, i) => lesson(`规则 ${i}`, [], { rule: '很长的说明'.repeat(40) }))
  const p = lessonsPrompt(ls, true)
  assert.ok(p.length < 8000, `提示太长：${p.length}`)
  assert.match(p, /另有 \d+ 条/)
})

test('同名的规则更新原来那条，不重复堆积', () => {
  const a = lesson('CLI 能力写进配置')
  const r = upsertLesson([a], { ...lesson('CLI 能力 写进配置'), id: 'new', cause: '又犯了一次' })
  assert.equal(r.list.length, 1)
  assert.equal(r.list[0].id, a.id)
  assert.equal(r.list[0].cause, '又犯了一次')
  assert.equal(r.added, false)
})

test('几个对话同时记，排队写入不丢条目', async () => {
  let p = Project.parse({ id: 'p1', name: '项目', createdAt: '', updatedAt: '' })
  const store = {
    get: async () => p,
    update: async (_id: string, input: ProjectInput) => {
      // 模拟磁盘读写的延迟：没有排队时后写的会盖掉先写的
      await new Promise((r) => setTimeout(r, 5))
      p = { ...p, ...input }
      return p
    },
  }
  const { record } = projectLessons(store)
  const rs = await Promise.all([
    record('p1', { title: '一' }),
    record('p1', { title: '二' }),
    record('p1', { title: '三' }),
  ])
  assert.ok(rs.every((r) => r.ok))
  assert.deepEqual(
    p.lessons.map((l) => l.title),
    ['一', '二', '三'],
  )
  assert.ok(p.lessons.every((l) => l.id && l.createdAt))
  const bad = await record('p1', { title: '  ' })
  assert.equal(bad.ok, false)
})

test('面板工具：只有项目里的调用有 project_lessons / record_lesson，参数缺了会报错', async () => {
  const { orchTools, callOrchTool } = await import('./orch-mcp.ts')
  const base = { self: 'n1', common: [], hasMain: false } as unknown as Parameters<typeof orchTools>[0]
  assert.ok(!orchTools(base).some((x) => x.name === 'record_lesson'))
  const got: unknown[] = []
  const o = {
    ...base,
    lessons: {
      find: async (files: string[]) => `查了 ${files.join(',')}`,
      record: async (input: unknown) => {
        got.push(input)
        return { ok: true, info: '已记下' }
      },
    },
  } as unknown as Parameters<typeof orchTools>[0]
  const names = orchTools(o).map((x) => x.name)
  assert.ok(names.includes('project_lessons') && names.includes('record_lesson'))
  const found = await callOrchTool(o, 'project_lessons', { files: ['a.ts'] })
  assert.equal(found.content[0].text, '查了 a.ts')
  const empty = await callOrchTool(o, 'record_lesson', { title: ' ' })
  assert.equal(empty.isError, true)
  await callOrchTool(o, 'record_lesson', { title: '写进配置', rule: '说明', paths: ['src/**', ' '] })
  assert.deepEqual(got, [{ title: '写进配置', rule: '说明', cause: '', paths: ['src/**'] }])
})

test('冲突改写：带 replaces 改写那一条，旧版本留进 history，没给的字段沿用', () => {
  const a = lesson('不按名字判断支付方式', ['src/payment/**'], { cause: '加微信支付时返工' })
  const r = upsertLesson(
    [a],
    { ...lesson('活动规则也写进配置'), id: a.id },
    { replaces: a.id, why: '用户要求只给支付宝显示角标' },
  )
  assert.equal(r.list.length, 1)
  const x = r.list[0]
  assert.equal(x.id, a.id)
  assert.equal(x.title, '活动规则也写进配置')
  assert.deepEqual(x.paths, ['src/payment/**'], '没给范围时沿用原来的')
  assert.equal(x.cause, '加微信支付时返工')
  assert.equal(x.history.length, 1)
  assert.equal(x.history[0].title, '不按名字判断支付方式')
  assert.equal(x.history[0].why, '用户要求只给支付宝显示角标')
  assert.ok(x.updatedAt)
  assert.equal(upsertLesson([a], lesson('新的'), { replaces: '不存在' }).missing, true)
})

test('record：改写不存在的或全局的教训会报错并说明怎么做', async () => {
  let p = Project.parse({ id: 'p1', name: '项目', createdAt: '', updatedAt: '', lessons: [lesson('旧规则')] })
  const store = {
    get: async () => p,
    update: async (_id: string, input: ProjectInput) => (p = { ...p, ...input }),
  }
  const { record } = projectLessons(store)
  const g = await record('p1', { title: '改全局', replaces: 'gabc', why: '冲突' })
  assert.equal(g.ok, false)
  assert.match(g.info, /全局教训只有用户能改/)
  const miss = await record('p1', { title: '改', replaces: 'nope', why: '冲突' })
  assert.match(miss.info, /project_lessons/)
  const ok = await record('p1', { title: '新规则', replaces: '旧规则', why: '两全' })
  assert.ok(ok.ok)
  assert.match(ok.info, /已改写/)
  assert.equal(p.lessons.length, 1)
  assert.equal(p.lessons[0].history[0].title, '旧规则')
})

test('全局教训：排在项目教训后面并写明优先级，project_lessons 也查得到', () => {
  const g = GlobalLesson.parse({ id: 'g1', title: '等待用后台命令', rule: '不用会立刻退出的脚本' })
  const p = lessonsPrompt([lesson('价格用整数分')], true, [g])
  assert.match(p, /用户这次的要求 > 项目教训 > 全局教训/)
  assert.ok(p.indexOf('价格用整数分') < p.indexOf('等待用后台命令'), '全局的排在后面')
  assert.match(p, /### 价格用整数分（id: 价格用整数分）/, '有工具时带 id，方便改写')
  assert.match(lessonsPrompt([], false, [g]), /等待用后台命令/, '没有项目教训时也带全局的')
  const found = findLessons([], ['a.ts'], [g])
  assert.match(found, /全局教训/)
  assert.match(found, /### 等待用后台命令/)
  assert.doesNotMatch(lessonsPrompt([], true, [{ ...g, enabled: false }]), /等待用后台命令/)
})

test('提取全局教训：update 要指向现有的那条，确认后按改动写入', () => {
  const g = GlobalLesson.parse({ id: 'g1', title: '旧的全局', from: ['甲'] })
  assert.match(
    resolveLessonChanges({ changes: [{ op: 'update', id: 'gx', title: 'x' }] }, [g]).error ?? '',
    /不是现有全局教训/,
  )
  const r = resolveLessonChanges(
    {
      changes: [
        { op: 'add', id: 'whatever', title: '新的全局', rule: '说明', sources: ['l1'] },
        { op: 'update', id: 'g1', title: '合并后的全局' },
      ],
    },
    [g],
  )
  assert.ok(r.changes)
  assert.equal(r.changes![0].id, '', 'add 的 id 不用 AI 给的')
  const out = applyGlobalChanges([g], r.changes!, '乙')
  assert.equal(out.length, 2)
  assert.equal(out[0].title, '合并后的全局')
  assert.deepEqual(out[0].from, ['甲', '乙'])
  assert.ok(out[1].id.startsWith('g'))
  assert.deepEqual(out[1].from, ['乙'])
})

test('面板工具：record_lesson 带 id 改写时必须写 change', async () => {
  const { callOrchTool } = await import('./orch-mcp.ts')
  const got: unknown[] = []
  const o = {
    self: 'n1',
    common: [],
    hasMain: false,
    lessons: {
      find: async () => '',
      record: async (input: unknown) => {
        got.push(input)
        return { ok: true, info: '已改写' }
      },
    },
  } as unknown as Parameters<typeof callOrchTool>[0]
  const noWhy = await callOrchTool(o, 'record_lesson', { title: '新规则', id: 'l1' })
  assert.equal(noWhy.isError, true)
  await callOrchTool(o, 'record_lesson', { title: '新规则', id: 'l1', change: '两全' })
  assert.deepEqual(got, [{ title: '新规则', rule: '', cause: '', paths: [], replaces: 'l1', why: '两全' }])
})
