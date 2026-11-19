// 用户放行（ADR 0070）：门禁拦下了用户明确要求的操作时，Agent 请用户在卡片上放行一次。
// 从 shared/engine/host.ts 的大接口里按能力拆出来（重构文档第 5 条）

type Receipt = { ok: boolean; info: string }

/** Orchestra 里请用户放行的那部分：只给用户能直接对话的对话本身（不给子任务、工作流节点） */
export interface OrchOverride {
  /** request_override：gate 是拦下它的门禁，reason 是用户怎么要求的（显示在卡片上） */
  requestOverride?: (input: { gate: string; reason: string }) => Promise<Receipt>
}

/** EngineHost 里请用户放行的那部分：弹卡、等用户点、记下放行（server/hooks/overrides.ts） */
export interface OverrideHost {
  requestOverride?: (input: { gate: string; reason: string }) => Promise<Receipt>
}
