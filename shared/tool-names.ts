import { t } from './i18n.ts'

/**
 * 面板自带的 MCP 工具在对话里的中文叫法，只在这一处维护：对话里的工具行、「正在写」那一行、子对话活动、
 * 查询 MCP 工具那一行的副标题都从这里取。没登记的工具会在工具行里露出英文原名（例如 update_bug_case 带个 panel 标签），
 * 所以新加面板工具（server/orch-mcp.ts、workflow-tools.ts、diagnosis-tool.ts、design-mcp.ts、blender-mcp.ts）时同时登记这里，
 * web/src/lib/tool-names.test.ts 会核对面板工具总表（PANEL_TOOL_NAMES）都有中文名。
 * 写成函数：t() 要在切换界面语言之后再取，模块加载时取会定死成加载那一刻的语言
 */
const PANEL_TOOLS = (): Record<string, string> => ({
  create_conversation: t('新建子对话'),
  send_to_conversation: t('发送消息'),
  list_conversations: t('查看子对话'),
  stop_workflow: t('终止工作流'),
  spawn_agents: t('派出子任务'),
  wait_agents: t('等待子任务'),
  stop_subtask: t('终止子任务'),
  run_background: t('后台命令'),
  check_background: t('查看后台命令'),
  stop_background: t('停止后台命令'),
  message_parent: t('发送消息'),
  suggest_next_step: t('收尾建议交给用户选'),
  submit_merge: t('请父对话收尾'),
  submit_build: t('请父对话收尾'),
  finish_child: t('收尾子对话'),
  request_build: t('申请编译'),
  list_peers: t('查看其他父对话'),
  message_peer: t('发送消息'),
  start_plan: t('启动工作流'),
  start_workflow: t('启动工作流'),
  run_workflow: t('启动工作流'),
  list_workflows: t('查看工作流运行'),
  message_workflow: t('给工作流补充要求'),
  revise_workflow: t('退回节点重做'),
  answer_workflow: t('代用户确认'),
  finish_workflow: t('合回或放弃工作流'),
  submit_diagnosis: t('交诊断报告'),
  request_logs: t('请你复现'),
  update_bug_case: t('记 Bug 档案'),
  remember: t('记住一件事'),
  set_plan: t('更新计划'),
  finish_plan: t('结束计划'),
  end_turn: t('结束这一轮'),
  request_user_action: t('请你操作'),
  get_status: t('查看节点状态'),
  begin_edit: t('开独立分支'),
  close_run: t('结束这次运行'),
  claim_files: t('认领文件'),
  release_files: t('释放文件'),
  p4_split_changelists: t('按类型分 changelist'),
  cherry_pick: t('cherry-pick 改动'),
  ask_push: t('请用户授权推送'),
  use_capability: t('加载能力'),
  begin_inline_edit: t('开始就地改动'),
  end_inline_edit: t('结束就地改动'),
  project_lessons: t('查看项目教训'),
  record_lesson: t('记下教训'),
  project_experience: t('查项目经验'),
  record_experience: t('记下经验'),
  read_state: t('读取共享状态'),
  write_state: t('写入共享状态'),
  ask_main: t('向主角色提问'),
  send_message: t('发送消息'),
  read_messages: t('查看消息'),
  submit_verdict: t('交结论'),
  submit_result: t('交结果'),
  dispatch: t('交决定'),
  ask_user: t('向用户提问'),
  read_user_notes: t('查看用户补充'),
  wait_user_message: t('等待用户消息'),
  app_actions: t('查看软件操作'),
  app_do: t('操作软件'),
  more_tools: t('查看工具用法'),
})

