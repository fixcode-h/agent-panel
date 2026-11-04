import assert from 'node:assert/strict'
import test from 'node:test'
import { checkOutput, globMatch, hookApplies, HookDef, type HookInput } from './hook-defs.ts'
import { setLang } from './i18n.ts'

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
