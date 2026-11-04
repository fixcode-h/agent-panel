/**
 * 钩子的分派（ADR 0049 第二期）：内置钩子按身份装不装、怎么答；用户钩子真的跑一遍脚本；
 * 保存前的校验拦住语法错误和密钥。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-hooks-'))
process.env.AGENT_PANEL_DATA = dir

const { setLang } = await import('../../shared/i18n.ts')
const { Task, ProjectInput } = await import('../../shared/schema.ts')
const { hookOptions, unverifiedEdit } = await import('./dispatch.ts')
const { putHook, setBuiltin, resetHooksCache, setBuiltinParam, setCliOff, setProjectBuiltin } =
  await import('./store.ts')
const { checkHook } = await import('./validate.ts')
const { recentTriggers } = await import('./run.ts')

setLang('zh')

const project = { ...ProjectInput.parse({ name: 'p', path: dir }), id: 'p1' } as never
const at = '2026-11-04T00:00:00.000Z'
const task = (over: Record<string, unknown> = {}) =>
  Task.parse({
    id: 't1',
    projectId: 'p1',
    title: 't',
    mode: 'chat',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    ...over,
  }) as never
const marks: string[] = []
const ctx = (over: { origin?: string; orch?: Record<string, unknown>; task?: never; step?: boolean } = {}) => ({
  task: over.task ?? task(),
  project,
  agent: { id: 'a1', name: '执行', origin: over.origin ?? '' },
  agents: [],
  cliId: 'claude',
  cwd: dir,
  call: {
    agentId: 'a1',
    prompt: '',
    sessionKey: 'a1',
    ...(over.step ? { step: { id: 's1' } } : {}),
    orch: { helper: false, coordinator: false, ...over.orch },
  } as never,
  mark: (r: string) => void marks.push(r),
})
const edit = (file: string) => ({
  tool: { kind: 'edit' as const, name: 'Edit', input: { file_path: file }, path: file, paths: [file] },
})

test('只读的角色改文件被拒绝，跑写仓库的命令也被拒绝；普通角色不装工具前', async () => {
  resetHooksCache()
  const ro = await hookOptions(ctx({ origin: 'builtin:explorer', orch: { helper: true } }))
  assert.ok(ro.hookEvents?.includes('tool.before'))
  const a = await ro.onHook!('tool.before', edit(path.join(dir, 'a.ts')))
  assert.equal(a.deny, true)
  assert.match(a.reason!, /只读的角色/)
  const b = await ro.onHook!('tool.before', {
    tool: { kind: 'shell', name: 'Bash', input: { command: 'git commit -m x' }, path: '', paths: [] },
  })
  assert.equal(b.deny, true)
  const c = await ro.onHook!('tool.before', {
    tool: { kind: 'shell', name: 'Bash', input: { command: 'git log' }, path: '', paths: [] },
  })
  assert.ok(!c.deny, '只读命令照常')
  // 第四期起推送、危险命令这些守卫默认开着，普通角色也装工具前；它改项目里的文件照常放行
  const plain = await hookOptions(ctx())
  assert.ok(plain.hookEvents?.includes('tool.before'))
  assert.ok(!(await plain.onHook!('tool.before', edit(path.join(dir, 'a.ts')))).deny, '普通角色改文件照常')
})

test('只统筹的父对话改文件被拒绝；就地微改动登记过的文件放行', async () => {
  resetHooksCache()
  const coord = await hookOptions(ctx({ orch: { coordinator: true } }))
  const a = await coord.onHook!('tool.before', edit('src/a.ts'))
  assert.match(a.reason ?? '', /begin_inline_edit/)
  const inline = await hookOptions(
    ctx({
      orch: { coordinator: true },
      task: task({ inlineEdit: { files: ['src/a.ts'], reason: 'x', startedAt: '' } }),
    }),
  )
  assert.ok(!(await inline.onHook!('tool.before', edit('src/a.ts'))).deny)
})

test('关掉内置钩子就不装；临时文件守卫默认关，打开后拦住写到盘符根目录下的文件', async () => {
  resetHooksCache()
  await setBuiltin('read-only-guard', false, true)
  const rv = await hookOptions(ctx({ origin: 'builtin:reviewer' }))
  assert.ok(!(await rv.onHook!('tool.before', edit(path.join(dir, 'a.ts')))).deny, '关掉只读守卫后评审改文件不拦')
  await setBuiltin('temp-file-guard', true, false)
  const o = await hookOptions(ctx())
  const r = await o.onHook!('tool.before', edit(path.join(path.parse(dir).root, 'scratch', 'x.txt')))
  assert.equal(r.deny, true)
  assert.ok(!(await o.onHook!('tool.before', edit(path.join(dir, 'x.txt')))).deny, '项目目录里照常')
  await setBuiltin('read-only-guard', true, true)
  await setBuiltin('temp-file-guard', false, false)
})

test('压缩之后补回计划：只在 compact 时补，内容带当前计划', async () => {
  resetHooksCache()
  const tk = task({
    plans: [
      {
        id: 'p',
        title: '',
        steps: [
          { id: '1', title: '改代码', status: 'done', note: '', waits: [], children: [] },
          { id: '2', title: '跑检查', status: 'running', note: '', waits: [], children: [] },
        ],
        createdAt: '2026-01-01',
        doneAt: '',
        summary: '',
      },
    ],
  })
  const o = await hookOptions(ctx({ task: tk }))
  assert.ok(o.hookEvents?.includes('context.restored'))
  const r = await o.onHook!('context.restored', { source: 'compact' })
  assert.match(r.context ?? '', /跑检查/)
  assert.deepEqual(await o.onHook!('context.restored', { source: 'resume' }), {})
})

test('用户钩子：真的跑脚本，拒绝原因交回；出错按设置放行或拒绝；触发记进最近触发', async () => {
  resetHooksCache()
  await putHook({
    id: 'deny-lock',
    name: '锁文件',
    event: 'tool.before',
    match: { tool: 'edit', path: '**/*-lock.json', command: '' },
    action: {
      type: 'command',
      script:
        "let r='';process.stdin.on('data',c=>r+=c).on('end',()=>{const i=JSON.parse(r);process.stdout.write(JSON.stringify({deny:true,reason:'锁文件不要手改：'+i.tool.name}))})",
    },
    enabled: true,
  })
  const o = await hookOptions(ctx())
  assert.ok(o.hookEvents?.includes('tool.before'))
  const r = await o.onHook!('tool.before', edit('package-lock.json'))
  assert.equal(r.deny, true)
  assert.equal(r.reason, '锁文件不要手改：Edit')
  assert.ok(!(await o.onHook!('tool.before', edit('src/a.ts'))).deny, '路径对不上不跑')
  assert.equal(recentTriggers()[0].result, 'deny')
  await putHook({
    id: 'broken',
    name: '坏的',
    event: 'tool.before',
    action: { type: 'command', script: 'process.exit(3)' },
    onError: 'deny',
    enabled: true,
  })
  const o2 = await hookOptions(ctx())
  const bad = await o2.onHook!('tool.before', edit('src/a.ts'))
  assert.equal(bad.deny, true)
  assert.match(bad.reason!, /出错/)
})

