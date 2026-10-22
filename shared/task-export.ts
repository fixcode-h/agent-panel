/**
 * 任务（对话、工作流执行）的导出、导入和 AI 分析：
 * - 导出成带版本号的 JSON：消息、工作流定义、用到的 Agent、每个节点的结果和统计，去掉会话、命令、本机路径和密钥；
 * - 别人导入后是一个只读的任务，能看完整的执行过程，也能交给 AI 分析；
 * - AI 分析时把导出整理成一份 Markdown 报告附给 Agent，Agent 在回复末尾写 workflow-evolution 块，
 *   给出对工作流、节点、Agent 的修改建议（用户看过差异再应用，不会自动改）和面板框架本身的问题。
 * 服务端和在线演示共用。
 */
import { z } from 'zod'
import { Agent, TaskData, Workflow, type Task, type TaskStep } from './schema.ts'
import { includedAgents } from './agent-role.ts'
import { stepMs, stepUsage } from './task.ts'
import { t } from './i18n.ts'

export const TASK_EXPORT_FORMAT = 'agent-panel/task'
export const TASK_EXPORT_VERSION = 1

/** 一个节点的统计：耗时、等待、验收轮数、用量、缓存命中率 */
export interface NodeStat {
  id: string
  parentId: string
  title: string
  kind: TaskStep['kind']
  slot: TaskStep['slot']
  agentId: string
  status: TaskStep['status']
  ms: number
  waitMs: number
  rounds: number
  verdict: TaskStep['verdict']
  interrupted: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheHitRate: number
  costUsd: number
  /** 改动的文件数 */
  files: number
  /** 输出的字数，太短或太长都值得看一下 */
  outputChars: number
  /** 这个节点里的报错条数 */
  errors: number
}

export interface TaskStats {
  durationMs: number
  waitMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheHitRate: number
  costUsd: number
  steps: { total: number; done: number; failed: number; skipped: number; pending: number }
  /** 验收没通过、退回重做的次数 */
  reworks: number
  /** 报错条数：带错误的系统消息 + 失败的工具调用（命令、读取、编辑等失败了也是要看的） */
  errors: number
  /** 其中失败的工具调用次数 */
  failedTools: number
  /** 追加要求、对话的轮数 */
  turns: number
  /** 其中没有正常结束的（停在执行中就被打断、服务重启） */
  turnsUnfinished: number
  nodes: NodeStat[]
}

/**
 * 缓存命中率：命中缓存的 token 占输入合计的比例。
 * 输入统一按「含缓存」记（见 parser 的 usage 换算），所以分母就是 inputTokens；
 * 封顶到 100%，口径真的对不上时宁可显示 100% 也不把 3348% 这种数字交给用户。
 */
export function cacheHitRate(u: { inputTokens: number; cacheReadTokens: number }) {
  const total = u.inputTokens || 0
  if (!total) return 0
  return Math.min(1, Math.max(0, Math.round((u.cacheReadTokens / total) * 1000) / 1000))
}

/**
 * 缓存命中数超过了输入合计：说明分子分母不是一个口径（例如某个 CLI 的 input 不含缓存、没换算）。
 * 封顶本身会把数字压成 100% 看不出来，报告里要单独提示一句，否则错误口径会一直隐身。
 */
export function cacheMismatch(u: { inputTokens: number; cacheReadTokens: number }) {
  const total = u.inputTokens || 0
  return total > 0 && (u.cacheReadTokens || 0) > total * 1.05
}

/** 失败的工具调用：命令非零退出、读取失败、编辑冲突都会标上 failed */
const failedToolsOf = (task: Task, step?: string) =>
  task.messages
    .filter((m) => (step === undefined ? true : m.step === step))
    .reduce((n, m) => n + m.tools.filter((x) => x.failed).length, 0)

export function taskStats(task: Task, now = Date.now()): TaskStats {
  const errorsOf = (step: string) => task.messages.filter((m) => m.error && m.step === step).length
  const nodes = task.steps.map((s): NodeStat => {
    const u = stepUsage(s)
    return {
      id: s.id,
      parentId: s.parentId,
      title: s.title,
      kind: s.kind,
      slot: s.slot,
      agentId: s.agentId,
      status: s.status,
      ms: stepMs(s, now),
      waitMs: s.waitMs ?? 0,
      rounds: s.rounds,
      verdict: s.verdict,
      interrupted: s.interrupted,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheHitRate: cacheHitRate(u),
      costUsd: u.costUsd,
      files: s.changes.length,
      outputChars: s.output.length,
      errors: errorsOf(s.id) + failedToolsOf(task, s.id),
    }
  })
  const count = (st: TaskStep['status']) => task.steps.filter((s) => s.status === st).length
  const u = task.usage
  return {
    durationMs: task.runMs ?? 0,
    waitMs: task.waitMs ?? 0,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheHitRate: cacheHitRate(u),
    costUsd: u.costUsd,
    steps: {
      total: task.steps.length,
      done: count('done'),
      failed: count('failed'),
      skipped: count('skipped'),
      pending: count('pending') + count('running'),
    },
    reworks: task.steps.reduce((n, s) => n + Math.max(0, s.rounds - (s.verdict === 'pass' ? 1 : 0)), 0),
    errors: task.messages.filter((m) => m.error).length + failedToolsOf(task),
    failedTools: failedToolsOf(task),
    turns: task.turns?.length ?? 0,
    turnsUnfinished: (task.turns ?? []).filter((x) => x.status !== 'done').length,
    nodes,
  }
}

