/**
 * 对话里「最新的一轮回复」是哪一段：运行区（子对话、子任务、后台命令、工作流运行）挂在它下面。
 *
 * 不能直接取最后一段：用户点发送时，这条用户消息会自己成一段（TaskView 的 toBlocks），
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
