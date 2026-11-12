/** 父对话管子对话：查看、新建、交给已有的（Orchestra.coordinator），收尾子对话（Orchestra.parentOf） */
import { childKindArgs, childKindFields, upgradeBugArg, upgradeBugFields } from '../children/kind-fields.ts'
import { docsFirstArgs, docsFirstFields } from '../docs/first-tool.ts'
import { routeField, routeOf, stepField } from '../orch-fields.ts'
import { noArgs, reply, str, text, type PanelTool } from './types.ts'

export const CONVERSATION_TOOLS: PanelTool[] = [
  {
    name: 'list_conversations',
    when: (o) => o.coordinator,
    def: () => ({
      name: 'list_conversations',
      title: '查看子对话',
      description: '列出当前对话下的子对话：id、标题、状态和最近一条结果。分派前先用它确认有没有合适的子对话。',
      inputSchema: noArgs(),
    }),
    // 分派子对话这一组（连同父对话起停工作流）在说明里是一句话，挂在 list_conversations 上
    hint: (_o, at) =>
      at === 'planning'
        ? 'list_conversations 看现有子对话、create_conversation 新建子对话、send_to_conversation 交给已有子对话（用户的一条消息只交给关联最紧密的一个子对话）、start_workflow 启动工作流（在你下面开工作流子对话）、stop_workflow 终止它的流程图；'
        : at === 'coordinator'
          ? '先用 list_conversations 看现有子对话的标题、状态和最近结果，相关就用 send_to_conversation 交给它（用户的一条消息只交给关联最紧密的一个子对话），需要新建就用 create_conversation；'
          : '',
    call: async (o) => text(await o.conversations()),
  },
  {
    name: 'create_conversation',
    when: (o) => o.coordinator,
    def: (o) => ({
      name: 'create_conversation',
      title: '新建子对话',
      description:
        '新建一个子对话并把这条需求交给它处理（异步执行，马上返回）。现有子对话都不相关、且需求需要改代码或做较大的研究时用。标题由你分析这条需求后起，不要照抄用户原话的开头几个字。子对话报错、失败或被中断要重试时不要新建：用 send_to_conversation 交回原来那个子对话，它在原来的会话里接着做。',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '你分析后起的短标题（10–20 字），点明要做的功能或问题，能和其他子对话区分开',
          },
          message: {
            type: 'string',
            description:
              '完整的需求和背景，子对话只看得到这些：写清涉及的模块或目录、要交付什么、验收标准是什么；派「文档」时给出要记什么和依据在哪（提交号、文件路径、命令输出、关键结论）',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description:
              '这个子对话负责的文件或目录（相对项目根）：共用目录时面板替它认领，别的子对话要等它做完；独立分支时用来核对有没有和别的子对话改到同一个文件（两边改同一文件时 git 常常自动合并、不报冲突）',
          },
          role: {
            type: 'string',
            description: '子对话用哪个高级角色（名字）：不写用「执行」；项目里有更合适的（例如 UE 专用的）时写它',
          },
          ...childKindFields,
          route: routeField(),
          ...docsFirstFields,
          ...(o.plans ? { step: stepField('这个子对话') } : {}),
        },
        required: ['title', 'message', 'kind'],
      },
    }),
    call: async (o, a) => {
      const message = str(a?.message).trim()
      if (!message) return text('message 不能为空：写清楚需求', true)
      const files = Array.isArray(a?.files) ? a.files.map(String).filter(Boolean) : undefined
      const r = await o.createConversation(str(a?.title).trim(), message, files, str(a?.step).trim(), {
        role: str(a?.role).trim() || undefined,
        route: routeOf(a?.route),
        ...childKindArgs(a),
        ...docsFirstArgs(a),
      })
      return text(r.id ? `${r.info}（id: ${r.id}）` : r.info, !r.ok)
    },
  },
  {
    name: 'send_to_conversation',
    when: (o) => o.coordinator,
    def: (o) => ({
      name: 'send_to_conversation',
      title: '交给子对话',
      description:
        '把消息交给一个已有的子对话继续处理（异步执行）。它和这条消息相关时用，id 从 list_conversations 取；子对话失败或被中断后要重试也用它交回原来那个子对话，不要新建。一条消息只交给一个子对话：用户的一条消息（连同用户定下的规则）只挑关联最紧密的那一个交，同一段话不要再发给别的子对话（会被拒绝），也不要换个说法再发。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '子对话 id' },
          message: { type: 'string', description: '要交给它的消息，写清楚和原任务的关系' },
          ...upgradeBugFields,
          route: routeField(),
          ...(o.plans ? { step: stepField('这个子对话') } : {}),
        },
        required: ['id', 'message'],
      },
    }),
    call: async (o, a) => {
      const id = str(a?.id).trim()
      const message = str(a?.message).trim()
      if (!id || !message) return text('id 和 message 都要写', true)
      return reply(await o.sendToConversation(id, message, str(a?.step).trim(), routeOf(a?.route), upgradeBugArg(a)))
    },
  },
]

export const FINISH_CHILD: PanelTool = {
  name: 'finish_child',
  when: (o) => o.parentOf,
  def: () => ({
    name: 'finish_child',
    title: '收尾子对话',
    description:
      '子对话请你收尾（消息里写着「收尾请求」）时调用：面板把它的独立分支合回你所在的分支、把它计划里的收尾步骤标完成、结束它并删除独立分支和分支，你计划里等它的那一步也标完成。合并就是验收：先看它交的验证结果，不够就别收，用 send_to_conversation 交回要补的。合不进去（冲突）会自动退回给它处理。项目里有范围为「全量，合并后由父对话跑」的测试步骤时，合回后面板自动在你的目录里按顺序跑它们（结果和耗时直接回传子对话，你不用自己跑）：通过才结束它，失败会退回给它修。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '子对话 id（收尾请求里有，或者从 list_conversations 取）' },
      },
      required: ['id'],
    },
  }),
  hint: (_o, at) =>
    at === 'planning' || at === 'coordinator' ? 'finish_child 收到子对话的收尾请求时合回并结束它；' : '',
  call: async (o, a) => reply(await o.finishChild(str(a?.id).trim())),
}
