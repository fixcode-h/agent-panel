import assert from 'node:assert/strict'
import test from 'node:test'
import type { HookFacts } from '../../shared/hooks/index.ts'
import { argHint, loopHint, type ArgHintDeps } from './tool-after-hints.ts'

const LUA_CODE = [
  { name: 'action', type: 'search | files | outline | references', required: true as const },
  { name: 'query', type: 'string' },
  { name: 'project', type: 'string' },
]
const deps: ArgHintDeps = {
  servers: async () => [
    { server: 'idea', names: ['lua_code', 'execute_tool', 'search_in_files_by_text'] },
    { server: 'uetovs', names: ['search_symbols'] },
  ],
  params: async (server, tool) => (server === 'idea' && tool === 'lua_code' ? LUA_CODE : undefined),
}
const call = (name: string, output: string, input: Record<string, unknown> = {}, failed: boolean | undefined = true) =>
  ({ tool: { kind: 'any', name, input, path: '', paths: [], result: { output, failed } } }) as HookFacts

test('参数传错：按缓存的参数表把真实参数补给模型，不按 CLI 写分支认工具名', async () => {
  const text = await argHint(
    't1',
    call('mcp__idea__lua_code', '{"error":"invalid_argument","message":"未知参数 projectPath"}'),
    deps,
  )
  assert.match(text, /idea 服务的 `lua_code` 报参数不对/)
  assert.match(text, /action（必填）：search \| files \| outline \| references、query：string、project：string/)
  assert.match(text, /不要换个值原样再试/)
  // 同一个对话同一个工具只补一次；别的对话照样补
  assert.equal(await argHint('t1', call('mcp__idea__lua_code', 'Unknown argument: projectPath'), deps), '')
  assert.match(await argHint('t2', call('idea_lua_code', 'Unknown argument: x'), deps), /`lua_code`/)
  // 经仅路由器的 execute_tool 转调：认出 command 里的工具
  const routed = await argHint(
    't3',
    call('mcp__idea__execute_tool', 'Unknown parameter: foo', { command: 'lua_code --foo 1' }),
    deps,
  )
  assert.match(routed, /`lua_code`[^\n]*action（必填）[^\n]*lua_code --参数名 值/)
})

test('参数传错：没有参数表时让它照报错改；成功的、不是参数错的、面板自己的工具不管', async () => {
  assert.match(
    await argHint('t4', call('mcp__uetovs__search_symbols', 'MCP error -32602: Invalid arguments'), deps),
    /先加载这个工具的说明/,
  )
  assert.equal(await argHint('t5', call('mcp__idea__lua_code', 'Unknown argument', {}, false), deps), '')
  assert.equal(await argHint('t5', call('mcp__idea__lua_code', 'timeout'), deps), '')
  const panel = call('mcp__panel-1__set_plan', 'Unknown argument')
  panel.tool!.panel = 'set_plan'
  assert.equal(await argHint('t5', panel, deps), '')
})

test('原地打转：同一条命令连续失败到次数提醒一次，成功清零', () => {
  const sh = (failed: boolean) =>
    ({
      tool: {
        kind: 'shell',
        name: 'Bash',
        input: { command: 'npm test' },
        path: '',
        paths: [],
        result: { output: '', failed },
      },
    }) as HookFacts
  assert.equal(loopHint('l1', sh(true), 2), '')
  assert.match(loopHint('l1', sh(true), 2), /连续失败 2 次/)
  loopHint('l1', sh(false), 2)
  assert.equal(loopHint('l1', sh(true), 2), '')
})