const SECRET = '[已移除]'
/** 常见的密钥格式：各家 API key、GitHub token、AWS key、Slack token */
const KEY_RE =
  /\b(?:sk-ant-[\w-]{16,}|sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|xox[abprs]-[\w-]{10,}|hf_[A-Za-z0-9]{20,})\b/g
const BEARER_RE = /\b(Bearer\s+)[\w.~+/=-]{16,}/gi
/** key=value、"key": "value" 这种写法里名字像密钥的值 */
const ASSIGN_RE =
  /((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|auth[_-]?token|authorization)["']?\s*[:=]\s*["']?)(?!\[已移除|Bearer\s)[^\s"',;]{6,}/gi

/** 去掉文字里的密钥 */
export function redactSecrets(s: string) {
  return s.replace(KEY_RE, SECRET).replace(BEARER_RE, `$1${SECRET}`).replace(ASSIGN_RE, `$1${SECRET}`)
}

/** 递归处理所有字符串 */
function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redactSecrets(v) as T
  if (Array.isArray(v)) return v.map(redactDeep) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T
  return v
}

/** 任务里用到的 Agent：对话的、各节点的、工作流的主 Agent，连同它们引入的 */
export function taskAgents(task: Pick<Task, 'agentId' | 'steps' | 'messages' | 'workflows'>, agents: Agent[]) {
  const ids = new Set<string>([
    task.agentId,
    ...task.steps.map((s) => s.agentId),
    ...task.messages.map((m) => m.agentId),
  ])
  for (const w of task.workflows) {
    ids.add(w.mainAgentId)
    for (const m of w.members) ids.add(m.agentId)
    for (const f of w.flows)
      for (const n of f.nodes) {
        ids.add(n.agentId)
        for (const s of n.steps) ids.add(s.agentId)
      }
  }
  for (const id of [...ids]) {
    const a = agents.find((x) => x.id === id)
    if (a) for (const x of includedAgents(a, agents)) ids.add(x.agent.id)
  }
  return agents.filter((a) => a.id && ids.has(a.id))
}

/** 导出文件里的任务：去掉只在本机有意义的字段（会话、命令、项目、独立分支和等待中的请求） */
const ExportedTask = TaskData.omit({
  projectId: true,
  sessions: true,
  sessionCli: true,
  sessionDir: true,
  wantsWorktree: true,
  rewind: true,
  command: true,
  baseline: true,
  baseRef: true,
  requests: true,
  worktree: true,
  budgetFrom: true,
  archived: true,
  imported: true,
  // 这些是运行中的临时状态，导入后都按空闲算
  working: true,
  turnDoneAt: true,
  awaitingUser: true,
  prewarming: true,
}).extend({ createdAt: z.string(), updatedAt: z.string() })
export type ExportedTask = z.infer<typeof ExportedTask>

export const TaskExport = z.object({
  format: z.literal(TASK_EXPORT_FORMAT),
  version: z.literal(TASK_EXPORT_VERSION),
  exportedAt: z.string(),
  /** 导出它的面板版本，方便排查格式问题 */
  app: z.string().default(''),
  task: ExportedTask,
  agents: z.array(Agent).default([]),
  /** 导出时算好的统计，分析时不用再算；导入时会重新算 */
  stats: z.unknown().optional(),
})
export type TaskExport = z.infer<typeof TaskExport>

/** 把任务整理成导出文件的内容 */
export function exportTask(task: Task, agents: Agent[], app = '', now = new Date()): TaskExport {
  const {
    id: _id,
    projectId: _p,
    sessions: _s,
    sessionCli: _sc,
    sessionDir: _sd,
    wantsWorktree: _ww,
    rewind: _r,
    command: _c,
    baseline: _b,
    baseRef: _br,
    requests: _rq,
    worktree: _w,
    budgetFrom: _bf,
    archived: _a,
    imported,
    ...rest
  } = task
  const body: ExportedTask = {
    ...rest,
    // 还在执行的任务导出的是当时的样子
    status: rest.status === 'running' ? 'stopped' : rest.status,
    runStartedAt: '',
    waitStartedAt: '',
    steps: rest.steps.map((s) => ({ ...s, command: [], waitStartedAt: '' })),
    // 附件只留名字和大小：路径是本机的，文件也不在导出里（路径字段不能为空，填文件名）
    messages: rest.messages.map((m) =>
      m.attachments ? { ...m, attachments: m.attachments.map((a) => ({ ...a, path: a.name })) } : m,
    ),
  }
  // 导入的任务再导出时，用导入时带来的 Agent
  const pool = imported ? [...agents, ...imported.agents.filter((a) => !agents.some((x) => x.id === a.id))] : agents
  const used = taskAgents(task, pool).map((a) => ({ ...a, categoryId: '', tags: [] }))
  return redactDeep({
    format: TASK_EXPORT_FORMAT,
    version: TASK_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    app,
    task: body,
    agents: used,
    stats: taskStats(task, now.getTime()),
  })
}

