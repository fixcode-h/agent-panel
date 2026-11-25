/** 工作流运行的流程图里选中节点直接发消息（shared/flow/node-message.ts、NodeTarget.tsx） */
export const EN_NODE_MESSAGE: Record<string, string> = {
  只有工作流运行能直接发给某个节点: 'Only workflow runs can send messages straight to a node',
  '这次运行已经结束，不再接收消息': 'This run has ended and no longer accepts messages',
  这次运行里没有这个节点: 'This run has no such node',
  '发给「{node}」：插进它正在做的这一轮，调整它的方向': 'To "{node}": steer the turn it is working on right now',
  '发给「{node}」：按这条意见修改它的结果': 'To "{node}": revise its result with this feedback',
  '发给「{node}」：它开始执行时带上这条': 'To "{node}": passed along when it starts',
  '发给「{node}」：带着这条意见退回到它重跑，之后的节点也会重跑':
    'To "{node}": send the run back to it with this feedback; later nodes rerun too',
  '已插给「{node}」': 'Sent into "{node}"',
  '已让「{node}」按意见修改': 'Asked "{node}" to revise',
  '已记下，「{node}」开始时会带上': 'Noted; "{node}" will get it when it starts',
  '已退回到「{node}」，带着意见重跑': 'Sent back to "{node}" to rerun with your feedback',
  发给整个运行: 'Send to the whole run',
  '退回「{node}」重跑': 'Rerun "{node}"',
  '发给「{node}」': 'Send to "{node}"',
  选中的节点: 'Selected node',
  '直接发给流程图里选中的节点：在跑的插进它这一轮，没开始的等它开始时带上，做完的带着意见退回重跑':
    'Send straight to the node selected in the flow chart: a running node gets it in its current turn, a pending one when it starts, a finished one reruns with your feedback',
}
