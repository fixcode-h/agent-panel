/**
 * 面板工具 request_user_action（等你操作）：定义和调用都在这里（面板工具注册表的条目）。
 * 判定和记录在 shared/user-action.ts（设计稿 docs/openspec/changes/user-action-wait/design.md）
 */
import type { Orchestra } from '../shared/engine.ts'
import type { PanelTool } from './panel-tools/types.ts'

const USER_ACTION_TOOL = 'request_user_action'

const steps = { type: 'array', items: { type: 'string' } }

const USER_ACTION_DEF = {
  name: USER_ACTION_TOOL,
  title: '等你操作',
  description:
    '请用户离开对话去做一件你自己做不了的事，做完把结果交回来：在本机、编辑器、浏览器、设备上操作（例如跑一次 PIE、在真机上看效果），复现一次，登录或授权，提供只在用户手里的文件、截图、日志、配置值。' +
    '只在你确实做不了时用：能跑的命令、能读的文件、能跑的测试自己做。要用户在几种做法里拿主意（偏好、取舍、授权不可逆的操作）用提问，不要用它；反过来，「你去做……再发回来」也不要写成提问的选项。' +
    '拿同一份东西有几种办法时，自己选一种写成步骤，另一种放 alternative，不要让用户先做选择题。一个对话一次只挂一件。' +
    '调用后这一轮照常结束（不依赖结果的事可以先做完），不用调用 end_turn；用户交回、做完、做不了或跳过时，面板会作为新消息推给你。用户报的 Bug 要复现贴日志、交验证结果时不用它，按诊断报告的流程交。你派出的子对话要用户做的事不要替它发（卡片会挂在你这个对话里）：交回让它在自己的对话里发。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '一句话写要用户做什么，例如「跑一次 PIE，抓路牌的 Actor 路径」' },
      why: { type: 'string', description: '拿到之后用来干什么（用户看到才知道为什么要做）' },
      collect: {
        type: 'object',
        properties: {
          steps: { ...steps, description: '1~8 步，每步一个具体动作；命令、菜单名、过滤条件写原文' },
          kind: {
            type: 'string',
            enum: ['result', 'confirm'],
            description: 'result：要交回东西（文字、日志、文件，都在输入框里交）；confirm：做完点一下就行',
          },
          where: { type: 'string', description: '结果在哪：日志文件路径、控制台、哪个面板' },
          filter: { type: 'string', description: '日志的过滤条件，例如 OnCreated hit' },
          expect: { type: 'string', description: '看到什么说明什么，用户交回前就知道每种结果的意思' },
        },
        required: ['steps'],
      },
      alternative: {
        type: 'object',
        description: '可选，最多一个：拿同一份东西的另一种办法',
        properties: { title: { type: 'string' }, steps },
      },
      fallback: { type: 'string', description: '必填：用户点「跳过」时你怎么继续' },
      step: { type: 'string', description: '可选：计划里哪一步在等这件事，不写就挂在正在做的那一步上' },
    },
    required: ['title', 'collect', 'fallback'],
  },
}

/** 执行一次 request_user_action：没有这个工具（子任务、工作流节点、Chat 页）时报错 */
function callUserAction(o: Orchestra, a: Record<string, unknown> | undefined) {
  const r = o.requestUserAction
    ? o.requestUserAction(a)
    : { ok: false, info: '这里不能请用户操作：缺东西就写进结果交回，由派你的对话发起' }
  return { content: [{ type: 'text', text: r.info }], ...(!r.ok && { isError: true }) }
}

export const USER_ACTION: PanelTool = {
  name: USER_ACTION_TOOL,
  when: (o) => !!o.requestUserAction,
  def: () => USER_ACTION_DEF,
  call: (o, a) => callUserAction(o, a),
}
