/**
 * 不是对话的执行（派出的子任务、工作流节点和主 Agent）读到的「授权情况」：推送、PR、合并主干都归发起它们的对话或用户。
 * 对话的授权段（engine.ts 的 policyPart）是写给要交付的对话的：父对话那份「允许直接推送，这就是用户的授权」
 * 还带「比角色设定优先」，子任务、节点拿到整段就会做完顺手推送并合并主干（每个节点各推一次）。
 * 角色正文（例如「版本控制」）不按身份分支，只看这一段写了什么，所以每种调用者都要拿到写给自己的一段
 */

/** 子任务（「版本控制」以外）：推送和收尾都归派它的对话，整段授权和收尾流程不用给它 */
export const HELPER_POLICY =
  '## 授权情况\n推送、创建 PR、合并主干、P4 submit、合回原分支都不归子任务：不执行、不询问用户，做完交回结果即可。'

/**
 * 派出的「版本控制」子任务（顶层和子对话派的都是这一段）：本地合并要派单写明目标分支——
 * 项目直接在 main 上开发时「本地合回 main」和「合并主干」字面上分不开，所以「合并主干」写明是用 gh 把 PR 合进远端主干
 */
export const VCS_HELPER_POLICY =
  '## 授权情况\n你是派出的「版本控制」子任务：本地提交、pending 分桶照常做；派单里写明了「把哪个分支合进哪个本地分支」的本地合并照做，派单没写目标分支就不合并、在结果里说明。推送、创建 PR、用 gh 把 PR 合进远端主干、P4 submit、svn commit 不归你：不执行、不询问用户，由派你的对话按它的授权做。'

/** 工作流运行的节点（父对话 start_workflow 起的）：推送等运行合回后由发起的父对话按项目设置决定 */
export const NODE_POLICY =
  '## 授权情况\n你在工作流里执行：推送、创建 PR、合并主干、P4 submit 不在工作流里做：不执行、不询问用户，也不写进建议；工作流跑完后由启动它的父对话按它的授权做。'

/**
 * 子任务 / 节点该读哪一段；返回 undefined 表示用对话那份 policyPart。
 * 子对话里跑的节点照旧读子对话那份（本来就不推，完成标准也写在那里）；不在项目里（没有推送策略）时节点不写授权段
 */
export function subPolicy(o: { helper: boolean; vcsHelper: boolean; child: boolean; project: boolean }) {
  if (o.helper) return HELPER_POLICY
  if (o.vcsHelper) return VCS_HELPER_POLICY
  if (o.child) return undefined
  return o.project ? NODE_POLICY : ''
}

/**
 * 项目里不分派的顶层对话（项目默认角色设成「执行」或自建角色）：拿的是父对话那份授权段，
 * 角色正文却可能自称子对话、写着「推送由父对话决定」——明说这里没有父对话，推送按授权段做
 */
export const topPush = (host: { policy?: unknown }) =>
  host.policy
    ? '\n你是用户直接对话的项目对话（没有父对话）：推送、PR、合并主干按上面「授权情况」做，角色设定里写给子对话的「由父对话决定、你不做」对你不适用。'
    : ''
