import { type Task } from '../../../shared/schema.ts'
import { type ChildHold } from '../../../shared/task.ts'
import { t } from '../../../shared/i18n.ts'
import { markWrapUp, openWork } from '../../../shared/plan/index.ts'
import { isolated } from '../helpers.ts'
import type { IntegrateResult } from '../../exec/worktree-integrate.ts'
import { freshTask, readTask } from '../read.ts'
import type { FinishResult, MergeCtx } from './context.ts'
import { afterMerged, childMerged } from './after-merge.ts'

/**
 * 共用目录的子对话（P4、没有版本管理、项目设成共用目录）收尾：没有分支要合，父对话收下就是验收。
 * 改过文件的和独立分支一样要先请求收尾（submit_merge 里校验了评审、测试和交接），没请求的不收：
 * 以前这里直接标完成，评审、验证、交接全被跳过（用户 2026-10-31 报的 P4 子对话改完不评审）
 */
export async function acceptShared(ctx: MergeCtx, parent: Task, tk: Task): Promise<{ ok: boolean; info: string }> {
  const { sc } = ctx
  if (tk.changes.length && tk.wrapRequest?.state !== 'requested')
    return {
      ok: false,
      info: `子对话「${tk.title}」${openWork(tk).length ? `还没做完：${t('计划还没做完')}。它` : ''}改了 ${tk.changes.length} 个文件，还没请求收尾：它和你共用目录，没有分支要合，但评审、验证和交接一样要做，要它先做完再调用 submit_merge。需要催它就用 send_to_conversation。`,
    }
  const accepted = tk.wrapRequest?.state === 'requested'
  // 没改文件、也没请求过的（只读排查）：不替它把收尾标完成，条件都满足才收口，免得计划没做完也被收掉一步
  const r = !accepted
    ? await sc.advanceChildTo(tk.id, { quiet: true })
    : ((await childMerged(
        ctx,
        tk.id,
        '【父对话收尾】父对话已验收你的改动。计划、后台命令、提问都收口后面板结束这个子对话；不要再改这次交付的文件。',
        { quiet: true, peer: await sc.peerOf(parent, 'parent', 'merge', '已验收') },
      )) ?? { holds: ['working'] as ChildHold[], info: '它这一轮还没结束，收口后面板自动结束它' })
  return r.holds.length
    ? { ok: false, info: `子对话「${tk.title}」${accepted ? '已验收，但' : ''}还没做完：${r.info}` }
    : {
        ok: true,
        info: `子对话「${tk.title}」已${accepted ? '验收并' : ''}标完成（它和你共用目录，改动已经在原目录里，不用合并）`,
      }
}

/**
 * 收尾一个子对话的实际动作（finish_child，见 ADR 0005）：子对话已经请求收尾（submit_merge），
 * 面板按父对话排队把它的分支合回父对话所在的分支（git 操作是确定的，交给面板做，父对话只决定收不收），
 * 合进去后把它计划里的收尾步骤标完成、按 childFlowOf 收口（结束进程、删独立分支和分支、置完成），
 * 父对话计划里等它的那一步由 finishChild 收尾后统一刷新。没合进去时按谁能修分：冲突退回给子对话处理，它处理好会再请求；
 * 父对话目录挡路、提交出错留着收尾请求，告诉父对话动什么，处理完再 finish_child。
 * 合并就是验收：没请求收尾（没交验证结果）的不收
 */
