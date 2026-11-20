import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 迁移在临时数据目录里跑，别碰本机的
const root = mkdtempSync(path.join(tmpdir(), 'agent-panel-migrations-'))
process.env.AGENT_PANEL_DATA = path.join(root, 'default')

const { runMigrations, readDataVersion, DATA_VERSION, MIGRATIONS } = await import('./index.ts')
/** 只跑到某个版本：后面的迁移（如 0013 给项目写上 knowledgeInRepo）会改同一份文件，挡住前面迁移「不动」的断言 */
const upTo = (v: number) => MIGRATIONS.filter((m) => m.version <= v)
const { parseMessagesJsonl } = await import('../tasks/messages-file.ts')

let n = 0
const freshDir = () => {
  const d = path.join(root, `d${n++}`)
  mkdirSync(d, { recursive: true })
  return d
}
const write = (file: string, data: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), 'utf8')
}
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
const quiet = () => {}

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: '',
  title: id,
  mode: 'chat',
  status: 'done',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
})
const message = (id: string, role: 'user' | 'agent', text: string) => ({ id, role, text, tools: [], at: '' })

test('新装的空目录：什么都不改，版本号直接记到最新', async () => {
  const d = freshDir()
  const res = await runMigrations({ dataDir: d, log: quiet })
  assert.equal(res.from, 0)
  assert.equal(res.to, DATA_VERSION)
  assert.equal((await readDataVersion(d)).version, DATA_VERSION)
  assert.ok(!existsSync(path.join(d, 'tasks')), '没建出多余的目录')
})

test('0001：tasks.json 和 items/ 两代旧布局拆成按项目分目录，对话写成 JSONL，原文件进备份', async () => {
  const d = freshDir()
  write(path.join(d, 'tasks', 'tasks.json'), [
    task('legacy-1', {
      projectId: 'p1',
      turnDoneAt: '2026-10-01T01:00:00.000Z',
      messages: [message('u1', 'user', '旧的要求'), message('a1', 'agent', '旧的回答')],
    }),
  ])
  write(
    path.join(d, 'tasks', 'items', 'legacy-2.json'),
    task('legacy-2', { messages: [message('u2', 'user', '旧的聊天')] }),
  )
  await runMigrations({ dataDir: d, log: quiet })
  const meta = json(path.join(d, 'tasks', 'projects', 'p1', 'legacy-1.json'))
  assert.deepEqual(
    meta.messages.map((m: { id: string }) => m.id),
    ['u1'],
    '任务记录里只放用户消息',
  )
  assert.equal(meta.turnSeenAt, '2026-10-01T01:00:00.000Z', '没有 turnSeenAt 的旧记录当作看过')
  const conv = parseMessagesJsonl(
    readFileSync(path.join(d, 'tasks', 'projects', 'p1', 'legacy-1.messages.jsonl'), 'utf8'),
  )
  assert.deepEqual(
    conv.messages.map((m) => m.id),
    ['u1', 'a1'],
  )
  assert.ok(existsSync(path.join(d, 'tasks', 'chats', 'legacy-2.json')))
  assert.ok(!existsSync(path.join(d, 'tasks', 'tasks.json')))
  assert.ok(!existsSync(path.join(d, 'tasks', 'items')), 'items 目录转换后删掉')
  assert.ok(existsSync(path.join(d, 'backup', '0001-task-layout', 'tasks', 'tasks.json')), '原文件在备份目录')
  assert.ok(existsSync(path.join(d, 'backup', '0001-task-layout', 'tasks', 'items', 'legacy-2.json')))
})

test('0002：删掉旧的运行时字段、补 turnSeenAt，别的字段原样；没要改的文件不碰', async () => {
  const d = freshDir()
  const dirty = path.join(d, 'tasks', 'chats', 'dirty.json')
  const clean = path.join(d, 'tasks', 'chats', 'clean.json')
  write(
    dirty,
    task('dirty', { turnDoneAt: 'T', cliAlive: true, jobs: [], childrenNeeds: 2, askedAt: 'x', note: '留着' }),
  )
  write(clean, task('clean', { turnSeenAt: '' }))
  const cleanBefore = readFileSync(clean, 'utf8')
  await runMigrations({ dataDir: d, log: quiet })
  const got = json(dirty)
  for (const k of ['cliAlive', 'jobs', 'childrenNeeds', 'askedAt']) assert.ok(!(k in got), `${k} 删掉了`)
  assert.equal(got.note, '留着', '不认识的字段也原样留着')
  assert.equal(got.turnSeenAt, 'T')
  assert.equal(readFileSync(clean, 'utf8'), cleanBefore, '不用改的文件一个字节都没动')
  assert.equal(
    json(path.join(d, 'backup', '0002-task-meta-cleanup', 'tasks', 'chats', 'dirty.json')).cliAlive,
    true,
    '改之前的原样备份',
  )
})