export const exportFileName = (title: string) =>
  `${title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'task'}.task.json`

/** 读导出文件：格式不对时给出能看懂的原因 */
export function parseTaskExport(raw: unknown): TaskExport {
  if (!raw || typeof raw !== 'object') throw new Error(t('不是有效的 JSON 文件'))
  const o = raw as Record<string, unknown>
  if (o.format !== TASK_EXPORT_FORMAT) throw new Error(t('这不是 Agent 面板导出的任务文件'))
  if (typeof o.version === 'number' && o.version > TASK_EXPORT_VERSION)
    throw new Error(t('这个文件是更新版本的面板导出的，请先升级面板'))
  const p = TaskExport.safeParse(raw)
  if (!p.success) throw new Error(t('任务文件的格式不对：{path}', { path: p.error.issues[0]?.path.join('.') ?? '' }))
  return p.data
}

/**
 * 导入：建一个只读的任务。Agent 不往本机的 Agent 列表里加，只存在任务里给页面显示名字；
 * 再去一遍密钥，免得别人导出时用的是旧版本、没去干净
 */
export function importTask(bundle: TaskExport, projectId: string, id: string, now = new Date().toISOString()): Task {
  const b = redactDeep(bundle)
  return {
    ...b.task,
    id,
    projectId,
    title: b.task.title,
    sessions: {},
    wantsWorktree: false,
    command: [],
    baseline: {},
    baseRef: '',
    requests: [],
    worktree: null,
    working: false,
    turnDoneAt: '',
    awaitingUser: false,
    prewarming: false,
    simulated: b.task.simulated,
    imported: { at: now, exportedAt: b.exportedAt, app: b.app, agents: b.agents },
    createdAt: b.task.createdAt,
    updatedAt: now,
  }
}

/** 页面显示导入的任务时，本机没有的 Agent 用导入时带来的 */
export function withImportedAgents(agents: Agent[], task: Pick<Task, 'imported'> | null | undefined) {
  const extra = task?.imported?.agents.filter((a) => !agents.some((x) => x.id === a.id)) ?? []
  return extra.length ? [...agents, ...extra] : agents
}

// ---- AI 分析 ----

export const EVOLUTION_LANG = 'workflow-evolution'

const fmtMs = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m${s % 60}s`
      : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const pct = (r: number) => `${Math.round(r * 100)}%`
/**
 * 记录里的时间统一用本地时间：表头原来直接切 ISO 串（UTC），正文却用 getHours()，
 * 同一份记录里能差出几个小时，读的人会以为任务跑了很久。
 */
const localTime = (iso: string) => {
  const d = new Date(iso)
  if (!iso || !Number.isFinite(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…（后面省略 ${s.length - n} 字）` : s)

