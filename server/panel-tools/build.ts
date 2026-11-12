/**
 * UE 编译申请（request_build）和父对话之间的协调（list_peers / message_peer）。
 * request_build 有两份：父对话向面板占位编译、共用目录的子对话向父对话申请；两份条件互斥、执行相同，
 * 在清单里各占原来的位置（父对话的排在前面，子对话的跟在 submit_merge 后面）
 */
import { stepField } from '../orch-fields.ts'
import { reply, str, text, type PanelTool } from './types.ts'

const callRequestBuild: PanelTool['call'] = async (o, a) => {
  // 也认旧提示里写错的 child（单个 id）：漏了的话面板还会按「谁申请过」补上（shared/build-ask.ts）
  const kids = [...(Array.isArray(a?.children) ? a.children.map(String) : []), ...(a?.child ? [String(a.child)] : [])]
  return reply(await o.requestBuild(str(a?.note), str(a?.step) || undefined, kids))
}

export const REQUEST_BUILD_PARENT: PanelTool = {
  name: 'request_build',
  when: (o) => o.ueBuild === 'parent',
  def: (o) => ({
    name: 'request_build',
    title: '申请编译',
    description:
      'UE 项目：收到子对话的编译申请或用户要求时，向面板申请编译（跑项目测试步骤里的编译）。编译是占位的资源：同一编译目录同一时间只编译一次，别的父对话占着时排在后面，面板会告诉你是谁、也告诉对方你在等。马上返回，结果推回给你，也推给 children 里的子对话。',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '为什么编译：哪些子对话申请的、包含哪些改动' },
        children: {
          type: 'array',
          items: { type: 'string' },
          description: '申请这次编译的子对话 id：编译结果面板会直接推给它们（不用你转述）',
        },
        ...(o.plans ? { step: stepField('这次编译') } : {}),
      },
      required: ['note'],
    },
  }),
  hint: (_o, at) =>
    at === 'planning'
      ? 'request_build 收到编译申请时向面板占位编译；'
      : at === 'coordinator'
        ? '收到编译申请时用 request_build 向面板占位编译；'
        : '',
  call: callRequestBuild,
}

// 有独立分支的走 submit_merge 的 build：改动要先合回父对话的目录才编得到
export const REQUEST_BUILD_CHILD: PanelTool = {
  name: 'request_build',
  when: (o) => o.child && o.ueBuild === 'child' && !o.isolated,
  def: () => ({
    name: 'request_build',
    title: '申请编译',
    description:
      'UE 项目：子对话不编译。改完、做完不用编译的检查后调用，向父对话申请编译；父对话按申请向面板占位编译，结果由父对话转给你。马上返回。',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '改了哪些模块和文件、需要编哪个目标、做过哪些检查' },
      },
      required: ['note'],
    },
  }),
  hint: (_o, at) => (at === 'child' ? 'request_build 向父对话申请编译（UE 不在子对话里编译，结果会推回来）、' : ''),
  call: callRequestBuild,
}

export const PEER_TOOLS: PanelTool[] = [
  {
    name: 'list_peers',
    when: (o) => o.peers,
    def: () => ({
      name: 'list_peers',
      title: '查看其他父对话',
      description: '列出同一项目里的其他父对话：id、标题、状态、是否占着编译。要和它们协调前先用它。',
      inputSchema: { type: 'object', properties: {} },
    }),
    hint: (_o, at) =>
      at === 'planning' || at === 'coordinator' ? 'list_peers / message_peer 和同项目的其他父对话协调；' : '',
    call: async (o) => text(await o.listPeers()),
  },
  {
    name: 'message_peer',
    when: (o) => o.peers,
    def: () => ({
      name: 'message_peer',
      title: '给其他父对话传话',
      description:
        '给同一项目里的另一个父对话传话（例如你在等它的编译、要改它也在改的公共文件）：它正在执行就实时送达，空闲就放进它的收件箱，下一轮处理。只协调，不替它做决定。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '父对话 id（list_peers 里有）' },
          text: { type: 'string', description: '要告诉它的事，写清背景和你希望它怎么配合' },
        },
        required: ['id', 'text'],
      },
    }),
    call: async (o, a) => reply(await o.messagePeer(str(a?.id), str(a?.text))),
  },
]
