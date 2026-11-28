import { t } from '../i18n.ts'

/**
 * 模型写哪些工具的入参时，要把写到哪了实时显示出来（用户 2026-11-28）。
 *
 * 入参要整段写完 CLI 才报调用：开子对话、派子任务、交诊断报告这类入参是一大段任务说明，要写好几秒到一二十秒，
 * 界面上只有一个转圈就像卡死了，所以边写边把内容显示出来。别的工具（更新计划、读写文件、跑命令……）不用看写的过程，
 * 「正在写」那一行只转圈计时，不推内容。
 *
 * 只认这里登记的：内置的写在 BUILTIN，插件或以后的面板工具用 registerDraftTool 加。
 * fields 只显示这几个顶层字段（其余字段写的时候不显示），labels 把字段名换成界面上的叫法（任意一层的同名字段都换）
 */
export type DraftShow = {
  fields?: string[]
  labels?: () => Record<string, string>
}

/** 子对话、子任务、工作流的任务说明这几个字段名的叫法，几个工具共用 */
const briefLabels = (): Record<string, string> => ({
  title: t('短标题'),
  message: t('任务说明'),
  instructions: t('任务说明'),
  input: t('任务说明'),
  prompt: t('任务说明'),
  description: t('短标题'),
  text: t('补充要求'),
  tasks: t('子任务'),
})

const BUILTIN: Record<string, DraftShow> = {
  // 面板的子对话、子任务、工作流
  create_conversation: { fields: ['title', 'message'], labels: briefLabels },
  send_to_conversation: { fields: ['message'], labels: briefLabels },
  spawn_agents: { fields: ['tasks'], labels: briefLabels },
  start_workflow: { fields: ['title', 'input'], labels: briefLabels },
  run_workflow: { fields: ['title', 'input'], labels: briefLabels },
  message_workflow: { fields: ['text'], labels: briefLabels },
  // 诊断报告整段都要看（用户 2026-11-05 报的就是它像卡死）
  submit_diagnosis: {},
  // CLI 自带的派子代理（Claude Code 的 Task / Agent）
  Task: { fields: ['description', 'prompt'], labels: briefLabels },
  Agent: { fields: ['description', 'prompt'], labels: briefLabels },
}

const extra = new Map<string, DraftShow>() // 模块状态：插件登记的，进程内一直有效

/** 插件、以后的面板工具登记「写入参时实时显示」：name 是不带 mcp__服务名__ 前缀的工具名 */
export function registerDraftTool(name: string, show: DraftShow) {
  extra.set(name, show)
}

/** MCP 工具在 CLI 里叫 mcp__服务名__工具名：按工具名查 */
export function bareToolName(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const i = tool.lastIndexOf('__')
  return i > 4 ? tool.slice(i + 2) : tool
}

/** 这个工具写入参时要不要实时显示；不用显示的返回 undefined */
export function draftShow(tool: string): DraftShow | undefined {
  const name = bareToolName(tool)
  return extra.get(name) ?? BUILTIN[name]
}
