/**
 * 模型正在写一个工具调用的入参（用户 2026-11-05：交诊断报告这类大段入参要写一二十秒，界面上一点动静都没有，像卡死了）。
 * CLI 报了「开始写某个工具的调用」（gen 事件带 tool）就记在 task.drafting，界面在运行区写「正在写…」；
 * 之后到的入参片段边收边转成能读的文字放进 drafting.text，界面像思考过程一样实时显示写到哪了（用户 2026-11-19）。
 * 只有开子对话、派子任务这类登记过的工具推内容（shared/live/draft-tools.ts，用户 2026-11-28：普通工具不用看写的过程），
 * 别的只转圈计时。
 * 调用本身到了、又开始说话或思考、这一轮结束，就去掉。从 runner.ts 拆出来（它到了行数上限）
 *
 * 还记下每个调用写了多久，调用到了时写进 tool.genMs：卡片上的耗时只算工具执行，几秒的「正在写」之后
 * 只显示几百毫秒会让人以为前面卡住了（用户 2026-11-28 截图），两段分开标
 */
import { createDraftReader, draftTail, type DraftReader } from '../../shared/live/draft-text.ts'
import { draftShow } from '../../shared/live/draft-tools.ts'
import type { Task } from '../../shared/schema.ts'
import type { CliEvent } from './parsers.ts'

/** 这些事件说明工具入参写完了、模型改去做别的了：「正在写」去掉，还没对上调用的写入参记录也作废 */
const DROP = new Set(['text_delta', 'text', 'thinking', 'result', 'request_start']) // 模块状态：常量，加载后不改

export function createDrafting(task: Pick<Task, 'drafting'>, changed: () => void) {
  let reader: DraftReader | undefined
  let text = ''
  /**
   * 写了还没对上调用的：一条回复里连写几个调用时，CLI 可能等几个都写完才逐个报，按顺序认领。
   * end 是下一个开始写的时刻（前一个肯定写完了）
   */
  const pending: { at: number; end?: number }[] = []
  const clear = () => {
    reader = undefined
    text = ''
    pending.length = 0
    if (!task.drafting) return
    task.drafting = undefined
    changed()
  }
  return {
    see(ev: CliEvent) {
      if (ev.type === 'gen' && ev.tool) {
        const show = draftShow(ev.tool)
        reader = show ? createDraftReader({ fields: show.fields, labels: show.labels?.() }) : undefined
        text = ''
        const now = Date.now()
        const last = pending[pending.length - 1]
        if (last && last.end === undefined) last.end = now
        pending.push({ at: now })
        task.drafting = { tool: ev.tool, at: new Date(now).toISOString() }
        changed()
      } else if (ev.type === 'tool') {
        // 调用到了：认领最早一个还没对上的写入参记录，记下写了多久
        const p = pending.shift()
        if (p && ev.tool.genMs === undefined) ev.tool.genMs = Math.max(0, (p.end ?? Date.now()) - p.at)
        if (pending.length) {
          // 后面还有在写的：只收掉已经写完的那个的「正在写」，留着正在写的
          return
        }
        reader = undefined
        text = ''
        if (task.drafting) {
          task.drafting = undefined
          changed()
        }
      } else if (ev.type === 'gen' && reader && task.drafting && ev.text) {
        const add = reader.feed(ev.text)
        if (!add) return
        // 完整文字留在这里，任务上只放尾巴：推送每次都带整份 drafting
        text += add
        task.drafting.text = draftTail(text.trimStart())
      } else if (DROP.has(ev.type)) clear()
    },
    clear,
  }
}
