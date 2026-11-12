import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { NewTaskInput, Task } from '../shared/schema.ts'
import type { Schedule } from '../shared/schedule.ts'
import { EMPTY_TRIGGER_STATE, ScheduleTrigger, type TriggerState } from '../shared/schedule/trigger.ts'

// 数据目录换成临时的，别动本机的计划和配置
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-triggers-'))
process.env.AGENT_PANEL_DATA = dir

const { schedulesApi } = await import('./schedules.ts')
const { probeTrigger, triggerDir } = await import('./schedule-triggers.ts')

const MINUTE = 60_000
const trig = (over: Partial<ScheduleTrigger>) => ScheduleTrigger.parse(over)

test('triggerDir：相对路径按项目目录算，聊天计划只认绝对路径', () => {
  const proj = path.join(dir, 'proj')
  assert.equal(triggerDir({ path: '' }, proj), proj)
  assert.equal(triggerDir({ path: 'Content' }, proj), path.join(proj, 'Content'))
  assert.equal(triggerDir({ path: '/abs/x' }, ''), '/abs/x')
  assert.throws(() => triggerDir({ path: 'rel' }, ''))
})

test('目录文件：指纹随文件变化，列出上次检查之后改过的文件', async () => {
  const watch = mkdtempSync(path.join(dir, 'watch-'))
  writeFileSync(path.join(watch, 'a.txt'), '1')
  mkdirSync(path.join(watch, 'node_modules'))
  writeFileSync(path.join(watch, 'node_modules', 'x.js'), '1')
  const tr = trig({ kind: 'files', path: watch })
  const first = await probeTrigger(tr, '', EMPTY_TRIGGER_STATE)
  // 没变：同一个值
  assert.equal((await probeTrigger(tr, '', EMPTY_TRIGGER_STATE)).value, first.value)
  // node_modules 里的变化不算
  writeFileSync(path.join(watch, 'node_modules', 'x.js'), '22')
  assert.equal((await probeTrigger(tr, '', EMPTY_TRIGGER_STATE)).value, first.value)

  const checkedAt = new Date(Date.now() - MINUTE).toISOString()
  writeFileSync(path.join(watch, 'b.txt'), 'new')
  // a.txt 的修改时间挪到上次检查之前：只有 b.txt 算新改动
  const old = new Date(Date.now() - 10 * MINUTE)
  utimesSync(path.join(watch, 'a.txt'), old, old)
  const next = await probeTrigger(tr, '', { ...EMPTY_TRIGGER_STATE, baseline: first.value, checkedAt })
  assert.notEqual(next.value, first.value)
  assert.match(next.detail, /b\.txt/)
  assert.doesNotMatch(next.detail, /a\.txt/)

  rmSync(path.join(watch, 'b.txt'))
  const removed = await probeTrigger(tr, '', { ...EMPTY_TRIGGER_STATE, checkedAt: new Date().toISOString() })
  assert.match(removed.detail, /删除/)
})

test('目录不存在：抛出原因，不当成没变化', async () => {
  await assert.rejects(probeTrigger(trig({ kind: 'files', path: path.join(dir, 'nope') }), '', EMPTY_TRIGGER_STATE))
})

test('命令：值是退出码，说明里带输出的最后几行', { skip: process.platform === 'win32' }, async () => {
  const cwd = mkdtempSync(path.join(dir, 'cmd-'))
  const ok = await probeTrigger(trig({ kind: 'command', command: 'echo hello' }), cwd, EMPTY_TRIGGER_STATE)
  assert.equal(ok.value, '0')
  const bad = await probeTrigger(trig({ kind: 'command', command: 'echo broken; exit 3' }), cwd, {
    ...EMPTY_TRIGGER_STATE,
    baseline: '0',
  })
  assert.equal(bad.value, '3')
  assert.match(bad.detail, /从 0 变成 3/)
  assert.match(bad.detail, /broken/)
})

test('远端分支：值是提交号，新提交后变化', { skip: process.platform === 'win32' }, async () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd })
      .toString()
      .trim()
  const remote = mkdtempSync(path.join(dir, 'remote-'))
  git(remote, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(remote, 'f.txt'), '1')
  git(remote, 'add', '.')
  git(remote, 'commit', '-q', '-m', 'one')
  const clone = mkdtempSync(path.join(dir, 'clone-'))
  git(clone, 'clone', '-q', remote, '.')
  const tr = trig({ kind: 'git', branch: 'main' })
  const first = await probeTrigger(tr, clone, EMPTY_TRIGGER_STATE)
  assert.equal(first.value, git(remote, 'rev-parse', 'HEAD'))
  writeFileSync(path.join(remote, 'f.txt'), '2')
  git(remote, 'commit', '-q', '-am', 'two')
  const next = await probeTrigger(tr, clone, { ...EMPTY_TRIGGER_STATE, baseline: first.value })
  assert.notEqual(next.value, first.value)
  assert.match(next.detail, /origin\/main/)
  await assert.rejects(probeTrigger(trig({ kind: 'git', branch: 'nope' }), clone, EMPTY_TRIGGER_STATE), /nope/)
})

