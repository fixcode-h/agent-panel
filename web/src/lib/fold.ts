/**
 * 一段回复收尾后怎么折叠：哪些收进折叠行、哪些留在外面（总结、结尾、要人看的、还没办完的派单），折叠行上写什么。
 * 界面（FoldedRun / ChatReply）直接用这里的结果，规则都能单独测。
 * 设计稿：项目共享目录 designs/回复折叠与派单行重设计-设计稿.md
 */
import type { TaskMessage, ToolUse } from '@shared/schema'
import { t } from '@shared/i18n'
import { stripToolMarkup } from '@shared/task'
import { panelCallName, toolView } from './tasks'
import { didWork, toolRole } from './fold-roles'
import { dispatchKey, dispatchesOf, type Dispatch } from './fold-dispatch'

export { addFoldCut, foldCuts, markFold, segOpenOf, splitFolds, toggleSegOpen } from './fold-state'

/** 正文里显示的文字：模型当成文字说出来的工具调用写法去掉，那些在工具的折叠块里已经有了 */
export const replyText = (m: TaskMessage) => (m.role === 'agent' ? stripToolMarkup(m.text) : m.text)

/**
 * 留在折叠外面的：报错（要让人看到）、子对话的提问（要人回答）、对话之间收发的消息
 * （父对话交代的、子对话上报的都摆在台面上，不收进「做了什么」的折叠里）
 */
export const keptOut = (m: TaskMessage) =>
  m.panel === 'ask' || !!m.peer || (m.role === 'system' && !m.panel && !m.spawned?.length)

/** 最后一个满足条件的下标（目标库没有 findLastIndex） */
function lastIndex<T>(list: T[], ok: (x: T) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) if (ok(list[i])) return i
  return -1
}

/** 文件路径只留文件名：折叠行里放得下两三个 */
const baseName = (p: string) => p.trim().split(/[\\/]/).filter(Boolean).pop() ?? p.trim()

/**
 * 折叠起来的那部分做了什么，和 Claude Code 一样按动作归总成一句：读了几个文件、改了哪些文件、跑了几条命令。
 * 改的文件不多时直接写文件名，一眼看出这段回复动了哪里；失败的调用单独标出来。
 * skip 里的工具（还没办完、留在外面的派单）不算：它们在外面自己有一行
 */
function processBrief(process: TaskMessage[], helpers: number, notes: number, skip: Set<string>) {
  const tools = process.flatMap((m) =>
    m.tools.flatMap((x, k) => {
      if (skip.has(dispatchKey(m.id, k))) return []
      const v = toolView(x)
      return v ? [{ tool: v.tool, call: panelCallName(x) }] : []
    }),
  )
  const files = (kind: ToolUse['kind']) =>
    new Set(
      tools
        .filter((x) => x.tool.kind === kind)
        .map((x) => x.tool.label.trim())
        .filter(Boolean),
    )
  const count = (kind: ToolUse['kind']) => tools.filter((x) => x.tool.kind === kind).length
  const calls = (...names: string[]) => tools.filter((x) => names.includes(x.call)).length
  const read = files('read').size || count('read')
  const edited = [...files('edit')]
  const edits = edited.length || count('edit')
  const newChild = calls('create_conversation', 'start_workflow')
  const resend = calls('send_to_conversation')
  const other =
    tools.filter((x) => !['read', 'edit', 'run', 'search', 'web'].includes(x.tool.kind)).length - newChild - resend
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
    newChild && t('新开 {n} 个子对话', { n: newChild }),
    resend && t('交回子对话 {n} 次', { n: resend }),
    helpers && t('派出 {n} 个子任务', { n: helpers }),
    other > 0 && t('其他操作 {n} 次', { n: other }),
    thoughts && t('思考 {n} 次', { n: thoughts }),
    notes && t('{n} 段说明', { n: notes }),
  ].filter((x): x is string => !!x)
  return { parts, failed: tools.filter((x) => x.tool.failed).length }
}

/** 折叠起来的一块：里面的消息、折叠行写什么、有几次失败；show 为 false 时不出这一行 */
export interface FoldPart {
  msgs: TaskMessage[]
  parts: string[]
  failed: number
  show: boolean
}

