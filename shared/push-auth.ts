/**
 * 推送授权（项目设置「第一次需要推送时问一次」）：父对话用面板工具 ask_push 请用户授权，
 * 面板弹「允许 / 拒绝」卡片、把回答记进 task.remotePush。不借 ask_user / AskUserQuestion 问：
 * 那样的回答面板认不出是推送授权、记不下来，「提问」关着时还会被自动作答成「按你的判断继续」，
 * 等于模型自己决定推不推（c5e5c5d8 加了 remotePush 字段却一直没有写入点）。
 * 回答只对这一个顶层对话有效（新对话重新问一次）；子对话不碰远端，拿不到这个工具。
 * 放在单独的文件里：engine.ts、schema.ts、runner.ts 都到了行数上限
 */
import type { EngineHost, Orchestra } from './engine/host.ts'
import type { Task } from './schema.ts'

export const ASK_PUSH = 'ask_push'

/** 授权段里父对话的推送规则：wt 是独立分支里的补充说明，planned 是「推送收尾已经在计划最后一步」 */
export function pushPolicyText(p: NonNullable<EngineHost['policy']>, wt: string, planned: string) {
  const done = '任务做完、验证通过并在本地提交之后'
  if (p.noRemote)
    return '推送：这个仓库没有配置远端（git remote 为空），没有地方可推：不 push、不建 PR、不合并主干，也不问用户要不要推送；结论里写「已在本地提交，仓库没有远端」。用户要推送时告诉他先给仓库加上远端。'
  if (p.push === 'deny')
    return '推送：项目设置是「不推送，只做本地提交」。不 push、不建 PR、不合并主干、不 P4 submit，也不问用户要不要推；用户在对话里要求推送时，告诉用户先到项目设置把「推送到远端」改掉（这个项目的 git push 已经被面板拦下）。'
  // 拒绝过以后：用户亲手在授权卡上点才算数，所以用户在对话里改口时也要再弹一次卡，不能凭一句话直接推
  if (p.answered === 'denied')
    return `推送：这个对话里用户已经拒绝过推送：不要推、不建 PR、不合并主干，也不要再问。用户之后在对话里明确要求推送时，调用 ${ASK_PUSH} 请用户在授权卡上确认一次，不要直接推。`
  if (p.answered === 'allowed' || p.push === 'allow')
    return `推送：${p.answered === 'allowed' ? '这个对话里用户已经同意推送' : '项目设置是「允许直接推送」，这就是用户的授权'}，不用再问。${done}${wt}就把当前分支推到它跟踪的远端分支（没有跟踪分支时推到 origin 的同名分支并设上跟踪）${planned}，推完回读确认（git status -sb），结论里写清推到了哪个远端分支。推送成功后用 GitHub CLI 把该分支普通合并到主干：先用 gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 取主干分支名（不同项目可能是 main / master / trunk），已有对应 PR 就复用，没有就 gh pr create --base <主干> --head <当前分支>，gh pr checks <PR> --watch 等检查通过后 gh pr merge <PR> --merge，合并后回读 PR 状态确认。只做普通推送和普通合并：不强推、不 --admin、不绕过检查；被拒（远端有新提交）、PR 冲突、检查失败、分支保护拦截就停下来报告，不自己 pull / rebase，也不直接往主干推。本机没有可用的 gh 时只推送，结论里说明没能合并主干。P4 submit 不在这个授权里，用户要求时才做。`
  return `推送：项目设置是「第一次需要推送时问一次」。${done}，调用面板工具 ${ASK_PUSH} 请用户授权推送并合并主干（面板弹出「允许 / 拒绝」卡片并记下回答），按回答做${wt}。不要用 ask_user / AskUserQuestion 这类提问工具问要不要推送：那样的回答面板记不下，「提问」关着时还会被自动作答。`
}

/**
 * 给这次调用的 Orchestra 接上 ask_push：只给项目里的顶层对话本身（不给子对话、子任务、工作流节点、Chat 页的对话），
 * 并且项目推送策略是「问一次」；没有项目（Chat 页）就没有推送策略。已经同意过直接返回、不弹卡；拒绝过再调照样弹卡（用户改口要推，以用户亲手点的为准）
 */
export function orchAskPush(host: EngineHost, chat: boolean, helper: boolean): Orchestra['askPush'] {
  const { task } = host
  if (
    helper ||
    !chat ||
    task.parentTaskId ||
    !task.projectId ||
    host.policy?.push !== 'ask' ||
    host.policy.noRemote ||
    !host.askPush
  )
    return undefined
  const ask = host.askPush
  return async (info) => {
    if (task.remotePush === 'allowed')
      return { ok: true, info: '这个对话里用户已经同意推送并合并主干，不用再问：按「授权情况」里的步骤做。' }
    const r = await ask({ branch: info.branch?.trim() || undefined, summary: info.summary?.trim() || undefined })
    if (!r) return { ok: false, info: '对话被停止了，没有拿到推送授权：先不要推送，等用户的下一条消息。' }
    if (r.allow) return { ok: true, info: '用户同意推送并合并主干：按「授权情况」里的步骤做，这个对话里之后不用再问。' }
    // 用户关掉卡片（终止对话）时面板给的是原话，回答没有记下；点「拒绝」才是不推
    if (r.message) return { ok: false, info: r.message }
    return {
      ok: true,
      info: '用户不推送：只做本地提交，不建 PR、不合并主干；这个对话里不要再问，用户明确要求时再调用。',
    }
  }
}

/** 推送授权卡上点的回答写进任务（只在 answerRequest 里同步调用：关掉卡片、请求作废都不经过这里，不会被记成拒绝） */
export function notePushAnswer(task: Task, allow: boolean, at = new Date().toISOString()) {
  task.remotePush = allow ? 'allowed' : 'denied'
  task.remotePushAt = at
}

/**
 * 撤回到 cutAt（被撤掉的第一条消息的时间）时，推送授权要不要清掉：回答是在被撤掉的那段对话里点的就清，
 * 之前点的保留。没记时间的旧回答当成在撤回点之后（偏保守：新的一轮重新问一次）
 */
export const pushAnswerCut = (task: Pick<Task, 'remotePush' | 'remotePushAt'>, cutAt: string) =>
  !!task.remotePush && (!task.remotePushAt || task.remotePushAt >= cutAt)

/** 清掉推送授权（分叉出来的新对话、撤回到回答之前）：store.update 是浅合并，undefined 会盖掉旧值 */
export const NO_PUSH_ANSWER = { remotePush: undefined, remotePushAt: undefined }
