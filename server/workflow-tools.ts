/**
 * 父对话操作工作流运行的面板工具（docs/openspec/changes/workflow-runs/design.md 第 4 节）：
 * start_workflow 起一次运行，list_workflows 看名下的运行，message / revise / answer / stop / finish 下指令。
 * 工作流运行不是子对话：子对话那套（send_to_conversation、finish_child）不作用到它身上。
 * 定义和调用都在这里，作为面板工具注册表（server/panel-tools/registry.ts）的条目；只有能启动工作流的父对话（Orchestra.planning）拿得到
 */
import type { Orchestra, RouteInput } from '../shared/engine/host.ts'
import { clip } from '../shared/text.ts'
import { stepField } from './orch-fields.ts'
import { str, text as out, type PanelTool, type ToolDef } from './panel-tools/types.ts'
const idField = { type: 'string', description: '工作流运行的 id（start_workflow 返回的，或 list_workflows 里的）' }

export const WORKFLOW_TOOL_NAMES = [
  'start_workflow',
  'list_workflows',
  'message_workflow',
  'revise_workflow',
  'answer_workflow',
  'stop_workflow',
  'finish_workflow',
] as const

/** 七个工具的定义（顺序就是清单里的顺序） */
function workflowDefs(o: Orchestra): ToolDef[] {
  return [
    {
      name: 'start_workflow',
      title: '启动工作流',
      description:
        '起一次工作流运行，按工作流的流程图把这件事做完（异步执行，马上返回运行 id）。运行不是子对话：面板按流程图推着走，跑完经评审、测试后等你用 finish_workflow 合回；要你决定时、跑完时会回信给你。只用于步骤和门禁事先定好的事，判定规则见提示里的「可用工作流」；问答、排查、Bug 定位、小改动不要起工作流。',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: {
            type: 'string',
            description: '工作流 id 或名字（见提示里的「可用工作流」）；不写用项目默认工作流',
          },
          input: { type: 'string', description: '这次要做什么：目标、范围、验收标准，工作流的节点只看得到这些' },
          title: { type: 'string', description: '运行的短标题（10–20 字），不写用工作流名字加要做的事' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: '这次运行负责的文件或目录（相对项目根），只用来提醒节点范围',
          },
          ...(o.plans ? { step: stepField('这个工作流') } : {}),
        },
        required: ['input'],
      },
    },
    {
      name: 'list_workflows',
      title: '查看工作流运行',
      description: '列出你名下的工作流运行：id、工作流、阶段、做到第几个节点。阶段说明见提示里的「名下的工作流」。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'message_workflow',
      title: '补充要求',
      description:
        '给运行补充要求（不打断它）。to 写 current 交给正在跑的节点（它下一次回到面板时看到）；写 later 记成运行级说明，之后每个节点都带上；也可以写节点名，只交给那个节点。',
      inputSchema: {
        type: 'object',
        properties: {
          id: idField,
          text: { type: 'string', description: '补充的要求，写清楚和原任务的关系' },
          to: { type: 'string', description: 'current（默认）、later，或节点名' },
        },
        required: ['id', 'text'],
      },
    },
    {
      name: 'revise_workflow',
      title: '退回节点重做',
      description:
        '把运行退回到某个节点重做：这个节点和它之后的节点改回待执行，意见记进决定记录（之后每个节点都看得到）。运行还在跑时先停下再退回；节点失败等你决定时也用它带着意见重跑。',
      inputSchema: {
        type: 'object',
        properties: {
          id: idField,
          node: { type: 'string', description: '退回到哪个节点（节点名）；不写是当前停着的节点' },
          text: { type: 'string', description: '要怎么改' },
        },
        required: ['id', 'text'],
      },
    },
    {
      name: 'answer_workflow',
      title: '代用户确认',
      description:
        '运行停在节点上等确认、用户把决定交给你时用：decision 写 confirm 通过、接着往下走；写 revise 要它按 text 修改这个节点的结果。用户没交给你时不要替他确认，告诉用户去运行上确认。',
      inputSchema: {
        type: 'object',
        properties: {
          id: idField,
          decision: { type: 'string', enum: ['confirm', 'revise'], description: 'confirm 通过；revise 要求修改' },
          text: { type: 'string', description: '通过时可以写备注；修改时写清楚改什么' },
        },
        required: ['id', 'decision'],
      },
    },
    {
      name: 'stop_workflow',
      title: '终止工作流',
      description:
        '终止一次运行：方向错了、已经不需要时用。没跑的节点不再跑，改过的文件留在它的分支上，之后用 finish_workflow 放弃或合回。只是想暂停不用它：用户在运行上点暂停。',
      inputSchema: {
        type: 'object',
        properties: {
          id: idField,
          reason: { type: 'string', description: '为什么终止，一句话' },
        },
        required: ['id', 'reason'],
      },
    },
    {
      name: 'finish_workflow',
      title: '合回或放弃',
      description:
        '收下一次运行的结果：action 写 merge 把它的分支合回你的目录（只在「待合回」时能用）；写 discard 放弃它的改动、删掉分支（待合回、失败、终止后都能用）。只读的工作流跑完就是完成，不用调。',
      inputSchema: {
        type: 'object',
        properties: {
          id: idField,
          action: { type: 'string', enum: ['merge', 'discard'], description: 'merge 合回；discard 放弃' },
        },
        required: ['id', 'action'],
      },
    },
  ]
}