test('0003：.messages.json 转成 JSONL，原文件挪进备份；读不懂的原样留着', async () => {
  const d = freshDir()
  const dir = path.join(d, 'tasks', 'projects', 'p')
  write(path.join(dir, 't.json'), task('t', { projectId: 'p', turnSeenAt: '' }))
  write(path.join(dir, 't.messages.json'), [message('u', 'user', '要求'), message('a', 'agent', '回答')])
  write(path.join(dir, 'bad.messages.json'), { not: 'messages' })
  await runMigrations({ dataDir: d, log: quiet })
  assert.deepEqual(
    parseMessagesJsonl(readFileSync(path.join(dir, 't.messages.jsonl'), 'utf8')).messages.map((m) => m.text),
    ['要求', '回答'],
  )
  assert.ok(!existsSync(path.join(dir, 't.messages.json')))
  assert.ok(existsSync(path.join(d, 'backup', '0003-messages-jsonl', 'tasks', 'projects', 'p', 't.messages.json')))
  assert.ok(existsSync(path.join(dir, 'bad.messages.json')), '读不懂的不动')
})

test('0004：平铺的 Bug 字段收进 task.bug；直接修的记成 fix；不是 Bug 的残留空字段丢掉；已经是新格式的不碰', async () => {
  const d = freshDir()
  const dir = path.join(d, 'tasks', 'chats')
  const diag = { version: 1, phase: 'cause', status: 'pending' }
  write(
    path.join(dir, 'r.json'),
    task('r', {
      turnSeenAt: '',
      bug: true,
      diagnoses: [diag],
      bugCase: { symptom: '角标' },
      logBase: { 'a.ts': 'h' },
      bugMethodPending: true,
      note: '留着',
    }),
  )
  write(path.join(dir, 'f.json'), task('f', { turnSeenAt: '', bugFix: true, fixBrief: { cause: '单位' } }))
  write(path.join(dir, 'p.json'), task('p', { turnSeenAt: '', diagnoses: [] }))
  write(path.join(dir, 'n.json'), task('n', { turnSeenAt: '', bug: { kind: 'report' } }))
  const fresh = readFileSync(path.join(dir, 'n.json'), 'utf8')
  await runMigrations({ dataDir: d, log: quiet })
  const r = json(path.join(dir, 'r.json'))
  assert.deepEqual(r.bug, {
    kind: 'report',
    diagnoses: [diag],
    case: { symptom: '角标' },
    logBase: { 'a.ts': 'h' },
    methodPending: true,
  })
  for (const k of ['diagnoses', 'bugCase', 'logBase', 'bugMethodPending']) assert.ok(!(k in r), `${k} 收进去了`)
  assert.equal(r.note, '留着')
  const f = json(path.join(dir, 'f.json'))
  assert.deepEqual(f.bug, { kind: 'fix', fixBrief: { cause: '单位' } })
  assert.ok(!('bugFix' in f) && !('fixBrief' in f))
  const p = json(path.join(dir, 'p.json'))
  assert.ok(!('bug' in p) && !('diagnoses' in p), '普通对话不凭空变成 Bug')
  assert.equal(readFileSync(path.join(dir, 'n.json'), 'utf8'), fresh, '新格式一个字节都没动')
  assert.equal(json(path.join(d, 'backup', '0004-task-bug', 'tasks', 'chats', 'r.json')).bug, true, '改之前的原样备份')
})