/**
 * 一段回复收尾后怎么摆（设计稿 §3）：
 * - summary：最后一次干活之后说的第一段话（同一条消息里工具在前、文字在后，那条消息自己的文字也算），
 *   带名字和主折叠开关；干完活之后一句话都没说（被插话打断、被停止）就没有总结，整段只剩折叠行
 * - ending：这一段最后一段话，和总结不是同一条时单独显示
 * - main：总结之前的过程（含总结那条消息自己的工具），折成一行
 * - mid：总结和结尾之间的派单、收尾动作、中间几句话（含结尾那条消息自己的工具），折成「协调小行」
 * - tail：结尾之后又跟着的调用（没有文字）
 *   mid、tail 里只有收尾动作（交建议、合回、结束计划）时 show 为 false，不出这一行
 * - open：还没办完的派单（key），和 keptOut 的消息一样留在原位，不收进任何折叠
 * 还没有带正文的回复时 flat 为 true，整段照常显示。判断只看工具种类和位置，不看文字（ADR 0041 / 0049）
 */
export interface FoldLayout {
  flat: boolean
  summary: number
  ending: number
  main: FoldPart
  mid: FoldPart
  tail: FoldPart
  open: Set<string>
}

const none = (): FoldPart => ({ msgs: [], parts: [], failed: 0, show: false })

export function foldLayout(msgs: TaskMessage[], isOpen: (d: Dispatch) => boolean = () => false): FoldLayout {
  const texts = msgs.flatMap((m, i) => (m.role === 'agent' && replyText(m).trim() ? [i] : []))
  const open = new Set(
    dispatchesOf(msgs)
      .filter(isOpen)
      .map((d) => d.key),
  )
  if (!texts.length) return { flat: true, summary: -1, ending: -1, main: none(), mid: none(), tail: none(), open }
  const work = lastIndex(msgs, didWork)
  const summary = texts.find((i) => i >= work) ?? -1
  const lastText = texts[texts.length - 1]
  const ending = summary >= 0 && lastText > summary ? lastText : -1
  // 一块里有什么：工具（不含留在外面的派单）、派出几个子任务、面板推回几条结果、几段说明
  const part = (from: number, to: number, notes: number): FoldPart => {
    const list = msgs.slice(from, to + 1)
    const folded = list.filter((m) => !keptOut(m) && m.role !== 'agent' && m.panel !== 'child' && m.panel !== 'wrapup')
    const helpers = folded
      .filter((m) => !open.has(dispatchKey(m.id, -1)))
      .reduce((n, m) => n + (m.spawned?.length ?? 0), 0)
    const brief = processBrief(
      list.filter((m) => m.role === 'agent'),
      helpers,
      notes,
      open,
    )
    // 面板推回的结果（后台命令、合并编译、子任务交回）也收在里面，按条数写
    const results = folded.filter((m) => m.panel).length
    if (results) brief.parts.push(t('{n} 条面板结果', { n: results }))
    // 只有收尾动作的一块不出折叠行：有中间的话、失败、派单、面板结果、非收尾的调用才出
    const busy =
      notes > 0 ||
      brief.failed > 0 ||
      list.some((m) =>
        m.role === 'agent'
          ? m.tools.some((x, k) => toolRole(x) !== 'wrap' && !open.has(dispatchKey(m.id, k)))
          : !keptOut(m) && !open.has(dispatchKey(m.id, -1)),
      )
    return { msgs: list, ...brief, show: brief.parts.length > 0 && busy }
  }
  if (summary < 0) {
    // 没有总结：整段一行，之前说过的话都是过程里的说明
    const main = part(0, msgs.length - 1, texts.length)
    return { flat: false, summary, ending, main: { ...main, show: true }, mid: none(), tail: none(), open }
  }
  // 总结之前说过的几段话是过程里的说明；总结那条消息本身（工具在文字前面）也算进主折叠
  const main = part(0, summary, texts.filter((i) => i < summary).length)
  const mid = ending >= 0 ? part(summary + 1, ending, texts.filter((i) => i > summary && i < ending).length) : none()
  const from = Math.max(summary, ending) + 1
  const tail = from < msgs.length ? part(from, msgs.length - 1, 0) : none()
  return { flat: false, summary, ending, main: { ...main, show: true }, mid, tail, open }
}

/**
 * 这一段收尾后留在折叠外面的回复文字（总结和结尾），朗读只念这些：
 * 折叠起来的思考、工具调用和中间的说明不念。还没有带正文的回复、没有总结时是空串
 */
export function unfoldedText(msgs: TaskMessage[]) {
  const { flat, summary, ending } = foldLayout(msgs)
  if (flat || summary < 0) return ''
  return [summary, ending]
    .filter((i) => i >= 0)
    .map((i) => replyText(msgs[i]).trim())
    .filter(Boolean)
    .join('\n\n')
}
