// 节点验收到上限还没通过时问用户（shared/engine/review-loop.ts）：用户的指令优先（用户 2026-11-19 定的原则），
// 门禁不该替用户做「停下」的决定

/** EngineHost 里问用户放行验收的那部分：弹卡、等用户点（server/exec/real-turn.ts） */
export interface ReviewLimitHost {
  /**
   * 弹卡问用户按现状通过（pass）还是再改一轮（again），停止任务返回 null。
   * 没有时（在线演示）照旧按失败停下
   */
  reviewLimit?: (
    step: { id: string; title: string; agentId: string },
    info: { round: number; feedback: string },
  ) => Promise<'pass' | 'again' | null>
}