test('0005：项目的表格设置挪进 plugins.tables；已经挪过的不覆盖；没有表格设置的项目和文件不动', async () => {
  const d = freshDir()
  const cfg = { dirs: ['Data'] }
  write(path.join(d, 'projects', 'projects.json'), [
    { id: 'a', name: 'A', path: '/a', tables: cfg, plugins: { other: 1 } },
    { id: 'b', name: 'B', path: '/b', tables: { dirs: ['旧'] }, plugins: { tables: cfg } },
    { id: 'c', name: 'C', path: '/c' },
  ])
  await runMigrations({ dataDir: d, migrations: upTo(12), log: quiet })
  const [a, b, c] = json(path.join(d, 'projects', 'projects.json'))
  assert.deepEqual(a.plugins, { other: 1, tables: cfg })
  assert.ok(!('tables' in a) && !('tables' in b))
  assert.deepEqual(b.plugins.tables, cfg, '已经在新位置的不被旧值盖掉')
  assert.deepEqual(c, { id: 'c', name: 'C', path: '/c' })
  assert.deepEqual(
    json(path.join(d, 'backup', '0005-project-tables', 'projects', 'projects.json'))[0].tables,
    cfg,
    '改之前的原样备份',
  )
  const clean = freshDir()
  write(path.join(clean, 'projects', 'projects.json'), [{ id: 'c' }])
  const before = readFileSync(path.join(clean, 'projects', 'projects.json'), 'utf8')
  await runMigrations({ dataDir: clean, migrations: upTo(12), log: quiet })
  assert.equal(
    readFileSync(path.join(clean, 'projects', 'projects.json'), 'utf8'),
    before,
    '没有表格设置时一个字节都不动',
  )
})

test('0006：项目里配置过的插件记进 capabilities.plugins；已经有的不重复；没配置插件的项目不动', async () => {
  const d = freshDir()
  write(path.join(d, 'projects', 'projects.json'), [
    { id: 'a', name: 'A', plugins: { tables: { dirs: ['Data'] } } },
    { id: 'b', name: 'B', plugins: { tables: {}, ue: {} }, capabilities: { plugins: ['tables'], mcp: ['x'] } },
    { id: 'c', name: 'C' },
  ])
  await runMigrations({ dataDir: d, migrations: upTo(12), log: quiet })
  const [a, b, c] = json(path.join(d, 'projects', 'projects.json'))
  assert.deepEqual(a.capabilities, { plugins: ['tables'] })
  assert.deepEqual(b.capabilities, { plugins: ['tables', 'ue'], mcp: ['x'] }, '只补缺的，别的能力原样')
  assert.deepEqual(c, { id: 'c', name: 'C' })
})

test('版本号：跑过的不再跑；from 0 重跑（导入旧备份后）结果不变', async () => {
  const d = freshDir()
  const dir = path.join(d, 'tasks', 'chats')
  write(path.join(dir, 'x.json'), task('x', { cliAlive: true }))
  write(path.join(dir, 'x.messages.json'), [message('u', 'user', '一')])
  const first = await runMigrations({ dataDir: d, log: quiet })
  assert.equal(first.ran.length, DATA_VERSION)
  const again = await runMigrations({ dataDir: d, log: quiet })
  assert.deepEqual(again.ran, [], '已经是最新版本')
  const meta = readFileSync(path.join(dir, 'x.json'), 'utf8')
  const conv = readFileSync(path.join(dir, 'x.messages.jsonl'), 'utf8')
  const redo = await runMigrations({ dataDir: d, from: 0, log: quiet })
  assert.equal(redo.ran.length, DATA_VERSION)
  assert.equal(readFileSync(path.join(dir, 'x.json'), 'utf8'), meta, '幂等')
  assert.equal(readFileSync(path.join(dir, 'x.messages.jsonl'), 'utf8'), conv, '幂等')
})

test('迁移失败：停在失败之前的版本，后面的不跑，下次启动再试', async () => {
  const d = freshDir()
  const ran: number[] = []
  const list = [1, 2, 3].map((version) => ({
    version,
    name: `m${version}`,
    async run() {
      if (version === 2) throw new Error('文件被占用')
      ran.push(version)
    },
  }))
  const res = await runMigrations({ dataDir: d, migrations: list, log: quiet })
  assert.deepEqual(ran, [1])
  assert.equal(res.failed?.version, 2)
  assert.equal((await readDataVersion(d)).version, 1)
})

