/** 英文词典的一部分，键是中文原文：额度用完、被限流后自动接上（shared/quota-resume.ts、server/tasks/quota-resume.ts、设置里的那一组） */
export const EN_QUOTA_RESUME: Record<string, string> = {
  '{what}（{from}），按备用顺序换成 {to} 接着做':
    '{what} ({from}); switching to {to} from the fallback order and continuing',
  '{what}：不知道什么时候恢复（可能要充值），没有自动继续':
    "{what}: unknown when it resets (a top-up may be needed), so it didn't continue automatically",
  '{what}：不知道什么时候恢复，{time} 自动再试一次': '{what}: reset time unknown, will try again at {time}',
  '{what}：备用顺序里的都用过了，没有自动继续':
    "{what}: every model in the fallback order has been used, so it didn't continue automatically",
  '{what}：恢复时间太远，没有自动继续': "{what}: the reset is too far away, so it didn't continue automatically",
  '{what}：这条要求之后已经自动接了 {n} 次，不再自动接，请你处理':
    '{what}: already continued automatically {n} times since this request; stopping here, over to you',
  '{what}：预计 {time} 恢复，到点自动继续': '{what}: expected to reset at {time}; will continue automatically then',
  '到了预计恢复的时间，但「到点自动继续」已经关了，没有自动继续':
    'Reset time reached, but "Continue after reset" has been turned off, so it didn\'t continue',
  '到了预计恢复的时间，自动继续': 'Reset time reached; continuing automatically',
  '自动继续没能开始：{error}': "Automatic continue couldn't start: {error}",
  '等额度恢复 · {time} 自动继续': 'Waiting for quota · continues at {time}',
  现在继续: 'Continue now',
  额度用完或限流: 'Quota or rate limit',
  到点自动继续: 'Continue after reset',
  '知道什么时候恢复时，到点接着做': 'When the reset time is known, pick up again then',
  '这一轮因为额度用完或被限流失败时，面板从报错和 Agent 报的额度窗口里读恢复时间，对话停在「等额度恢复」，到点自动继续（和点「继续执行」一样）。被限流又读不到时间时 5 分钟后再试；额度用完又读不到时间（多半要充值）就不等。每次都在对话里写一行；同一条要求之后最多自动接 6 次。默认关：继续会花钱。':
    'When a turn fails because the quota ran out or the request was rate limited, the panel reads the reset time from the error and the usage windows the Agent reports, keeps the conversation "waiting for quota", and continues automatically at that time (same as clicking "Continue"). If rate limited with no known time, it retries after 5 minutes; if the quota ran out with no known time (usually needs a top-up), it doesn\'t wait. Each step is noted in the conversation, with at most 6 automatic continues per request. Off by default: continuing costs money.',
  额度用完或限流后到点自动继续: 'Continue automatically after the quota or rate limit resets',
  换备用模型: 'Switch to fallback model',
  按下面的顺序换一个接着做: 'Continue on the next one in the order below',
  '额度用完或被限流时，按顺序换成第一个还没用过的模型马上接着做，可以跨 Agent（换 Agent 时把之前的对话带过去）。用角色的对话：角色固定了 Agent 的只换这个 Agent 的模型。都用过了再看「到点自动继续」。切换时在对话里写明换成了什么。':
    'When the quota runs out or the request is rate limited, switch right away to the first model in the order not yet used and continue; it can cross Agents (the conversation so far is carried over). For conversations using a role whose Agent is fixed, only that Agent\'s models are used. Once all have been used, "Continue after reset" applies. Each switch is noted in the conversation.',
  额度用完或限流后换备用模型: 'Switch to a fallback model when the quota or rate limit is hit',
  备用顺序: 'Fallback order',
  '排在前面的先用；模型留空用这个 Agent 的默认模型':
    "Earlier entries go first; an empty model means the Agent's default",
  '备用的 Agent': 'Fallback Agent',
  备用的模型: 'Fallback model',
}