export async function finishChildStep(ctx: MergeCtx, parent: Task, childId: string): Promise<FinishResult> {
  const { sc, merging } = ctx
  const tk = await readTask(sc, childId)
  if (!tk || tk.parentTaskId !== parent.id)
    return { ok: false, info: '找不到这个子对话：id 从 list_conversations 取，只能收尾你自己名下的子对话' }
  if (tk.resolved) return { ok: true, info: `子对话「${tk.title}」已经完成了，不用再收尾` }
  if (!isolated(tk)) return acceptShared(ctx, parent, tk)
  if (merging.has(childId)) return { ok: false, info: `子对话「${tk.title}」正在合并，结果出来会告诉你` }
  if (tk.wrapRequest?.state === 'testing')
    return {
      ok: false,
      info: `子对话「${tk.title}」的分支已经合回，面板正在你的目录里跑它范围为「全量，合并后由父对话跑」的测试步骤。结果出来后通过就自动标完成、删分支，失败就退回给它修——等结果，不要重复收尾。`,
    }
  if (tk.wrapRequest?.state !== 'requested')
    return {
      ok: false,
      info:
        tk.wrapRequest?.state === 'test-failed'
          ? `子对话「${tk.title}」的分支已经合回，但父对话测试没通过（${tk.wrapRequest.info.split('\n')[0]}），已经退回给它修。它修好会再请你收尾，等它请求，不要重复收尾。`
          : `子对话「${tk.title}」还没请求收尾${tk.wrapRequest?.state === 'failed' ? `（上次没合进去：${tk.wrapRequest.info.split('\n')[0]}，它处理好会再请求）` : ''}：合并就是验收，要它先在自己的分支里跑通验证、调用 submit_merge。需要催它就用 send_to_conversation。`,
    }
  const req = tk.wrapRequest
  merging.add(childId)
  const setReq = async (next: Task['wrapRequest']) => {
    const entry = sc.live.get(childId)
    const cur = entry?.task ?? tk
    cur.wrapRequest = next
    cur.updatedAt = new Date().toISOString()
    if (entry) entry.rev++
    await sc.store.update(cur.id, cur)
    return cur
  }
  await setReq({ ...req, state: 'merging' })
  let r: IntegrateResult
  try {
    r = await sc.mergeLock(parent.id, async () => sc.integrate(tk, freshTask(sc, parent)))
  } catch (e) {
    // 面板自己合并时抛的错（git 起不来之类）：不是子对话分支的问题，按提交出错交给父对话
    const msg = (e as Error).message
    r = { ok: false, kind: 'error', why: `合并出错：${msg.split('\n')[0]}`, info: `合并出错：${msg}` }
  } finally {
    merging.delete(childId)
  }
  // 挡路的在父对话自己的目录（暂存区、没做完的合并、和分支重叠的未提交改动、换了分支）或提交本身出错：
  // 子对话动不了父对话的目录，退回给它只会两边互相等或来回空转。收尾请求留着 requested，
  // 把要动什么写给父对话，它处理完直接再 finish_child；要子对话改的由父对话 send_to_conversation 交回
  if (!r.ok && r.kind && r.kind !== 'conflict') {
    const cur = await setReq({ ...req, state: 'requested', info: r.info })
    const what = r.kind === 'error' ? '合并后提交出错' : '父对话的目录挡住了合并'
    markWrapUp(cur, 'merge', 'waiting', `${what}，等父对话处理：${r.why ?? r.info.split('\n')[0]}`)
    await sc.store.update(cur.id, cur)
    // 不 reportedState.delete、不 sendToChild：子对话这边什么都不用做，叫醒它开新一轮反而会清掉收尾请求（run.ts）
    return {
      ok: false,
      kind: r.kind,
      why: r.why,
      info: `没能合回子对话「${tk.title}」，${r.kind === 'error' ? '提交这一步出错，已撤回' : '原因在你的目录，不在子对话'}：\n${r.info}\n收尾请求还留着，不用找子对话、它也不会再请求：处理完直接再调用 finish_child（id ${tk.id}）。`,
    }
  }
  if (!r.ok) {
    const cur = await setReq({ ...req, state: 'failed', info: r.info })
    markWrapUp(cur, 'merge', 'running', `没能合回：${r.info.split('\n')[0]}`)
    await sc.store.update(cur.id, cur)
    // 退回去了：它处理好再请求时要重新上报一次
    sc.reportedState.delete(childId)
    await sc.sendToChild(
      parent.id,
      childId,
      `【父对话收尾】没能合回原分支：${r.info}
在你的分支里处理好、重新跑通验证后再调用 submit_merge 请父对话收尾。`,
      'build',
      'merge',
      true,
    )
    return {
      ok: false,
      kind: 'conflict',
      why: r.why,
      info: `没能合回子对话「${tk.title}」：${r.info}\n已经退回给它处理，它处理好会再请你收尾。`,
    }
  }
  return afterMerged(ctx, parent, tk, req, r)
}