test('数据是更新版本写的：一个文件都不动；太老的版本接不上：告诉调用方拒绝启动', async () => {
  const d = freshDir()
  write(path.join(d, 'data-version.json'), { version: 999, history: [] })
  write(path.join(d, 'tasks', 'chats', 'x.messages.json'), [message('u', 'user', '一')])
  const res = await runMigrations({ dataDir: d, log: quiet })
  assert.equal(res.newer, true)
  assert.ok(existsSync(path.join(d, 'tasks', 'chats', 'x.messages.json')), '没转换')
  const old = freshDir()
  const list = [5, 6].map((version) => ({ version, name: `m${version}`, async run() {} }))
  assert.equal((await runMigrations({ dataDir: old, migrations: list, log: quiet })).tooOld, true)
})

test('备份只留最近 3 个版本的', async () => {
  const d = freshDir()
  const list = [1, 2, 3, 4, 5].map((version) => ({
    version,
    name: `m${version}`,
    async run(ctx: { dataDir: string; backup: (f: string) => Promise<void> }) {
      const f = path.join(ctx.dataDir, 'f.txt')
      write(f, String(version))
      await ctx.backup(f)
    },
  }))
  await runMigrations({ dataDir: d, migrations: list, log: quiet })
  assert.deepEqual(readdirSync(path.join(d, 'backup')).sort(), ['0003-m3', '0004-m4', '0005-m5'])
})

test('0007：仓库里已经有教训、经验的项目记成随仓库存，其余不写这一项', async () => {
  const d = freshDir()
  const withLessons = path.join(root, `repo${n++}`)
  write(path.join(withLessons, 'docs', 'lessons', 'build.md'), '# 构建\n')
  mkdirSync(path.join(withLessons, '.git'), { recursive: true })
  const onlyReadme = path.join(root, `repo${n++}`)
  write(path.join(onlyReadme, 'docs', 'lessons', 'README.md'), '# 说明\n')
  mkdirSync(path.join(onlyReadme, '.git'), { recursive: true })
  write(path.join(d, 'projects', 'projects.json'), [
    { id: 'a', path: withLessons },
    { id: 'b', path: onlyReadme },
    { id: 'c', path: withLessons, knowledgeInRepo: false },
    { id: 'd' },
  ])
  // 只跑 0007：版本号先记到 6
  write(path.join(d, 'data-version.json'), { version: 6 })
  await runMigrations({ dataDir: d, migrations: upTo(12), log: quiet })
  const [a, b, c, e] = json(path.join(d, 'projects', 'projects.json'))
  assert.equal(a.knowledgeInRepo, true)
  assert.ok(!('knowledgeInRepo' in b), '只有 README 不算记过')
  assert.equal(c.knowledgeInRepo, false, '用户已经选过的不改')
  assert.ok(!('knowledgeInRepo' in e))
})

test('0008：平铺的执行上限字段收进 task.budget；0（不限）丢掉；什么都没设的不造出 budget；已经是新格式的不碰', async () => {
  const d = freshDir()
  const dir = path.join(d, 'tasks', 'chats')
  const from = { usd: 0.5, tokens: 1200, at: 1760000000000 }
  write(
    path.join(dir, 'a.json'),
    task('a', { turnSeenAt: '', budgetTokens: 5000, budgetMinutes: 30, budgetFrom: from, budgetNotice: 'warn' }),
  )
  write(path.join(dir, 'z.json'), task('z', { turnSeenAt: '', budgetTokens: 0, budgetMinutes: 0 }))
  write(path.join(dir, 'n.json'), task('n', { turnSeenAt: '', budget: { tokens: 10 } }))
  const fresh = readFileSync(path.join(dir, 'n.json'), 'utf8')
  write(path.join(d, 'data-version.json'), { version: 7 })
  await runMigrations({ dataDir: d, migrations: upTo(12), log: quiet })
  const a = json(path.join(dir, 'a.json'))
  assert.deepEqual(a.budget, { tokens: 5000, minutes: 30, from, notice: 'warn' })
  for (const k of ['budgetTokens', 'budgetMinutes', 'budgetFrom', 'budgetNotice']) assert.ok(!(k in a), `${k} 收进去了`)
  const z = json(path.join(dir, 'z.json'))
  assert.ok(!('budget' in z) && !('budgetTokens' in z) && !('budgetMinutes' in z), '不限的不留空对象')
  assert.equal(readFileSync(path.join(dir, 'n.json'), 'utf8'), fresh, '新格式一个字节都没动')
  assert.equal(json(path.join(d, 'backup', '0008-task-budget', 'tasks', 'chats', 'a.json')).budgetTokens, 5000)
})

