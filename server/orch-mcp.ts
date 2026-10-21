import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { HelperReport, HelperSpec, Orchestra } from '../shared/engine.ts'

/**
 * 编排工具（MCP）：工作流里每次调用 CLI 时面板临时开一个，绑定在调用它的节点上（执行引擎的 Orchestra）。
 * 节点用它派子 Agent 并行处理、取回结果、查各 Agent 的状态、向主 Agent 提问、给别的 Agent 传话。
 * 和设计工具一样由面板提供 HTTP 服务；工具调用不能等太久（Codex 默认 60 秒超时），等待都有上限
 */

/** 一次工具调用里最多等多久（秒） */
const MAX_WAIT_S = 50
const DEFAULT_WAIT_S = 40

const sessions = new Map<string, Orchestra>()

/** 交给哪个 Agent：列出通用 Agent，模型不用猜名字 */
function agentField(o: Orchestra) {
  const list = o.common.map((a) => `「${a.name}」${a.description ? `（${a.description}）` : ''}`).join('、')
  return {
    type: 'string',
    description: `交给哪个 Agent（名字）；不写用你自己的 Agent${list ? `。可以直接派的通用 Agent：${list}` : ''}`,
  }
}

const tasksField = (o: Orchestra) => ({
  type: 'array',
  description: '每个子任务交给一个子 Agent，互相之间不能有依赖',
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '子任务的短标题（显示在任务进度里）' },
      instructions: { type: 'string', description: '要做什么、范围、产出；子 Agent 只看得到这些和用户需求' },
      agent: agentField(o),
      tier: { type: 'string', enum: ['high', 'medium', 'low'], description: '模型档位；不写跟你一样' },
    },
    required: ['title', 'instructions'],
  },
})

function tools(o: Orchestra) {
  const main = o.self.endsWith('@main')
  return [
    {
      name: 'get_status',
      description:
        '查看这个任务里所有 Agent（主 Agent、各节点、派出的子 Agent）的状态和结果摘要，按层级缩进。传话、等结果前先用它找节点 id。',
      inputSchema: { type: 'object', properties: {} },
    },
    ...(o.planning
      ? [
          {
            name: 'start_plan',
            description:
              '按工作流启动一次计划执行：节点全部新建，同一层没有依赖的节点同时执行，跑完把结果交回对话。需要完整流程、跨模块改动或较大的研究时用；简单任务直接在对话里做更快。',
            inputSchema: {
              type: 'object',
              properties: {
                workflow: {
                  type: 'string',
                  description: '工作流 id（见提示里的「可用工作流」）；不写用项目默认工作流',
                },
                input: { type: 'string', description: '这次计划要做什么：目标、范围、验收标准' },
              },
              required: ['input'],
            },
          },
        ]
      : []),
    ...(o.planner && !o.planning
      ? [
          {
            name: 'run_workflow',
            description:
              '起一次新的工作流运行：节点全部新建，从开始节点按流程图顺序执行一遍（同一层没有依赖的节点同时执行）。这次运行走完就停下，不会自己再跑。你的会话保留，前面几轮的结论还在。',
            inputSchema: {
              type: 'object',
              properties: {
                input: { type: 'string', description: '这次运行要做什么：目标、范围、和上一轮的区别' },
              },
              required: ['input'],
            },
          },
          {
            name: 'close_run',
            description:
              '结束这次运行：还没执行的节点不再执行，之后的要求由你直接处理。用户说不用再走了、或者走不下去时用。',
            inputSchema: { type: 'object', properties: {} },
          },
        ]
      : []),
    ...(o.coordinator
      ? [
          {
            name: 'list_conversations',
            description: '列出当前对话下的子对话：id、标题、状态和最近一条结果。分派前先用它确认有没有合适的子对话。',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'create_conversation',
            description:
              '新建一个子对话并把这条需求交给它处理（异步执行，马上返回）。现有子对话都不相关、且需求需要改代码或做较大的研究时用。标题由你分析这条需求后起，不要照抄用户原话的开头几个字。',
            inputSchema: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: '你分析后起的短标题（10–20 字），点明要做的功能或问题，能和其他子对话区分开',
                },
                message: { type: 'string', description: '完整的需求和背景，子对话只看得到这些' },
              },
              required: ['title', 'message'],
            },
          },
          {
            name: 'send_to_conversation',
            description: '把消息交给一个已有的子对话继续处理（异步执行）。它和这条消息相关时用，id 从 list_conversations 取。',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '子对话 id' },
                message: { type: 'string', description: '要交给它的消息，写清楚和原任务的关系' },
              },
              required: ['id', 'message'],
            },
          },
        ]
      : []),
    {
      name: 'read_state',
      description: '读这次运行里所有节点共享的状态（键、值、版本、谁写的），长时间执行时中途用它同步进展。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'write_state',
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
    },
    {
      name: 'spawn_agents',
      description:
        '派子 Agent 并行处理互不相关的几块工作（例如几个模块分别改、几类测试分别跑），马上返回它们的 id，不等它们做完；之后用 wait_agents 取结果。子 Agent 也能再派一层。只拆真正能同时做、不会改同一个文件的事，小事自己做更快。',
      inputSchema: { type: 'object', properties: { tasks: tasksField(o) }, required: ['tasks'] },
    },
    {
      name: 'wait_agents',
      description: `等派出的子 Agent 做完并取回结果。一次最多等 ${MAX_WAIT_S} 秒，没做完的会列出来，过一会儿再调用；做完前不要自己重复它们的工作。`,
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '子 Agent 的 id；不写等你派出的全部' },
          seconds: { type: 'number', description: `最多等几秒（默认 ${DEFAULT_WAIT_S}，最多 ${MAX_WAIT_S}）` },
        },
      },
    },
    ...(o.hasMain && !main
      ? [
          {
            name: 'ask_main',
            description:
              '向主 Agent 提问：需求有歧义、几种做法拿不准、和别的节点有冲突时用它，不要自己猜。主 Agent 忙时先返回，回答之后用 read_messages 取。',
            inputSchema: {
              type: 'object',
              properties: { question: { type: 'string', description: '问题，写清楚背景和可选的做法' } },
              required: ['question'],
            },
          },
        ]
      : []),
    {
      name: 'send_message',
      description: main
        ? '给某个 Agent 发指示：正在执行的会马上收到（或在它下次查看消息时），还没开始的开始时会带上。'
        : '给同时执行的其他 Agent 传话：to 写节点 id 或标题。例如告诉并行节点你改了某个接口，让它别重复改。',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '节点 id 或标题；main 表示主 Agent' },
          text: { type: 'string' },
        },
        required: ['to', 'text'],
      },
    },
    {
      name: 'read_messages',
      description: '看别的 Agent 发给你的消息和主 Agent 的回答（看过就清掉）。做比较久的事时中途看一下。',
      inputSchema: { type: 'object', properties: {} },
    },
  ]
}

