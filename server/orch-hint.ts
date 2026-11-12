/**
 * 交给 CLI 的面板工具用法说明（orchHint）：工具列表模型自己看得到，这里说什么时候用。
 * 这里只排各身份说明的句式和顺序；「给不给这个工具」和单个工具的那一句都取自注册表
 * （server/panel-tools/registry.ts 的 toolHint / hasTool），条件和措辞跟着工具走，不在这里再写一遍。
 * orch-mcp.ts 照旧导出它
 */
import type { Orchestra } from '../shared/engine.ts'
import { hasTool, toolHint } from './panel-tools/registry.ts'
import type { HintAt } from './panel-tools/types.ts'

/** 交给 CLI 的一句用法说明：工具列表模型自己看得到，这里说什么时候用 */
export function orchHint(o: Orchestra) {
  const h = (name: string, at: HintAt) => toolHint(o, name, at)
  // 没有并行节点和子任务的对话（Chat 模式）：只讲计划和后台命令；都没有时返回空，runner 不拼空行
  if (!o.team) {
    const s = h('set_plan', 'chat') + h('run_background', 'chat')
    return s ? `（你有面板工具 panel：${s}不要用 CLI 自带的后台命令。）` : ''
  }
  // 子任务只做派给它的那件事：不提派子任务、工作流、子对话这些它用不了的工具
  if (o.helper)
    return `（你有面板工具 panel：get_status 查看其他节点和子任务的状态；${h('read_state', 'helper')}send_message 给同时执行的节点传话、read_messages 看别人发给你的。你不能再派子任务、不能启动工作流或子对话。不要用 CLI 自带的子 Agent（Task / agent 这类工具）。）`
  // 通用 Agent 写进说明里：不写的话模型很少想到去派别的 Agent
  const common = o.common.length
    ? `；可以派的通用 Agent：${o.common.map((a) => `「${a.name}」`).join('、')}（spawn_agents 的 agent 写名字）`
    : ''
  const state = h('read_state', 'conv')
  const bg = h('set_plan', 'conv') + h('end_turn', 'conv') + h('begin_edit', 'conv') + h('run_background', 'conv')
  // 子对话（连同它的节点）多两样：和父对话通讯、改文件前先认领
  const child =
    bg +
    (o.child
      ? ['submit_diagnosis', 'claim_files', 'request_build', 'submit_merge', 'suggest_next_step', 'message_parent']
          .map((n) => h(n, 'child'))
          .join('')
      : '')
  // 对话里派完子任务结束这一轮就行，结果自动交回；工作流节点要自己用 wait_agents 取
  const collect = o.autoReturn ? '派完结束这一轮，结果会自动交回' : '再用 wait_agents 取结果'
  if (o.planning)
    return `（你有面板工具 panel：${h('finish_child', 'planning')}${h('list_conversations', 'planning')}${h('request_build', 'planning')}${h('list_peers', 'planning')}${child}get_status 查看节点状态；${state}send_message 给并行节点传话、read_messages 看别人发给你的；需要并行收集、核实或出计划时用 spawn_agents 派子任务，派完结束这一轮，结果会自动交回${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
  if (hasTool(o, 'list_conversations'))
    return `（你有面板工具 panel：${h('list_conversations', 'coordinator')}${h('finish_child', 'coordinator')}${h('request_build', 'coordinator')}${h('list_peers', 'coordinator')}${bg}get_status 查看节点状态；需要并行收集、核实或出计划时用 spawn_agents 派子任务，派完结束这一轮，结果会自动交回${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
  return o.self.endsWith('@main')
    ? `（你有面板工具 panel：${o.planner ? 'run_workflow 按流程图起一次新的运行、close_run 结束这次运行；' : ''}get_status 查看各 Agent 的状态和结果；${state}send_message 给正在执行的 Agent 发指示；需要并行核实时可以用 spawn_agents 派子任务，${collect}${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
    : `（你有面板工具 panel：${child}能拆成互不相关的几块时用 spawn_agents 派子任务同时做，${collect}；get_status 查看其他 Agent 的状态；${state}send_message 传话，read_messages 看别人发给你的${common}。不要用 CLI 自带的子 Agent（Task / agent 这类工具）：要拆出去并行就用 spawn_agents，面板才能显示进度、管住并发。）`
}