test('0009：analysis 种类和 analysisOf 收进 task.analysis；modelDesign 转成 plugin；已经是新格式的不碰', async () => {
  const d = freshDir()
  const dir = path.join(d, 'tasks', 'chats')
  write(path.join(dir, 'a.json'), task('a', { turnSeenAt: '', analysis: 'fix', analysisOf: 'b' }))
  write(path.join(dir, 'o.json'), task('o', { turnSeenAt: '', analysisOf: 'b' }))
  write(path.join(dir, 'm.json'), task('m', { turnSeenAt: '', modelDesign: true }))
  write(path.join(dir, 'k.json'), task('k', { turnSeenAt: '', modelDesign: true, plugin: 'x.y' }))
  write(path.join(dir, 'n.json'), task('n', { turnSeenAt: '', analysis: { kind: 'run' }, plugin: 'blender.model' }))
  const fresh = readFileSync(path.join(dir, 'n.json'), 'utf8')
  write(path.join(d, 'data-version.json'), { version: 8 })
  await runMigrations({ dataDir: d, log: quiet })
  const a = json(path.join(dir, 'a.json'))
  assert.deepEqual(a.analysis, { kind: 'fix', of: 'b' })
  assert.ok(!('analysisOf' in a))
  const o = json(path.join(dir, 'o.json'))
  assert.ok(!('analysis' in o) && !('analysisOf' in o), '没有种类的不算分析对话')
  const m = json(path.join(dir, 'm.json'))
  assert.equal(m.plugin, 'blender.model')
  assert.ok(!('modelDesign' in m))
  assert.equal(json(path.join(dir, 'k.json')).plugin, 'x.y', '已有的 plugin 不覆盖')
  assert.equal(readFileSync(path.join(dir, 'n.json'), 'utf8'), fresh, '新格式一个字节都没动')
})

test('0010：只有子对话用的字段收进 task.child；空提问列表丢掉；父对话那一侧的 inbox 留在顶层；已经是新格式的不碰', async () => {
  const d = freshDir()
  const dir = path.join(d, 'tasks', 'chats')
  const wrap = { state: 'requested', at: '', note: '做完了', tests: '', info: '' }
  const ask = { id: 'q', question: '用哪个？', options: ['A'], kind: 'question' }
  write(
    path.join(dir, 'k.json'),
    task('k', {
      turnSeenAt: '',
      parentTaskId: 'p',
      wrapRequest: wrap,
      handoff: { text: '交接', files: '', at: '' },
      pendingReport: '汇报',
      parentAsks: [ask],
      autoAsk: { at: '', count: 1 },
    }),
  )
  write(path.join(dir, 'p.json'), task('p', { turnSeenAt: '', parentAsks: [], inbox: [] }))
  write(path.join(dir, 'n.json'), task('n', { turnSeenAt: '', child: { userDirect: '改成蓝色' } }))
  const fresh = readFileSync(path.join(dir, 'n.json'), 'utf8')
  write(path.join(d, 'data-version.json'), { version: 9 })
  await runMigrations({ dataDir: d, log: quiet })
  const k = json(path.join(dir, 'k.json'))
  assert.deepEqual(k.child, {
    wrapRequest: wrap,
    handoff: { text: '交接', files: '', at: '' },
    pendingReport: '汇报',
    parentAsks: [ask],
    autoAsk: { at: '', count: 1 },
  })
  for (const x of ['wrapRequest', 'handoff', 'pendingReport', 'parentAsks', 'autoAsk'])
    assert.ok(!(x in k), `${x} 收进去了`)
  const p = json(path.join(dir, 'p.json'))
  assert.ok(!('child' in p) && !('parentAsks' in p), '空的提问列表不造出 task.child')
  assert.deepEqual(p.inbox, [], '父对话那一侧的字段不动')
  assert.equal(readFileSync(path.join(dir, 'n.json'), 'utf8'), fresh, '新格式一个字节都没动')
})

