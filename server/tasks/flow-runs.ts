/**
 * 工作流运行的宿主（docs/openspec/changes/workflow-runs/design.md 第 3、4 节）：父对话的 start_workflow 等工具最终落到这里。
 * 运行是一个 mode=workflow、带 flowRun 的任务，不是子对话：没有 parentTaskId，子对话那套（自驱、收尾规则、状态上报）都不作用到它。
 * - 改代码的（kind change）在自己的独立分支里跑，跑完由父对话 finish_workflow 合回或放弃；只读的直接在父对话的目录里跑
 * - 运行只在等决定（失败、交给父对话决定的确认）、待合回、完成、被用户终止时给父对话写信，同一阶段只写一次
 * - 父对话停了，名下在跑的运行一起暂停；父对话继续时接着跑（D4）
 */
import { randomUUID } from 'node:crypto'
import type { Agent, Project, Task, TaskMessage } from '../../shared/schema.ts'
import { NewTaskInput } from '../../shared/schema.ts'
import { FlowRun } from '../../shared/task-flow-schema.ts'
import type { FlowRunHost, RunTarget } from '../../shared/flow-run-orch.ts'
import type { PickedFlow } from '../../shared/flow-run.ts'
import { RUN_ENDED, runEntry, runLine, runNodes, rewindTo } from '../../shared/flow-run.ts'
import { newTask } from '../../shared/task.ts'
import { settleWait } from '../../shared/plan.ts'
import { clip } from '../../shared/text.ts'
import { t } from '../../shared/i18n.ts'
import { createWorktree } from '../exec/worktree.ts'
import { gitHead } from '../exec/git.ts'
import { answerRequest } from '../exec/requests.ts'
import { steerTask } from '../exec/steering.ts'
import { log } from '../log.ts'
import type { TasksScope } from './scope.ts'

const now = () => new Date().toISOString()
const bad = (info: string) => ({ ok: false, info })

