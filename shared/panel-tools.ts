/**
 * 面板调度工具（panel MCP）的名字：对话里按「做了什么」显示它们（新建子对话、等待子任务）。
 * Pi 这类用扩展注册工具的 CLI 报上来的是不带服务名的裸名字，解析时要靠这张表认出来，
 * 不然 wait_agents 会因为名字里有 agent 被当成 CLI 自己的子 Agent
 */
export const PANEL_TOOL_NAMES = [
  'create_conversation',
  'send_to_conversation',
  'list_conversations',
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
  'set_plan',
  'finish_plan',
  'get_status',
  'begin_edit',
  'run_workflow',
  'close_run',
  'claim_files',
  'release_files',
  'p4_split_changelists',
  'project_lessons',
  'record_lesson',
  'read_state',
  'write_state',
  'ask_main',
  'send_message',
  'read_messages',
  // 提问和补充这几个也挂在同一个面板服务上：不登记的话对话里会显示成原始工具名
  // （Command Code、Gemini CLI 报的是 mcp__panel_xxx__ask_user 这类，界面认不出来）
  'ask_user',
  'read_user_notes',
  'wait_user_message',
] as const

/**
 * 从 CLI 报上来的工具名里认出面板工具，返回裸名字；认不出返回空。各家写法不一样：
 * 裸名字（Pi）、「mcp__panel-xxxx__run_background」「panel_run_background」「mcp_panel-xxxx_run_background」
 */
const PANEL_TOOL_RE = new RegExp(`panel[\\w-]*[\\W_]{1,4}(${PANEL_TOOL_NAMES.join('|')})\\b`)
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