test('0011：旧的阶段流程、单层工作流参数、runInParent、任务的节点下标和 queue 换成当前格式；新格式的不碰', async () => {
  const d = freshDir()
  const stageWf = {
    id: 'w-old',
    name: '旧流程',
    mainAgentId: 'default-agent',
    members: [{ agentId: 'default-agent' }, { agentId: 'a1' }],
    stages: [{ nodes: [{ id: 'n1', title: '一' }] }, { nodes: [{ id: 'n2', title: '二' }] }],
  }
  const newWf = { id: 'w-new', name: '新流程', flows: [{ id: 'main', name: '主流程', nodes: [], edges: [] }] }
  write(path.join(d, 'config', 'workflows.json'), [stageWf, newWf])
  write(path.join(d, 'projects', 'projects.json'), [
    {
      id: 'p-old',
      name: '旧项目',
      workflowId: 'w-old',
      workflowParams: { docRoot: 'docs', tags: ['a'] },
      testSteps: [{ id: 's', name: '端到端', command: 'npm run test:e2e', runInParent: false }],
      initResult: { steps: [{ id: 'i', name: '编译', command: 'make', appliesTo: ['**/*.c'] }] },
    },
    { id: 'p-new', name: '新项目', workflowParams: { 'w-new': { docRoot: 'docs' } }, testSteps: [] },
  ])
  const dir = path.join(d, 'tasks', 'chats')
  write(
    path.join(dir, 'old.json'),
    task('old', {
      turnSeenAt: '',
      steps: [{ title: '一' }, { id: 'x', title: '二' }],
      messages: [{ ...message('u1', 'user', '要求'), step: 1 }],
      queue: [
        { id: 'q1', text: '再改一下', at: '2026-10-01T00:02:00.000Z' },
        { id: 'q2', text: '等 CLI 取的补充', note: true },
      ],
      workflows: [stageWf],
      testSteps: [{ id: 's', name: '编译', command: 'make', merge: true }],
    }),
  )
  write(path.join(dir, 'old.messages.jsonl'), JSON.stringify(message('u1', 'user', '要求')) + '\n')
  write(path.join(dir, 'new.json'), task('new', { turnSeenAt: '', steps: [{ id: 's0', nodeId: 'n' }] }))
  const fresh = readFileSync(path.join(dir, 'new.json'), 'utf8')
  write(path.join(d, 'trash', 'items', 'workflow-w-gone.json'), {
    kind: 'workflow',
    id: 'w-gone',
    name: '删掉的',
    deletedAt: '',
    item: { id: 'w-gone', name: '删掉的', stages: [] },
  })
  write(path.join(d, 'data-version.json'), { version: 10 })
  await runMigrations({ dataDir: d, log: quiet })

  const [w, w2] = json(path.join(d, 'config', 'workflows.json'))
  assert.ok(!('stages' in w), '阶段去掉了')
  assert.deepEqual(w.flows[0].edges.map((e: { from: string; to: string }) => `${e.from}>${e.to}`).sort(), [
    'n1>n2',
    'n2>end',
    'start>n1',
  ])
  assert.deepEqual(w.members, [{ agentId: 'a1' }], '指向默认 Agent 的旧成员去掉')
  assert.deepEqual(w2, newWf, '新格式的工作流不动')
  const [p, p2] = json(path.join(d, 'projects', 'projects.json'))
  assert.deepEqual(p.workflowParams, { 'w-old': { docRoot: 'docs', tags: ['a'] } }, '单层参数归到 workflowId 下')
  assert.equal(p.testSteps[0].scope, 'parent', '全量命令换算成 parent')
  assert.ok(!('runInParent' in p.testSteps[0]))
  assert.equal(p.initResult.steps[0].scope, 'changed', '保存的初始化推荐里的步骤也换')
  assert.deepEqual(p2.workflowParams, { 'w-new': { docRoot: 'docs' } })

  const t = json(path.join(dir, 'old.json'))
  assert.deepEqual(
    t.steps.map((s: { id: string; nodeId: string }) => `${s.id}/${s.nodeId}`),
    ['s0/s0', 'x/x'],
  )
  assert.equal(t.messages[0].step, 'x', '节点下标换成节点 id')
  assert.ok(!('queue' in t))
  assert.deepEqual(
    t.messages.map((m: { id: string }) => m.id),
    ['u1', 'q1'],
    '普通排队要求补进对话，等 CLI 取的补充丢掉',
  )
  assert.ok(Array.isArray(t.workflows[0].flows) && !('stages' in t.workflows[0]), '工作流快照一起换')
  assert.equal(t.testSteps[0].scope, 'changed', '测试步骤快照一起换')
  const conv = parseMessagesJsonl(readFileSync(path.join(dir, 'old.messages.jsonl'), 'utf8'))
  assert.deepEqual(
    conv.messages.map((m) => m.id),
    ['u1', 'q1'],
    '排队要求也追加进对话文件',
  )
  assert.equal(readFileSync(path.join(dir, 'new.json'), 'utf8'), fresh, '新格式一个字节都没动')
  assert.ok(existsSync(path.join(d, 'backup', '0011-legacy-shapes', 'tasks', 'chats', 'old.json')), '改之前备份')
  const trashed = json(path.join(d, 'trash', 'items', 'workflow-w-gone.json'))
  assert.ok(Array.isArray(trashed.item.flows) && !('stages' in trashed.item), '回收站里的工作流也换')

  // 重跑（导入旧备份后从 0 跑）不再改
  await runMigrations({ dataDir: d, from: 10, log: quiet })
  assert.deepEqual(
    parseMessagesJsonl(readFileSync(path.join(dir, 'old.messages.jsonl'), 'utf8')).messages.map((m) => m.id),
    ['u1', 'q1'],
    '重跑不会再追加',
  )
})

