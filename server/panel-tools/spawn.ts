/**
 * 派子任务：spawn_agents / stop_subtask / wait_agents（Orchestra.canSpawn）。
 * 子任务不能再派子任务，Chat 模式不派子任务（canSpawn 为 false）
 */
import type { HelperReport, HelperSpec } from '../../shared/engine-host.ts'
import {
  agentField,
  batchField,
  briefOf,
  paramsField,
  resumeField,
  reviewField,
  routeField,
  routeOf,
  SPAWN_TOP_FIELDS,
  stepField,
  tasksField,
  tierField,
} from '../orch-fields.ts'
import { reply, str, text, type PanelTool } from './types.ts'

// wait_agents 等到子任务全部结束或有人传话才回（每回一次 CLI 就带整份上下文再请求一次），这是兜底上限：
// 要短于 CLI 一次工具调用的超时（Codex 的 tool_timeout_sec 在定义里放宽到 1 小时），等待期间写 SSE 心跳（ask-mcp.ts）
export const WAIT_AGENTS_S = 1500

function reportText(r: HelperReport) {
  const head = `### ${r.id}｜${r.title}（${r.status === 'done' ? '完成' : r.status === 'failed' ? '失败' : r.status === 'running' ? '执行中' : '没有执行'}）`
  return [head, r.output, r.error ? `出错：${r.error}` : ''].filter(Boolean).join('\n')
}

