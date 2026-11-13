/**
 * 面板自带 MCP 工具（agent-panel 服务）的声明：作用、什么时候用、什么时候别用、对外界做什么。
 * 写成 Record：新登记进 PANEL_TOOL_NAMES 的工具不写声明就过不了类型检查（和 PANEL_TOOL_ROLE 一样）。
 *
 * useWhen / avoidWhen 会拼进交给 Agent 的说明（./describe.ts），所以写给模型看：具体、能直接照做，
 * 不重复 description 里已经说过的参数细节。
 */
import type { PanelToolName } from '../panel-tools.ts'
import type { ToolEffect, ToolGuide } from './types.ts'

export type PanelGuide = ToolGuide & { effects: ToolEffect[] }

const G = {
  plan: '计划与收尾',
  dispatch: '分派与协作',
  edit: '改文件与版本管理',
  bg: '后台命令',
  know: '教训与经验',
  ask: '提问与等你操作',
  bug: 'Bug 诊断',
  flow: '工作流运行',
  app: '操控软件',
  old: '只认调用的旧工具',
}
/** 只认调用、不再列出的旧工具的组名（目录里不显示它们） */
export const OLD_GROUP = G.old

export const PANEL_TOOL_GUIDE: Record<PanelToolName, PanelGuide> = {
  // ---- 分派与协作 ----
  create_conversation: {
    title: '新建子对话',
    summary: '新开一个子对话，把一件独立的事交给它做。',
    useWhen: '要改代码、排查 Bug、做较大的研究，而现有子对话都不相关时',
    avoidWhen: '一两句话能答完的问题自己答；已有相关子对话或要重试时用 send_to_conversation',
    group: G.dispatch,
    effects: ['dispatch'],
  },
  send_to_conversation: {
    title: '交给子对话',
    summary: '把消息交给一个已有的子对话接着做。',
    useWhen: '消息和某个已有子对话相关，或它失败、被中断后要重试时',
    avoidWhen: '同一段话不要再发给第二个子对话',
    group: G.dispatch,
    effects: ['dispatch'],
  },
  list_conversations: {
    title: '查看子对话',
    summary: '列出名下子对话的状态和最近结果。',
    useWhen: '分派前确认有没有合适的子对话；用户问子对话进展时',
    group: G.dispatch,
    effects: ['read'],
  },
  finish_child: {
    title: '收尾子对话',
    summary: '验收并合回子对话的改动，结束它。',
    useWhen: '子对话发来「收尾请求」、看过它交的验证结果之后',
    avoidWhen: '验证不够时别收，用 send_to_conversation 交回要补的',
    group: G.dispatch,
    effects: ['edit'],
  },
  message_parent: {
    title: '回报父对话',
    summary: '子对话给父对话发消息：要它拍板就马上送达，汇报进展就攒到这一轮结束。',
    useWhen: '需要父对话决定、协调别的子对话，或阶段性汇报时',
    avoidWhen: '只剩收尾时用 submit_merge',
    group: G.dispatch,
    effects: ['dispatch'],
  },
  suggest_next_step: {
    title: '收尾建议交给用户选',
    summary: '把「下一步怎么做」的几个做法交给用户选，选完自动交回。',
    useWhen: '这一轮做完、要给用户下一步建议时',
    avoidWhen: '不要把建议只写在结论里；推送、合主干这类由父对话决定，不写成建议',
    group: G.plan,
    effects: ['ask'],
  },
  submit_merge: {
    title: '请父对话收尾',
    summary: '子对话做完后请父对话验收、合回。',
    useWhen: '计划其余步骤都做完、评审和测试跑通、只剩收尾时',
    avoidWhen: '还有没做完的步骤、在跑的后台命令或待回答的提问时',
    group: G.plan,
    effects: ['dispatch'],
  },
  submit_build: {
    title: '请父对话收尾（旧名）',
    summary: 'submit_merge 的旧名字，照样执行。',
    useWhen: '不要用，改用 submit_merge',
    group: G.old,
    effects: ['dispatch'],
  },
  request_build: {
    title: '申请编译',
    summary: 'UE 项目的编译排队：父对话向面板占位编译，子对话向父对话申请。',
    useWhen: 'UE 项目改完、需要编译验证时（子对话），或收到子对话的编译申请时（父对话）',
    avoidWhen: '不要自己直接跑 Build.bat / UBT',
    group: G.dispatch,
    effects: ['dispatch'],
  },
  list_peers: {
    title: '查看其他父对话',
    summary: '列出同项目里其他父对话的状态和编译占用。',
    useWhen: '要和别的父对话协调（等编译、改同一个公共文件）之前',
    group: G.dispatch,
    effects: ['read'],
  },
  message_peer: {
    title: '给其他父对话传话',
    summary: '给同项目里另一个父对话传话协调。',
    useWhen: '在等它的编译、要改它也在改的公共文件时',
    avoidWhen: '不要替它做决定',
    group: G.dispatch,
    effects: ['dispatch'],
  },
  spawn_agents: {
    title: '派出子任务',
    summary: '派几个子任务并行做互不相关的事，马上返回。',
    useWhen: '有几块能同时做、不会改同一个文件的工作（查资料、查代码、核实结论）',
    avoidWhen: '小事自己做更快；子任务不能再派子任务',
    group: G.dispatch,
    effects: ['dispatch'],
  },
  wait_agents: {
    title: '等待子任务',
    summary: '等派出的子任务做完并取回结果，一次等到底。',
    useWhen: '派出子任务后、要用它们的结果时',
    avoidWhen: '不要轮询，也不要自己重复它们的工作',
    group: G.dispatch,
    effects: ['read'],
  },
  stop_subtask: {
    title: '终止子任务',
    summary: '终止派出的子任务。',
    useWhen: '子任务方向错了、不再需要或卡住不动时',
    group: G.dispatch,
    effects: ['danger'],
  },
  get_status: {
    title: '查看节点状态',
    summary: '看这次运行里各节点、子任务的状态和结果摘要。',
    useWhen: '传话、等结果前找节点 id；想知道并行的进展时',
    group: G.dispatch,
    effects: ['read'],
  },
  send_message: {
    title: '传话',
    summary: '给同时执行的其他 Agent 传话。',
    useWhen: '改了别的节点会用到的接口、要避免重复劳动时',
    group: G.dispatch,
    effects: ['dispatch'],
  },
  read_messages: {
    title: '查看消息',
    summary: '看别的 Agent 发给你的消息。',
    useWhen: '做比较久的事时中途看一下',
    group: G.dispatch,
    effects: ['read'],
  },
  read_state: {
    title: '读取共享状态',
    summary: '读工作流运行里节点共享的键值。',
    useWhen: '长时间执行时同步并行节点的进展；写之前先读',
    group: G.dispatch,
    effects: ['read'],
  },
  write_state: {
    title: '写入共享状态',
    summary: '写一个共享键，并行节点都能看到。',
    useWhen: '同步接口约定、文件分工、进度和结论时',
    avoidWhen: '不要覆盖别人刚写的，先 read_state',
    group: G.dispatch,
    effects: ['edit'],
  },
  submit_result: {
    title: '交结果',
    summary: '子任务最后交结果：做完、没做完或做不下去。',
    useWhen: '子任务结束时，最后一个动作',
    avoidWhen: '没做完先接着做，确实停下来才交 unfinished',
    group: G.plan,
    effects: ['dispatch'],
  },
  submit_verdict: {
    title: '交结论',
    summary: '交这一步的通过 / 不通过结论。',
    useWhen: '验收、评审、选分支的节点做完判断时',
    group: G.plan,
    effects: ['verify'],
  },
  claim_files: {
    title: '认领文件',
    summary: '子对话改文件前认领，避免和别的子对话撞车。',
    useWhen: '共用目录的子对话改文件之前',
    group: G.edit,
    effects: ['read'],
  },
  release_files: {
    title: '释放文件',
    summary: '让出认领了却没改的文件。',
    useWhen: '别的子对话需要你认领着的文件时',
    group: G.edit,
    effects: ['read'],
  },

  // ---- 计划与收尾 ----
  set_plan: {
    title: '更新计划',
    summary: '列出或更新这个对话的执行计划。',
    useWhen: '开始一件多步骤的事时；每完成一步、跑长命令或派子对话前更新状态',
    avoidWhen: '目标整个变了先 finish_plan 再开新计划',
    group: G.plan,
    effects: ['read'],
  },
  finish_plan: {
    title: '结束计划',
    summary: '主动结束当前计划并写总结。',
    useWhen: '目标变了要换一份计划，或计划要提前收掉时',
    group: G.plan,
    effects: ['read'],
  },
  end_turn: {
    title: '结束这一轮',
    summary: '交代这一轮怎么结束：做完了，或做不下去缺什么。',
    useWhen: '写好结论之后、作为这一轮最后一个动作',
    avoidWhen: '需要用户去操作用 request_user_action，要用户选做法用 ask_user',
    group: G.plan,
    effects: ['read'],
  },
  remember: {
    title: '记住一件事',
    summary: '记下用户的长期偏好或事实，以后每个 Chat 对话都带上。',
    useWhen: '用户说了称呼、格式偏好、常用技术栈、长期项目这类以后还用得上的事',
    avoidWhen: '不记这一次对话的细节，不记密码和密钥',
    group: G.know,
    effects: ['edit'],
  },

  // ---- 改文件与版本管理 ----
  begin_edit: {
    title: '开独立分支',
    summary: '从当前目录开一个独立分支，切过去再改文件。',
    useWhen: '确定要改文件、动手之前',
    avoidWhen: '只是查看或回答问题时不要调',
    group: G.edit,
    effects: ['edit'],
  },
  begin_inline_edit: {
    title: '开始就地改动',
    summary: '父对话直接改一两处小地方（文案、配置值）。',
    useWhen: '改什么已经清楚、不用排查、在文件数和行数限制内时',
    avoidWhen: 'Bug、要排查的、改接口或数据格式的交给子对话',
    group: G.edit,
    effects: ['edit'],
  },
  end_inline_edit: {
    title: '结束就地改动',
    summary: '就地改动改完后让面板核对范围。',
    useWhen: '改完、跑过快速检查并本地提交之后',
    group: G.edit,
    effects: ['verify'],
  },
  p4_split_changelists: {
    title: '按类型分 changelist',
    summary: 'P4 工作区：把改动按文件类型分进各自的 pending changelist，不 submit。',
    useWhen: '要把改动放进 pending changelist 时',
    avoidWhen: '不要自己建一个混着几类文件的 changelist',
    group: G.edit,
    effects: ['edit'],
  },
  cherry_pick: {
    title: 'cherry-pick 到目标',
    summary: '把改动搬到项目设置的目标分支或 stream，由面板核对后执行。',
    useWhen: '用户要求把改动 cherry-pick 到目标时',
    avoidWhen: '不要自己跑 git cherry-pick / merge 或 p4 integrate / copy',
    group: G.edit,
    effects: ['edit'],
  },
  ask_push: {
    title: '请用户授权推送',
    summary: '弹出「允许 / 拒绝」卡片请用户授权推送和合并主干。',
    useWhen: '项目设成「第一次推送时问一次」，任务做完、验证通过并本地提交之后',
    avoidWhen: '不要用 ask_user 问要不要推送',
    group: G.edit,
    effects: ['ask'],
  },
  use_capability: {
    title: '加载能力',
    summary: '取你挂载的某个能力的完整做法，在当前对话里照做。',
    useWhen: '要就地用角色设定里「你挂载的能力」之一时',
    group: G.plan,
    effects: ['read'],
  },

  // ---- 后台命令 ----
  run_background: {
    title: '后台命令',
    summary: '把要跑很久的命令交给面板在后台跑，结果推回对话。',
    useWhen: '完整测试、编译、打包、装依赖、下载、开发服务器这类跑超过一分钟或不会自己结束的命令',
    avoidWhen: '几秒就完的命令直接用你自己的命令工具；不要用它写文件',
    group: G.bg,
    effects: ['dispatch'],
  },
  check_background: {
    title: '查看后台命令',
    summary: '查后台命令的状态和最近输出。',
    useWhen: '开发服务器启动后看地址和报错；怀疑命令卡住时',
    avoidWhen: '结果会自动推回，不要轮询',
    group: G.bg,
    effects: ['read'],
  },
  stop_background: {
    title: '停止后台命令',
    summary: '停掉一条后台命令。',
    useWhen: '确认它卡住、跑偏，或开发服务器用完了',
    group: G.bg,
    effects: ['danger'],
  },

  // ---- 教训与经验 ----
  project_lessons: {
    title: '查看项目教训',
    summary: '按要改的文件或关键词取项目教训。',
    useWhen: '动手改文件之前',
    group: G.know,
    effects: ['read'],
  },
  record_lesson: {
    title: '记下教训',
    summary: '把踩过的坑写成项目教训，以后改到相关文件会提醒。',
    useWhen: '用户纠正了做法、换了做法才成，或修的是之前改出来的问题时',
    avoidWhen: '同类已有就带 id 改写那一条；全局教训只有用户能改',
    group: G.know,
    effects: ['edit'],
  },
  project_experience: {
    title: '查项目经验',
    summary: '查以前对话学到的位置、叫法对照、命令和验证方法。',
    useWhen: '要全项目搜索或试命令之前，先按关键词查',
    group: G.know,
    effects: ['read'],
  },
  record_experience: {
    title: '记下项目经验',
    summary: '记一条以后能省掉搜索或试错的项目经验。',
    useWhen: '用户用 /learn 让你学一件事时',
    group: G.know,
    effects: ['edit'],
  },

  // ---- 提问与等你操作 ----
  ask_user: {
    title: '向用户提问',
    summary: '把要用户拿主意的问题做成选项卡片，等他回答。',
    useWhen: '要用户做选择、补充他脑子里的信息、确认方向时',
    avoidWhen: '要用户离开对话去做事用 request_user_action',
    group: G.ask,
    effects: ['ask'],
  },
  request_user_action: {
    title: '等你操作',
    summary: '请用户离开对话去做一件你做不了的事，做完交回再继续。',
    useWhen: '要用户在本机、编辑器、设备上操作，复现一次，登录授权，或给只在他手里的文件和日志时',
    avoidWhen: '能自己跑的命令、能读的文件自己做；要用户拿主意用 ask_user',
    group: G.ask,
    effects: ['ask'],
  },
  read_user_notes: {
    title: '取用户补充',
    summary: '取用户在你执行中补充的信息。',
    useWhen: '开始动手前取一次；做比较久的事时每隔一会儿取一次',
    group: G.ask,
    effects: ['read'],
  },
  wait_user_message: {
    title: '等用户下一句',
    summary: '回复完停在原地，等用户在这个对话里的下一句。',
    useWhen: '回复完这一轮、对话页还开着时',
    group: G.ask,
    effects: ['ask'],
  },

  // ---- Bug 诊断 ----
  submit_diagnosis: {
    title: '交诊断报告',
    summary: '用户报的 Bug 每到一个关口交一份报告：论证、根因、修复方案、修复、验证。',
    useWhen: 'Bug 对话里，每个阶段的结论准备好、需要用户看时',
    group: G.bug,
    effects: ['ask'],
  },
  update_bug_case: {
    title: '记 Bug 档案',
    summary: '把查到的现象、调用栈、假设、影响面记进档案草稿。',
    useWhen: 'Bug 对话里，查的过程中随查随记',
    group: G.bug,
    effects: ['read'],
  },
  request_logs: {
    title: '请用户复现',
    summary: '加好临时日志后请用户复现并贴日志。',
    useWhen: '用户同意了日志计划、日志加好了、自己又复现不了时',
    avoidWhen: '自己能复现就不用调',
    group: G.bug,
    effects: ['ask'],
  },

  // ---- 工作流运行 ----
  start_workflow: {
    title: '启动工作流',
    summary: '按工作流的流程图起一次运行，把一件事做完。',
    useWhen: '步骤和门禁事先定好、符合提示里「可用工作流」判定规则的事',
    avoidWhen: '问答、排查、Bug 定位、小改动不要起工作流',
    group: G.flow,
    effects: ['dispatch'],
  },
  list_workflows: {
    title: '查看工作流运行',
    summary: '列出名下工作流运行的阶段和进度。',
    useWhen: '用户问运行进展、要操作某次运行前',
    group: G.flow,
    effects: ['read'],
  },
  message_workflow: {
    title: '补充要求',
    summary: '给运行补充要求，不打断它。',
    useWhen: '用户对正在跑的运行有新要求时',
    group: G.flow,
    effects: ['dispatch'],
  },
  revise_workflow: {
    title: '退回节点重做',
    summary: '把运行退回到某个节点带着意见重做。',
    useWhen: '某个节点的结果不对，或节点失败等你决定时',
    group: G.flow,
    effects: ['dispatch'],
  },
  answer_workflow: {
    title: '代用户确认',
    summary: '运行停在节点上等确认时替用户确认或要求修改。',
    useWhen: '用户明确把这个决定交给你时',
    avoidWhen: '用户没交给你时不要替他确认',
    group: G.flow,
    effects: ['confirm'],
  },
  stop_workflow: {
    title: '终止工作流',
    summary: '终止一次运行，没跑的节点不再跑。',
    useWhen: '方向错了、已经不需要这次运行时',
    avoidWhen: '只想暂停让用户在运行上点暂停',
    group: G.flow,
    effects: ['danger'],
  },
  finish_workflow: {
    title: '合回或放弃',
    summary: '把运行的分支合回你的目录，或放弃改动删掉分支。',
    useWhen: '运行「待合回」要收下结果，或要放弃它的改动时',
    group: G.flow,
    effects: ['edit'],
  },

  // ---- 操控软件 ----
  app_actions: {
    title: '查软件动作',
    summary: '列出能操控 Agent 面板本身的动作和参数。',
    useWhen: '用户让你操作面板（停子对话、删对话、改设置、打开页面、改配置表）时，先查动作',
    group: G.app,
    effects: ['read'],
  },
  app_do: {
    title: '执行软件动作',
    summary: '执行一个操控面板的动作。',
    useWhen: '用 app_actions 查到要的动作之后',
    avoidWhen: 'danger 级别的只在用户明确要求时做',
    group: G.app,
    effects: ['edit'],
  },
  more_tools: {
    title: '更多面板工具',
    summary: '不常用面板工具的入口：先查用法，再按名字调用。',
    useWhen: '提示里让你用某个没直接列出的面板工具，或确实需要它时',
    group: G.app,
    effects: ['read'],
  },

  // ---- 只认调用的旧工具 ----
  start_plan: {
    title: '启动计划（旧）',
    summary: '旧工具，现在提示改用 start_workflow。',
    useWhen: '不要用，改用 start_workflow',
    group: G.old,
    effects: ['read'],
  },
  run_workflow: {
    title: '运行工作流（旧）',
    summary: '已经删掉的旧工具。',
    useWhen: '不要用',
    group: G.old,
    effects: ['read'],
  },
  close_run: {
    title: '关闭运行（旧）',
    summary: '已经删掉的旧工具。',
    useWhen: '不要用',
    group: G.old,
    effects: ['read'],
  },
  ask_main: {
    title: '问主 Agent（旧）',
    summary: '已经删掉的旧工具。',
    useWhen: '不要用',
    group: G.old,
    effects: ['read'],
  },
  dispatch: {
    title: '分派（旧）',
    summary: '只认调用的旧工具。',
    useWhen: '不要用',
    group: G.old,
    effects: ['read'],
  },
}

/** 面板服务（agent-panel）是做什么的：握手时作为 MCP 的 instructions 交给 CLI，设置页的服务头也用它 */
export const PANEL_SUMMARY =
  'Agent 面板自己的工具：分派子对话和子任务、后台命令、计划、提问和请用户操作、收尾、教训和经验、操控面板本身。每轮按对话类型和角色能力给不同的一份。'

/** 面板服务什么时候挂（设置页「什么时候挂」） */
export const PANEL_ATTACH =
  '支持 MCP 的 CLI 每一轮都挂；工具按对话类型（父对话、子对话、子任务、工作流节点、Chat）和角色能力裁剪，不常用的收进 more_tools，查过用法照样能调。'

/** 操控软件（动作表）是做什么的 */
export const APP_SUMMARY =
  '操控 Agent 面板这个软件本身的动作：停止或删除对话、新建对话、改设置、打开页面；开着的插件也会登记自己的动作。Agent 经 app_actions 查、app_do 执行。'

export const APP_ATTACH =
  '用户直接在聊的对话（父对话、子对话、Chat）里，和面板工具一起挂；派出的子任务和工作流节点没有。'