test('0012：项目里的对话、子对话从 chat 改存成 agent；Chat 页的对话和工作流不碰', async () => {
  const d = freshDir()
  const proj = path.join(d, 'tasks', 'projects', 'p1')
  const chats = path.join(d, 'tasks', 'chats')
  write(path.join(proj, 'a.json'), task('a', { projectId: 'p1' }))
  write(path.join(proj, 'k.json'), task('k', { projectId: 'p1', parentTaskId: 'a' }))
  write(path.join(proj, 'w.json'), task('w', { projectId: 'p1', mode: 'workflow' }))
  write(path.join(chats, 'c.json'), task('c'))
  const keep = readFileSync(path.join(chats, 'c.json'), 'utf8')
  write(path.join(d, 'data-version.json'), { version: 11 })
  await runMigrations({ dataDir: d, log: quiet })
  assert.equal(json(path.join(proj, 'a.json')).mode, 'agent', '项目里的父对话')
  assert.equal(json(path.join(proj, 'k.json')).mode, 'agent', '子对话')
  assert.equal(json(path.join(proj, 'w.json')).mode, 'workflow')
  assert.equal(readFileSync(path.join(chats, 'c.json'), 'utf8'), keep, 'Chat 页的对话一个字节都没动')
})

test('0013 教训默认随仓库：数据目录里已经有的照旧存数据目录，没有的改成随仓库，已经随仓库的不动', async () => {
  const { DATA_FILES } = await import('../store.ts')
  const d = freshDir()
  write(path.join(d, 'data-version.json'), { version: 12, history: [] })
  const file = path.join(d, DATA_FILES['projects.json'])
  write(file, [
    { id: 'keep', path: '/w/a', knowledgeInRepo: false },
    { id: 'old', path: '/w/b' },
    { id: 'empty', path: '/w/c', knowledgeInRepo: false },
    { id: 'repo', path: '/w/d', knowledgeInRepo: true },
  ])
  write(path.join(d, 'knowledge', 'keep', 'lessons', 'a.md'), '# a')
  write(path.join(d, 'knowledge', 'old', 'experience', 'e.md'), '# e')
  await runMigrations({ dataDir: d, log: quiet })
  const by = Object.fromEntries((json(file) as { id: string; knowledgeInRepo: boolean }[]).map((p) => [p.id, p]))
  assert.equal(by.keep.knowledgeInRepo, false)
  assert.equal(by.old.knowledgeInRepo, false, '没写这一项、数据目录里有经验的：写明 false，默认值改了也读得到原来那份')
  assert.equal(by.empty.knowledgeInRepo, true)
  assert.equal(by.repo.knowledgeInRepo, true)
})