/** 一次执行整理成 Markdown：统计、工作流定义、每个节点的结果、报错、用户的要求 */
export function taskReport(b: TaskExport, maxOutput = 4000) {
  const tk = b.task
  const st = (b.stats as TaskStats | undefined) ?? taskStats({ ...tk, id: '', projectId: '' } as Task)
  const agentName = (id: string) => (id ? (b.agents.find((a) => a.id === id)?.name ?? id) : '主 Agent')
  const lines: string[] = [
    `# 执行记录：${tk.title}`,
    `方式：${tk.mode === 'workflow' ? `工作流「${tk.workflowName || tk.workflowId}」（id: ${tk.workflowId}）` : `对话（Agent: ${agentName(tk.agentId)}）`}　状态：${tk.status}　开始：${localTime(tk.createdAt)}`,
    '',
    '## 统计',
    `- 执行 ${fmtMs(st.durationMs)}，其中等用户 ${fmtMs(st.waitMs)}；追加要求/对话 ${st.turns} 轮${st.turnsUnfinished ? `（其中 ${st.turnsUnfinished} 轮没有正常结束）` : ''}（对话页开着时，用户的新消息会直接交回同一个进程，多条消息可能都算在同一轮里）`,
    `- Token：输入 ${fmtK(st.inputTokens)}（缓存命中 ${fmtK(st.cacheReadTokens)}，${pct(st.cacheHitRate)}），输出 ${fmtK(st.outputTokens)}，费用 $${st.costUsd.toFixed(3)}`,
    ...(cacheMismatch(st)
      ? [
          `- 注意：缓存命中数 ${fmtK(st.cacheReadTokens)} 超过输入合计 ${fmtK(st.inputTokens)}，这两个数不是一个口径（某个 CLI 的 input 不含缓存或没换算），命中率已封顶到 100%，实际值不可信`,
        ]
      : []),
    `- 节点 ${st.steps.total} 个：完成 ${st.steps.done}，失败 ${st.steps.failed}，跳过 ${st.steps.skipped}，未完成 ${st.steps.pending}；返工 ${st.reworks} 次；报错 ${st.errors} 条（其中失败的工具调用 ${st.failedTools} 次）`,
  ]
  // 用户每条要求的发出时间：判断「后面越来越慢」时看相邻两条之间隔了多久
  const asks = tk.messages.filter((m) => m.role === 'user')
  if (asks.length > 1)
    lines.push(
      `- 用户消息 ${asks.length} 条：${asks
        .map((m) => {
          const d = new Date(m.at ?? '')
          return Number.isFinite(d.getTime())
            ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
            : '?'
        })
        .join('、')}`,
    )
  if (st.nodes.length) {
    lines.push(
      '',
      '| 节点 id | 标题 | 类型 | Agent | 状态 | 耗时 | 等待 | 验收轮数/结论 | 输入/缓存命中 | 输出 | 改文件 | 报错 |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
    )
    for (const n of st.nodes)
      lines.push(
        `| ${n.id} | ${n.title} | ${[n.kind, n.slot].filter(Boolean).join('/')} | ${agentName(n.agentId)} | ${n.status}${n.interrupted ? '（被打断）' : ''} | ${fmtMs(n.ms)} | ${fmtMs(n.waitMs)} | ${n.rounds}/${n.verdict || '-'} | ${fmtK(n.inputTokens)}/${pct(n.cacheHitRate)} | ${fmtK(n.outputTokens)} | ${n.files} | ${n.errors} |`,
      )
  }
  for (const w of tk.workflows) {
    lines.push('', `## 工作流定义：${w.name}（id: ${w.id}）`)
    if (w.description) lines.push(w.description)
    lines.push(
      `主 Agent：${agentName(w.mainAgentId)}（id: ${w.mainAgentId || '-'}）　主 Agent 调度：${w.dispatch === false ? '关' : '开'}`,
    )
    if (w.document.trim()) lines.push('', '### 工作流说明', clip(w.document.trim(), 6000))
    for (const f of w.flows) {
      lines.push('', `### 流程「${f.name || f.id}」（flow id: ${f.id}）`)
      lines.push(`连线：${f.edges.map((e) => `${e.from}→${e.to}${e.when ? `[${e.when}]` : ''}`).join('，') || '无'}`)
      for (const n of f.nodes) {
        const hooks = (['start', 'review', 'end'] as const)
          .filter((k) => n.hooks[k])
          .map((k) => `${k}=${n.hooks[k]!.kind}:${n.hooks[k]!.id}`)
        lines.push(
          '',
          `#### 节点「${n.title || n.id}」（node id: ${n.id}）`,
          n.steps.length
            ? `按顺序执行 ${n.steps.length} 步${hooks.length ? `　入口：${hooks.join('，')}` : ''}`
            : `类型 ${n.kind}${n.flow ? `（执行 ${n.flow.kind}:${n.flow.id}）` : ''}　Agent：${agentName(n.agentId)}　档位：${n.tier || '默认'}　重试：${n.retries}　验收最多 ${n.hooks.maxRounds} 轮${hooks.length ? `　入口：${hooks.join('，')}` : ''}${n.hooks.confirm ? '　完成后等用户确认' : ''}`,
        )
        if (n.steps.length) {
          for (const [i, s] of n.steps.entries()) {
            lines.push(
              `${i + 1}. ${s.title || s.id}：${s.kind === 'flow' ? `执行 ${s.flow?.kind}:${s.flow?.id}` : agentName(s.agentId)}　档位：${s.tier || '默认'}　重试：${s.retries}　验收最多 ${s.maxRounds} 轮${s.review ? `（${s.review.kind}:${s.review.id}）` : ''}${s.confirm ? '　完成后等用户确认' : ''}`,
            )
            if (s.instructions.trim()) lines.push('   要求：', clip(s.instructions.trim(), 3000))
          }
        } else if (n.instructions.trim()) lines.push('要求：', clip(n.instructions.trim(), 3000))
      }
    }
  }
  if (b.agents.length) {
    lines.push('', '## 用到的 Agent')
    for (const a of b.agents) {
      lines.push(
        '',
        `### ${a.name}（agent id: ${a.id}）`,
        `CLI：${a.cli || '默认'}　模型：${a.model || '默认'}　思考：${a.effort || '默认'}${a.skills.length ? `　Skill：${a.skills.join('、')}` : ''}`,
      )
      if (a.description) lines.push(a.description)
      if (a.instructions.trim()) lines.push('角色设定：', clip(a.instructions.trim(), 3000))
    }
  }
  lines.push('', '## 执行过程')
  // 每条带上时间：长任务「后面越来越慢」只能靠时间戳定位从哪一步开始变慢
  const at = (iso: string) => {
    if (!iso) return ''
    const d = new Date(iso)
    return Number.isFinite(d.getTime())
      ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} `
      : ''
  }
  let step = ''
  let last = ''
  for (const m of tk.messages) {
    if (m.role === 'system' && !m.error && !m.answers) continue
    if (m.step !== step) {
      step = m.step
      const s = tk.steps.find((x) => x.id === step)
      lines.push('', s ? `### 节点：${s.title}（${s.id}，${s.status}）` : '### 节点之外')
    }
    const who =
      m.role === 'user'
        ? '用户'
        : m.role === 'system'
          ? m.error
            ? '报错'
            : '用户回答'
          : `AI（${agentName(m.agentId)}）`
    const body = m.answers ? m.answers.map((a) => `${a.question}：${a.answer}`).join('\n') : m.text.trim()
    const stamp = at(m.at ?? '')
    // 和上一条同一秒的合并显示，不重复刷时间；间隔超过 1 分钟单独提示，看出等待在哪
    const gap = m.at && last ? Date.parse(m.at) - Date.parse(last) : 0
    if (gap > 60_000) lines.push('', `_（距上一条 ${fmtMs(gap)}）_`)
    if (stamp) last = m.at ?? ''
    const failed = m.tools.filter((x) => x.failed)
    const tools = m.tools.length
      ? `\n工具：${m.tools
          .slice(0, 30)
          .map((x) => `${x.name || x.kind} ${x.label}${x.failed ? '（失败）' : ''}`)
          .join('；')}${m.tools.length > 30 ? `…共 ${m.tools.length} 个` : ''}`
      : ''
    // 失败的工具调用给出输出尾部：分析返工和报错时只看到「（失败）」没法判断原因
    const detail = failed.length
      ? `\n失败详情：${failed
          .slice(0, 5)
          .map(
            (x) => `\n- ${x.name || x.kind} ${x.label}\n${clip((x.output || x.detail || '（没有输出）').trim(), 1200)}`,
          )
          .join('')}`
      : ''
    // 用户的要求不截断：约束、边界条件常常写在后面，截掉就判断不了是否满足要求
    const limit = m.role === 'user' ? Infinity : maxOutput
    if (body || tools) lines.push(`**${who}**：${stamp}${clip(body, limit)}${tools}${detail}`)
  }
  const outs = tk.steps.filter((s) => s.output.trim())
  if (outs.length) {
    lines.push('', '## 节点的最终输出（交给下游的内容）')
    for (const s of outs) lines.push('', `### ${s.title}（${s.id}）`, clip(s.output.trim(), maxOutput))
  }
  // 改动的文件按节点自己的记录列：任务级 changes 是「项目目录相对任务开始时」的差额，
  // 同一个工作区里并行的其他任务改了文件也会算进来，不能当成这次任务的产出
  const mine = tk.steps.filter((s) => s.changes.length)
  if (mine.length) {
    lines.push('', '## 改动的文件（按节点记录）')
    for (const s of mine)
      lines.push('', `### ${s.title}（${s.id}）`, ...s.changes.map((c) => `- ${c.path} +${c.add} -${c.del}`))
  } else if (tk.changes.length) {
    lines.push(
      '',
      '## 改动的文件',
      '（任务级统计：项目目录相对任务开始时全部有变化的文件；同一工作区里别的任务改的文件也会出现在这里）',
      ...tk.changes.slice(0, 80).map((c) => `- ${c.path} +${c.add} -${c.del}`),
    )
  }
  return lines.join('\n')
}

