/**
 * 交给 CLI 的面板工具用法说明（orchHint）：工具列表模型自己看得到，这里说什么时候用。
 * 从 server/orch-mcp.ts 搬出来的（那个文件到了行数上限），orch-mcp.ts 照旧导出它
 */
import type { Orchestra } from '../shared/engine.ts'

/** 交给 CLI 的一句用法说明：工具列表模型自己看得到，这里说什么时候用 */
export function orchHint(o: Orchestra) {
  // 没有并行节点和子任务的对话（Chat 模式）：只讲计划和后台命令；都没有时返回空，runner 不拼空行
  if (!o.team) {
    const s =
      (o.plans ? 'set_plan / finish_plan 列执行计划、更新进度；' : '') +
      (o.canBackground
        ? 'run_background 把要跑很久的命令放到后台（跑完结果自动推回），check_background / stop_background 查看、停止它们；'
        : '')
    return s ? `（你有面板工具 panel：${s}不要用 CLI 自带的后台命令。）` : ''
  }
  // 子任务只做派给它的那件事：不提派子任务、工作流、子对话这些它用不了的工具
  if (o.helper)
    return `（你有面板工具 panel：get_status 查看其他节点和子任务的状态；${o.sharedState ? 'read_state / write_state 读写共享状态；' : ''}send_message 给同时执行的节点传话、read_messages 看别人发给你的。你不能再派子任务、不能启动工作流或子对话。不要用 CLI 自带的子 Agent（Task / agent 这类工具）。）`
  // 通用 Agent 写进说明里：不写的话模型很少想到去派别的 Agent
  const common = o.common.length
    ? `；可以派的通用 Agent：${o.common.map((a) => `「${a.name}」`).join('、')}（spawn_agents 的 agent 写名字）`
    : ''
  // 对话模式没有共享状态（没有 task.runs），说明里也不提，免得模型去调一个不存在的工具
  const state = o.sharedState ? 'read_state / write_state 读写本次运行的共享状态，并发节点靠它同步进展；' : ''
  // 子对话（连同它的节点）多两样：和父对话通讯、改文件前先认领
  const bg =
    (o.plans ? 'set_plan 列执行计划、随时更新进度；' : '') +
    // 结束只认 end_turn（shared/end-turn.ts）：不写明的话模型照旧说完就停，面板只能再提醒一次
    (o.endTurn
      ? 'end_turn 结束这一轮（做完了先写好结论，再调用 end_turn（outcome: done）作为最后一个动作，之后最多一句话收尾、不要重复总结；做不下去用 outcome: blocked，need 写缺什么）；'
      : '') +
    (o.canBeginEdit ? '改文件前先调用 begin_edit 开独立分支，开好后结束这一轮；' : '') +
    (o.canBackground ? 'run_background 把要跑很久的命令放到后台（跑完结果自动推回）；' : '')
  const child =
    bg +
    (o.child
      ? `${o.diagnose ? 'update_bug_case 查的过程中随查随记 Bug 档案（修完也用它记结果）、submit_diagnosis 修 Bug 之前交诊断报告、等用户确认方案再改、' : ''}${o.claims ? 'claim_files 改文件前认领（被别的子对话占着的不要改）、' : ''}${o.ueBuild === 'child' && !o.isolated ? 'request_build 向父对话申请编译（UE 不在子对话里编译，结果会推回来）、' : ''}${o.canSubmit ? (o.ueBuild === 'child' && o.isolated ? 'submit_merge 检查完请父对话收尾（合回原分支后由父对话申请编译，UE 不在子对话里编译）、' : o.isolated ? 'submit_merge 测试跑通、只剩合回时请父对话收尾（结果会推回来）、' : 'submit_merge 评审处置完、测试跑通、只剩收尾时请父对话验收（结果会推回来）、') : ''}suggest_next_step 把收尾建议交给用户选（总结里要给建议时必须用它，不要只写在结论里）、message_parent 向父对话汇报或提问；`
      : '')
  // 对话里派完子任务结束这一轮就行，结果自动交回；工作流节点要自己用 wait_agents 取
  const collect = o.autoReturn ? '派完结束这一轮，结果会自动交回' : '再用 wait_agents 取结果'
  if (o.planning)
    return `（你有面板工具 panel：${o.parentOf ? 'finish_child 收到子对话的收尾请求时合回并结束它；' : ''}${o.coordinator ? `list_conversations 看现有子对话、create_conversation 新建子对话、send_to_conversation 交给已有子对话（用户的一条消息只交给关联最紧密的一个子对话）、start_workflow 启动工作流（在你下面开工作流子对话）、stop_workflow 终止它的流程图；` : ''}${o.ueBuild === 'parent' ? 'request_build 收到编译申请时向面板占位编译；' : ''}${o.peers ? 'list_peers / message_peer 和同项目的其他父对话协调；' : ''}${child}get_status 查看节点状态；${state}send_message 给并行节点传话、read_messages 看别人发给你的；需要并行收集、核实或出计划时用 spawn_agents 派子任务，派完结束这一轮，结果会自动交回${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
  if (o.coordinator)
    return `（你有面板工具 panel：先用 list_conversations 看现有子对话的标题、状态和最近结果，相关就用 send_to_conversation 交给它（用户的一条消息只交给关联最紧密的一个子对话），需要新建就用 create_conversation；${o.parentOf ? 'finish_child 收到子对话的收尾请求时合回并结束它；' : ''}${o.ueBuild === 'parent' ? '收到编译申请时用 request_build 向面板占位编译；' : ''}${o.peers ? 'list_peers / message_peer 和同项目的其他父对话协调；' : ''}${bg}get_status 查看节点状态；需要并行收集、核实或出计划时用 spawn_agents 派子任务，派完结束这一轮，结果会自动交回${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
  return o.self.endsWith('@main')
    ? `（你有面板工具 panel：${o.planner ? 'run_workflow 按流程图起一次新的运行、close_run 结束这次运行；' : ''}get_status 查看各 Agent 的状态和结果；${state}send_message 给正在执行的 Agent 发指示；需要并行核实时可以用 spawn_agents 派子任务，${collect}${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
    : `（你有面板工具 panel：${child}能拆成互不相关的几块时用 spawn_agents 派子任务同时做，${collect}；get_status 查看其他 Agent 的状态；${state}send_message 传话，read_messages 看别人发给你的${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
}
