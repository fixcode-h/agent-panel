/**
 * 面板工具 ask_push（推送授权）：定义和调用都在这里（面板工具注册表的条目）。
 * 判定和回给模型的话在 shared/push-auth.ts，卡片和回答的记录在 server/exec/panel-requests.ts
 */
import type { Orchestra } from '../shared/engine.ts'
import { ASK_PUSH } from '../shared/push-auth.ts'
import type { PanelTool } from './panel-tools/types.ts'

const ASK_PUSH_TOOL = {
  name: ASK_PUSH,
  title: '请用户授权推送',
  description:
    '项目设置是「第一次需要推送时问一次」时，任务做完、验证通过并在本地提交之后用它请用户授权推送并合并主干：面板弹出「允许 / 拒绝」卡片并记下回答，返回用户的决定。不要用 ask_user / AskUserQuestion 问要不要推送。这个对话里已经同意过时直接返回，不再打扰用户。',
  inputSchema: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: '要推送的分支（显示在卡片上）' },
      summary: { type: 'string', description: '一两句说明这次要推送的改动（显示在卡片上）' },
    },
  },
}

/** 执行一次 ask_push：没有这个工具（不是问一次的项目、不是顶层对话）时报错 */
async function callAskPush(o: Orchestra, a: { branch?: unknown; summary?: unknown } | undefined) {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const r = o.askPush
    ? await o.askPush({ branch: str(a?.branch), summary: str(a?.summary) })
    : {
        ok: false,
        info: '这个对话不需要问推送授权：按「授权情况」那段做（子对话不推送，项目设置允许或禁止推送时不用问）',
      }
  return { content: [{ type: 'text', text: r.info }], ...(!r.ok && { isError: true }) }
}

export const ASK_PUSH_ENTRY: PanelTool = {
  name: ASK_PUSH,
  when: (o) => !!o.askPush,
  def: () => ASK_PUSH_TOOL,
  call: (o, a) => callAskPush(o, a),
}
