import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  apiQueueWait,
  compactionText,
  deliveredToCli,
  groupTools,
  jobLabel,
  lastCompaction,
  messageRecorded,
  startedRun,
  tokenGroups,
  toolView,
  withTurnSeenAt,
} from './tasks.ts'
import type { TaskMessage, ToolUse } from '../../../shared/schema.ts'
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
  // 带服务名的写法（Command Code 走配置文件接 MCP）
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
  // CLI 在结果前面插了自己的说明（Command Code 的 repair_note）：照样认出编号，没拿到结果前算在等
  const noted = toolView(
    tool('mcp__panel__run_background', '', {
      input: '{"command":"node scripts/ui-check.mjs 02"}',
      output: '<repair_note>Coerced string `exclusive` to a boolean.</repair_note>\n已放到后台（编号 fb0d6fa4）。',
    }),
  )
  assert.equal(noted?.job, 'fb0d6fa4')
  assert.equal(noted?.waiting, true)
  const done = toolView(
    tool('mcp__panel__run_background', '', {
      output: '已放到后台（编号 fb0d6fa4）。\n\n【后台命令 fb0d6fa4 已结束】后台命令「检查」跑完了：成功',
    }),
  )
  assert.equal(done?.waiting, undefined, '结果接上了就不再等')
})

test('后台命令：命令在 input 原文里时，折叠行显示命令，不再只剩「后台命令」', () => {
  // 解析层对带 command 的输入直接存命令原文（不是 JSON），参数解析拿不到 name / command
  const command = 'npm ci > /tmp/npmci.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/npmci.log'
  const plain = tool('mcp__panel__run_background', '', {
    input: command,
    output: '已放到后台（编号 1a2b3c4d）。跑完结果会自动推回给你，先去做不依赖它的事。',
  })
  const view = toolView(plain)
  assert.equal(view?.tool.name, '后台命令')
  assert.equal(view?.tool.label, command)
  // 展开的 IN 还是完整命令
  assert.equal(view?.tool.input, command)
  assert.equal(view?.job, '1a2b3c4d')

  // 多行命令只取第一行：折叠行不换行、不撑破
  const multi = toolView(tool('mcp__panel__run_background', '', { input: 'npm run build\nls -la\n' }))
  assert.equal(multi?.tool.label, 'npm run build')
  assert.equal(multi?.tool.input, 'npm run build\nls -la')

  // 给的 JSON 参数里没有 name：标题用命令
  const unnamed = toolView(tool('mcp__panel__run_background', '', { input: '{"command":"npm test"}' }))
  assert.equal(unnamed?.tool.label, 'npm test')

  // 命令本身是合法的 JSON 字面量（true、false 是真实存在的 shell 命令）：同样要当成命令原文
  for (const literal of ['true', 'false']) {
    const v = toolView(tool('mcp__panel__run_background', '', { input: literal }))
    assert.equal(v?.tool.label, literal)
    assert.equal(v?.tool.input, literal)
  }

  // 有 name 时优先用名字
  const named = toolView(tool('mcp__panel__run_background', '', { input: '{"command":"npm test","name":"单元测试"}' }))
  assert.equal(named?.tool.label, '单元测试')
})