/** UI 设计对话的 design 工具（server/design-mcp.ts） */
const DESIGN_TOOLS = (): Record<string, string> => ({
  get_tree: t('查看控件树'),
  get_design: t('查看设计概况'),
  add_widgets: t('添加控件'),
  update_widgets: t('修改控件'),
  remove_widgets: t('删除控件'),
  move_widgets: t('移动控件'),
  rename_widgets: t('重命名控件'),
  replace_widget: t('替换控件'),
  duplicate_widgets: t('复制控件'),
  wrap_widget: t('套一层面板'),
  find_widgets: t('查找控件'),
  undo: t('撤回修改'),
  create_components: t('新建子控件'),
  resize_components: t('修改子控件尺寸'),
  delete_components: t('删除子控件'),
  add_images: t('列出要生成的图片'),
  add_animations: t('添加动画'),
  remove_animations: t('删除动画'),
  set_data: t('设置预览数据'),
  set_design: t('修改设计设置'),
  ask_user: t('向用户提问'),
  generate_concepts: t('生成效果图'),
  screenshot: t('截取画布'),
  get_layout: t('计算控件位置'),
  inspect_image: t('测量图片'),
  view_image: t('查看图片'),
  propose_layout: t('拆分布局区块'),
  compare_template: t('和模板对比'),
  check: t('检查设计'),
})

/** 3D 对话的 Blender 工具（server/blender-mcp.ts） */
const BLENDER_TOOLS = (): Record<string, string> => ({
  blender_python: t('执行 Blender 脚本'),
  blender_scene: t('查看场景'),
})

/** 面板自己的 MCP 服务：工具行旁边那个淡色标签的叫法，也决定工具名查哪张表 */
type Own = 'panel' | 'design' | 'blender'
function ownServer(server: string): Own | '' {
  const s = server.trim().toLowerCase()
  if (s === 'design' || s === 'agent-panel-design') return 'design'
  if (s === 'blender' || s === 'agent-panel-blender') return 'blender'
  // 面板调度服务的几种写法：panel、panel-xxxx、agent-panel、agent-panel-xxxx、老版本的 orch（见 server/panel-mcp-files.ts）
  return /^(?:(?:agent-)?panel(?:[-_][\w-]*)?|orch)$/.test(s) ? 'panel' : ''
}

/** 面板工具（PANEL_TOOL_NAMES 里的裸名字）的中文名；没登记返回空 */
export const panelToolTitle = (name: string): string => PANEL_TOOLS()[name] ?? ''

/** MCP 服务名的显示：面板自己的服务换成中文，别家的（notion、github）照原样 */
export function serverTitle(server: string): string {
  const own = ownServer(server)
  return own === 'panel' ? t('面板') : own === 'design' ? t('设计') : own === 'blender' ? 'Blender' : server
}

/**
 * 某个服务里的工具名的中文名：面板自己的服务按对应的表查，别家服务的工具照原名（没法替它们起名）。
 * server 不写时按「mcp__服务名__工具名」拆，拆不出就当裸名字、在面板的几张表里依次查
 */
export function toolTitle(name: string, server?: string): string {
  let tool = name.trim()
  let srv = server
  const mcp = srv === undefined ? /^mcp__(.+?)__(.+)$/.exec(tool) : null
  if (mcp) [srv, tool] = [mcp[1], mcp[2]]
  const own = srv === undefined ? '' : ownServer(srv)
  if (srv !== undefined && !own) return tool
  const tables =
    own === 'design'
      ? [DESIGN_TOOLS()]
      : own === 'blender'
        ? [BLENDER_TOOLS()]
        : own === 'panel'
          ? [PANEL_TOOLS()]
          : [PANEL_TOOLS(), DESIGN_TOOLS(), BLENDER_TOOLS()]
  for (const m of tables) if (m[tool]) return m[tool]
  return tool
}

/** 查询 MCP 工具那一行的副标题「finish_child, set_plan」：每个名字换成中文 */
export function toolListTitle(label: string): string {
  const parts = label.split(/,\s*/)
  const zh = parts.map((s) => (s ? toolTitle(s) : s))
  // 一个都不认识（关键词搜索、别家的工具）就原样显示，不改分隔符
  return zh.some((s, i) => s !== parts[i]) ? zh.join(t('、')) : label
}
