/**
 * 面板 MCP 工具注册表的条目（重构文档第 4 条）：一个工具的「给不给、定义、用法说明、执行」写在同一处，
 * orchTools（工具清单）、orchHint（用法说明）、callOrchTool（执行）都从注册表（registry.ts）生成，
 * 不再在三处各写一遍条件和说明。
 */
import type { Orchestra } from '../../shared/engine/host.ts'

/** 交给 CLI 的工具定义（MCP tools/list 里的一项） */
export interface ToolDef {
  name: string
  title?: string
  description: string
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] }
}

/** MCP 工具调用的结果 */
export interface ToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}

/**
 * 用法说明（orchHint）里的位置：同一个工具在不同身份的说明里措辞不一样（Chat 页只讲计划和后台命令，
 * 子任务只讲查状态和传话……），由工具按位置给出自己那一句；不在这个位置出现时返回空串
 * - chat：没有并行节点和子任务的对话（Chat 模式）
 * - helper：子任务
 * - conv：对话和节点共有的那一段（计划、结束这一轮、开独立分支、后台命令）
 * - child：子对话多出的那一段（和父对话通讯、认领文件、请父对话收尾）
 * - planning / coordinator：能启动工作流的父对话 / 只分派子对话的父对话
 */
export type HintAt = 'chat' | 'helper' | 'conv' | 'child' | 'planning' | 'coordinator'

// oxlint-disable-next-line no-explicit-any -- MCP 的参数就是任意 JSON，各工具自己取字段、自己校验
export type ToolArgs = any

export interface PanelTool {
  name: string
  /** 旧名字：保活的旧进程、记住了旧名字的模型还会这么调，照样执行，但不列进清单 */
  aliases?: string[]
  /**
   * 这个调用者给不给（按能力给，ADR 0038）。只决定列不列进清单和说明：
   * 执行不看它，没列出的工具被直接按名字调用时由 call 自己说清楚为什么用不了，不悄悄吞掉
   */
  when: (o: Orchestra) => boolean
  /** 工具定义；没有的是只认调用、不再列出的旧工具 */
  def?: (o: Orchestra) => ToolDef
  /** 这个工具在用法说明里那一句（见 HintAt）；只在 when 为真时取 */
  hint?: (o: Orchestra, at: HintAt) => string
  call: (o: Orchestra, a: ToolArgs, signal?: AbortSignal) => ToolResult | Promise<ToolResult>
}

export const text = (s: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: s }],
  ...(isError && { isError }),
})
export const str = (v: unknown) => (typeof v === 'string' ? v : '')
/** 宿主回调的 { ok, info } 原样交回：没成功按出错 */
export const reply = (r: { ok: boolean; info: string }) => text(r.info, !r.ok)
/** 不带参数的工具（每次新给一份，免得哪个调用方改了它影响别的工具） */
export const noArgs = () => ({ type: 'object', properties: {} })
