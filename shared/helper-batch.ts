import type { TaskStep } from './schema.ts'
import { clip } from './text.ts'

/**
 * 交回结果的截取：节点、子任务的输出超上限时存成文件只交开头，一批子任务交回时按总量分份额。
 * 对话模式自动交回（engine 的 settleHelpers）和工作流节点手动取（wait_agents）走同一套，份额不各算各的
 */

/** 把交回的完整内容存成文件，返回路径；存不了返回空串（宿主不支持、写盘失败） */
export type SaveHandoff = ((step: TaskStep, text: string) => Promise<string>) | undefined

/**
 * 交回的结果超出上限：完整内容存成文件，只交开头 + 文件路径。
 * 截断就必须写明全文在哪：存不了文件（宿主不支持、写盘失败）时整段交回，不能悄悄丢掉后半段
 * （评审的意见在后半段被截掉，派它的对话既看不到也找不到全文）
 */
export async function clipToFile(save: SaveHandoff, step: TaskStep, text: string, limit: number, hint: string) {
  if (text.length <= limit) return text
  const file = save ? await save(step, text).catch(() => '') : ''
  if (!file) return text
  return `${clip(text, limit)}\n\n（完整结果有 ${text.length} 字，这里只附了开头。完整内容在文件 ${file}，${hint}）`
}

/**
 * 评审、测试验收这类要逐条处置的结果（whole）交回的上限：超出才存文件只交开头。
 * 原来和普通结果一样 4000 字，评审意见后半截要另读文件，父对话常常读不到就让评审「原样重述」（ADR 0041 第 14 节）
 */
export const WHOLE_OUTPUT = 20000

/** 一批子任务交回结果的总字数，和每个至少留多少 */
const HELPER_BATCH_CHARS = 12000
const HELPER_SHARE_MIN = 1500
const FULL_POINTER = /\n\n（完整结果有 \d+ 字，这里只附了开头。完整内容在文件 [^\n]+）$/

/** 交回结果超出份额：只带开头（结论写在开头），后面写明全文在哪个文件；没存过文件的现存一份 */
async function layeredOutput(save: SaveHandoff, step: TaskStep, output: string, share: number) {
  const pointer = FULL_POINTER.exec(output)?.[0] ?? ''
  const body = pointer ? output.slice(0, -pointer.length) : output
  if (body.length <= share) return output
  if (pointer) return `${clip(body, share)}${pointer}`
  // 没存过文件的现存一份；存不了就整段交回，不截掉看不到的部分
  return clipToFile(save, step, output, share, '需要细节时再读。')
}

/**
 * 一批交回的结果按总量分：一批十几个子任务时每个都交 4000 字，一次就是好几万字压进派它的对话。
 * 子任务被要求把结论写在开头，超出份额的只带开头 + 全文文件的位置；whole 为真的（评审代码的意见要逐条处置）照旧整段交。
 * 返回 id → 分过份额的输出；没有输出、整段交的不在里面
 */
export async function layeredBatch(save: SaveHandoff, kids: TaskStep[], whole: (k: TaskStep) => boolean) {
  const share = Math.max(HELPER_SHARE_MIN, Math.floor(HELPER_BATCH_CHARS / Math.max(1, kids.length)))
  const outputs = new Map<string, string>()
  for (const k of kids)
    if (k.status === 'done' && k.output && !whole(k)) outputs.set(k.id, await layeredOutput(save, k, k.output, share))
  return outputs
}
