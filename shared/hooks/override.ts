/**
 * 用户放行（ADR 0070，用户 2026-11-19 定：用户的指令优先级最高）：门禁拦下了用户明确要求的操作时，
 * Agent 调 request_override 请用户在卡片上确认，确认后同一个门禁放行一次。
 * 放行只认用户在卡片上亲手点的（不按模型回复的文字判断，ADR 0041、0049）；
 * 门禁拦下的是什么由面板自己记（server/hooks/overrides.ts），卡片上显示的不是 Agent 自报的。
 * 这里只放各处共用的名字和交给 Agent 的话（提示词，不翻译）
 */

export const REQUEST_OVERRIDE = 'request_override'

/** 评审门禁（submit_merge 的 review_override）在放行登记里用的名字：不是钩子，单独起一个 */
export const REVIEW_GATE = 'review-gate'

/** 用户自己写的钩子在放行登记里的名字 */
export const userHookGate = (name: string) => `hook:${name}`

/** 拦下时附在原因后面的一句：用户明确要求的就请用户放行，不自己判断、不绕开 */
export const overrideTip = (gate: string) =>
  `\n如果这正是用户明确要求的：调用面板工具 ${REQUEST_OVERRIDE}（gate 填 "${gate}"，reason 写用户的原话或怎么要求的；不在工具清单里就经 more_tools 调）请用户在卡片上确认，用户同意后重试同一个操作，面板放行一次。用户没要求过就照上面说的做：不要自己判断「问题不大」去请求放行，也不要换个写法绕开。`

/** 放行后要另外交代的（面板还有别的兜底拦着时）：按门禁给 */
export const AFTER_GRANT: Record<string, string> = {
  'push-guard':
    '项目设成「不推送」、或者在子对话的独立分支里时，面板还用 git 配置兜底拦着推送（推送地址被改写成 agent-panel-no-push://）：这一次推送的命令前面加 env -u GIT_CONFIG_COUNT（PowerShell 里先执行 $env:GIT_CONFIG_COUNT=$null）。',
}
