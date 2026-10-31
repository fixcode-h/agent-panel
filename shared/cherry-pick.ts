import type { EngineHost } from './engine.ts'

/**
 * 项目设了 cherry-pick 目标时告诉对话：用户让它 cherry-pick 时搬到哪、只搬什么。
 * 只搬这个对话自己的提交 / 改动（用户 2026-10-31 定的）：两条分支本来就不一样的内容不是这次的修改，
 * 按分支差异整个搬过去会把对方分支故意没有的东西也带过去
 */
export function cherryPickPart(host: EngineHost) {
  const c = host.policy?.cherryPick
  if (!c?.target || host.task.parentTaskId) return ''
  const what =
    c.vcs === 'git'
      ? `目标是本地分支「${c.target}」：commits 只列这个对话里你自己做的提交（先用 git log 确认），这次的改动还没提交就先单独提交`
      : `目标是 P4 工作区里的项目目录「${c.target}」：changelist 写这次改动所在的 pending（default 里混着别的改动时先用 p4_split_changelists 分出来），面板会在目标工作区建一个对应的 pending，不 submit`
  return `## Cherry-pick
用户要求把改动 cherry-pick 过去时，必须调用 cherry_pick 工具，由面板核对后执行：${what}。面板只收这个对话自己做的改动，有不属于这次修改的提交或文件会整次拒绝。不要自己跑 git cherry-pick / merge / rebase，不要按两条分支或两个目录的差异同步，也不要复制文件过去；被拒绝或有冲突时把原因告诉用户，由用户决定。只有用户明确要求时才调用（面板会核对用户的消息，用户没提时调用会被拒绝），不要自己发起，也不要写进计划或建议里替用户决定。`
}