export function createFlowRuns(sc: TasksScope) {
  const get = async (id: string) => sc.live.get(id)?.task ?? (await sc.store.get(id))

  /** 改一次运行并落盘：在执行位上的改内存里那份（推送跟着走），不在的改存储里的 */
  async function edit(id: string, fn: (tk: Task) => void) {
    const e = sc.live.get(id)
    const tk = e?.task ?? (await sc.store.get(id))
    if (!tk) return null
    fn(tk)
    tk.updatedAt = now()
    if (e) e.rev++
    await sc.store.update(id, tk)
    return tk
  }

  /** 父对话名下的这次运行；不是它的、或者根本不是运行，都按找不到说 */
  async function owned(ownerId: string, id: string) {
    const tk = id ? await get(id.trim()) : null
    return tk?.flowRun?.owner === ownerId ? (tk as Task & { flowRun: FlowRun }) : null
  }
  const notFound = (id: string) => bad(`找不到你名下的工作流运行 ${id}：id 从 list_workflows 取`)

  /** 运行里记一条系统说明（谁、做了什么），界面上按时间顺序看得到 */
  const note = (tk: Task, text: string, peer?: TaskMessage['peer']): TaskMessage => {
    const m: TaskMessage = {
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      at: now(),
      ...(peer && { peer }),
    }
    tk.messages.push(m)
    return m
  }

  /** 在后台跑一轮：和子对话一样立刻开始，不按并发上限排队；出错记在运行上 */
  async function runTurn(tk: Task, agents?: Agent[], resume = false) {
    try {
      const got = sc.reserve(tk)
      if (!got.fresh) return
      const list = agents ?? (await sc.deps.agents.list())
      await sc.start(got.value, tk.flowRun?.input || tk.title, !resume, list, undefined, resume)
      await got.value.done
    } catch (e) {
      log.error('task', '工作流运行出错', { task: tk.id, error: (e as Error).message })
      sc.alertOn(tk.id, 'panel', t('执行这次工作流运行时出错'), 'error')(e)
    }
  }

  /** 运行停着时接着跑（重启、父对话继续、退回、代答后）；在跑的不动 */
  async function resume(id: string) {
    if (sc.live.has(id)) return
    const tk = await sc.store.get(id)
    if (!tk?.flowRun || RUN_ENDED.includes(tk.flowRun.phase)) return
    tk.flowRun.pausedBy = undefined
    void runTurn(tk, undefined, true)
  }

  /** 停下一次在跑的运行并等它收完；by 记在运行上（父对话继续时只拉起随它停的） */
  async function halt(id: string, by: FlowRun['pausedBy']) {
    const e = sc.live.get(id)
    if (!e) return
    if (e.task.flowRun) e.task.flowRun.pausedBy = by
    sc.stopTask(id, by === 'user' ? 'user' : 'parent')
    if (e.done) await e.done.catch(() => {})
  }

  async function start(
    owner: Task,
    project: Project,
    p: PickedFlow & { input: string; title: string; files?: string[] },
  ): Promise<{ ok: boolean; id?: string; info: string }> {
    const all = await sc.deps.workflows.list()
    const fallback = (await sc.projectWorkflow(project)) ?? undefined
    const plan = sc.planWorkflow(project, all, fallback, p.workflowId)
    if (!plan) return bad(`找不到工作流「${p.workflowName || p.workflowId}」`)
    const id = randomUUID()
    const at = now()
    const scope = p.files?.length ? `\n\n## 负责的文件\n${p.files.map((f) => `- ${f}`).join('\n')}` : ''
    const input = NewTaskInput.parse({ projectId: project.id, mode: 'workflow', prompt: p.input + scope })
    const draft: Task = {
      ...newTask(input, plan.workflow, at, id, plan.workflows, plan.skillSlots),
      id,
      createdAt: at,
      updatedAt: at,
      title: clip(p.title, 80),
      autoTitle: false,
      flowRun: FlowRun.parse({
        owner: owner.id,
        workflowName: plan.workflow.name,
        kind: p.kind,
        input: p.input + scope,
        reviseLimit: plan.workflow.reviseLimit ?? 3,
      }),
    } as Task
    // 第一条是父对话交代的：运行里画成「接收消息 · 交代任务」
    if (draft.messages[0]) draft.messages[0].peer = await sc.peerOf(owner, 'parent', 'task', p.input)
    // 改代码的在自己的独立分支里跑：几个运行、父对话自己的改动互不干扰，跑完由父对话决定合不合回
    let shared = ''
    if (p.kind === 'change') {
      const base = await sc.taskDir(owner)
      try {
        draft.worktree = await createWorktree(base, id, draft.title)
        draft.baseRef = await gitHead(draft.worktree.path).catch(() => '')
      } catch (e) {
        shared = (e as Error).message
        log.warn('task', '工作流运行开不了独立分支，在父对话的目录里跑', { task: id, error: shared })
        note(draft, t('开不了独立分支（{error}），这次运行直接在父对话的目录里改', { error: shared }))
      }
    }
    const tk = await sc.store.create(draft)
    void runTurn(tk)
    return {
      ok: true,
      id: tk.id,
      info: [
        `已起工作流运行「${tk.title}」（工作流「${plan.workflow.name}」）。它在后台按流程图执行，等决定、待合回、完成时会来信叫你；进度用 list_workflows 看。`,
        shared ? `注意：开不了独立分支（${shared}），它直接在你的目录里改，合回时不用再合。` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  async function list(ownerId: string) {
    const all = (await sc.store.list()).filter((x) => x.flowRun?.owner === ownerId)
    return all
      .map((x) => runEntry(sc.live.get(x.id)?.task ?? x))
      .filter((e) => !!e)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }

  async function message(owner: Task, id: string, text: string, to: RunTarget) {
    const tk = await owned(owner.id, id)
    if (!tk) return notFound(id)
    if (RUN_ENDED.includes(tk.flowRun.phase))
      return bad(`这次运行已经${runLine(runEntry(tk)!).split('：').pop()}，不再接收补充`)
    const peer = await sc.peerOf(owner, 'parent', 'rule', text)
    const target = to === 'current' || to === 'later' ? '' : to.trim()
    // 交给正在跑的节点：CLI 支持插话的直接插进去，不支持的等它下一次回到面板时取（见 steering.ts 的 steerTask）
    const e = sc.live.get(tk.id)
    const running = e ? runNodes(e.task).step : undefined
    if (e && to !== 'later' && running?.status === 'running' && (!target || running.title === target)) {
      const msg: TaskMessage = {
        id: randomUUID(),
        role: 'user',
        agentId: '',
        step: '',
        text,
        tools: [],
        at: now(),
        peer,
      }
      const how = await steerTask(e.task, text, msg)
      if (how) {
        e.rev++
        return { ok: true, info: `已交给正在跑的节点「${running.title}」` }
      }
    }
    // 交不进去（没在跑、点名的节点还没开始）或者本来就是给之后的：记成运行级说明，之后每个节点都带上
    const line = target ? `给「${target}」：${text}` : text
    await edit(tk.id, (x) => {
      x.flowRun!.notes.push(line)
      x.flowRun!.decisions.push({ at: now(), node: target, kind: 'note', text })
      note(x, t('父对话补充：{text}', { text: clip(text, 400) }), peer)
    })
    return { ok: true, info: target ? `已记下，节点「${target}」开始时会带上` : '已记下，之后的节点都会带上' }
  }

  async function revise(owner: Task, id: string, node: string, text: string) {
    const tk = await owned(owner.id, id)
    if (!tk) return notFound(id)
    const f = tk.flowRun
    if (f.phase === 'done' || f.phase === 'discarded') return bad('这次运行已经收下或放弃了：要再改就再起一次运行')
    const cur = runNodes(tk)
    const at = node.trim() || cur.node
    // 停在等确认的就是这个节点：按「要求修改」回答那张确认卡，不用停下重来
    const live = sc.live.get(tk.id)
    const req = live?.task.requests.find((r) => r.kind === 'confirm')
    if (live && req && f.phase === 'confirm' && at === cur.node) {
      live.task.flowRun!.delegated = true
      if (answerRequest(live.task, req.id, { allow: false, answer: text }, randomUUID)) {
        live.rev++
        return { ok: true, info: `已让「${at}」按意见修改` }
      }
    }
    await halt(tk.id, 'parent')
    let back: string[] = []
    const after = await edit(tk.id, (x) => {
      back = rewindTo(x, at).map((s) => s.title)
      if (!back.length) return
      const r = x.flowRun!
      r.decisions.push({ at: now(), node: at, kind: 'back', text })
      r.phase = 'running'
      r.pausedBy = undefined
      r.preAnswer = undefined
      r.wrap = undefined
      r.told = ''
      x.status = 'stopped'
      note(x, t('父对话把运行退回到「{node}」：{text}', { node: at, text: clip(text, 400) }))
    })
    if (!after) return notFound(id)
    if (!back.length) {
      const names = runNodes(after).total
        ? after.steps.filter((s) => !s.parentId && s.workflowId).map((s) => `「${s.title}」`)
        : []
      return bad(`没有「${at}」这个节点${names.length ? `：节点有 ${names.join('、')}` : ''}`)
    }
    void resume(tk.id)
    return { ok: true, info: `已退回到「${at}」，${back.length} 个节点会带着意见重跑` }
  }

  async function answer(owner: Task, id: string, allow: boolean, text: string) {
    const tk = await owned(owner.id, id)
    if (!tk) return notFound(id)
    if (tk.flowRun.phase !== 'confirm') return bad(`这次运行现在不在等确认（${runLine(runEntry(tk)!)}）`)
    const live = sc.live.get(tk.id)
    const req = live?.task.requests.find((r) => r.kind === 'confirm')
    if (live && req) {
      live.task.flowRun!.delegated = true
      if (!answerRequest(live.task, req.id, { allow, answer: text }, randomUUID)) return bad('这张确认已经有人答过了')
      live.rev++
      await sc.store.update(tk.id, live.task)
      return { ok: true, info: allow ? '已确认，运行接着往下走' : '已让它按意见修改' }
    }
    // 运行停着（暂停、面板重启过）：记下回答，接着跑回到确认时直接用
    await edit(tk.id, (x) => {
      x.flowRun!.preAnswer = { allow, answer: text }
      x.flowRun!.delegated = true
    })
    void resume(tk.id)
    return { ok: true, info: allow ? '已确认，运行会接着往下走' : '已让它按意见修改' }
  }

  async function stop(owner: Task, id: string, why: string) {
    const tk = await owned(owner.id, id)
    if (!tk) return notFound(id)
    if (RUN_ENDED.includes(tk.flowRun.phase)) return { ok: true, info: '这次运行已经结束了' }
    // 先记成终止再停：引擎收尾时看到终止就不再把阶段改回「等确认」
    await edit(tk.id, (x) => {
      x.flowRun!.phase = 'cancelled'
      x.flowRun!.told = 'cancelled'
      x.flowRun!.decisions.push({ at: now(), node: '', kind: 'parent', text: `终止：${why}` })
      note(x, t('父对话终止了这次运行：{why}', { why }))
    })
    await halt(tk.id, 'parent')
    settle(owner.id, tk.id, false)
    const kept = tk.worktree?.state === 'active' ? '改过的文件还在它的分支上，用 finish_workflow discard 放弃。' : ''
    return { ok: true, info: `已终止。${kept}` }
  }

  async function finish(owner: Task, id: string, action: 'merge' | 'discard') {
    const tk = await owned(owner.id, id)
    if (!tk) return notFound(id)
    const f = tk.flowRun
    if (f.phase === 'done' || f.phase === 'discarded') return { ok: true, info: '这次运行已经收尾了' }
    if (sc.live.get(tk.id)?.task.working) return bad('运行还在跑：等它待合回，或先 stop_workflow 终止')
    if (action === 'merge') {
      if (f.phase !== 'ready') return bad(`现在还不能合回（${runLine(runEntry(tk)!)}）：做完、待合回时才能合回`)
      if (tk.worktree?.state === 'active') {
        const r = await sc.integrate(tk, owner)
        if (!r.ok) return bad(r.info)
        await sc.dropWorktree(tk)
      }
    } else if (tk.worktree?.state === 'active') await sc.dropWorktree(tk)
    await edit(tk.id, (x) => {
      x.flowRun!.phase = action === 'merge' ? 'done' : 'discarded'
      x.flowRun!.told = x.flowRun!.phase
      x.worktree = tk.worktree
      note(x, action === 'merge' ? t('父对话把这次运行的改动合回了') : t('父对话放弃了这次运行的改动'))
    })
    settle(owner.id, tk.id, action === 'merge')
    return { ok: true, info: action === 'merge' ? '已合回你的目录，分支已删除' : '已放弃这次运行的改动，分支已删除' }
  }

  /** 父对话计划里等这次运行的那一步：运行有了结论就收口（合回、完成算成，终止、放弃算没成） */
  function settle(ownerId: string, runId: string, ok: boolean) {
    const e = sc.live.get(ownerId)
    void (async () => {
      const owner = e?.task ?? (await sc.store.get(ownerId))
      if (!owner || !settleWait(owner, 'workflow', runId, ok).length) return
      if (e) e.rev++
      await sc.store.update(ownerId, owner)
    })().catch((err) => log.warn('task', '收口父对话计划里等运行的那一步失败', { task: ownerId, error: String(err) }))
  }

  /**
   * 运行这一轮收完（run.ts 的收尾里调）：按阶段给父对话写信。只写要它出面的几种：等决定（失败）、待合回、完成；
   * 被父对话自己终止、合回、放弃的不写（它自己做的）。用户在运行上点终止的写一封，父对话好接着安排
   */
  async function afterTurn(run: Task) {
    const f = run.flowRun
    if (!f || f.told === f.phase || sc.shuttingDown) return
    const letter =
      f.phase === 'failed' ||
      f.phase === 'ready' ||
      f.phase === 'done' ||
      (f.phase === 'cancelled' && f.pausedBy === 'user')
    if (!letter) return
    const owner = await get(f.owner)
    await edit(run.id, (x) => (x.flowRun!.told = f.phase))
    if (!owner) return
    const e = runEntry(run)!
    const last = [...run.messages].reverse().find((m) => m.error)?.text ?? ''
    const body = [
      `【工作流运行】${runLine(e)}`,
      f.phase === 'failed' && last ? `出错：${clip(last, 600)}` : '',
      (f.phase === 'ready' || f.phase === 'done') && f.summary ? `结论：\n${clip(f.summary, 1500)}` : '',
      f.phase === 'ready'
        ? '看过结论后用 finish_workflow 合回（merge）或放弃（discard）；要改某个节点用 revise_workflow 退回。'
        : '',
      f.phase === 'failed' ? '要它带着意见重跑就用 revise_workflow；不做了就 stop_workflow。' : '',
    ]
      .filter(Boolean)
      .join('\n')
    if (f.phase === 'done' || f.phase === 'cancelled') settle(owner.id, run.id, f.phase === 'done')
    await sc.wakeTask(owner.id, run, body, { panel: 'workflow' })
  }

  /** 用户在运行卡片上点「交给父对话决定」：确认卡片留着，写信请父对话用 answer_workflow 代答 */
  async function delegate(runId: string) {
    const run = await get(runId)
    const f = run?.flowRun
    if (!run || !f || f.phase !== 'confirm') return bad(t('这次运行现在不在等确认'))
    await edit(runId, (x) => (x.flowRun!.delegated = true))
    const n = runNodes(run)
    const detail = [...run.requests].reverse().find((r) => r.kind === 'confirm')?.detail ?? n.step?.output ?? ''
    await sc.wakeTask(
      f.owner,
      run,
      `【工作流运行】工作流「${f.workflowName}」（id ${run.id}）的节点「${n.node}」做完了，用户请你决定：\n${clip(detail, 3000)}\n\n用 answer_workflow 回答：confirm 通过，revise 写清改什么。`,
      { panel: 'workflow' },
    )
    return { ok: true, info: t('已交给父对话决定') }
  }

  /** 父对话停了：名下在跑的运行一起暂停（D4），记成随父对话停，父对话继续时接着跑 */
  function pauseRunsOf(ownerIds: ReadonlySet<string>): string[] {
    const runs = [...sc.live.values()].filter((e) => e.task.flowRun && ownerIds.has(e.task.flowRun.owner))
    // 只打停止标记、不等收完：调用方（stopTree）接着一起结束各自的 CLI 进程
    for (const e of runs) {
      e.task.flowRun!.pausedBy = 'parent'
      sc.stopTask(e.task.id, 'parent')
    }
    return runs.map((e) => e.task.id)
  }

  /** 父对话继续了：随它停的（和面板重启时停的）运行接着跑 */
  async function resumeRunsOf(ownerId: string) {
    const all = (await sc.store.list()).filter((x) => x.flowRun?.owner === ownerId)
    for (const x of all) if (x.flowRun?.pausedBy === 'parent' || x.flowRun?.pausedBy === 'restart') void resume(x.id)
  }

  /** 父对话这一轮的工具宿主：只给项目里的父对话 */
  function hostFor(owner: () => Task, project: Project): FlowRunHost {
    return {
      start: (p) => start(owner(), project, p),
      list: () => list(owner().id),
      message: (id, text, to) => message(owner(), id, text, to),
      revise: (id, node, text) => revise(owner(), id, node, text),
      answer: (id, allow, text) => answer(owner(), id, allow, text),
      stop: (id, why) => stop(owner(), id, why),
      finish: (id, action) => finish(owner(), id, action),
    }
  }

  return { hostFor, afterTurn, delegate, pauseRunsOf, resumeRunsOf, resume, halt }
}