/** 多次执行合成一份报告（分析一个工作流最近几次的执行） */
export function analysisReport(bundles: TaskExport[], max = 120_000) {
  const per = Math.floor(max / Math.max(1, bundles.length))
  return bundles
    .map((b, i) => {
      const r = taskReport(b)
      const head = bundles.length > 1 ? `<!-- 第 ${i + 1} 次执行 -->\n` : ''
      return (
        head +
        (r.length > per
          ? `${r.slice(0, per * 0.4)}\n\n…（中间省略 ${r.length - per} 字）…\n\n${r.slice(-per * 0.6)}`
          : r)
      )
    })
    .join('\n\n---\n\n')
}

/** 面板执行工作流的代码在哪：分析框架问题时引用 */
const FRAMEWORK_MAP = `- shared/engine.ts：工作流执行引擎（节点调度、并发、验收轮次、开始/验收/结束入口、条件连线、重试）
- shared/dispatch.ts：主 Agent 调度（评估子 Agent 结果、通过/退回/委派工作流、整理最终结果）
- shared/agent-role.ts：拼 Agent 的角色设定、参数模板、节点用哪一档模型
- shared/flow.ts：流程图结构、拓扑顺序、工作流快照
- server/exec/runner.ts：真实执行（启动 CLI、续接会话、交接文件、权限请求、提问）
- server/exec/*.ts：各 CLI 的输出解析和参数
- shared/task.ts：计时、等待时间、用量统计`