/**
 * 计划这边：检查的结果按顺序交给假的 probe，验证「第一次只记现状、变了才启动、出错记原因」。
 * 几个用例共用同一个数据文件：开始前清掉上一个用例建的计划，免得它们也来取检查结果
 */
async function setup(values: (string | Error)[]) {
  const calls: NewTaskInput[] = []
  const api = schedulesApi({
    startChat: async (input) => {
      calls.push(input)
      return { id: `task-${calls.length}` } as Task
    },
    projectPath: async () => dir,
    probe: async (_tr, _dir, _prev: TriggerState) => {
      const v = values.shift() ?? ''
      if (v instanceof Error) throw v
      return { value: v, detail: `变成了 ${v}` }
    },
  })
  const create = async (body: Record<string, unknown>) => {
    const res = await api.routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as Schedule & { error?: string }
    return { status: res.status, json }
  }
  const find = async (id: string) =>
    ((await (await api.routes.request('/')).json()) as Schedule[]).find((s) => s.id === id)!
  for (const old of (await (await api.routes.request('/')).json()) as Schedule[])
    await api.routes.request(`/${old.id}`, { method: 'DELETE' })
  return { api, calls, create, find }
}

const eventPlan = (name: string, trigger: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  name,
  prompt: `处理 ${name}`,
  projectId: 'p1',
  agentId: '',
  at: new Date().toISOString(),
  trigger,
  ...over,
})

test('按事件的计划：第一次只记现状，变了才启动，提示词附上触发原因', async () => {
  const { api, calls, create, find } = await setup(['a', 'a', 'b'])
  const { json: s } = await create(eventPlan('事件-1', { kind: 'files', everyMin: 5 }))
  const now = Date.now()
  await api.tick(now)
  await api.settled()
  assert.equal(calls.length, 0, '第一次检查不启动')
  assert.equal((await find(s.id)).triggerState.baseline, 'a')

  // 没到检查间隔：不检查
  await api.tick(now + MINUTE)
  await api.settled()
  assert.equal((await find(s.id)).triggerState.baseline, 'a')

  await api.tick(now + 6 * MINUTE)
  await api.settled()
  assert.equal(calls.length, 0, '没变化不启动')
  await api.tick(now + 12 * MINUTE)
  await api.settled()
  assert.equal(calls.length, 1)
  assert.match(calls[0].prompt, /^处理 事件-1/)
  assert.match(calls[0].prompt, /变成了 b/)
  const after = await find(s.id)
  assert.equal(after.lastTaskId, 'task-1')
  assert.equal(after.status, 'pending', '按事件的计划启动后还会继续检查')
  assert.equal(after.runs[0].at, '', '运行记录不写排期时间')
  assert.equal(after.triggerState.firedAt, after.triggerState.checkedAt)
})

test('检查出错：原因记进计划，baseline 不动', async () => {
  const { api, calls, create, find } = await setup(['a', new Error('远端连不上')])
  const { json: s } = await create(eventPlan('事件-2', { kind: 'git', branch: 'main', everyMin: 1 }))
  const now = Date.now()
  await api.tick(now)
  await api.settled()
  await api.tick(now + 2 * MINUTE)
  await api.settled()
  const after = await find(s.id)
  assert.equal(after.triggerState.error, '远端连不上')
  assert.equal(after.triggerState.baseline, 'a')
  assert.equal(calls.length, 0)
})

test('命令只在失败时：退出码变回 0 不启动，变成非 0 才启动', async () => {
  const { api, calls, create } = await setup(['1', '0', '2'])
  await create(eventPlan('事件-3', { kind: 'command', command: 'check', onlyFailure: true, everyMin: 1 }))
  const now = Date.now()
  for (let i = 0; i < 3; i++) {
    await api.tick(now + i * 2 * MINUTE)
    await api.settled()
  }
  assert.equal(calls.length, 1)
  assert.match(calls[0].prompt, /变成了 2/)
})

test('保存校验：git 没填分支、聊天计划填相对路径都拦下', async () => {
  const { create } = await setup([])
  const noBranch = await create(eventPlan('事件-4', { kind: 'git' }))
  assert.equal(noBranch.status, 400)
  const rel = await create(eventPlan('事件-5', { kind: 'files', path: 'sub' }, { projectId: '' }))
  assert.equal(rel.status, 400)
})

test('改了触发条件：从头记现状', async () => {
  const { api, create, find } = await setup(['a'])
  const { json: s } = await create(eventPlan('事件-6', { kind: 'files', everyMin: 5 }))
  await api.tick(Date.now())
  await api.settled()
  assert.equal((await find(s.id)).triggerState.baseline, 'a')
  const res = await api.routes.request(`/${s.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(eventPlan('事件-6', { kind: 'files', path: 'Content', everyMin: 5 }, { at: s.at })),
  })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as Schedule).triggerState.baseline, '')
})
