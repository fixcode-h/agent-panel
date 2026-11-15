import { randomUUID } from 'node:crypto'
import { type PeerFrom, type Task, type TaskMessage } from '../../../shared/schema.ts'
import { type ChildHold } from '../../../shared/task.ts'
import { steerTask } from '../../exec/steering.ts'
import { markChildWrapUp } from '../../../shared/plan/index.ts'
import { log } from '../../log.ts'
import { isolated } from '../helpers.ts'
import type { IntegrateResult } from '../../exec/worktree-integrate.ts'
import type { FinishResult, MergeCtx } from './context.ts'

/**
 * 合并成功（共用目录的子对话是父对话验收通过）：只更新分支状态（「已在「dev」里」）和计划最后一步，不等于这个子对话做完了。
 * 还在一轮里的把结果交给它，等这一轮结束再按 childFlowOf 收口；已经停下的马上试一次，
 * 计划、后台命令、提问还没完就保留独立分支（见 advanceChildTo）。返回收口的结果（还在一轮里时为空）
 */
export async function childMerged(
  ctx: MergeCtx,
  childId: string,
  text: string,
  opts: { quiet?: boolean; peer?: PeerFrom } = {},
): Promise<{ holds: ChildHold[]; info: string } | undefined> {
  const { sc } = ctx
  const entry = sc.live.get(childId)
  const tk = entry?.task ?? (await sc.store.get(childId))
  if (!tk) return undefined
  const msg: TaskMessage = {
    id: randomUUID(),
    role: 'system',
    agentId: '',
    step: '',
    text,
    tools: [],
    panel: 'build',
    ...(opts.peer && { peer: opts.peer }),
    at: new Date().toISOString(),
  }
  const steered = entry?.task.working ? await steerTask(entry.task, text, msg).catch(() => false) : false
  if (!steered) tk.messages.push(msg)
  // 计划最后一步的收尾（合回、验收）由面板标完成：计划做完才走得到完成那一步
  markChildWrapUp(tk, 'done', isolated(tk) ? '已合回父对话所在的分支' : '父对话已验收')
  // 收尾请求办完了：合进去之后它就不再是「待收尾」。
  // 写 undefined 不用 delete：store.update 是把传入的字段盖到旧记录上，删掉的键盖不掉旧值
  tk.wrapRequest = undefined
  tk.updatedAt = new Date().toISOString()
  // 排在它后面的子对话按这个时间判断能不能开始（shared/children/after.ts）
  tk.mergedAt = tk.updatedAt
  if (entry) entry.rev++
  await sc.store.update(tk.id, tk)
  // 父对话的分支现在已经带着它的提交：排在它后面的子对话可以开始了，独立分支从这里开
  if (tk.parentTaskId)
    void sc
      .releaseAfter(tk.parentTaskId)
      .catch((e) => log.warn('task', '启动排在后面的子对话失败', { task: tk.id, error: (e as Error).message }))
  if (entry?.task.working) return undefined
  return sc.advanceChildTo(childId, opts)
}

/**
 * 合回成功之后（ADR 0018 的第二、三段）：有范围为 parent 的步骤就交给父对话测试队列，跑完才收尾；
 * 没有就直接 childMerged 收口。返回给父对话的工具结果
 */
export async function afterMerged(
  ctx: MergeCtx,
  parent: Task,
  tk: Task,
  req: NonNullable<Task['wrapRequest']>,
  r: IntegrateResult,
): Promise<FinishResult> {
  const { sc } = ctx
  // 范围为 parent 的步骤（ADR 0018 / 0020）：合回后由面板在这儿跑，跑完才让子对话收尾。
  // 不能先 childMerged：那一步会标完成、清 wrapRequest、收口删分支，父对话测试还没跑就没得修了
  const parentSteps = await sc.parentTestStepsOf(tk)
  if (parentSteps.length) {
    await sc.startParentTests(tk, parentSteps)
    return {
      ok: true,
      info: [
        `已把子对话「${tk.title}」合回：${r.info}`,
        `合回还没收尾：它范围为「全量，合并后由父对话跑」的步骤（${parentSteps.map((s) => s.name).join('、')}），面板现在在你的目录里按顺序跑，一次只跑一个（和编译共用一条队）。结果直接回传给子对话：通过才标完成、删分支；失败会退回给它修，它再合并时这些步骤会全部重跑。你不用自己跑，也不用转述结果。`,
        req.build
          ? `这是 UE 项目：编译仍按 ADR 0004 由你调用 request_build 申请（children 写 ["${tk.id}"]），和这批测试共用独占队。`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  const done = await childMerged(
    ctx,
    tk.id,
    `【父对话收尾】已合回原分支：${r.info}
父对话已经验收合并。计划、后台命令、提问都收口后面板结束这个子对话并删除独立分支；不要再改已经合进去的文件。`,
    { quiet: true, peer: await sc.peerOf(parent, 'parent', 'merge', `已合回原分支：${r.info}`) },
  )
  const finished = !!done && !done.holds.length
  return {
    ok: true,
    info: [
      `已把子对话「${tk.title}」合回：${r.info}`,
      finished
        ? '它的计划收尾步骤已标完成，子对话已结束，独立分支和分支已删除。'
        : `它的计划收尾步骤已标完成；${done ? `还差：${done.info}` : '它这一轮还没结束'}，收口后面板自动结束它并删除独立分支。`,
      req.build
        ? `这是 UE 项目：改动已经进了你的目录，现在调用 request_build 编译（children 写 ["${tk.id}"]），编译结果面板会转给它。`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}
