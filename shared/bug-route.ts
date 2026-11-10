import type { EngineHost } from './engine.ts'

/**
 * 父对话：用户报的 Bug 用哪种方式修（用户 2026-11-07 定的）。
 * - 用户发 /bug：一定走完整流程（create_conversation 写 kind: "bug"）；发 /fix：一定直接修（kind: "fix"，
 *   收尾时留一份只读的简版报告，分析稿 B2 第 ③ 条，shared/bug-fix-brief.ts）。
 * - 只是描述了一个 Bug：「提问」开着先问用户选哪种；关着默认直接修，不问。
 *   以前由父对话自己判断「是不是要查原因的 Bug」，判成完整流程后每一步都要用户在弹窗里确认，
 *   用户没开提问、只想快点修好时也被拉进了多轮确认。
 * - 已经派出去在修的，用户要改走完整流程：send_to_conversation 写 kind: "bug"，面板把那个子对话标成用户报的 Bug。
 * 按「提问」开关现算，每轮都放进父对话的提示：开关在对话中途能改，段落内容变了续接时会重发（shared/prompt-delta.ts）
 */
export function bugRoutePart(host: Pick<EngineHost, 'task'>, coordinator: boolean) {
  if (!coordinator || !host.task.projectId) return ''
  const how = host.task.askUser
    ? `- 只是描述了一个 Bug（没发 /bug 也没发 /fix）：「提问」开着，派之前先用提问工具（有原生提问的用原生方式，没有的用面板的 ask_user）问用户用哪种方式，两个选项写清后果：「完整 Bug 流程：子对话分阶段交诊断报告（论证、根因、修复方案、验证），每一步你在弹窗里确认后才改」和「直接修：子对话查清原因就修，不交报告确认」；按现象卡推荐一个（偶发、跨模块、修过没修好、说不清从哪次开始坏的推荐完整流程，其余推荐直接修）并标「（推荐）」。用户选完整流程就 create_conversation 写 kind: "bug" 和 level，选直接修就写 kind: "fix"。`
    : `- 只是描述了一个 Bug（没发 /bug 也没发 /fix）：「提问」关着，默认直接修：create_conversation 写 kind: "fix"，不问用户、也不自己改判成完整流程。派出后在回复里提一句：要改走完整流程（分阶段交诊断报告、确认后才改）可以发 /bug，或者让你把这个子对话升级成 Bug 流程。`
  return `## 用户报的 Bug 用哪种方式修
- 用户发了 /bug：走完整 Bug 流程，create_conversation 写 kind: "bug" 和 level。用户发了 /fix、或明确说直接修：kind 写 "fix"，子对话查清就修，不交诊断报告，收尾时留一份简版报告（根因一句、改了什么、怎么验证的）给用户回看。
${how}
- 用户要把某个已有子对话正在处理的问题改按完整 Bug 流程修（「把 xx 子对话升级成 Bug 流程」「这个让它按 kind:bug 来」）：用 send_to_conversation 交给那个子对话，写 kind: "bug"（能判断级别的同时写 level），message 写清用户原话和现象卡里已知的几项。面板把它标成用户报的 Bug：它拿到交诊断报告的工具，接下来按完整流程查，用户同意方案之前不再改文件。它正在回复时会被拒绝，等它这一轮结束再交。不要为此另开一个子对话重查。`
}
