import type { EngineHost } from './engine.ts'

/**
 * 项目设了 cherry-pick 目标时告诉对话：用户让它 cherry-pick 时搬到哪、只搬什么。
 * 只搬这个对话自己的提交 / 改动（用户 2026-10-31 定的）：两条分支本来就不一样的内容不是这次的修改，
 * 按分支差异整个搬过去会把对方分支故意没有的东西也带过去
 */
export function cherryPickPart(host: EngineHost) {
  const c = host.policy?.cherryPick
  if (!c?.target || host.task.parentTaskId) return ''
  const how =
    c.vcs === 'git'
      ? `目标是本地分支「${c.target}」。只把这个对话里你自己做的那几个提交按顺序 git cherry-pick 过去（先用 git log 列出这些提交确认一遍）；不要 merge / rebase 整个分支，也不要按两条分支的 diff 去改目标分支。冲突时只按这几个提交的意图解决，目标分支上原有、而当前分支没有的内容保持原样。做完切回原来的分支。`
      : `目标是 P4 工作区里的项目目录「${c.target}」（和当前项目是同一个项目的另一条分支）。只把这个对话里你自己改过的文件、按你改的那几处搬过去（逐个文件对照你的修改在目标目录里改同样的地方，先 p4 edit 再改）；不要整文件覆盖，也不要按两边目录的差异去同步。目标里本来就和这里不同的内容不是这次的修改，保持原样。改完放进目标工作区的一个新 changelist，不要 submit。`
  return `## Cherry-pick
用户要求把改动 cherry-pick 过去时：${how}用户没提就不要主动做。`
}
