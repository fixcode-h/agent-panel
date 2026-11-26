/** 演示任务里的样例：计划、用量、几条报错和警告，从 demo-backend.ts 拆出来（文件行数上限） */
import { type PlanStatus, Task, type TaskMessage, type TaskTurn } from '@shared/schema'

export function demoPlans(task: Task) {
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
  const item = (id: string, title: string, status: PlanStatus, start = 0, end = 0) => ({
    id,
    title,
    status,
    note: '',
    waits: [],
    startedAt: start ? at(start) : '',
    endedAt: end ? at(end) : '',
    // 这项最后一次变化：演示里「进行中」的那一步 12 分钟没动了，界面上的滞后标记和「N 分钟前更新」才验得到
    updatedAt: end ? at(end) : start ? at(start) : '',
  })
  task.plans = [
    {
      id: 'p1',
      title: '定位角标不刷新的原因',
      createdAt: at(40),
      doneAt: at(30),
      summary:
        '角标读的是首次渲染时的购物车快照，加购后没有订阅 `cart:changed` 事件。已确认问题在 `CartBadge.tsx`，修复放到下一份计划里做。',
      autoSummary: false,
      steps: [
        { ...item('1', '复现：连续加购三次看角标', 'done', 40, 37), children: [] },
        { ...item('2', '找出角标的数据来源', 'done', 37, 30), children: [] },
      ],
    },
    {
      id: 'p2',
      title: '修复购物车角标',
      createdAt: at(28),
      // 计划最后变化在第 3 步开始的时候，之后 12 分钟没动过：折叠头的「N 分钟前更新」应该是警示色
      updatedAt: at(12),
      doneAt: '',
      summary: '',
      autoSummary: false,
      steps: [
        { ...item('1', '角标订阅购物车变化', 'done', 28, 20), children: [] },
        {
          ...item('2', '跑端到端测试', 'waiting', 20),
          waits: [{ kind: 'background', ref: 'e2e01', label: '端到端测试', state: 'waiting' }],
          children: [],
        },
        {
          ...item('3', '补上加购后的单元测试', 'running', 18),
          children: [
            item('3.1', '覆盖连续加购', 'done', 18, 12),
            item('3.2', '覆盖删除商品后角标归零', 'running', 12),
            item('3.3', '覆盖未登录的本地购物车', 'pending'),
          ],
        },
        // 等的结果没成功：没有「失败」，仍是进行中，备注红字写「需要修复：原因」，对话去查问题修好重做
        { ...item('4', '整理改动和总结', 'running'), note: '需要修复：等的结果没成功：npm run build', children: [] },
      ],
    },
  ]
}

/**
 * 演示任务的用量：几轮分散在最近十几天（故意空出两天），日历上能看到有数据的日子，
 * 按周、按月也有数。演示里本来没有 turns，不补的话用量统计永远是空的。
 * 金额按美元记在 usage 上，只当 CLI 上报的费用作对照；表格里的费用按计价模型实时折算。
 */
export function seedDemoUsage(task: Task, minutes: number) {
  if (task.turns?.length) return
  // 任务的「最近一天」：createdAt 已经按 back() 的偏移移过，不会再被重复改
  const last = new Date(new Date(task.createdAt).getTime() + minutes * 60_000)
  const turns: TaskTurn[] = []
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
  for (let i = 0; i < 12; i++) {
    // 隔几天空一天：日历上的点不必连成一片
    if (i === 5 || i === 9) continue
    const day = new Date(last.getFullYear(), last.getMonth(), last.getDate() - i)
    const startedAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10 + (i % 7), 12 + i)
    const input = 320_000 + i * 41_000
    const output = 26_000 + i * 3_100
    const cacheRead = Math.round(input * 0.62)
    const cacheWrite = Math.round(input * 0.08)
    usage.inputTokens += input
    usage.outputTokens += output
    usage.cacheReadTokens += cacheRead
    usage.cacheWriteTokens += cacheWrite
    usage.costUsd += 0.42 + i * 0.03
    turns.push({
      id: `demo-turn-${task.id.slice(-8)}-${i}`,
      title: '',
      agentId: '',
      status: 'done',
      startedAt: startedAt.toISOString(),
      endedAt: new Date(startedAt.getTime() + 90_000).toISOString(),
      from: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, waitMs: 0 },
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      waitMs: 0,
    })
  }
  task.turns = turns
  // 会话栏「模型响应」：给对话自己的 Agent 一份首包记录（有快有慢，看得出最近平均和最长）
  const agents = { ...(task.usage?.agents ?? {}) }
  const key = task.agentId || Object.keys(agents)[0] || ''
  const recent = [1420, 2310, 1860, 2950, 1730, 2080, 6400, 2210, 1690, 2470]
  const firstToken = { n: 37, sumMs: 37 * 2300, maxMs: 9800, recent }
  const blank = { context: 0, window: 0, model: '', tps: 0, lastTps: 0, outputTokens: 0, genMs: 0 }
  agents[key] = { ...((agents[key] as typeof blank | undefined) ?? blank), firstToken }
  task.usage = { ...(task.usage ?? {}), ...usage, agents }
}

/** 对话里的报错和警告长什么样：一条已恢复的网络断开、一条 CLI 没有响应、一条额度用完（见 shared/alerts.ts） */
export function demoAlerts(task: Task) {
  const at = new Date().toISOString()
  const note = (text: string, alert: TaskMessage['alert']): TaskMessage => ({
    id: `demo-${crypto.randomUUID()}`,
    role: 'system',
    agentId: '',
    step: '',
    text,
    tools: [],
    alert,
    at,
  })
  task.messages.push(
    note('Claude Code 执行失败：\n· 和模型服务的连接中途断开了。\n\n正在自动续接会话重试（第 1/2 次）…', {
      kind: 'network',
      level: 'warn',
      detail: 'API Error: Stream connection failed mid-response: terminated',
      resolved: '已自动续接，从中断的地方继续了',
    }),
    note('Claude Code 收到消息 90 秒了还没有任何输出。直接再发一条消息，面板会停掉它、接回这个会话重新开始。', {
      kind: 'no_response',
      level: 'warn',
      detail:
        'Claude Code 在 90 秒里没有任何输出（没有思考、正文或工具调用）。\n交给它的最后一条内容：\n后台命令「等待 CI」跑完了：成功',
    }),
    note('Claude Code 执行失败（退出码 1）：', {
      kind: 'quota',
      level: 'error',
      detail: 'API Error: 402 {"type":"error","error":{"type":"billing_error","message":"Insufficient balance"}}',
    }),
  )
}