test('运行区的后台命令名：没有名字时用命令第一行', () => {
  assert.equal(jobLabel({ name: '端到端测试', command: 'npm run test:e2e' }), '端到端测试')
  assert.equal(jobLabel({ name: '', command: 'npm run build\nls -la' }), 'npm run build')
  // 名字和命令都没有时才退回动作名，不能是空串
  assert.equal(jobLabel({ name: '', command: '' }), '后台命令')
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

test('toolView：给别的对话发消息的几个工具画成「发送消息」，带类型、收件方和正文', () => {
  const send = toolView(
    tool('mcp__panel__send_to_conversation', '', {
      input: '{"id":"c1","message":"把侧栏时间改成相对时间"}',
      output: '「修侧栏」正在执行，已实时送达',
    }),
  )
  assert.deepEqual(send?.send, { kind: 'task', to: '修侧栏', body: '把侧栏时间改成相对时间' })
  assert.equal(send?.child, 'c1')
  const ask = toolView(
    tool('mcp__panel__message_parent', '', { input: '{"text":"用哪个库？","question":true,"options":["a","b"]}' }),
  )
  assert.equal(ask?.send?.kind, 'question')
  assert.equal(ask?.send?.body, '用哪个库？\n\n1. a\n2. b')
  const report = toolView(tool('mcp__panel__message_parent', '', { input: '{"text":"做完了"}' }))
  assert.equal(report?.send?.kind, 'report')
  const peer = toolView(
    tool('mcp__panel__message_peer', '', { input: '{"id":"p2","text":"我先编"}', output: '已交给父对话「美术」' }),
  )
  assert.deepEqual(peer?.send, { kind: 'chat', to: '美术', body: '我先编' })
  // 节点之间、给子任务传话（send_message）：正文由这一行承载，不再铺成居中的系统块
  const chat = toolView(
    tool('mcp__panel__send_message', '', {
      input: '{"to":"测试","text":"接口改名了"}',
      output: '已交给正在执行的「测试」',
    }),
  )
  assert.deepEqual(chat?.send, { kind: 'chat', to: '测试', body: '接口改名了' })
  // 别的面板工具不是发消息
  assert.equal(toolView(tool('mcp__panel__get_status', ''))?.send, undefined)
})

test('groupTools：相邻几次把同一段话交给不同子对话合成一行，别的工具和不同的话各占一行', () => {
  const send = (id: string, message: string) =>
    tool('MCP', 'panel · send_to_conversation', {
      input: JSON.stringify({ id, message }),
      output: `已交给子对话「${id}」`,
    })
  const read = tool('读取', 'a.ts', { kind: 'read' })
  const groups = groupTools([
    send('c1', '规则'),
    send('c2', '规则'),
    send('c3', '规则'),
    send('c1', '别的'),
    read,
    send('c2', '别的'),
  ])
  assert.deepEqual(
    groups.map((g) => g.length),
    [3, 1, 1, 1],
  )
})

/**
 * 截图上那个矛盾：左边写着「排队等 API 名额 · 下一个就是这里」，右边同一行显示 188.7 token/s。
 * 这一轮其实在输出，只是等完子任务拿回名额时排上了队 —— 不能显示成「还没开始」。
 */
test('状态行：让出名额后拿回的排队不显示成「排队等名额」', () => {
  assert.equal(apiQueueWait({ apiWait: { api: 'OpenDesign', ahead: 0, reason: 'yield' } }, false), undefined)
  assert.equal(apiQueueWait({ apiWait: { api: 'OpenDesign', ahead: 3, reason: 'yield' } }, false), undefined)
})

test('状态行：开跑前真的在排队时照常显示，没有标记时什么都不显示', () => {
  assert.equal(apiQueueWait({ apiWait: { api: 'OpenDesign', ahead: 2, reason: 'start' } }, false)?.ahead, 2)
  assert.deepEqual(apiQueueWait({ apiWait: { api: 'OpenDesign', ahead: 0, reason: 'start' } }, false), {
    api: 'OpenDesign',
    ahead: 0,
    reason: 'start',
  })
  assert.equal(apiQueueWait({}, false), undefined)
  assert.equal(apiQueueWait({}, true), undefined)
})

test('状态行：已经在出 token 时不当成在排队', () => {
  // 实时速度大于 0 就是真的在输出，两个信息同时出现时以「在输出」为准
  assert.equal(apiQueueWait({ apiWait: { api: 'OpenDesign', ahead: 0, reason: 'start' } }, true), undefined)
})

test('messageRecorded：服务端没回写这条消息（/rule 这类面板命令）时要撤掉本地待认领的那条', () => {
  assert.equal(messageRecorded([{ id: 'm1' }, { id: 'm2' }], 'm1'), true)
  // /rule：服务端只 push 一条 system 提示，返回的对话里没有页面传上去的 id
  assert.equal(messageRecorded([{ id: 'm1' }], 'pending-id'), false)
  assert.equal(messageRecorded([], 'pending-id'), false)
})

test('deliveredToCli：请求报错时服务端其实已交给 CLI 的不要恢复草稿，标了没送出去的才恢复', () => {
  for (const how of ['wait', 'steer', 'notes', 'held', 'next'] as const)
    assert.equal(deliveredToCli({ delivery: { how, at: '' } }), true)
  assert.equal(deliveredToCli({ delivery: { how: 'lost', at: '' } }), false)
  // pending 是页面本地还没交出去的状态，不能当成已交付（否则会把用户的文字丢掉）
  assert.equal(deliveredToCli({ delivery: { how: 'pending', at: '' } }), false)
  assert.equal(deliveredToCli({}), false)
  assert.equal(deliveredToCli(undefined), false)
})

test('withTurnSeenAt：/seen 只回来的「看到哪」合进本地那份，对话不重造、值没变就不换对象', () => {
  const base = {
    id: 't1',
    turnDoneAt: '2026-10-01T03:00:00.000Z',
    turnSeenAt: '',
    messages: [{ id: 'm1' }],
  } as unknown as Parameters<typeof withTurnSeenAt>[0]
  const next = withTurnSeenAt(base, base.turnDoneAt)
  assert.equal(next.turnSeenAt, base.turnDoneAt)
  assert.equal(next.messages, base.messages, '消息数组原样带过去，不从接口整份换回来')
  // 已经一样就不换对象：侧栏和对话页不用为一次心跳重渲染
  assert.equal(withTurnSeenAt(next, base.turnDoneAt), next)
})

/** 一次压缩工具调用：只写有值的数值，和真实数据里缺 before / after 的样子一致 */
const compactTool = (before?: number, after?: number): ToolUse => {
  const values = { ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }
  return { kind: 'compact', label: '', detail: '', ...(Object.keys(values).length ? { compact: values } : {}) }
}

const chatMessage = (over: Partial<TaskMessage>): TaskMessage =>
  ({
    id: 'm',
    role: 'agent',
    agentId: '',
    step: '',
    text: '',
    tools: [],
    at: '2026-10-27T10:00:00.000Z',
    ...over,
  }) as TaskMessage

test('压缩记录：按节点 / Agent 取最近一次，缺时间、缺数值时降级显示', () => {
  const messages = [
    chatMessage({ id: 'a', step: 'n1', at: '2026-10-27T10:00:00.000Z', tools: [compactTool(90_000, 20_000)] }),
    chatMessage({
      id: 'b',
      step: 'n1/review.1',
      at: '2026-10-27T11:00:00.000Z',
      tools: [compactTool(80_000, 18_000)],
    }),
    chatMessage({ id: 'c', agentId: 'a2', at: '2026-10-27T12:00:00.000Z', tools: [compactTool(70_000, 15_000)] }),
    // 续接、补写时消息顺序不保证按时间：更早的那条排在后面
    chatMessage({ id: 'd', step: 'n1', at: '2026-10-27T09:00:00.000Z', tools: [compactTool(100_000, 30_000)] }),
  ]
  // 节点自己和它派出的子节点（step 带前缀）都算这个节点的压缩（workflow 一行代表整个顶层节点）
  assert.deepEqual(
    lastCompaction(messages, (m) => m.step === 'n1' || m.step.startsWith('n1/')),
    { at: '2026-10-27T11:00:00.000Z', before: 80_000, after: 18_000 },
  )
  // scope 里子步骤已经单列成行：精确匹配只算这个节点自己的压缩，不把子节点的算进来
  assert.deepEqual(
    lastCompaction(messages, (m) => m.step === 'n1'),
    {
      at: '2026-10-27T10:00:00.000Z',
      before: 90_000,
      after: 20_000,
    },
  )
  assert.deepEqual(
    lastCompaction(messages, (m) => m.agentId === 'a2'),
    {
      at: '2026-10-27T12:00:00.000Z',
      before: 70_000,
      after: 15_000,
    },
  )
  // 没有压缩记录的行返回 undefined，界面据此不显示这一行
  assert.equal(
    lastCompaction(messages, (m) => m.step === 'n2'),
    undefined,
  )
  // 老数据没有结构化数值时只保留时间；只有压缩前、只有压缩后的数值也都保留
  const legacy = lastCompaction([chatMessage({ tools: [{ kind: 'compact', label: '', detail: '' }] })], () => true)
  assert.equal(legacy?.at, '2026-10-27T10:00:00.000Z')
  assert.equal(legacy?.before, undefined)
  assert.equal(legacy?.after, undefined)
  const beforeOnly = lastCompaction([chatMessage({ tools: [compactTool(90_000)] })], () => true)
  assert.equal(beforeOnly?.before, 90_000)
  assert.equal(beforeOnly?.after, undefined)

  // 文案：时间 + 前后大小，缺哪项就不写哪项；断言用英文，不受本机语言影响
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
  setLang('en')
  try {
    assert.equal(
      compactionText({ at: fiveMinutesAgo, before: 176_000, after: 24_000 }),
      'Compacted 5m ago · Before 176.0k · after 24.0k',
    )
    assert.equal(compactionText({ at: fiveMinutesAgo, before: 176_000 }), 'Compacted 5m ago · Before 176.0k')
    assert.equal(compactionText({ at: fiveMinutesAgo, after: 24_000 }), 'Compacted 5m ago · After 24.0k')
    // 没有时间（老数据）时只剩数值；什么都没有时返回空字符串，不画这一行
    assert.equal(compactionText({ at: '', before: 176_000 }), 'Before 176.0k')
    assert.equal(compactionText({ at: '' }), '')
  } finally {
    setLang('zh')
  }
})
