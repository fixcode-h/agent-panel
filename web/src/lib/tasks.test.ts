import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startedRun, tokenGroups, toolView } from './tasks.ts'
import { setLang } from '../../../shared/i18n.ts'

// 断言里是中文，不管本机是什么语言
setLang('zh')

const tool = (name: string, label: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'other', name, label, detail: '', input: '', ...extra }) as Parameters<typeof toolView>[0]

test('面板工具在对话里显示中文名，不再露出原始工具名', () => {
  // Pi 的桥接扩展注册裸名字，解析层会归一成 mcp__panel__<name>，界面按「做了什么」显示
  const record = toolView(
    tool('mcp__panel__record_lesson', '写进配置', { input: '{"title":"写进配置","rule":"说明"}' }),
  )
  assert.equal(record?.tool.name, '记下教训')
  assert.equal(record?.tool.label, '写进配置')

  // 带 id 的是改写已有的一条
  const rewrite = toolView(tool('mcp__panel__record_lesson', '改写', { input: '{"id":"l1","title":"旧规则"}' }))
  assert.equal(rewrite?.tool.name, '改写教训')

  const view = toolView(tool('mcp__panel__project_lessons', '查看', { input: '{"files":["a.ts"]}' }))
  assert.equal(view?.tool.name, '查看项目教训')
  assert.equal(view?.tool.label, 'a.ts')

  assert.equal(toolView(tool('mcp__panel__get_status', ''))?.tool.name, '查看节点状态')
  assert.equal(toolView(tool('mcp__panel__wait_agents', ''))?.tool.name, '等待子任务')
})

test('面板挂在同一个服务上的提问、补充工具也显示中文名', () => {
  // 这三个没登记进 PANEL_TOOL_NAMES 时，对话里会直接露出 mcp__panel-xxxx__read_user_notes 这串名字
  const notes = toolView(tool('mcp__panel__read_user_notes', ''))
  assert.equal(notes?.tool.name, '查看用户补充')
  assert.equal(notes?.tool.kind, 'read')
  // 带服务名的写法（Command Code、Gemini CLI 走配置文件接 MCP）
  assert.equal(toolView(tool('mcp__panel-142a58__read_user_notes', ''))?.tool.name, '查看用户补充')
  const ask = toolView(tool('mcp__panel-142a58__ask_user', '', { input: '{"questions":[{"question":"先做哪个？"}]}' }))
  assert.equal(ask?.tool.name, '向用户提问')
  assert.equal(ask?.tool.label, '先做哪个？')
  assert.equal(toolView(tool('mcp__panel__wait_user_message', ''))?.tool.name, '等待用户消息')
})

test('MCP 服务名的写法也认：panel-xxxx · record_lesson', () => {
  const view = toolView(tool('MCP', 'panel-ab12cd · record_lesson', { input: '{"title":"写进配置"}' }))
  assert.equal(view?.tool.name, '记下教训')
  assert.equal(view?.server, undefined)
})

test('别的 MCP 服务里的同名工具不会被当成面板工具', () => {
  // 带服务名的才会被当成那家的工具，显示服务名 + 原始工具名
  const other = toolView(tool('MCP', 'notion · record_lesson', { input: '{"title":"x"}' }))
  assert.equal(other?.server, 'notion')
  assert.equal(other?.tool.name, 'record_lesson')
  // 只是名字里带着这几个词的不算面板工具：仍按原始工具显示（run、read 这种）
  assert.equal(toolView(tool('run', 'git status'))?.tool.name, 'run')
  assert.equal(toolView(tool('read', 'README.md'))?.tool.name, 'read')
})

/** Token 合计：只造浮层用到的字段 */
const tokens = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
})

