/**
 * 一段回复收尾后折叠起来的过程：折叠行上的统计口径，以及「一段已经收尾、又从子对话或后台命令来了新内容」时怎么分段。
 * 界面（Messages.tsx 的 FoldedRun / ChatReply）直接用这里的结果，口径和分段都能单独测。
 */
import type { StepStatus, TaskMessage, ToolUse } from '@shared/schema'
import { t } from '@shared/i18n'
import { stripToolMarkup } from '@shared/task'
import { PANEL_TOOL_RE, panelToolName } from '@shared/panel-tools'
import { toolView, type ToolView } from './tasks'

/** 正文里显示的文字：模型当成文字说出来的工具调用写法去掉，那些在工具的折叠块里已经有了 */
export const replyText = (m: TaskMessage) => (m.role === 'agent' ? stripToolMarkup(m.text) : m.text)

/**
 * 留在折叠外面的：报错（要让人看到）、子对话的提问（要人回答）、对话之间收发的消息
 * （父对话交代的、子对话上报的都摆在台面上，不收进「做了什么」的折叠里）
 */
export const keptOut = (m: TaskMessage) =>
  m.panel === 'ask' || !!m.peer || (m.role === 'system' && !m.panel && !m.spawned?.length)

/**
 * 派出的子任务里还没收尾的（排队中、执行中，口径和 engine 里算子任务名额一样）：
 * 它们的卡片和运行中的工具、后台命令一样留在折叠外面，放在这一段的总结上面，
 * 交回结果之后才跟着这一段收进折叠。一次派了几个、只有几个还在跑时，只把还在跑的那几行留在外面
 */
export function liveHelpers(
  msgs: TaskMessage[],
  steps: { id: string; status: StepStatus }[] | undefined,
): { msg: TaskMessage; ids: string[] }[] {
  const live = new Set((steps ?? []).filter((s) => s.status === 'running' || s.status === 'pending').map((s) => s.id))
  const out: { msg: TaskMessage; ids: string[] }[] = []
  if (!live.size) return out
  for (const m of msgs) {
    const ids = (m.spawned ?? []).filter((id) => live.has(id))
    if (ids.length) out.push({ msg: m, ids })
  }
  return out
}

/** 最后一个满足条件的下标（目标库没有 findLastIndex） */
function lastIndex<T>(list: T[], ok: (x: T) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) if (ok(list[i])) return i
  return -1
}

/** 文件路径只留文件名：折叠行里放得下两三个 */
const baseName = (p: string) => p.trim().split(/[\\/]/).filter(Boolean).pop() ?? p.trim()

/**
 * 折叠起来的过程做了什么，和 Claude Code 一样按动作归总成一句：读了几个文件、改了哪些文件、跑了几条命令。
 * 改的文件不多时直接写文件名，一眼看出这段回复动了哪里；失败的调用单独标出来
 */
function processBrief(process: TaskMessage[], helpers: number, notes: number) {
  const tools = process.flatMap((m) =>
    m.tools
      .map(toolView)
      .filter((v): v is ToolView => !!v)
      .map((v) => v.tool),
  )
  const files = (kind: ToolUse['kind']) =>
    new Set(
      tools
        .filter((x) => x.kind === kind)
        .map((x) => x.label.trim())
        .filter(Boolean),
    )
  const count = (kind: ToolUse['kind']) => tools.filter((x) => x.kind === kind).length
  const read = files('read').size || count('read')
  const edited = [...files('edit')]
  const edits = edited.length || count('edit')
  const other = tools.filter((x) => !['read', 'edit', 'run', 'search', 'web'].includes(x.kind)).length
  const thoughts = process.filter((m) => m.thinking?.trim()).length
  const parts = [
    read && t('查看 {n} 个文件', { n: read }),
    edits &&
      (edited.length && edited.length <= 2
        ? t('修改 {files}', { files: edited.map(baseName).join(t('、')) })
        : t('修改 {n} 个文件', { n: edits })),
    count('run') && t('运行 {n} 条命令', { n: count('run') }),
    count('search') && t('搜索 {n} 次', { n: count('search') }),
    count('web') && t('查阅网页 {n} 次', { n: count('web') }),
    helpers && t('派出 {n} 个子任务', { n: helpers }),
    other && t('其他操作 {n} 次', { n: other }),
    thoughts && t('思考 {n} 次', { n: thoughts }),
    notes && t('{n} 段说明', { n: notes }),
  ].filter((x): x is string => !!x)
  return { parts, failed: tools.filter((x) => x.failed).length }
}

/**
 * 一段消息收尾时折叠行上写什么：只统计这一段里的操作。
 * `last` 是这条回复最后一条带正文的 Agent 消息，折叠行放在它上面，它下面是能看到的最后回复；
 * 还没有这样的回复（刚开始、只有思考或工具）时 parts 为空，整段照常显示
 */