/** 交给 Agent 的分析要求 */
export function analysisPrompt(bundles: TaskExport[], focus = '') {
  const flows = new Map<string, Workflow>()
  for (const b of bundles) for (const w of b.task.workflows) if (!flows.has(w.id)) flows.set(w.id, w)
  const agents = new Map<string, Agent>()
  for (const b of bundles) for (const a of b.agents) agents.set(a.id, a)
  const targets = [
    ...[...flows.values()].map(
      (w) =>
        `- 工作流 workflowId: ${w.id}｜${w.name}\n${w.flows
          .flatMap((f) => f.nodes.map((n) => `  - 节点 flowId: ${f.id}, nodeId: ${n.id}｜${n.title || n.id}`))
          .join('\n')}`,
    ),
    ...[...agents.values()].filter((a) => a.id).map((a) => `- Agent agentId: ${a.id}｜${a.name}`),
  ]
  const one = bundles.length === 1 ? bundles[0].task : null
  const head = one
    ? `分析附件里这次${one.mode === 'workflow' ? '工作流执行' : '对话'}「${one.title}」的完整记录`
    : `分析附件里工作流最近 ${bundles.length} 次执行的完整记录`
  return `${head}，判断哪里需要优化，并给出可以直接应用的修改建议。只分析，不要修改任何文件。
${focus.trim() ? `\n用户特别关心：${focus.trim()}\n` : ''}
## 要回答的问题
1. 结果质量：最终产出是否达到了用户的要求？哪里不够好、为什么（引用记录里的原文或节点）。
2. 工作流本身：节点拆分是否合理、要求写得清不清楚、有没有多余或缺少的节点、验收标准和轮数、模型档位和重试是否合适；
   结合统计看耗时、token、缓存命中率、返工和报错集中在哪里，哪些节点可以合并、并行或用更低的档位。
3. Agent：角色设定有没有含糊、冲突、和节点要求重复的地方。
4. 面板框架：有没有看起来是面板（执行引擎、调度、CLI 调用、计时统计）本身的问题，而不是工作流写得不好，
   例如状态不对、输出丢失、重复执行、等待时间算错、提示词拼得不对。面板代码的位置：
${FRAMEWORK_MAP}
   只写成发现，写清现象、依据和可能的位置（文件路径，能确定时带行号），不要去改面板代码。

## 回复格式
用中文写，排版要好读：开头不加标题，用两三句话给结论；再用「### 1. 结果质量」「### 2. 工作流」「### 3. Agent」「### 4. 面板框架」四个小标题分节，节里用列表一条一条写，每条都要有依据，关键数字和节点名加粗。没有问题的一节写一句「没有发现问题」。

最后单独写一个代码块，语言名写 ${EVOLUTION_LANG}，内容是 JSON，把建议的修改写成可以直接应用的形式：

\`\`\`${EVOLUTION_LANG}
{
  "summary": "一句话概括这次的建议",
  "changes": [
    {"target": "node", "workflowId": "…", "flowId": "…", "nodeId": "…", "field": "instructions", "value": "改好后的完整内容", "reason": "为什么这样改"},
    {"target": "workflow", "workflowId": "…", "field": "document", "value": "改好后的完整说明", "reason": "…"},
    {"target": "agent", "agentId": "…", "field": "instructions", "value": "改好后的完整角色设定", "reason": "…"}
  ],
  "framework": [
    {"title": "问题标题", "detail": "现象、依据、建议怎么改", "files": ["shared/engine.ts:120"]}
  ]
}
\`\`\`

- target 为 node 时 field 可以是 instructions、title、tier（high/medium/low/空字符串）、retries（0-5）、maxRounds（1-10）、confirm（true/false）；
  workflow 可以是 document、description；agent 可以是 instructions、description。
- value 写修改后的**完整**值（不是片段，也不是差异），用户会看到和现在的对比再决定是否应用。
- 只用下面列出的 id，不要编造；没有值得改的就写空数组。不要为了凑数改动，每条改动都要能从记录里找到依据。

## 可以修改的对象
${targets.join('\n') || '（没有工作流，只能给 Agent 的建议）'}`
}

// ---- 修改建议 ----

const NODE_FIELDS = ['instructions', 'title', 'tier', 'retries', 'maxRounds', 'confirm'] as const
const Change = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('node'),
    workflowId: z.string(),
    flowId: z.string().default(''),
    nodeId: z.string(),
    field: z.enum(NODE_FIELDS),
    value: z.unknown(),
    reason: z.string().default(''),
  }),
  z.object({
    target: z.literal('workflow'),
    workflowId: z.string(),
    field: z.enum(['document', 'description']),
    value: z.unknown(),
    reason: z.string().default(''),
  }),
  z.object({
    target: z.literal('agent'),
    agentId: z.string(),
    field: z.enum(['instructions', 'description']),
    value: z.unknown(),
    reason: z.string().default(''),
  }),
])
export type EvolutionChange = z.infer<typeof Change>

export interface FrameworkFinding {
  title: string
  detail: string
  files: string[]
}

export interface Evolution {
  summary: string
  changes: EvolutionChange[]
  framework: FrameworkFinding[]
}