const text = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError && { isError }) })
const str = (v: unknown) => (typeof v === 'string' ? v : '')

function reportText(r: HelperReport) {
  const head = `### ${r.id}｜${r.title}（${r.status === 'done' ? '完成' : r.status === 'failed' ? '失败' : r.status === 'running' ? '执行中' : '没有执行'}）`
  return [head, r.output, r.error ? `出错：${r.error}` : ''].filter(Boolean).join('\n')
}

/** 执行一个工具调用 */
export async function callOrchTool(o: Orchestra, name: string, a: any) {
  switch (name) {
    case 'get_status':
      return text(o.status())
    case 'start_plan': {
      const input = str(a?.input).trim()
      if (!input) return text('input 是空的：写清楚这次计划要做什么', true)
      const r = o.plan(str(a?.workflow).trim(), input)
      return text(r.info, !r.ok)
    }
    case 'read_state':
      return text(o.readState())
    case 'write_state': {
      const key = str(a?.key).trim()
      if (!key) return text('key 不能为空', true)
      const r = o.writeState(key, str(a?.value))
      return text(r.info, !r.ok)
    }
    case 'list_conversations':
      return text(await o.conversations())
    case 'create_conversation': {
      const message = str(a?.message).trim()
      if (!message) return text('message 不能为空：写清楚需求', true)
      const r = await o.createConversation(str(a?.title).trim(), message)
      return text(r.id ? `${r.info}（id: ${r.id}）` : r.info, !r.ok)
    }
    case 'send_to_conversation': {
      const id = str(a?.id).trim()
      const message = str(a?.message).trim()
      if (!id || !message) return text('id 和 message 都要写', true)
      const r = await o.sendToConversation(id, message)
      return text(r.info, !r.ok)
    }
    case 'run_workflow': {
      const input = str(a?.input).trim()
      if (!input) return text('input 是空的：写清楚这次运行要做什么', true)
      const r = o.run(input)
      return text(r.info, !r.ok)
    }
    case 'close_run': {
      const r = o.closeRun()
      return text(r.info, !r.ok)
    }
    case 'spawn_agents': {
      const list: HelperSpec[] = (Array.isArray(a?.tasks) ? a.tasks : [])
        .filter((x: unknown) => x && typeof x === 'object')
        .map((x: any) => ({
          title: str(x.title),
          instructions: str(x.instructions),
          agent: str(x.agent) || undefined,
          tier: str(x.tier) || undefined,
        }))
      const r = o.spawn(list)
      if (r.error) return text(r.error, true)
      return text(`已派出 ${r.ids.length} 个子 Agent：${r.ids.join('、')}\n用 wait_agents 取结果。`)
    }
    case 'wait_agents': {
      const ids = Array.isArray(a?.ids) ? a.ids.map(String) : []
      const s = Math.min(MAX_WAIT_S, Math.max(1, Number(a?.seconds) || DEFAULT_WAIT_S))
      const r = await o.wait(ids, s * 1000)
      if (!r.done.length && !r.running.length) return text('你还没有派出子 Agent')
      return text(
        [
          r.done.length ? `做完 ${r.done.length} 个：\n\n${r.done.map(reportText).join('\n\n')}` : '',
          r.running.length
            ? `还在执行 ${r.running.length} 个：${r.running.map((x) => `${x.id}｜${x.title}`).join('、')}\n过一会儿再调用 wait_agents。`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      )
    }
    case 'ask_main': {
      const q = str(a?.question).trim()
      if (!q) return text('question 是空的', true)
      const r = await o.ask(q, DEFAULT_WAIT_S * 1000)
      if (r.error) return text(r.error, true)
      if (r.pending) return text('主 Agent 还在处理别的事，回答到了会放进你的消息里，过一会儿用 read_messages 看。')
      return text(`主 Agent 的回答：\n${r.answer || '（没有回答内容）'}`)
    }
    case 'send_message': {
      const to = str(a?.to).trim()
      const body = str(a?.text).trim()
      if (!to || !body) return text('to 和 text 都要写', true)
      const r = await o.send(to, body)
      return text(r.info, !r.ok)
    }
    case 'read_messages': {
      const got = o.inbox()
      return text(got.length ? got.map((m) => `- ${m}`).join('\n') : '没有新消息')
    }
    default:
      return text(`没有这个工具：${name}`, true)
  }
}

async function handle(o: Orchestra, msg: any) {
  if (msg?.id === undefined || msg?.id === null) return undefined
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result })
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-panel-orch', version: '1.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: tools(o) })
    case 'tools/call':
      return reply(await callOrchTool(o, String(msg.params?.name ?? ''), msg.params?.arguments ?? {}))
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `不支持 ${msg.method}` } }
  }
}

