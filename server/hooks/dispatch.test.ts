/**
 * 钩子的分派（ADR 0049 第二期）：内置钩子按身份装不装、怎么答；用户钩子真的跑一遍脚本；
 * 保存前的校验拦住语法错误和密钥。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-hooks-'))
process.env.AGENT_PANEL_DATA = dir

const { setLang } = await import('../../shared/i18n.ts')
const { Task, ProjectInput } = await import('../../shared/schema.ts')
const { hookOptions, unverifiedEdit } = await import('./dispatch.ts')
const { putHook, readHooks, setBuiltin, resetHooksCache, setBuiltinParam, setCliOff, setProjectBuiltin, setTier } =
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
  // 临时脚本放行：项目 .tmp/、系统临时目录里不在项目里的路径；项目本身在临时目录里时项目文件照样拦
  assert.ok(!(await ro.onHook!('tool.before', edit(path.join(dir, '.tmp', 'probe.py')))).deny, '项目 .tmp/ 放行')
  const scratch = path.join(tmpdir(), 'agent-panel-scratch-x', 'probe.mjs')
  assert.ok(!(await ro.onHook!('tool.before', edit(scratch))).deny, '系统临时目录放行')
  assert.equal((await ro.onHook!('tool.before', edit(path.join(dir, 'src', 'b.ts')))).deny, true, '临时目录里的项目')
  const co = await hookOptions(ctx({ orch: { coordinator: true } }))
  assert.ok(!(await co.onHook!('tool.before', edit(scratch))).deny, '父对话写临时脚本也放行')
  assert.equal((await co.onHook!('tool.before', edit(path.join(dir, 'a.ts')))).deny, true, '父对话改项目文件照样拦')
  // 第四期起推送、危险命令这些守卫默认开着，普通角色也装工具前；它改项目里的文件照常放行
  const plain = await hookOptions(ctx())
  assert.ok(plain.hookEvents?.includes('tool.before'))
  assert.ok(!(await plain.onHook!('tool.before', edit(path.join(dir, 'a.ts')))).deny, '普通角色改文件照常')
  // 内置守卫只看改文件、跑命令和读文件（读大文件守卫）：能按工具名过滤的 CLI 不再为搜索这类工具跑钩子（没有用户钩子时）；
  // 按情境推技能（ADR 0083）还要看面板工具（收尾时推 verification-before-completion）
  assert.deepEqual([...new Set(plain.hookTools?.['tool.before'])].sort(), ['edit', 'panel', 'read', 'shell'])
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
  // 原因后面附上「用户要求的就请用户放行」（ADR 0070）
  assert.match(r.reason!, /^锁文件不要手改：Edit\n.*request_override.*"hook:锁文件"/)
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
  assert.match(d.reason!, /^先写总结\n.*request_override/)
  assert.deepEqual(marks, [d.reason])
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

test('参数传错时补参数表：默认开，工具后看任意工具，MCP 工具报参数错补一句，同一个工具只补一次', async () => {
  resetHooksCache()
  const o = await hookOptions(ctx({ task: task({ id: 'arg1' }) }))
  assert.ok(o.hookTools?.['tool.after']?.includes('any'), '别家 MCP 工具不在 CLI 的工具类别里，要按任意工具装')
  const mcp = (output: string, failed = true) => ({
    tool: {
      kind: 'any' as const,
      name: 'mcp__nobody__lua_code',
      input: { action: 'search', projectPath: '/w' },
      path: '',
      paths: [],
      result: { output, failed },
    },
  })
  assert.ok(!(await o.onHook!('tool.after', mcp('Found 3 symbols', false))).context)
  // 缓存里没有这个服务：照报错改、先加载说明
  assert.match(
    (await o.onHook!('tool.after', mcp('Unknown argument: projectPath'))).context ?? '',
    /参数不对[^\n]*先加载这个工具的说明/,
  )
  assert.ok(!(await o.onHook!('tool.after', mcp('Unknown argument: projectPath'))).context, '同一个工具只补一次')
  assert.ok(recentTriggers().some((x) => x.hookId === 'builtin:arg-table-hint' && x.result === 'context'))
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
  const { deleteHook } = await import('./store.ts')
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
  const { applyPlan } = await import('../../shared/plan/index.ts')
  const tk = task({ id: 'pace1' })
  applyPlan(tk, { steps: [{ title: '改界面', status: 'running' }, { title: '跑测试' }] })
  // 大输出提醒、参数传错提醒、推送项目知识默认也装工具后：这里只看计划提醒，先关掉它们
  await setBuiltin('big-output-hint', false, true)
  await setBuiltin('arg-table-hint', false, true)
  await setBuiltin('push-lessons', false, true)
  // 按情境推技能有工具后的条件（测试命令失败后推 systematic-debugging），也先关掉
  await setBuiltin('skill-push', false, true)
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
  await setBuiltin('big-output-hint', true, true)
  await setBuiltin('arg-table-hint', true, true)
  await setBuiltin('push-lessons', true, true)
  await setBuiltin('skill-push', true, true)
})

test('大输出提醒：默认开，一次结果超过字数补一句，每次调用最多两次', async () => {
  resetHooksCache()
  const o = await hookOptions(ctx())
  assert.ok(o.hookEvents?.includes('tool.after'))
  assert.ok(o.hookTools?.['tool.after']?.includes('read'))
  const big = (size: number) => ({
    tool: {
      kind: 'shell' as const,
      name: 'Bash',
      input: { command: 'cat x' },
      path: '',
      paths: [],
      result: { output: 'x', size },
    },
  })
  assert.ok(!(await o.onHook!('tool.after', big(100))).context)
  assert.match((await o.onHook!('tool.after', big(50000))).context ?? '', /50000 字/)
  assert.match((await o.onHook!('tool.after', big(50000))).context ?? '', /50000 字/)
  assert.ok(!(await o.onHook!('tool.after', big(50000))).context, '第三次不再提醒')
})

test('档位：严格档装上「不许改检查配置」，回到标准就不拦；选档位清掉逐个改过的开关', async () => {
  resetHooksCache()
  await setBuiltin('loop-hint', true)
  await setTier('strict')
  assert.equal((await readHooks()).builtins['loop-hint'], undefined, '选档位清掉逐个改的')
  const strict = await hookOptions(ctx())
  assert.match((await strict.onHook!('tool.before', edit('tsconfig.json'))).reason ?? '', /检查配置/)
  await setTier('standard')
  const std = await hookOptions(ctx({ task: task({ id: 'tier-std' }) }))
  assert.ok(!(await std.onHook!('tool.before', edit('tsconfig.json'))).deny)
})

test('推送项目教训和经验：默认开；跑命令、改文件、搜索之前推，报错之后按报错推；同一条只推一次，标到工具行上', async () => {
  resetHooksCache()
  const { ProjectLesson } = await import('../../shared/schema.ts')
  const { ProjectExperience } = await import('../../shared/experience.ts')
  const l = (o: Record<string, unknown>) => ProjectLesson.parse({ title: 't', rule: '', createdAt: at, ...o })
  const withLessons = {
    ...(project as object),
    lessons: [
      l({ id: 'cmd', title: 'e2e 在 WSL 里跑', rule: '`npm run test:e2e` 放到 WSL 里跑' }),
      l({ id: 'path', title: 'CLI 差异写进定义', rule: '不按名字写分支', paths: ['shared/clis/**'] }),
      l({
        id: 'err',
        title: 'zod 深推断超限拆 schema',
        rule: '报 TS2589 Type instantiation is excessively deep 时拆开',
      }),
    ],
  } as never
  const exps = [
    ProjectExperience.parse({ id: 'drop', title: '掉落表在哪', keywords: ['UDropTable'], paths: ['Source/Loot'] }),
  ]
  const t = task({
    id: 'know1',
    messages: [
      {
        id: 'm1',
        role: 'agent',
        text: '',
        at,
        tools: [{ kind: 'run', label: 'npm run test:e2e', input: 'npm run test:e2e' }],
      },
    ],
  })
  const o = await hookOptions({
    ...ctx({ task: t, orch: { experience: { list: async () => exps } } }),
    project: withLessons,
  })
  assert.ok(o.hookEvents?.includes('tool.before') && o.hookEvents.includes('tool.after'))
  const shell = (command: string, result?: { output: string; failed: boolean }) => ({
    tool: {
      kind: 'shell' as const,
      name: 'Bash',
      input: { command },
      path: '',
      paths: [],
      ...(result ? { result } : {}),
    },
  })
  const a = await o.onHook!('tool.before', shell('cd x && npm run test:e2e'))
  assert.match(a.context ?? '', /e2e 在 WSL 里跑/)
  assert.deepEqual(
    (t as { messages: { tools: { knowledge?: { id: string }[] }[] }[] }).messages[0].tools[0].knowledge?.map(
      (k) => k.id,
    ),
    ['cmd'],
    '标到对话里那一行命令上',
  )
  assert.ok(!(await o.onHook!('tool.before', shell('npm run test:e2e'))).context, '同一条只推一次')
  assert.match((await o.onHook!('tool.before', edit('shared/clis/pi.json'))).context ?? '', /CLI 差异写进定义/)
  const s = await o.onHook!('tool.before', {
    tool: { kind: 'read' as const, name: 'Grep', input: { pattern: 'UDropTable' }, path: '', paths: [] },
  })
  assert.match(s.context ?? '', /掉落表在哪/)
  const e = await o.onHook!(
    'tool.after',
    shell('npx tsc', { output: 'a.ts(1,1): error TS2589: Type instantiation is excessively deep.', failed: true }),
  )
  assert.match(e.context ?? '', /以前遇到过类似的报错[\s\S]*zod 深推断超限/)
  assert.ok(
    recentTriggers().some((x) => x.hookId === 'builtin:push-lessons'),
    '记进最近触发',
  )
})

test('按模型档位加强扶持：弱模型套严格档、第一次改文件前没计划推「先列实现计划」；强模型和以前一样', async () => {
  resetHooksCache()
  await setTier('standard')
  const { resolveSupport, ModelSupportData } = await import('../../shared/models/support.ts')
  const weak = resolveSupport(ModelSupportData.parse({}), 'low')
  const strong = resolveSupport(ModelSupportData.parse({}), 'high')
  const file = path.join(dir, 'b.ts')
  writeFileSync(file, 'export {}\n')
  const w = await hookOptions({ ...ctx({ task: task({ id: 'sup1' }), orch: { plans: {} } }), support: weak })
  const first = await w.onHook!('tool.before', edit(file))
  // 严格档的「改前先读」守卫开起来了：没读过就改会被拦，拦下的调用不推情境规则
  assert.equal(first.deny, true)
  assert.match(first.reason ?? '', /读/)
  const s = await hookOptions({
    ...ctx({ task: task({ id: 'sup2' }), orch: { plans: {} } }),
    support: { ...weak, hookTier: 'standard' },
  })
  const pushed = await s.onHook!('tool.before', edit(file))
  assert.match(pushed.context ?? '', /set_plan 列出实现计划/)
  // 一个对话只推一次
  assert.doesNotMatch((await s.onHook!('tool.before', edit(file))).context ?? '', /实现计划/)
  const st = await hookOptions({ ...ctx({ task: task({ id: 'sup3' }), orch: { plans: {} } }), support: strong })
  assert.doesNotMatch((await st.onHook!('tool.before', edit(file))).context ?? '', /实现计划/)
})

// 实跑 2026-11-22：「识别现场与方案」节点确认后，规划角色把实现、测试全做了，后面的实现节点只能复核
test('工作流里规划角色的节点：改代码被拒绝，方案文档照写；不在节点里（就地用）不拦', async () => {
  resetHooksCache()
  const node = await hookOptions(ctx({ origin: 'builtin:analyst', step: true }))
  const a = await node.onHook!('tool.before', edit(path.join(dir, 'src/catalog.js')))
  assert.equal(a.deny, true)
  assert.match(a.reason!, /不改代码/)
  assert.ok(!(await node.onHook!('tool.before', edit(path.join(dir, 'docs/design.md')))).deny, '方案文档照写')
  const free = await hookOptions(ctx({ origin: 'builtin:analyst' }))
  assert.ok(!(await free.onHook?.('tool.before', edit(path.join(dir, 'src/catalog.js'))))?.deny)
})

// 实跑 2026-11-22：派出去写模块文档的「文档」把文档直接提交到主分支，同目录的 Bug 子对话发现 HEAD 变了
test('派出去的「文档」：文档照写，提交被拒绝', async () => {
  resetHooksCache()
  const docs = await hookOptions(ctx({ origin: 'builtin:docsync', orch: { helper: true } }))
  assert.ok(!(await docs.onHook!('tool.before', edit(path.join(dir, 'docs/modules/a/README.md')))).deny)
  const shell = (command: string) => ({
    tool: { kind: 'shell' as const, name: 'Bash', input: { command }, path: '', paths: [] },
  })
  const c = await docs.onHook!('tool.before', shell('git add docs && git commit -m "docs"'))
  assert.equal(c.deny, true)
  assert.match(c.reason!, /不要提交/)
  assert.ok(!(await docs.onHook!('tool.before', shell('git status'))).deny)
})
