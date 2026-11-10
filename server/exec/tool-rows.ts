/**
 * 一次调用里的工具行：按调用 id 找到那一行，把晚到的结果、边跑边来的输出补上去。
 * 从 runner.ts 拆出来（文件行数上限，见 docs/lessons/file-caps.md）；建行、计时仍在 runAgent 里
 */
import type { ToolUse } from '../../shared/schema.ts'
import type { CliEvent } from './parsers.ts'

/** 留着的命令输出最多这么多字（只留最后一段，最新的输出最有用） */
const MAX_LIVE_OUTPUT = 8000
const tail = (s: string) => (s.length > MAX_LIVE_OUTPUT ? '…' + s.slice(-MAX_LIVE_OUTPUT) : s)

/** endTool：结果到了，收掉运行中标记、记下耗时（runAgent 的那个） */
export function createToolRows(endTool: (x: ToolUse) => void) {
  const toolsById = new Map<string, ToolUse>()
  /**
   * 工具行还没建好就到了的输出增量（有的 CLI 先推输出、后报调用）。
   * 按 id 先攒着，等 tool 事件建好行时补上，不然开头这段输出会丢
   */
  const earlyDeltas = new Map<string, string>()
  return {
    /** tool 事件建好了这一行：登记 id */
    added(id: string, tool: ToolUse) {
      toolsById.set(id, tool)
      // 输出比调用先到：补到刚建好的行上，并把这一行标成还在跑，界面才会边跑边跟着更新
      const early = earlyDeltas.get(id)
      if (early !== undefined) {
        earlyDeltas.delete(id)
        tool.output = tail(early)
        tool.running = true
      }
    },
    result(ev: Extract<CliEvent, { type: 'tool_result' }>) {
      // 工具的输出晚于调用到达，补到对应的那一行上
      const t = toolsById.get(ev.id)
      if (t) {
        if (ev.output) t.output = ev.output
        if (ev.failed) t.failed = true
        if (ev.exitCode !== undefined) t.exitCode = ev.exitCode
        if (ev.patch) t.input = ev.patch
        if (ev.detail !== undefined) t.detail = ev.detail
        delete t.running
        endTool(t)
      }
    },
    delta(ev: Extract<CliEvent, { type: 'tool_delta' }>) {
      const t = toolsById.get(ev.id)
      // 快照是到目前为止的全部输出（Pi 每次都给完整的一段），直接替换；其余是新增的一段，接在后面
      if (t) {
        t.output = ev.snapshot ? tail(ev.text) : tail((t.output ?? '') + ev.text)
        // 有输出在更新说明还在跑：CLI 的调用事件没带这个标记时也要让界面边跑边显示。
        // 已经有 ms 的是跑完的调用（迟到的增量），不能再标回运行中，否则会一直转圈
        if (t.output && t.ms === undefined) t.running = true
      } else {
        // 工具行还没建：先攒着（快照直接替换，增量接在后面），等 tool 事件到达时补上
        const prev = ev.snapshot ? '' : (earlyDeltas.get(ev.id) ?? '')
        earlyDeltas.set(ev.id, tail(prev + ev.text))
      }
    },
  }
}