/** 执行上面几个工具 */
const CALLS: Record<(typeof WORKFLOW_TOOL_NAMES)[number], PanelTool['call']> = {
  start_workflow: (o, a) => callStartWorkflow(o, a),
  list_workflows: async (o) => out(await o.runs.listWorkflows()),
  message_workflow: async (o, a) => {
    const to = str(a?.to).trim() || 'current'
    const r = await o.runs.messageWorkflow(str(a?.id), str(a?.text), to)
    return out(r.info, !r.ok)
  },
  revise_workflow: async (o, a) => {
    const r = await o.runs.reviseWorkflow(str(a?.id), str(a?.node), str(a?.text))
    return out(r.info, !r.ok)
  },
  answer_workflow: async (o, a) => {
    const d = str(a?.decision)
    if (d !== 'confirm' && d !== 'revise') return out('decision 写 confirm 或 revise', true)
    const r = await o.runs.answerWorkflow(str(a?.id), d === 'confirm', str(a?.text))
    return out(r.info, !r.ok)
  },
  stop_workflow: async (o, a) => {
    if (!str(a?.id).trim()) return out('id 要写：工作流运行的 id', true)
    const r = await o.runs.stopWorkflow(str(a?.id), str(a?.reason))
    return out(r.info, !r.ok)
  },
  finish_workflow: async (o, a) => {
    const act = str(a?.action)
    if (act !== 'merge' && act !== 'discard') return out('action 写 merge 或 discard', true)
    const r = await o.runs.finishWorkflow(str(a?.id), act)
    return out(r.info, !r.ok)
  },
}

/** 面板工具注册表的条目：只有能启动工作流的父对话（Orchestra.planning）拿得到 */
export const WORKFLOW_TOOLS: PanelTool[] = WORKFLOW_TOOL_NAMES.map((name) => ({
  name,
  when: (o) => o.planning,
  def: (o) => workflowDefs(o).find((d) => d.name === name)!,
  call: CALLS[name],
}))

/**
 * 执行一次 start_workflow：先按 id / 名字认出工作流（认不出就列出能用的），再起一次运行，
 * 运行挂到父对话计划里的一步上（在等工作流），跑完时由面板结算
 */
export async function callStartWorkflow(o: Orchestra, a: Record<string, unknown> | undefined, _route?: RouteInput) {
  const input = str(a?.input).trim()
  if (!input) return out('input 是空的：写清楚这次要做什么、范围和验收标准', true)
  // 老会话里模型还记得 again（在原来的工作流子对话里再跑一次）：现在没有工作流子对话了，说清楚该怎么做
  if (str(a?.again).trim())
    return out(
      '工作流运行不再「在原地再跑一次」：要改某个节点用 revise_workflow 退回重做；要从头再来就再起一次运行',
      true,
    )
  const picked = o.pickWorkflow(str(a?.workflow))
  if (!picked.ok) return out(picked.info, true)
  const title = str(a?.title).trim() || `${picked.flow.workflowName}：${clip(input.replace(/\s+/g, ' '), 24)}`
  const files = Array.isArray(a?.files) ? a.files.map(String).filter(Boolean) : undefined
  const r = await o.runs.startWorkflow(picked.flow, input, title, files, str(a?.step).trim())
  return out(r.id ? `${r.info}（id: ${r.id}）` : r.info, !r.ok)
}
