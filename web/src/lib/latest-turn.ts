/**
 * 对话里「最新的一轮回复」是哪一段：运行区（子对话、子任务、后台命令、工作流运行）挂在它下面。
 *
 * 不能直接取最后一段：用户点发送时，这条用户消息会自己成一段（task-blocks.ts 的 toBlocks），
 * 排在那一轮回复后面。此时「最后一段」是用户消息，原来那轮回复就不再算最新，
 * 运行区在 AI 说出第一句之前整块不渲染——看起来就是发送的一瞬间闪没了。
 */
export function latestTurnIndex(blocks: { kind: string }[]): number {
  // 尾部的消息段都是「刚发出去、还没回复」的内容，跳过它们继续往前找那一轮回复；
  // 遇到别的段（节点输出、工作流运行卡片）就停：那些段自己就是最后一段，运行区不往更早的轮挂
  for (let i = blocks.length - 1; i >= 0; i--) {
    const kind = blocks[i].kind
    if (kind === 'turn') return i
    if (kind !== 'msg') return -1
  }
  return -1
}

/**
 * 正在输出的是哪一轮（working 时）：最后一段，或者后面只跟着插进这一轮的用户消息的那一轮。
 *
 * 以前只认「最后一段」：用户在这一轮进行中插话（已插进当前这一轮），这条消息自己成一段排在后面，
 * 原来那轮就不算在输出了，思考过程和整轮回复被立刻折叠，实际 Agent 还在接着想、接着写。
 * inRound 判断尾部那条消息是不是还属于这一轮（插进去、排队等这一轮结束、发送中）；
 * 遇到不属于的（新起一轮的消息、没送出去的）就不算，和以前一样。
 */
export function liveTurnIndex<B extends { kind: string }>(
  blocks: B[],
  working: boolean,
  inRound: (b: B) => boolean,
): number {
  if (!working) return -1
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.kind === 'turn') return i
    if (b.kind !== 'msg' || !inRound(b)) return -1
  }
  return -1
}
