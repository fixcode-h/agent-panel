/**
 * 面板调度工具（panel MCP）的名字：对话里按「做了什么」显示它们（新建子对话、等待子任务）。
 * Pi 这类用扩展注册工具的 CLI 报上来的是不带服务名的裸名字，解析时要靠这张表认出来，
 * 不然 wait_agents 会因为名字里有 agent 被当成 CLI 自己的子 Agent
 */
export const PANEL_TOOL_NAMES = [
  'create_conversation',
  'send_to_conversation',
  'list_conversations',
  'stop_workflow',
  'spawn_agents',
  'wait_agents',
  'stop_subtask',
  'run_background',
  'check_background',
  'stop_background',
  'message_parent',
  'suggest_next_step',
  'submit_merge',
  'submit_build',
  'finish_child',
  'request_build',
  'list_peers',
  'message_peer',
  'start_plan',
  'start_workflow',
  'list_workflows',
  'message_workflow',
  'revise_workflow',
  'answer_workflow',
  'finish_workflow',
  'submit_diagnosis',
  'request_logs',
  // 随查随记的 Bug 档案草稿（ADR 0046）：只在 Bug 对话里挂，没登记时对话里露出 update_bug_case 原名
  'update_bug_case',
  'remember',
  'set_plan',
  'finish_plan',
  // Agent 用它交代这一轮怎么结束（做完 / 卡住），见 shared/end-turn.ts
  'end_turn',
  // 请用户离开对话去做一件事（等你操作），见 shared/user-action.ts
  'request_user_action',
  'get_status',
  'begin_edit',
  'run_workflow',
  'close_run',
  'claim_files',
  'release_files',
  'p4_split_changelists',
  'cherry_pick',
  'ask_push',
  'use_capability',
  'begin_inline_edit',
  'end_inline_edit',
  'project_lessons',
  'record_lesson',
  'project_experience',
  'record_experience',
  'read_state',
  'write_state',
  'ask_main',
  'send_message',
  'read_messages',
  // 交结论（ADR 0041 第 16 节：状态只认工具调用）
  'submit_verdict',
  'submit_result',
  'dispatch',
  // 提问和补充这几个也挂在同一个面板服务上：不登记的话对话里会显示成原始工具名
  // （带服务名的写法报的是 mcp__panel_xxx__ask_user 这类，界面认不出来）
  'ask_user',
  'read_user_notes',
  'wait_user_message',
  // 操控软件的两个工具（见 docs/adr/0011）
  'app_actions',
  'app_do',
  // 从视频截帧（server/video/agent-frames.ts）
  'video_frames',
  // 不常用工具的入口（见下面的 DEFERRED_TOOLS）
  'more_tools',
] as const

export type PanelToolName = (typeof PANEL_TOOL_NAMES)[number]

/**
 * 面板工具在一段回复里起什么作用，决定回复收尾后怎么折叠（web/src/lib/fold-roles.ts）：
 * - work：干活（改东西、取信息、等结果回来）。总结是「最后一次干活之后说的话」
 * - dispatch：派单，有一个自己往前走的对象（子对话、子任务、工作流运行、后台命令、就地改动）；
 *   对象没办完时这一行不收进折叠
 * - wrap：收尾 / 协调，只把结果交出去或做安排，不干活，不打断总结
 * - ask：要人看的（提问、请用户去操作），一律不折
 * 写成 Record：新登记的工具不选一类就过不了类型检查（设计稿：回复折叠与派单行重设计）
 */
export type ToolRole = 'work' | 'dispatch' | 'wrap' | 'ask'
export const PANEL_TOOL_ROLE: Record<PanelToolName, ToolRole> = {
  create_conversation: 'dispatch',
  send_to_conversation: 'dispatch',
  list_conversations: 'work',
  stop_workflow: 'wrap',
  spawn_agents: 'dispatch',
  // 等子任务算干活：等回来之后写的那段才是总结，等之前那句「派出去了」只是进度说明
  wait_agents: 'work',
  stop_subtask: 'wrap',
  run_background: 'dispatch',
  check_background: 'work',
  stop_background: 'wrap',
  message_parent: 'wrap',
  suggest_next_step: 'wrap',
  submit_merge: 'wrap',
  submit_build: 'wrap',
  finish_child: 'wrap',
  request_build: 'dispatch',
  list_peers: 'work',
  message_peer: 'wrap',
  start_plan: 'dispatch',
  start_workflow: 'dispatch',
  list_workflows: 'work',
  message_workflow: 'wrap',
  revise_workflow: 'wrap',
  answer_workflow: 'wrap',
  finish_workflow: 'wrap',
  submit_diagnosis: 'wrap',
  request_logs: 'wrap',
  update_bug_case: 'wrap',
  remember: 'wrap',
  set_plan: 'wrap',
  finish_plan: 'wrap',
  end_turn: 'wrap',
  request_user_action: 'ask',
  get_status: 'work',
  begin_edit: 'work',
  run_workflow: 'dispatch',
  close_run: 'wrap',
  claim_files: 'work',
  release_files: 'wrap',
  p4_split_changelists: 'work',
  cherry_pick: 'work',
  ask_push: 'ask',
  use_capability: 'work',
  begin_inline_edit: 'dispatch',
  end_inline_edit: 'wrap',
  project_lessons: 'work',
  record_lesson: 'wrap',
  project_experience: 'work',
  record_experience: 'wrap',
  read_state: 'work',
  write_state: 'work',
  ask_main: 'ask',
  send_message: 'wrap',
  read_messages: 'work',
  submit_verdict: 'wrap',
  submit_result: 'wrap',
  dispatch: 'wrap',
  ask_user: 'ask',
  read_user_notes: 'work',
  wait_user_message: 'ask',
  app_actions: 'work',
  app_do: 'work',
  video_frames: 'work',
  // more_tools 本身只是入口：调用方先解包（unwrapMoreTools）再分类；解不开（只查用法）时不算干活
  more_tools: 'wrap',
}

