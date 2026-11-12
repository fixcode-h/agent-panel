import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 迁移在临时数据目录里跑，别碰本机的
const root = mkdtempSync(path.join(tmpdir(), 'agent-panel-migrations-'))
process.env.AGENT_PANEL_DATA = path.join(root, 'default')

const { runMigrations, readDataVersion, DATA_VERSION } = await import('./index.ts')
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

test('版本号：跑过的不再跑；from 0 重跑（导入旧备份后）结果不变', async () => {
  const d = freshDir()
  const dir = path.join(d, 'tasks', 'chats')
  write(path.join(dir, 'x.json'), task('x', { cliAlive: true }))
  write(path.join(dir, 'x.messages.json'), [message('u', 'user', '一')])
  const first = await runMigrations({ dataDir: d, log: quiet })
  assert.equal(first.ran.length, 4)
  const again = await runMigrations({ dataDir: d, log: quiet })
  assert.deepEqual(again.ran, [], '已经是最新版本')
  const meta = readFileSync(path.join(dir, 'x.json'), 'utf8')
  const conv = readFileSync(path.join(dir, 'x.messages.jsonl'), 'utf8')
  const redo = await runMigrations({ dataDir: d, from: 0, log: quiet })
  assert.equal(redo.ran.length, 4)
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