const BLOCK = new RegExp('```' + EVOLUTION_LANG + '[^\\n]*\\n([\\s\\S]*?)```', 'g')

/** 从回复里读出最后一个建议块；格式不对的单条跳过 */
export function parseEvolution(text: string): Evolution | null {
  const last = [...text.matchAll(BLOCK)].at(-1)
  if (!last) return null
  let raw: unknown
  try {
    raw = JSON.parse(last[1].trim())
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const changes = (Array.isArray(o.changes) ? o.changes : [])
    .map((c) => Change.safeParse(c))
    .filter((p) => p.success)
    .map((p) => p.data)
  const framework = (Array.isArray(o.framework) ? o.framework : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      title: String(f.title ?? '').trim(),
      detail: String(f.detail ?? '').trim(),
      files: Array.isArray(f.files) ? f.files.map(String).slice(0, 10) : [],
    }))
    .filter((f) => f.title || f.detail)
  return { summary: String(o.summary ?? '').trim(), changes, framework }
}

/** 显示时去掉建议块（界面另外画成可以审阅的差异）；流式输出到一半时去掉到结尾 */
export function stripEvolution(text: string) {
  if (!text.includes('```' + EVOLUTION_LANG)) return text
  return text
    .replace(BLOCK, '')
    .replace(new RegExp('```' + EVOLUTION_LANG + '[\\s\\S]*$'), '')
    .trimEnd()
}

/** 一条建议在现在的数据上的样子：改之前、改之后（都转成文字方便对比）；对象不存在或值不合法时给出原因 */
export interface ResolvedChange {
  change: EvolutionChange
  /** 显示用：工作流「x」· 节点「y」· 要求 */
  label: string
  /** label 拆开的两段：改的是哪个对象（工作流「x」· 节点「y」）、哪一项（要求）；界面分开排版 */
  scope: string
  field: string
  before: string
  after: string
  error?: string
}

const fieldLabel = (f: string, agent = false) =>
  ({
    instructions: agent ? t('角色设定') : t('要求'),
    title: t('标题'),
    tier: t('模型档位'),
    retries: t('失败重试次数'),
    maxRounds: t('验收最多轮数'),
    confirm: t('完成后等用户确认'),
    document: t('工作流说明'),
    description: t('简介'),
  })[f] ?? f

const text = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

/** 校验并规整建议的值，不合法时返回错误 */
function normalize(c: EvolutionChange): { value: unknown } | { error: string } {
  const v = c.value
  if (c.target === 'node' && c.field === 'tier')
    return ['', 'high', 'medium', 'low'].includes(String(v ?? ''))
      ? { value: String(v ?? '') }
      : { error: t('档位只能是 high、medium、low 或空') }
  if (c.target === 'node' && (c.field === 'retries' || c.field === 'maxRounds')) {
    const n = Number(v)
    const [lo, hi] = c.field === 'retries' ? [0, 5] : [1, 10]
    return Number.isInteger(n) && n >= lo && n <= hi
      ? { value: n }
      : { error: t('应该是 {lo} 到 {hi} 的整数', { lo, hi }) }
  }
  if (c.target === 'node' && c.field === 'confirm')
    return typeof v === 'boolean' ? { value: v } : { error: t('应该是 true 或 false') }
  if (typeof v !== 'string') return { error: t('应该是文字') }
  const max = c.field === 'title' ? 60 : c.field === 'description' ? 200 : c.target === 'node' ? 20000 : 50000
  if (c.field === 'title' && !v.trim()) return { error: t('标题不能为空') }
  return v.length > max
    ? { error: t('超过 {n} 字', { n: max }) }
    : { value: c.field === 'title' || c.field === 'description' ? v.trim() : v }
}

export function resolveChange(c: EvolutionChange, workflows: Workflow[], agents: Agent[]): ResolvedChange {
  const f = fieldLabel(c.field, c.target === 'agent')
  const norm = normalize(c)
  const after = 'value' in norm ? text(norm.value) : text(c.value)
  if (c.target === 'agent') {
    const a = agents.find((x) => x.id === c.agentId)
    const label = t('角色「{name}」· {field}', { name: a?.name ?? c.agentId, field: f })
    const head = { change: c, label, scope: t('角色「{name}」', { name: a?.name ?? c.agentId }), field: f }
    if (!a) return { ...head, before: '', after, error: t('本机没有这个角色') }
    return { ...head, before: text(a[c.field]), after, error: 'error' in norm ? norm.error : undefined }
  }
  const w = workflows.find((x) => x.id === c.workflowId)
  if (c.target === 'workflow') {
    const label = t('工作流「{name}」· {field}', { name: w?.name ?? c.workflowId, field: f })
    const head = { change: c, label, scope: t('工作流「{name}」', { name: w?.name ?? c.workflowId }), field: f }
    if (!w) return { ...head, before: '', after, error: t('本机没有这个工作流') }
    return { ...head, before: text(w[c.field]), after, error: 'error' in norm ? norm.error : undefined }
  }
  const flow = w?.flows.find((x) => x.id === c.flowId) ?? w?.flows.find((x) => x.nodes.some((n) => n.id === c.nodeId))
  const node = flow?.nodes.find((n) => n.id === c.nodeId)
  const label = t('工作流「{name}」· 节点「{node}」· {field}', {
    name: w?.name ?? c.workflowId,
    node: node?.title || c.nodeId,
    field: f,
  })
  const scope = t('工作流「{name}」· 节点「{node}」', { name: w?.name ?? c.workflowId, node: node?.title || c.nodeId })
  const head = { change: c, label, scope, field: f }
  if (!w) return { ...head, before: '', after, error: t('本机没有这个工作流') }
  if (!node) return { ...head, before: '', after, error: t('工作流里没有这个节点') }
  const cur = c.field === 'maxRounds' || c.field === 'confirm' ? (node.hooks[c.field] ?? false) : node[c.field]
  return { ...head, before: text(cur), after, error: 'error' in norm ? norm.error : undefined }
}

