import { appActions, appCatalog, runAppAction } from './index.ts'
import type { ActionCaller } from './registry.ts'

/**
 * 对 Agent 只暴露这两个工具，永远不再加（见 ADR 0011）：能力的增减只改动作表，
 * 保活中的 CLI 拿到的工具列表不会过期，每次调用也不用背几十份 schema
 */
export const APP_TOOLS = [
  {
    name: 'app_actions',
    description:
      '列出能用来操控 Agent 面板这个软件的动作（停止子对话 / 子任务 / 后台命令、删除对话、新建对话、改设置、打开页面、UI 设计……）和各自的参数。' +
      '用户让你操作软件时先用它查有哪些动作，再用 app_do 执行。不写 group 列出全部。',
    inputSchema: {
      type: 'object',
      properties: { group: { type: 'string', description: '只列这一组：task、project、settings、ui、design' } },
    },
  },
  {
    name: 'app_do',
    description:
      '执行一个操控软件的动作（名字和参数见 app_actions）。级别为 danger 的（停止、删除）只在用户明确要求时执行：用户说了就直接做，不要再问一遍；用户没说就不要做。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '动作名，例如 task.stop_children' },
        args: { type: 'object', description: '动作的参数，没有参数时不写' },
      },
      required: ['action'],
    },
  },
]

const text = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError } : {}) })

export async function callAppTool(caller: ActionCaller, name: string, a: any) {
  if (name === 'app_actions') {
    const group = typeof a?.group === 'string' && a.group ? a.group : undefined
    if (group && !appActions.groups().includes(group))
      return text(`没有这一组：${group}。可用的组：${appActions.groups().join('、')}`, true)
    return text(appCatalog(group))
  }
  const action = typeof a?.action === 'string' ? a.action : ''
  if (!action) return text('要写 action：动作名见 app_actions', true)
  const r = await runAppAction(action, a?.args ?? {}, caller)
  return r.ok ? text(JSON.stringify(r.result, null, 2)) : text(r.error, true)
}

/** 有这两个工具时附在输入后面的一行用法 */
export const APP_HINT =
  '（面板工具）用户让你操作 Agent 面板这个软件本身时（停掉子对话、子任务、后台命令，删除对话，改设置，打开页面，新建 UI 设计等），先用 app_actions 查动作，再用 app_do 执行；用户的明确指令优先，说了就做。'
