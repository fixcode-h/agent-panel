/**
 * 查状态、传话、共享状态：有并行的节点或子任务时才有（Orchestra.team），共享状态只在工作流运行里有
 */
import { noArgs, reply, str, text, type PanelTool } from './types.ts'

export const GET_STATUS: PanelTool = {
  name: 'get_status',
  when: (o) => o.team,
  def: () => ({
    name: 'get_status',
    title: '查看节点状态',
    description: '查看这次运行里各节点和派出的子 Agent 的状态、结果摘要，按层级缩进。传话、等结果前先用它找节点 id。',
    inputSchema: noArgs(),
  }),
  call: (o) => text(o.status()),
}

// 共享状态只存在于工作流运行的 task.runs 里，对话模式没有：注册了模型每次调都是「没有共享状态」
export const SHARED_STATE: PanelTool[] = [
  {
    name: 'read_state',
    when: (o) => o.sharedState,
    def: () => ({
      name: 'read_state',
      title: '读取共享状态',
      description: '读这次运行里所有节点共享的状态（键、值、版本、谁写的），长时间执行时中途用它同步进展。',
      inputSchema: noArgs(),
    }),
    // 对话模式没有共享状态（没有 task.runs），说明里也不提，免得模型去调一个不存在的工具
    hint: (_o, at) =>
      at === 'helper'
        ? 'read_state / write_state 读写共享状态；'
        : at === 'conv'
          ? 'read_state / write_state 读写本次运行的共享状态，并发节点靠它同步进展；'
          : '',
    call: (o) => text(o.readState()),
  },
  {
    name: 'write_state',
    when: (o) => o.sharedState,
    def: () => ({
      name: 'write_state',
      title: '写入共享状态',
      description:
        '写共享状态的一个键：并发节点都能看到，后写的覆盖先写的。用来同步接口、文件分工、进度和结论，写之前先读一遍别覆盖别人刚写的。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '键名，例如 interface、progress、api-changed' },
          value: { type: 'string', description: '值，写清楚别人需要知道的内容' },
        },
        required: ['key', 'value'],
      },
    }),
    call: (o, a) => {
      const key = str(a?.key).trim()
      if (!key) return text('key 不能为空', true)
      return reply(o.writeState(key, str(a?.value)))
    },
  },
]

/** 传话、看消息：有并行的节点或子任务时才有 */
export const MESSAGES: PanelTool[] = [
  {
    name: 'send_message',
    when: (o) => o.team,
    def: (o) => ({
      name: 'send_message',
      title: '传话',
      description: o.self.endsWith('@main')
        ? '给某个 Agent 发指示：正在执行的会马上收到（或在它下次查看消息时），还没开始的开始时会带上。'
        : '给同时执行的其他 Agent 传话：to 写节点 id 或标题。例如告诉并行节点你改了某个接口，让它别重复改。',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: '节点 id 或标题',
          },
          text: { type: 'string' },
        },
        required: ['to', 'text'],
      },
    }),
    call: async (o, a) => {
      const to = str(a?.to).trim()
      const body = str(a?.text).trim()
      if (!to || !body) return text('to 和 text 都要写', true)
      return reply(await o.send(to, body))
    },
  },
  {
    name: 'read_messages',
    when: (o) => o.team,
    def: () => ({
      name: 'read_messages',
      title: '查看消息',
      description: '看别的 Agent 发给你的消息（看过就清掉）。做比较久的事时中途看一下。',
      inputSchema: noArgs(),
    }),
    call: (o) => {
      const got = o.inbox()
      return text(got.length ? got.map((m) => `- ${m}`).join('\n') : '没有新消息')
    },
  },
]
