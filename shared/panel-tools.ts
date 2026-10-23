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
  'run_background',
  'check_background',
  'message_parent',
  'suggest_next_step',
  'submit_merge',
  'submit_build',
  'start_plan',
  'set_plan',
  'finish_plan',
  'get_status',
  'begin_edit',
  'run_workflow',
  'close_run',
  'claim_files',
  'release_files',
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