test('用户的结束前钩子：内置判断没拦时再问它，拦住就记一行', async () => {
  resetHooksCache()
  await putHook({
    id: 'end',
    name: '结束前',
    event: 'turn.beforeEnd',
    action: { type: 'command', script: "process.stdout.write(JSON.stringify({block:true,reason:'先写总结'}))" },
    enabled: true,
  })
  marks.length = 0
  const o = await hookOptions(ctx())
  const d = await o.beforeEnd!({})
  assert.equal(d.block, true)
  assert.equal(d.reason, '先写总结')
  assert.deepEqual(marks, ['先写总结'])
})

test('保存前校验：语法错误、写死的密钥、给非工具事件配匹配都拦下', async () => {
  const syntax = await checkHook({ name: 'x', event: 'tool.after', action: { type: 'command', script: 'let = ;' } })
  assert.match(syntax.errors.join(), /语法错误/)
  const secret = await checkHook({
    name: 'x',
    event: 'tool.after',
    action: { type: 'command', script: `const k = 'sk-${'a'.repeat(30)}'` }, // secret-check-ok：测试用的假密钥
  })
  assert.match(secret.errors.join(), /密钥/)
  const match = await checkHook({
    name: 'x',
    event: 'turn.beforeEnd',
    match: { tool: 'edit', path: '', command: '' },
    action: { type: 'command', script: '' + 'process.exit(0)' },
  })
  assert.match(match.errors.join(), /只有工具前、工具后/)
  const ok = await checkHook(
    { name: 'x', event: 'tool.after', action: { type: 'command', script: "process.stdout.write('{}')" } },
    { run: true },
  )
  assert.deepEqual(ok.errors, [])
})