export const SPAWN_TOOLS: PanelTool[] = [
  {
    name: 'spawn_agents',
    when: (o) => o.canSpawn,
    def: (o) => ({
      name: 'spawn_agents',
      title: '派出子任务',
      description: o.autoReturn
        ? '派子任务并行处理互不相关的几件事（收集资料、查代码、核实结论、出计划），马上返回它们的 id。派完就可以结束这一轮回复：对话会停下等它们全部做完，结果自动交回给你接着做，不用轮询。子任务不能再派子任务、不能启动工作流或子对话。只拆真正能同时做的事，小事自己做更快。'
        : '派子任务并行处理互不相关的几块工作（收集资料、查代码、核实结论、出计划），马上返回它们的 id，不等它们做完；之后用 wait_agents 取结果，节点结束前没取的结果也会并进你的输出。子任务不能再派子任务。只拆真正能同时做、不会改同一个文件的事，小事自己做更快。',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: tasksField(o),
          // 整批的默认值：只派一个任务时可以直接写在顶层。只读 tasks[i] 的话，模型把 resume 写在顶层时
          // 会被静默丢掉，复看的评审退回默认「子任务」角色 + 新会话（提示词也跟着换了一套）
          agent: batchField(agentField(o)),
          tier: batchField(tierField()),
          resume: resumeField(true),
          params: batchField(paramsField()),
          review: batchField(reviewField()),
          // 和 create_conversation / run_background 一样：这批子任务全部结束、结果交回时，
          // 计划里这一步标完成；失败或被终止退回进行中并写清原因
          ...(o.plans ? { step: stepField('这批子任务') } : {}),
          ...(o.coordinator ? { route: routeField() } : {}),
        },
        required: ['tasks'],
      },
    }),
    call: (o, a) => {
      // 顶层写了不认得的字段就报错，不静默丢掉：调用方以为生效了，实际没派成想派的那样
      const unknown = Object.keys(a && typeof a === 'object' ? a : {}).filter((k) => !SPAWN_TOP_FIELDS.includes(k))
      if (unknown.length)
        return text(
          `spawn_agents 不认得顶层字段${unknown.map((k) => `「${k}」`).join('、')}：每个子任务写进 tasks 的每一项；整批共用的 agent、tier、params、review 可以直接写在顶层，只派一个任务时 resume 也可以`,
          true,
        )
      const tasks: any[] = (Array.isArray(a?.tasks) ? a.tasks : []).filter((x: unknown) => x && typeof x === 'object')
      // 写了但不是字符串（数字、数组、对象）不能当成「没写」：会被顶层默认值顶掉，
      // 调用方以为写了 agent / tier / resume，实际一个都没生效
      const notString = (v: unknown) => v !== undefined && v !== null && typeof v !== 'string'
      const wrongType: string[] = ['agent', 'tier', 'resume'].filter((k) => notString(a?.[k])).map((k) => `顶层 ${k}`)
      tasks.forEach((x, i) => {
        for (const k of ['agent', 'tier', 'resume']) if (notString(x[k])) wrongType.push(`tasks[${i}].${k}`)
      })
      if (wrongType.length) return text(`spawn_agents 的 ${wrongType.join('、')} 要写字符串`, true)
      // params 要是对象：写成字符串（'{"task":"清理用例"}'）时静默丢掉，派出去的就是默认那套做法
      const notObject = (v: unknown) => v !== undefined && v !== null && (typeof v !== 'object' || Array.isArray(v))
      const badParams = [a?.params, ...tasks.map((x) => x.params)].some(notObject)
      if (badParams) return text('spawn_agents 的 params 要写对象，例如 {"task": "清理用例"}', true)
      // 顶层 resume 是一批共用的一份：一个会话只能接着跑一轮，配多个任务就说不清谁接它
      const topResume = str(a?.resume) || undefined
      if (topResume && tasks.length > 1)
        return text('顶层 resume 只能配一个子任务：一次派多个时把 resume 写进对应那一项', true)
      // 默认值：任务里写了以任务里的为准（没写才落到顶层），都不写交给引擎（角色沿用原任务、档位跟发起节点）
      const batch = { agent: str(a?.agent) || undefined, tier: str(a?.tier) || undefined, resume: topResume }
      const list: HelperSpec[] = tasks.map((x) => ({
        title: str(x.title),
        instructions: str(x.instructions),
        agent: str(x.agent) || batch.agent,
        tier: str(x.tier) || batch.tier,
        resume: str(x.resume) || batch.resume,
        params: x.params ?? a?.params ?? undefined,
        // 顶层 review 是整批共用的交接单：模型常照着顶层 agent、tier 的写法把它也写在顶层，拒掉只会白费一轮
        review: briefOf(x.review) ?? briefOf(a?.review),
      }))
      // 点名的计划步骤由面板在子任务全部结束后收口（见 engine.ts 的 settleHelperWaits）
      const stepId = str(a?.step).trim()
      const r = o.spawn(list, stepId || undefined, { route: routeOf(a?.route) })
      if (r.error) return text(r.error, true)
      // 整批都转交父对话了：本地一个也没派，不能写成「已派出 0 个子任务」
      if (!r.ids.length) return text(r.info || '已交给父对话创建这些子任务')
      const body = o.autoReturn
        ? `已派出 ${r.ids.length} 个子任务：${r.ids.join('、')}\n可以结束这一轮回复了，它们全部做完后结果会自动交回给你。`
        : `已派出 ${r.ids.length} 个子任务：${r.ids.join('、')}\n用 wait_agents 取结果。`
      return text([body, r.info].filter(Boolean).join('\n'))
    },
  },
  {
    name: 'stop_subtask',
    when: (o) => o.canSpawn,
    def: () => ({
      name: 'stop_subtask',
      title: '终止子任务',
      description:
        '终止你派出的子任务：方向错了、已经不需要了、卡住不动时用。还在跑的马上结束，还在排队的不再开始，它们按「已终止」交回，不用再等。ids 不写就终止你派出的全部还没结束的子任务。',
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: '子任务的 id（spawn_agents 返回的）或标题；不写就是全部还没结束的',
          },
          reason: { type: 'string', description: '为什么终止，一句话' },
        },
        required: ['reason'],
      },
    }),
    call: (o, a) => {
      const ids = Array.isArray(a?.ids) ? a.ids.map(String).filter((x: string) => x.trim()) : []
      const why = str(a?.reason).trim() || '派它的对话决定不再需要'
      return reply(o.stopHelpers(ids, why))
    },
  },
  // 对话里子任务做完会自动交回，不给等待工具：给了模型就会每隔几十秒调一次轮询，白白占着上下文
  {
    name: 'wait_agents',
    when: (o) => o.canSpawn && !o.autoReturn,
    def: () => ({
      name: 'wait_agents',
      title: '等待子任务',
      description:
        '等派出的子任务做完并取回结果：一直等到它们全部结束（或有人给你传话）才返回，等待期间不占 API 名额，调一次就够，不用轮询；只交回上次取过之后新做完的。做完前不要自己重复它们的工作。',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '子任务的 id；不写等你派出的全部' },
        },
      },
    }),
    call: async (o, a, signal) => {
      const ids = Array.isArray(a?.ids) ? a.ids.map(String) : []
      // 对话里结果会自动交回：老会话里模型还记得这个工具时不陪它等，告诉它结束这一轮。
      // 老会话的模型还会带 seconds：不再理它，短等待只会让它每隔几十秒带着整份上下文再请求一次
      const r = await o.wait(ids, o.autoReturn ? 0 : WAIT_AGENTS_S * 1000, signal)
      if (!r.done.length && !r.running.length)
        return text(r.taken ? `派出的 ${r.taken} 个子任务都已经交回过了，结果在前面。` : '你还没有派出子任务')
      // 没做完的只列 id：标题在派出时的返回里有，每次都重列一遍没有新信息
      const again = o.autoReturn
        ? '不用再查：结束这一轮回复，它们全部做完后结果会自动交回给你。'
        : '有人传话时会提前返回：先处理那条消息（收件箱里的用 read_messages 看），再调用 wait_agents 接着等。'
      return text(
        [
          r.done.length ? `做完 ${r.done.length} 个：\n\n${r.done.map(reportText).join('\n\n')}` : '',
          r.running.length ? `还在执行：${r.running.map((x) => x.id).join('、')}\n${again}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      )
    },
  },
]