/**
 * 从 CLI 报上来的工具名里认出面板工具，返回裸名字；认不出返回空。各家写法不一样：
 * 裸名字（Pi）、「mcp__panel-xxxx__run_background」「panel_run_background」「mcp_panel-xxxx_run_background」
 */
export const PANEL_TOOL_RE = new RegExp(`panel[\\w-]*[\\W_]{1,4}(${PANEL_TOOL_NAMES.join('|')})\\b`)
export function panelToolName(name: string): string {
  if ((PANEL_TOOL_NAMES as readonly string[]).includes(name)) return name
  return PANEL_TOOL_RE.exec(name)?.[1] ?? ''
}

/**
 * 后台命令那一行（run_background、request_build）的输出里交出去的编号。不锚定开头：
 * 有的 CLI 会在工具结果前面插几行自己的说明（Command Code 的 <repair_note>），锚定了就认不出来、那一行马上显示完成
 */
export function bgJobIds(output: string): string[] {
  const one = /已放到后台（编号 ([0-9a-f]{8})）/.exec(output)
  if (one) return [one[1]]
  const build = /已申请编译（[^\n]*?），编号 ([0-9a-f]{8}(?:、[0-9a-f]{8})*)。/.exec(output)
  return build ? build[1].split('、') : []
}

/** 命令结束后面板接在那一行后面的结果段的开头：带上编号，界面按它判断哪几条已经有结果 */
export const bgResultHead = (id: string) => `【后台命令 ${id} 已结束】`

/** 交出去、还没拿到结果的编号：只要有一条，那一行就一直转圈 */
export function bgPendingIds(output: string): string[] {
  return bgJobIds(output).filter((id) => !output.includes(bgResultHead(id)))
}

/**
 * 命令会不会新开一个命令行 / 终端窗口（Windows 的 start、cmd /k、Start-Process、wt，mac 的 open -a Terminal，
 * Linux 的各家终端）。面板里的命令一律在后台静默跑，输出交回对话；弹窗口既看不到结果，也打断用户手上的事
 */
export function opensWindow(command: string): boolean {
  const seg = String.raw`(?:^|[;&|(\n]\s*|\b(?:call|cmd(?:\.exe)?\s+\/[cs])\s+)`
  return new RegExp(
    seg +
      String.raw`(?:start(?:\.exe)?\b(?!-)|cmd(?:\.exe)?\s+(?:\/\w+\s+)*\/k\b|start-process\b|saps\b|wt(?:\.exe)?\b|conhost(?:\.exe)?\b|open\s+-a\s+\S*terminal|osascript\b[^\n]*terminal|x-terminal-emulator\b|gnome-terminal\b|konsole\b|xterm\b)`,
    'i',
  ).test(command.trim())
}

/** 不常用工具的入口：不直接列出的工具都经它查用法、调用 */
export const MORE_TOOLS = 'more_tools'

/**
 * 不直接列出的面板工具：每个会话都要整份带着全部工具说明（父对话二十多个、上万字），这些一轮里很少用到。
 * 提示词里点名让模型用的（begin_inline_edit、list_peers……）照样能用：more_tools 的说明里列着名字，
 * 直接按名字调也照样执行（server/ask-mcp.ts）。get_status / send_message / read_messages 不能收：
 * Pi 的桥接扩展靠它们核对工具清单是否完整（shared/clis/pi.json 的 CORE_TOOLS）
 */
