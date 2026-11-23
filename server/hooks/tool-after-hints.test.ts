import assert from 'node:assert/strict'
import test from 'node:test'
import type { HookFacts } from '../../shared/hooks/index.ts'
import { argHint, ideProjectHint, loopHint, type ArgHintDeps } from './tool-after-hints.ts'
import { ideProjectOf } from '../mcp-catalog/ide-project.ts'

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

const noProject = (paths: string[]) =>
  'Unable to determine the target project for the current MCP tool call.\n Currently open projects: ' +
  JSON.stringify({ projects: paths.map((path) => ({ path })) })

test('IDE 定不了项目：按工作目录挑出 projectPath 让 Agent 带上重调并记下；挑不出来列编号问用户', async () => {
  const d = { servers: deps.servers, projectId: 'p1', dirs: ['G:/P4/ws', 'G:/P4/ws'] }
  const out = noProject(['G:/P4/ws/Project', 'D:/Other'])
  const text = await ideProjectHint('i1', call('mcp__idea__lua_code', out, { action: 'search' }), d)
  assert.match(text, /对上的是 `G:\/P4\/ws\/Project`[^\n]*`projectPath`=`G:\/P4\/ws\/Project` 原样重调/)
  assert.equal(ideProjectOf('p1', 'idea'), 'G:/P4/ws/Project')
  // 同一句一个对话只说一次
  assert.equal(await ideProjectHint('i1', call('mcp__idea__lua_code', out), d), '')
  // 经 execute_tool 转调：写明 command 里加 --projectPath
  assert.match(
    await ideProjectHint('i2', call('mcp__idea__execute_tool', out, { command: 'lua_code --action search' }), d),
    /command 里加 `--projectPath "G:\/P4\/ws\/Project"`/,
  )
  // 带着挑出来的路径还失败：忘掉，交给用户选，不让它重试同一个
  const again = await ideProjectHint('i3', call('mcp__idea__lua_code', out, { projectPath: 'G:/P4/ws/Project' }), d)
  assert.match(again, /停下来把这个编号列表给用户/)
  assert.match(again, /1\. D:\/Other/)
  assert.equal(ideProjectOf('p1', 'idea'), undefined)
  // 工作目录下有两个项目：列这两个问用户
  const many = await ideProjectHint('i4', call('mcp__idea__lua_code', noProject(['G:/P4/ws/A', 'G:/P4/ws/B'])), d)
  assert.match(many, /1\. G:\/P4\/ws\/A\n2\. G:\/P4\/ws\/B/)
  // 别的报错、成功的结果不管
  assert.equal(await ideProjectHint('i5', call('mcp__idea__lua_code', '{"error":"indexing"}'), d), '')
  assert.equal(await ideProjectHint('i6', call('mcp__idea__lua_code', out, {}, false), d), '')
})