test('Token 分组：没有子对话和子任务时不出现「子任务 0」', () => {
  // 只有本对话：分组为空，浮层和以前一样只显示总数和输入输出
  assert.deepEqual(
    tokenGroups({ own: tokens(100, 10), sub: tokens(0, 0), tps: 12, subTps: 0, children: 0, helpers: 0 }),
    [],
  )
  // 有子任务与子对话：两行，两行的速度加起来正好是整体速度
  const groups = tokenGroups({
    own: tokens(100, 10),
    sub: tokens(50, 5),
    tps: 12,
    subTps: 8,
    children: 1,
    helpers: 2,
  })
  assert.deepEqual(groups, [
    { key: 'own', tokens: 110, tps: 12 },
    { key: 'sub', tokens: 55, tps: 8 },
  ])
  // 子任务刚派出去、还没花 token：有数量也要列出来（否则用户看不出有子任务在跑）
  assert.equal(
    tokenGroups({ own: tokens(100, 10), sub: tokens(0, 0), tps: 3, subTps: 0, children: 0, helpers: 1 }).length,
    2,
  )
  // 子任务那一行的速度就是子任务与子对话自己的实时速度（停下的部分是 0，不当成噪声去掉）
  const idle = tokenGroups({ own: tokens(100, 10), sub: tokens(50, 5), tps: 0, subTps: 0, children: 1, helpers: 0 })
  assert.deepEqual(idle, [
    { key: 'own', tokens: 110, tps: 0 },
    { key: 'sub', tokens: 55, tps: 0 },
  ])
})

test('放到后台的命令记下面板给的编号：命令还在跑时那一行一直转圈', () => {
  const view = toolView(
    tool('mcp__panel__run_background', '', {
      input: '{"command":"npm test","name":"单元测试"}',
      output: '已放到后台（编号 1a2b3c4d）。跑完结果会自动推回给你，先去做不依赖它的事。',
    }),
  )
  assert.equal(view?.job, '1a2b3c4d')
  assert.equal(view?.tool.label, '单元测试')
  assert.equal(toolView(tool('mcp__panel__check_background', '', { input: '{"id":"1a2b3c4d"}' }))?.job, undefined)
  // 旧数据：带前缀的后台命令被解析成了 CLI 自己的「运行命令」，按面板的回复认回来，照样转圈
  const old = toolView({
    kind: 'run',
    label: 'npx playwright install',
    detail: '',
    output: '已放到后台（编号 6a369828）。跑完结果会自动推回给你，先去做不依赖它的事。',
  } as Parameters<typeof toolView>[0])
  assert.equal(old?.job, '6a369828')
  assert.equal(old?.tool.name, '后台命令')
  assert.equal(old?.tool.label, 'npx playwright install')
})

test('「启动工作流」一行认回启动的是第几次运行', () => {
  const start = (input: string, output = '') =>
    tool('mcp__panel__start_plan', '启动工作流', { input: `{"input":"${input}"}`, output })
  const msg = (at: number, step: string, tools: Parameters<typeof toolView>[0][] = []) =>
    ({ id: `m${at}`, role: 'agent', agentId: 'a', step, text: '', tools, at: String(at) }) as never
  // 主 Agent 的常驻节点不是一次运行里的节点，后面的运行按节点 id 前缀分
  const step = (id: string, runId: number) => ({ id, kind: 'agent', parentId: '', runId }) as never
  const task = (messages: unknown[], steps: unknown[]) => ({ messages, steps }) as never

  // 第一次运行：调用之后第一条属于运行节点的消息，那个节点的 runId 就是这次运行
  const first = start('补接口')
  const one = task([msg(1, '@main', [first]), msg(2, 'n1'), msg(3, '@main')], [step('@main', 1), step('n1', 1)])
  assert.equal(startedRun(one, toolView(first)!.tool), 1)

  // 第二次运行的节点带 r2/ 前缀：同一次调用对上的还是第一次运行
  const two = task(
    [msg(1, '@main', [first]), msg(2, 'n1'), msg(3, 'r2/n1')],
    [step('@main', 1), step('n1', 1), step('r2/n1', 2)],
  )
  assert.equal(startedRun(two, toolView(first)!.tool), 1)

  // 调用没跑起来（后面又启动了一次）：没有运行可看，界面按「没有启动运行」显示原因
  const failed = start('跑不起来')
  const none = task([msg(1, '@main', [failed]), msg(2, '@main', [start('另一件事')])], [step('@main', 1)])
  assert.equal(startedRun(none, toolView(failed)!.tool), undefined)

  // 认不回同一次调用时不乱认到别的运行上
  const other = task([msg(1, '@main', [failed]), msg(2, 'n1')], [step('@main', 1), step('n1', 1)])
  assert.equal(startedRun(other, toolView(start('另一件事'))!.tool), undefined)
})