/** 给一次调用开编排工具：url 交给 CLI，close 在这次调用结束时调用 */
export function openOrchSession(o: Orchestra) {
  const token = randomUUID()
  sessions.set(token, o)
  const port = Number(process.env.PORT ?? 8787)
  return {
    url: `http://127.0.0.1:${port}/api/mcp/orch/${token}`,
    close: () => sessions.delete(token),
  }
}

/** 交给 CLI 的一句用法说明：工具列表模型自己看得到，这里说什么时候用 */
export function orchHint(o: Orchestra) {
  // 通用 Agent 写进说明里：不写的话模型很少想到去派别的 Agent
  const common = o.common.length
    ? `；可以派的通用 Agent：${o.common.map((a) => `「${a.name}」`).join('、')}（spawn_agents 的 agent 写名字）`
    : ''
  const state = 'read_state / write_state 读写本次运行的共享状态，并发节点靠它同步进展；'
  if (o.planning)
    return `（你有编排工具 orch：${o.coordinator ? 'list_conversations 看现有子对话、create_conversation 新建子对话、send_to_conversation 交给已有子对话；' : ''}start_plan 按工作流启动一次计划；get_status 查看节点状态；${state}send_message 给并行节点传话、read_messages 看别人发给你的；需要并行核实时可以用 spawn_agents 派子 Agent、wait_agents 取结果${common}。）`
  return o.self.endsWith('@main')
    ? `（你有编排工具 orch：${o.planner ? 'run_workflow 按流程图起一次新的运行、close_run 结束这次运行；' : ''}get_status 查看各 Agent 的状态和结果；${state}send_message 给正在执行的 Agent 发指示；需要并行核实时可以用 spawn_agents 派子 Agent、wait_agents 取结果${common}。）`
    : `（你有编排工具 orch：能拆成互不相关的几块时用 spawn_agents 派子 Agent 同时做，再用 wait_agents 取结果；get_status 查看其他 Agent 的状态；${state}${o.hasMain ? '拿不准、需要决定时用 ask_main 问主 Agent，不要自己猜；' : ''}send_message 传话，read_messages 看别人发给你的${common}。）`
}

export function orchMcpApi() {
  return new Hono()
    .post('/orch/:token', async (c) => {
      const o = sessions.get(c.req.param('token'))
      if (!o) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '这次调用已经结束了' } }, 404)
      const body = await c.req.json().catch(() => null)
      const out = Array.isArray(body)
        ? (await Promise.all(body.map((m) => handle(o, m)))).filter(Boolean)
        : await handle(o, body)
      if (!out || (Array.isArray(out) && !out.length)) return c.body(null, 202)
      return c.json(out)
    })
    .get('/orch/:token', (c) => c.body(null, 405))
    .delete('/orch/:token', (c) => c.body(null, 200))
}
