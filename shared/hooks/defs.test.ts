import assert from 'node:assert/strict'
import test from 'node:test'
import { checkOutput, commandSegments, globMatch, hookApplies, HookDef, type HookInput } from './defs.ts'
import { setLang } from '../i18n.ts'

setLang('zh')

// 钩子规范（ADR 0049 第二期）：输出按事件只认对应的字段，范围和匹配都对上才跑

const hook = (over: Partial<HookDef> = {}) =>
  HookDef.parse({
    id: 'h1',
    name: '测试',
    event: 'tool.before',
    action: { type: 'command', script: 'process.stdout.write("{}")' },
    enabled: true,
    ...over,
  })

const input = (over: Partial<HookInput> = {}): HookInput => ({
  event: 'tool.before',
  task: { id: 't', title: '', parent: true },
  project: { id: 'p1', path: '/p' },
  agent: { id: 'a1', name: '执行' },
  cli: 'claude',
  tool: { kind: 'edit', name: 'Edit', input: { file_path: 'src/a.ts' } },
  ...over,
})

test('输出按事件检查：不支持的字段、拦住没写原因都算格式错，空输出是不表态', () => {
  assert.deepEqual(checkOutput('tool.after', undefined), { out: {} })
  assert.deepEqual(checkOutput('tool.before', { deny: true, reason: '不行' }), { out: { deny: true, reason: '不行' } })
  assert.ok('error' in checkOutput('tool.after', { deny: true, reason: 'x' }), '工具后不能拒绝')
  assert.ok('error' in checkOutput('turn.beforeEnd', { block: true }), '拦住要写原因')
  assert.ok('error' in checkOutput('context.restored', [1]), '要是对象')
  assert.deepEqual(checkOutput('turn.beforeEnd', { block: true, reason: '接着做' }), {
    out: { block: true, reason: '接着做' },
  })
})

test('路径通配：** 跨目录、* 不跨目录', () => {
  assert.ok(globMatch('src/**/*.ts', 'src/a/b/c.ts'))
  assert.ok(globMatch('src/**/*.ts', 'src/c.ts'))
  assert.ok(!globMatch('src/*.ts', 'src/a/c.ts'))
  assert.ok(globMatch('**/*-lock.json', 'package-lock.json'))
})

test('范围和匹配：关着的、事件不对、范围外、工具类别 / 路径 / 命令对不上的都不跑', () => {
  assert.ok(hookApplies(hook(), input(), 'src/a.ts'))
  assert.ok(!hookApplies(hook({ enabled: false }), input(), 'src/a.ts'))
  assert.ok(!hookApplies(hook({ event: 'tool.after' }), input(), 'src/a.ts'))
  assert.ok(!hookApplies(hook({ scope: { projects: ['p2'], agents: [], clis: [] } }), input(), 'src/a.ts'))
  assert.ok(!hookApplies(hook({ scope: { projects: [], agents: [], clis: ['codex'] } }), input(), 'src/a.ts'))
  assert.ok(!hookApplies(hook({ match: { tool: 'shell', path: '', command: '' } }), input(), 'src/a.ts'))
  assert.ok(!hookApplies(hook({ match: { tool: 'any', path: 'docs/**', command: '' } }), input(), 'src/a.ts'))
  const sh = input({ tool: { kind: 'shell', name: 'Bash', input: { command: 'git push origin dev' } } })
  assert.ok(hookApplies(hook({ match: { tool: 'shell', path: '', command: 'git push' } }), sh))
  assert.ok(!hookApplies(hook({ match: { tool: 'shell', path: '', command: 'npm' } }), sh))
  // 模型常在前面加 cd：按 &&、; 拆开逐段比
  const cd = input({ tool: { kind: 'shell', name: 'bash', input: { command: 'cd /p && npm test 2>&1 | tail -20' } } })
  assert.ok(hookApplies(hook({ match: { tool: 'shell', path: '', command: 'npm test' } }), cd))
  // 面板工具按名字比
  const pt = input({ tool: { kind: 'panel', name: 'mcp__panel__submit_merge', input: {}, panel: 'submit_merge' } })
  assert.ok(hookApplies(hook({ match: { tool: 'panel', path: '', command: 'submit_merge' } }), pt))
  assert.ok(!hookApplies(hook({ match: { tool: 'panel', path: '', command: 'spawn_agents' } }), pt))
})

test('新建的钩子默认关着；动作只能是脚本或 HTTP，请求头只引用环境变量', () => {
  const h = HookDef.parse({ id: 'x', name: 'n', event: 'tool.after', action: { type: 'command', script: 'x' } })
  assert.equal(h.enabled, false)
  assert.equal(h.onError, 'allow')
  assert.ok(
    !HookDef.safeParse({ id: 'x', name: 'n', event: 'tool.after', action: { type: 'shell', cmd: 'x' } }).success,
  )
  const http = HookDef.parse({
    id: 'x',
    name: 'n',
    event: 'tool.after',
    action: { type: 'http', url: 'https://example.com/hook', headers: [{ key: 'Authorization', env: 'MY_TOKEN' }] },
  })
  assert.equal(http.action.type === 'http' && http.action.headers[0].env, 'MY_TOKEN')
})

test('AI 创建的提案：范围里写的角色名、项目名换成 id，对不上的退回给 AI 改；一律关着、来源 ai', async () => {
  const { resolveHookProposal } = await import('../assist-hook.ts')
  const agents = [{ id: 'r1', name: '评审' }] as never
  const subject = { projects: JSON.stringify([{ id: 'p1', name: '商城' }]) }
  const base = { name: '评审禁止提交', event: 'tool.before', action: { type: 'command', script: 'x' }, enabled: true }
  const ok = resolveHookProposal(
    { ...base, scope: { agents: ['评审'], projects: ['商城'], clis: [] } },
    subject,
    agents,
  )
  assert.deepEqual(ok.proposal?.hook.scope, { agents: ['r1'], projects: ['p1'], clis: [] })
  assert.equal(ok.proposal?.hook.enabled, false)
  assert.equal(ok.proposal?.hook.createdBy, 'ai')
  const bad = resolveHookProposal({ ...base, scope: { agents: ['不存在'], projects: [], clis: [] } }, subject, agents)
  assert.match(bad.error ?? '', /不存在/)
})

test('命令按段比之前剥掉外壳：cmd /c、wsl -e、powershell -Command、bash -c、& 套几层也认得出里面的命令', () => {
  // 用户 2026-11-05 问到：Windows 上 PowerShell 工具里 `cmd /c git push`、`wsl -e git push`，以前这一段开头是 cmd / wsl，守卫对不上
  assert.deepEqual(commandSegments('cd a && cmd /c git push origin dev'), ['cd a', 'git push origin dev'])
  assert.deepEqual(commandSegments('cmd.exe /C "git add . && git push"'), ['git add .', 'git push'])
  assert.deepEqual(commandSegments('wsl -d Ubuntu -e git push'), ['git push'])
  assert.deepEqual(commandSegments('wsl -- bash -lc "git push"'), ['git push'])
  assert.deepEqual(commandSegments('pwsh -NoProfile -Command "git push; git status"'), ['git push', 'git status'])
  assert.deepEqual(commandSegments('& git push'), ['git push'])
  assert.deepEqual(commandSegments('npm test | tail -5'), ['npm test', 'tail -5'], '没有外壳的照旧按段切')
})
