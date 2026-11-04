/**
 * 结论只认 submit_verdict 工具调用（ADR 0041 第 16 节、ADR 0049 第三期）：面板不再从回复里找「验收结论：通过」这类字眼。
 * 以前按文字识别结论的 parseVerdict / leadVerdict 已经删掉；这里只剩一件事：把旧版角色、工作流节点里
 * 「最后一行写『验收结论：通过』」这类要求改写成「调用 submit_verdict 交结论」，不然它们照旧写一行字、不调工具，
 * 面板追问一次后按出错停下。内置模板的源码已经改过；用户存下来的副本在启动时用它迁一遍（server/verdict-migrate.ts）
 */

/** 改写后的说法：和内置角色里的写法一致（见 shared/builtin/agents.ts 的 VERDICT_TOOL_TEXT） */
const SUBMIT = '最后调用 submit_verdict 交结论（verdict 写 pass 或 fail），不通过时 blockers 写失败项。'

const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  // 「最后单独一行写『验收结论：通过』或『验收结论：不通过』。」（验证结论同理）
  [/最后(?:单独)?一行写「(?:验收|验证)?结论：(?:不通过|通过)」或「(?:验收|验证)?结论：(?:不通过|通过)」。?/g, SUBMIT],
  // 「有 🛑 时最后一行写『验收结论：不通过』，否则写『验收结论：通过』。」
  [
    /(有[^「。\n]{1,40}?)时最后一行写「(?:验收|验证)?结论：不通过」，否则写「(?:验收|验证)?结论：通过」。?/g,
    (_m, cond) => `${cond}时调用 submit_verdict 交 fail（blockers 写失败项），否则交 pass。`,
  ],
]

/** 把要求「写一行结论」的旧说法换成「调用 submit_verdict」；没有旧说法时原样返回（同一个字符串） */
export function rewriteVerdictText(text: string): string {
  let out = text
  for (const [re, to] of RULES) out = out.replace(re, to as never)
  return out
}