test('原地打转提醒：同一条命令连续失败到设置的次数时补一句，成功一次就清零；默认关着', async () => {
  resetHooksCache()
  const fail = (ok: boolean) => ({
    tool: {
      kind: 'shell' as const,
      name: 'Bash',
      input: { command: 'npm  run build' },
      path: '',
      paths: [],
      result: { output: ok ? 'ok' : 'error TS2322', failed: !ok },
    },
  })
  const off = await hookOptions(ctx({ task: task({ id: 'loop0' }) }))
  assert.ok(!(await off.onHook!('tool.after', fail(false))).context, '默认关着')
  await setBuiltin('loop-hint', true, false)
  await setBuiltinParam('loop-hint', 'times', 2, false)
  const o = await hookOptions(ctx({ task: task({ id: 'loop1' }) }))
  assert.ok(!(await o.onHook!('tool.after', fail(false))).context)
  assert.match((await o.onHook!('tool.after', fail(false))).context ?? '', /连续失败 2 次/)
  await o.onHook!('tool.after', fail(true))
  assert.ok(!(await o.onHook!('tool.after', fail(false))).context, '成功过一次重新数')
  await setBuiltin('loop-hint', false, false)
  await setBuiltinParam('loop-hint', 'times', 3, true)
})

test('改完没验证：改了文件、之后没跑命令才算；跑过命令或自检过的不算', () => {
  const m = (role: string, tools: string[] = [], panel?: string) => ({
    id: `${role}${tools.join('')}${panel ?? ''}`,
    role,
    text: '',
    tools: tools.map((kind) => ({ kind, label: kind })),
    ...(panel ? { panel } : {}),
  })
  const t1 = { messages: [m('user'), m('agent', ['read', 'edit'])] } as never
  assert.equal(unverifiedEdit(t1), 'user')
  assert.equal(unverifiedEdit({ messages: [m('user'), m('agent', ['edit', 'run'])] } as never), '')
  assert.equal(unverifiedEdit({ messages: [m('user'), m('agent', ['read'])] } as never), '')
  assert.equal(unverifiedEdit({ messages: [m('user'), m('agent', ['edit']), m('system', [], 'hook')] } as never), '')
})

test('按 CLI 关掉的事件不装；内置钩子按项目单独的开关覆盖全局', async () => {
  resetHooksCache()
  // 前面用例留下的用户钩子（有一个故意出错、按设置拒绝）会干扰这里，先清掉
  const { deleteHook, readHooks } = await import('./store.ts')
  for (const h of (await readHooks()).hooks) await deleteHook(h.id)
  await setCliOff('claude', ['tool.before'])
  assert.ok(!(await hookOptions(ctx({ origin: 'builtin:explorer' }))).hookEvents?.includes('tool.before'))
  await setCliOff('claude', [])
  await setProjectBuiltin('p1', 'read-only-guard', false)
  const ro = await hookOptions(ctx({ origin: 'builtin:explorer' }))
  const roA = await ro.onHook!('tool.before', edit(path.join(dir, 'a.ts')))
  assert.ok(!roA.deny, `这个项目关了只读守卫：${roA.reason}`)
  await setProjectBuiltin('p1', 'read-only-guard', null)
  const back = await hookOptions(ctx({ origin: 'builtin:explorer' }))
  assert.ok((await back.onHook!('tool.before', edit(path.join(dir, 'a.ts')))).deny, '去掉单独设置后跟着全局')
  // 内置守卫拦下的也记进最近触发
  assert.ok(recentTriggers().some((x) => x.hookId === 'builtin:read-only-guard' && x.result === 'deny'))
})

test('计划没跟上提醒：默认开、只给有执行计划的对话，动手到次数补一句', async () => {
  resetHooksCache()
  const { applyPlan } = await import('../../shared/plan.ts')
  const tk = task({ id: 'pace1' })
  applyPlan(tk, { steps: [{ title: '改界面', status: 'running' }, { title: '跑测试' }] })
  const none = await hookOptions(ctx({ task: tk }))
  assert.ok(!none.hookEvents?.includes('tool.after'), '没有执行计划（子任务、Chat 页）不装')
  await setBuiltinParam('plan-pace', 'calls', 2, false)
  const o = await hookOptions(ctx({ task: tk, orch: { plans: true } }))
  assert.ok(o.hookEvents?.includes('tool.after'))
  const file = path.join(dir, 'a.ts')
  assert.ok(!(await o.onHook!('tool.after', edit(file))).context)
  assert.match((await o.onHook!('tool.after', edit(file))).context ?? '', /「改界面」/)
  assert.ok(!(await o.onHook!('tool.after', edit(file))).context, '同一步只提醒一次')
  assert.ok(recentTriggers().some((x) => x.hookId === 'builtin:plan-pace' && x.result === 'context'))
  await setBuiltinParam('plan-pace', 'calls', 20, true)
})
