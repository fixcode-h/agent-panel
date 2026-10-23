import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tokenGroups, toolView } from './tasks.ts'
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
