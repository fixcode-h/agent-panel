/**
 * 模型正在写一个工具调用的入参（用户 2026-11-05：交诊断报告这类大段入参要写一二十秒，界面上一点动静都没有，像卡死了）。
 * CLI 报了「开始写某个工具的调用」（gen 事件带 tool）就记在 task.drafting，界面在运行区写「正在写…」；
 * 之后到的入参片段边收边转成能读的文字放进 drafting.text，界面像思考过程一样实时显示写到哪了（用户 2026-11-19）。
 * 调用本身到了、又开始说话或思考、这一轮结束，就去掉。从 runner.ts 拆出来（它到了行数上限）
 */
import { createDraftReader, draftTail, type DraftReader } from '../../shared/live/draft-text.ts'
import type { Task } from '../../shared/schema.ts'
import type { CliEvent } from './parsers.ts'

/** 这些事件说明工具入参写完了（或者模型改去做别的了） */
const ENDS = new Set(['tool', 'text_delta', 'text', 'thinking', 'result', 'request_start']) // 模块状态：常量，加载后不改

export function createDrafting(task: Pick<Task, 'drafting'>, changed: () => void) {
  let reader: DraftReader | undefined
  let text = ''
  const clear = () => {
    reader = undefined
    text = ''
    if (!task.drafting) return
    task.drafting = undefined
    changed()
  }
  return {
    see(ev: CliEvent) {
      if (ev.type === 'gen' && ev.tool) {
        reader = createDraftReader()
        text = ''
        task.drafting = { tool: ev.tool, at: new Date().toISOString() }
        changed()
      } else if (ev.type === 'gen' && reader && task.drafting && ev.text) {
        const add = reader.feed(ev.text)
        if (!add) return
        // 完整文字留在这里，任务上只放尾巴：推送每次都带整份 drafting
        text += add
        task.drafting.text = draftTail(text.trimStart())
      } else if (ENDS.has(ev.type)) clear()
    },
    clear,
  }
}