export function foldStats(msgs: TaskMessage[]) {
  const last = lastIndex(msgs, (m) => m.role === 'agent' && !!replyText(m).trim())
  if (last < 0) return { last, first: last, parts: [] as string[], failed: 0 }
  const first = summaryStart(msgs, last)
  const before = msgs.slice(0, last)
  const process = msgs.slice(0, last + 1).filter((m) => m.role === 'agent')
  const folded = before.filter((m) => !keptOut(m) && m.role !== 'agent' && m.panel !== 'child' && m.panel !== 'wrapup')
  const helpers = folded.reduce((n, m) => n + (m.spawned?.length ?? 0), 0)
  // 中间说过的几段说明（总结那几段不算，它们在折叠外面）
  const notes = msgs.slice(0, first).filter((m) => m.role === 'agent' && replyText(m).trim()).length
  const { parts, failed } = processBrief(process, helpers, notes)
  // 面板推回的结果（后台命令、合并编译、子任务交回）也收在里面，按条数写
  const results = folded.filter((m) => m.panel).length
  if (results) parts.push(t('{n} 条面板结果', { n: results }))
  return { last, first, parts, failed }
}

/**
 * 总结之后常跟着的收尾动作：交建议、请求合回、结束计划这类面板工具。
 * 它们不干活，只是把总结交出去，后面 CLI 往往再补一句「已提交建议」
 */
const WRAP_TOOLS = new Set([
  'suggest_next_step',
  'submit_merge',
  'submit_build',
  'finish_child',
  'finish_plan',
  'set_plan',
  'message_parent',
  'record_lesson',
  'release_files',
  'end_inline_edit',
])

const wrapTool = (x: ToolUse) =>
  WRAP_TOOLS.has(panelToolName(x.name ?? '') || PANEL_TOOL_RE.exec(`${x.name ?? ''} ${x.label}`)?.[1] || '')

/**
 * 总结从第几条开始：最后一条回复前面，中间只隔着收尾动作的那几段话也是总结。
 * 不然 AI 写完总结、调一下 suggest_next_step / submit_merge、再补一句「已提交」，
 * 真正的总结就被当成「中间的说明」收进折叠，外面只剩那一句（用户要求总结一律不折叠，父对话、子对话都一样）
 */
export function summaryStart(msgs: TaskMessage[], last: number) {
  let first = last
  // 一条消息里工具在前、文字在后（文字接在工具后面，工具不会接在文字后面，见 server/exec/runner.ts）：
  // 判断能不能再往前一条，看的是这条消息自己的工具是不是都是收尾动作
  let wrapOnly = msgs[last].tools.every(wrapTool)
  for (let i = last - 1; i >= 0 && wrapOnly; i--) {
    const m = msgs[i]
    if (m.role !== 'agent') break
    if (replyText(m).trim()) first = i
    wrapOnly = m.tools.every(wrapTool)
  }
  return first
}

/**
 * 这一轮收尾了：记下折到第几条消息。
 * 之后子对话回报、后台命令结果进来把 CLI 重新拉起来时，前面这段按这个位置始终折叠，新过程接在后面
 */
export function markFold(cuts: number[], len: number) {
  return len > (cuts.at(-1) ?? 0) ? [...cuts, len] : cuts
}

/**
 * 每一轮收尾到哪儿：按这一轮第一条消息的 id 记在内存里。
 * 消息列表滚到早的段被裁掉又回来、切到别的页签又回来时会重新挂载组件，记在这里就不用又从展开状态开始
 */
const turnCuts = new Map<string, number[]>()

/** 这一轮已经折到哪儿（没折过是空的） */
export function foldCuts(key: string) {
  return turnCuts.get(key) ?? []
}

/** 这一轮又收尾了一次：往后记一段，同一轮不会重复记同一位置 */
export function addFoldCut(key: string, len: number) {
  const cuts = markFold(foldCuts(key), len)
  turnCuts.set(key, cuts)
  return cuts
}

/**
 * 用户点开 / 收起某一段的选择：按「这一轮 + 第几段」记在内存里。
 * 来了新内容重新分段、切到别的页签又回来、消息被裁掉再恢复时组件会重新挂载，
 * 不记住的话每次都会回到默认的收起状态，用户点开过的那段又缩回去了
 */
const segOpen = new Map<string, boolean>()

/** 这一段现在是展开的（没点过就按 fallback：普通对话收起，和收尾后的默认状态一致；AI 分析窗口里默认展开） */
export function segOpenOf(id: string, fallback = false) {
  return segOpen.get(id) ?? fallback
}

/** 点了这一段的开关：记下新的状态并返回，界面直接用这个值 */
export function toggleSegOpen(id: string, fallback = false) {
  const next = !segOpenOf(id, fallback)
  segOpen.set(id, next)
  return next
}

/**
 * 按记下的位置把这一轮分成几段：前面的段都已经收尾（始终折叠），最后一段是这次新来的内容。
 * 最后一段可能是空的（收尾后还没有新内容）；记下的位置超出现在的消息数时按现有消息切，不丢消息
 */
export function splitFolds<T>(msgs: T[], cuts: number[]): T[][] {
  const parts: T[][] = []
  let from = 0
  for (const cut of cuts) {
    const to = Math.min(cut, msgs.length)
    if (to <= from) continue
    parts.push(msgs.slice(from, to))
    from = to
  }
  parts.push(msgs.slice(from))
  return parts
}