/** 把选中的建议应用到工作流和 Agent 上，返回改过的那些（调用方再保存）；不合法的跳过 */
export function applyChanges(changes: EvolutionChange[], workflows: Workflow[], agents: Agent[]) {
  const ws = new Map<string, Workflow>()
  const as = new Map<string, Agent>()
  for (const c of changes) {
    const norm = normalize(c)
    if (!('value' in norm)) continue
    if (c.target === 'agent') {
      const a = as.get(c.agentId) ?? agents.find((x) => x.id === c.agentId)
      if (a) as.set(a.id, { ...a, [c.field]: norm.value })
      continue
    }
    const base = ws.get(c.workflowId) ?? workflows.find((x) => x.id === c.workflowId)
    if (!base) continue
    const w: Workflow = structuredClone(base)
    if (c.target === 'workflow') (w as Record<string, unknown>)[c.field] = norm.value
    else {
      const flow =
        w.flows.find((x) => x.id === c.flowId && x.nodes.some((n) => n.id === c.nodeId)) ??
        w.flows.find((x) => x.nodes.some((n) => n.id === c.nodeId))
      const node = flow?.nodes.find((n) => n.id === c.nodeId)
      if (!node) continue
      if (c.field === 'maxRounds') node.hooks.maxRounds = norm.value as number
      else if (c.field === 'confirm') node.hooks.confirm = norm.value as boolean
      else (node as Record<string, unknown>)[c.field] = norm.value
    }
    ws.set(w.id, w)
  }
  return { workflows: [...ws.values()], agents: [...as.values()] }
}

/** 按行比较两段文字（最长公共子序列），给建议的差异视图用；太长时退化成整段替换 */
export function lineDiff(a: string, b: string): { kind: 'same' | 'add' | 'del'; text: string }[] {
  const x = a ? a.split('\n') : []
  const y = b ? b.split('\n') : []
  if (x.length * y.length > 4_000_000)
    return [...x.map((s) => ({ kind: 'del' as const, text: s })), ...y.map((s) => ({ kind: 'add' as const, text: s }))]
  const n = x.length
  const m = y.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: { kind: 'same' | 'add' | 'del'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ kind: 'same', text: x[i] }), i++, j++)
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', text: x[i++] })
    else out.push({ kind: 'add', text: y[j++] })
  }
  while (i < n) out.push({ kind: 'del', text: x[i++] })
  while (j < m) out.push({ kind: 'add', text: y[j++] })
  return out
}

/** 在线演示：按分析要求里列出的对象编一份建议，演示里也能看到差异和应用 */
export function demoEvolution(prompt: string) {
  const node = /- 工作流 workflowId: (\S+?)｜[^\n]*\n {2}- 节点 flowId: (\S+?), nodeId: (\S+?)｜([^\n]+)/.exec(prompt)
  const changes = node
    ? [
        // 演示只改简介和档位，不动节点要求：免得应用后演示里的工作流不能用了
        {
          target: 'workflow',
          workflowId: node[1],
          field: 'description',
          value: '交给它的事先确认范围再动手：列出要用到的文件和接口，产出写清楚改了什么、怎么验证的',
          reason: '记录里节点花了较多时间摸索范围，简介里写明做法，选工作流时也更清楚',
        },
        {
          target: 'node',
          workflowId: node[1],
          flowId: node[2],
          nodeId: node[3],
          field: 'tier',
          value: 'medium',
          reason: '这一步不需要最高档，降一档能省 token',
        },
      ]
    : []
  return (
    '```' +
    EVOLUTION_LANG +
    '\n' +
    JSON.stringify(
      {
        summary: '把做法写进简介，降低不必要的模型档位',
        changes,
        framework: [
          {
            title: '验收不通过后重做时没有带上一轮的改动摘要',
            detail:
              '演示示例：重做的节点重新读了一遍全部文件，耗时比第一轮还长。可以在退回意见里附上上一轮的改动列表。',
            files: ['shared/engine.ts'],
          },
        ],
      },
      null,
      2,
    ) +
    '\n```'
  )
}