export const DEFERRED_TOOLS: readonly string[] = [
  'record_lesson',
  'record_experience',
  'begin_inline_edit',
  'end_inline_edit',
  'list_peers',
  'message_peer',
  'stop_subtask',
  'check_background',
  'stop_background',
  'close_run',
  'p4_split_changelists',
  'app_actions',
  'app_do',
  'video_frames',
]

interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema?: unknown
}

const firstSentence = (s = '') => s.split(/(?<=[。.！？])/)[0].slice(0, 80)

/** 把这一轮的工具分成直接列出的和收起来的；收起来的不止一个时才加 more_tools，只有一个就照常列出 */
export function splitDeferred<T extends McpTool>(all: T[]): { listed: (T | McpTool)[]; deferred: T[] } {
  const deferred = all.filter((t) => DEFERRED_TOOLS.includes(t.name))
  if (deferred.length < 2) return { listed: all, deferred: [] }
  const listed: (T | McpTool)[] = all.filter((t) => !DEFERRED_TOOLS.includes(t.name))
  listed.push({
    name: MORE_TOOLS,
    title: '更多面板工具',
    description:
      `下面这些面板工具不常用，没有直接列出：${deferred.map((t) => `${t.name}（${t.title ?? firstSentence(t.description)}）`).join('、')}。` +
      '提示里让你用其中某个、或者确实需要时通过这里调用：先只写 name 看它的用法和参数，再带上 name 和 arguments 调用（没有参数的写 arguments: {}）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '工具名' },
        arguments: { type: 'object', description: '这个工具的参数；不写就是查看用法' },
      },
      required: ['name'],
    },
  })
  return { listed, deferred }
}

/** more_tools 的一次调用：没写 arguments 返回用法，写了就交给调用方按名字执行 */
export function moreTools(
  deferred: McpTool[],
  a: { name?: unknown; arguments?: unknown },
): { call: string; args: unknown } | { content: { type: 'text'; text: string }[]; isError?: boolean } {
  const name = typeof a?.name === 'string' ? a.name.trim() : ''
  const tool = deferred.find((t) => t.name === name)
  if (!tool)
    return {
      content: [
        {
          type: 'text',
          text: `没有这个工具：${name || '（没写 name）'}。可用的：${deferred.map((t) => t.name).join('、')}`,
        },
      ],
      isError: true,
    }
  if (a.arguments === undefined || a.arguments === null)
    return {
      content: [
        {
          type: 'text',
          text: `${tool.name}：${tool.description ?? ''}\n参数（JSON Schema）：${JSON.stringify(tool.inputSchema ?? {})}\n调用：more_tools，name 写 ${tool.name}，arguments 按上面的参数写。`,
        },
      ],
    }
  return { call: tool.name, args: typeof a.arguments === 'object' ? a.arguments : {} }
}

/** 经 more_tools 调用的那一次：拆出真正的工具名和参数，界面按真正的工具显示；不是就返回 undefined */
export function unwrapMoreTools(input: string): { name: string; args: Record<string, unknown> } | undefined {
  try {
    const v = JSON.parse(input)
    if (!v || typeof v.name !== 'string' || !DEFERRED_TOOLS.includes(v.name)) return undefined
    // 没带 arguments 是只查用法（见 moreTools），不是调用：不能显示成「记下教训」这类真做了的事
    if (v.arguments === undefined || v.arguments === null) return undefined
    return { name: v.name, args: typeof v.arguments === 'object' ? v.arguments : {} }
  } catch {
    return undefined
  }
}

/**
 * CLI 按需加载工具定义的那一步（Claude Code 的 ToolSearch、Pi 的 tool_search）：参数里写着要加载的工具名
 * （「select:mcp__panel__finish_child」），但它只是查出工具定义、没有真的调用。
 * 不单独认出来的话，界面会按参数里的面板工具名把它显示成「收尾子对话」，看起来像同一个工具调了两次
 */
export const isToolLookup = (name: string) => /^tool_?search$/i.test(name)

/** 工具查询那一行的副标题：select 写法列出要加载的工具名（去掉 mcp__服务名__ 前缀），关键词搜索原样显示 */
export function toolLookupLabel(query: unknown): string {
  const q = String(query ?? '').trim()
  const select = /^select:(.*)$/s.exec(q)
  if (!select) return q
  return select[1]
    .split(',')
    .map((s) => s.trim().replace(/^mcp__.+?__/, ''))
    .filter(Boolean)
    .join(', ')
}

/**
 * 身份无关的三件核心编排工具：有并行的节点或子任务的对话都有（Orchestra.team）。Pi 的桥接扩展据握手里的
 * orchestration.enabled 核对清单里有没有它们（shared/clis/pi.json 的 CORE_TOOLS，单测核对两边一致）；
 * Chat 模式没有这三件，握手按清单现算成 false（ADR 0038）
 */
export const ORCH_CORE_TOOLS = ['get_status', 'send_message', 'read_messages'] as const
