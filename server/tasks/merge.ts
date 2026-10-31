import { coreDefinition } from '../../shared/builtin/core.ts'
import { randomUUID } from 'node:crypto'
import { Task, type Project, type PeerFrom, type TaskMessage } from '../../shared/schema.ts'
import { childReport, type ConvState, taskDeleted, type ChildHold } from '../../shared/task.ts'
import { branchCommits, gitChanges, gitHead, gitNumstat } from '../exec/git.ts'
import { type HandoffInput, handoffMissing, handoffTemplate, handoffText } from '../../shared/handoff.ts'
import { overrideText, reviewGate, triageText, type ReviewOverride, type TriageItem } from '../../shared/review-gate.ts'
import { steerTask } from '../exec/runner.ts'
import { hasHeld } from '../exec/delivery.ts'
import { placedFiles } from '../attachments.ts'
import { commitWorktree } from '../exec/worktree.ts'
import { buildSteps, stepCommand } from '../../shared/test-steps.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import {
  activePlan,
  markChildWrapUp,
  markWrapUp,
  planProgress,
  openWork,
  refreshChildWait,
  syncKids,
  type PlanKid,
} from '../../shared/plan.ts'
import { normClaimPath, overlaps } from '../claims.ts'
import { inlineEditBlocker, inlineEditOverrun, inlineEditOverrunText } from '../../shared/inline-edit.ts'
import { isolated } from './helpers.ts'
import type { TasksScope } from './scope.ts'

/**
 * 子对话收尾：submit_merge 合回父对话分支（评审门禁、合并时编译）、UE 编译请求、就地微改动、finish_child、父计划里等子对话的那一步。
 */
export function createMerge(sc: TasksScope) {
  /** 父对话正在合并的子对话：这一轮结束时不催它合并，父对话等它的计划步骤也留给合并结果收口 */
  const merging = new Set<string>()
  /** 这一轮结束时已经催过「请父对话收尾」的子对话：再结束还没请就照常上报父对话，不反复催 */
  const mergeNudged = new Set<string>()
  /**
   * 计划没做完就收尾、被催过接着做的子对话：记下催的时候计划做到哪（计划 id + 已完成几步）。
   * 同一个进度只催一次：催过还停在原地就照常上报父对话「未完成」，不在面板里来回推
   */
  const planNudged = new Map<string, string>()
  /** 面板已经按这个进度推过它接着做（nudgePlan），它还停在原地 */
  const stuckAfterNudge = (tk: Task) => {
    const plan = activePlan(tk)
    return !!plan && planNudged.get(tk.id) === `${plan.id}:${planProgress(tk, plan).done}`
  }
  /** 一轮结束后等多久再推「接着做计划」：等 CLI 停到等下一句上；测试用环境变量缩短 */
  const PLAN_NUDGE_MS = Number(process.env.AGENT_PANEL_PLAN_NUDGE_MS) || 2000

  /**
   * 子对话只剩合回时请父对话收尾（ADR 0005）：子对话这边能做的都做完了——计划除了合回都做完、
   * 后台命令都结束、没有等用户 / 父对话回答的提问、编译测试在自己的分支里跑通（tests 写明）。
   * 面板先把现在的改动提交到它的分支，记下收尾请求，计划最后一步标「等待中」，再把请求交给父对话马上处理；
   * 合并、改计划、删分支都由父对话调用 finish_child 发起（面板做 git 操作，父对话决定什么时候收）。
   * 合并就是验收：所以测试必须在这之前、在子对话自己的分支里做完
   */
  async function submitMerge(
    childId: string,
    note: string,
    tests: string,
    /** UE 项目：合回去后父对话要接着编译（独立分支里编不了 UE，见 ADR 0004） */
    build = false,
    /** 交接要点（见 ADR 0007）：以后再被叫醒、上下文又大时只带这份摘要 */
    handoff: HandoffInput = {},
    /** 对最近一次评审每条高级、中级意见的处置（见 ADR 0009）：门禁按它放行，原样交给父对话验收 */
    triage: TriageItem[] = [],
    /**
     * 显式放行（见 shared/review-gate.ts）：评审没过而用户明确要求「已知问题也合并」时带上。
     * 只有门禁真的拦下时它才生效；生效后记录会写在任务上、并随收尾消息交给父对话
     */
    override?: ReviewOverride,
  ): Promise<{ ok: boolean; info: string }> {
    const entry = sc.live.get(childId)
    const tk = entry?.task ?? (await sc.store.get(childId))
    if (!tk?.parentTaskId) return { ok: false, info: '只有子对话能请父对话收尾' }
    // 共用父对话目录的子对话（P4、没有版本管理、项目设成共用目录）：没有分支要合，但下面的校验一条不少，
    // 评审、测试、交接、父对话验收是交付的必备步骤，不跟着版本管理方式变（用户 2026-10-31 定的）
    const own = isolated(tk)
    // 合并就是验收：没写跑了什么就不收，免得没验证的改动进了父对话的分支
    if (!tests)
      return {
        ok: false,
        info: '没有请求收尾：tests 里写上你在独立分支里跑了哪些编译、测试和结果。没跑通就先修好再调用；这次确实不需要测试（只改了文档、注释）时写明原因。',
      }
    // 后台还在跑的命令多半就是测试：没跑完就不算跑通，合进去后回收分支还会把它掐掉
    const pending = sc.background.list(childId).filter((j) => j.state === 'queued' || j.state === 'running')
    if (pending.length)
      return {
        ok: false,
        info: `没有请求收尾：后台还有命令没跑完（${pending.map((j) => `「${j.name}」`).join('、')}）。等结果推回来、确认通过后再调用 submit_merge。`,
      }
    // 合回已完成、父对话在跑范围为 parent 的步骤（ADR 0018 / 0020）：等它跑完，不能重复请求
    if (sc.parentTesting(childId, tk))
      return {
        ok: false,
        info: '没有请求收尾：你的分支已经合回，父对话正在跑范围为「全量，合并后由父对话跑」的步骤。结果推回来时：通过就自动标完成、删分支；失败按报错修好再调用 submit_merge。',
      }
    if (tk.requests.length || tk.parentAsks?.length)
      return {
        ok: false,
        info: '没有请求收尾：还有等用户或父对话回答的提问。等回答回来、按回答处理完再调用 submit_merge。',
      }
    const left = openWork(tk)
    if (left.length)
      return {
        ok: false,
        info: `没有请求收尾：计划还有步骤没做完（${left
          .slice(0, 5)
          .map((x) => `${x.id}「${x.title}」`)
          .join('、')}）。做完并用 set_plan 标完成；确实不做的从计划里删掉并说明原因，再调用 submit_merge。`,
      }
    // 合回前必须先评审：收尾流程是 改完 → 快速检查 → 评审（计划里的独立步骤） → 按意见改 → 完整测试 → submit_merge，
    // 评审就是一次普通的 spawn_agents，结论从它的输出里读（见 shared/review-gate.ts）。
    // 子任务是按 id 或名字找角色的：用户自己建了同名的「评审」时，派出去的可能是那个，所以名字也认
    const reviewerName = coreDefinition('reviewer').agent.name
    // 读不到角色列表时单独说明：兜底成空数组会让门禁报「还没有真的派过评审」，把模型引向重复派评审
    const known = await sc.deps.agents.list().catch(() => null)
    if (!known) return { ok: false, info: '没有请求收尾：读取角色列表失败，稍后再试一次。' }
    // 改过文件才要评审：独立分支是 begin_edit 要改文件时才开的，开了就算交付代码；
    // 共用目录看这个对话记下的改动（Git 按差异算，P4 和没有版本管理时按 CLI 报的写文件）。只读排查不用评审
    const review =
      (own || tk.changes.length > 0) &&
      reviewGate(
        tk.steps,
        (id) => known.some((a) => a.id === id && (a.origin === 'builtin:reviewer' || a.name === reviewerName)),
        activePlan(tk)?.steps ?? [],
        triage,
        override,
      )
    if (review && !review.ok) return review
    // 放行记录的时间由面板记：调用方自报的时间挡不住「先传一个过去的时间」。
    // 这里只算出来、先不写回任务：后面还有几步校验，被拒时不留下一条没发起过收尾的「已放行」
    const bypass = review && review.bypass ? { ...review.bypass, at: new Date().toISOString() } : undefined
    // 只认内存里的 merging：记录上的 merging 可能是合并途中面板重启、或旧版本没清掉留下的
    if (merging.has(childId)) return { ok: false, info: '父对话正在合并你的分支，等结果推回来。' }
    // 交接要点放在最后查：前面几样没满足时先修那些，别让它为了写摘要白跑一趟
    const missing = handoffMissing(handoff)
    if (missing.length)
      return {
        ok: false,
        info: `没有请求收尾：handoff 里还缺「${missing.join('、')}」。以后父对话再把消息交给你、上下文又大时，新会话只带这份交接摘要，按下面的模板写（每项写具体路径和结论，不写过程）：\n${handoffTemplate()}`,
      }
    const parentId = tk.parentTaskId
    const wt = own ? tk.worktree! : undefined
    // 先把现在的改动提交到它自己的分支：之后再改的不在这次合并里
    if (wt)
      try {
        await commitWorktree(wt, `Agent 面板：${tk.title}${note ? ` — ${note.slice(0, 60)}` : ''}`)
      } catch (e) {
        return { ok: false, info: `提交到独立分支失败：${(e as Error).message}` }
      }
    mergeNudged.delete(childId)
    const at = new Date().toISOString()
    // 面板补的事实（提交、改动文件）现在就读：合回去以后分支和目录会被删掉；共用目录的用这个对话记下的改动
    const [commits, changed] = wt
      ? await Promise.all([
          branchCommits(wt.path, tk.baseRef).catch(() => []),
          gitNumstat(wt.path, tk.baseRef, placedFiles(tk)).catch(() => null),
        ])
      : [[], Object.fromEntries(tk.changes.map((c) => [c.path, `+${c.add} -${c.del}`]))]
    const request = tk.messages.find((m) => m.role === 'user' && !m.step && !m.panel)?.text ?? ''
    tk.handoff = {
      text: handoffText(handoff, {
        title: tk.title,
        request,
        note,
        tests,
        branch: wt?.branch ?? '',
        base: wt?.baseBranch ?? '',
        commits,
        changed: changed ?? {},
        triage: triageText(triage),
        override: bypass ? overrideText(bypass) : '',
        shared: !wt,
      }),
      files: handoff.files ?? '',
      at,
    }
    tk.wrapRequest = { state: 'requested', at, note, tests, ...(build && { build }), info: '' }
    // 校验都过了才记放行；这次没绕过门禁就清掉旧的，留着的只能是当前这次收尾的放行
    tk.reviewOverride = bypass
    markChildWrapUp(tk, 'waiting', wt ? '已请父对话收尾，等父对话合并' : '已请父对话验收，等父对话收下')
    tk.updatedAt = at
    if (entry) entry.rev++
    await sc.store.update(tk.id, tk)
    // 这次请求本身就是一次状态上报：一轮结束时不再报一遍「待收尾」
    sc.reportedState.set(childId, sc.reportKey(tk, 'wrapup'))
    const child = { id: tk.id, title: tk.title, state: 'wrapup' as const }
    await wakeTask(
      parentId,
      tk,
      `【收尾请求】子对话「${tk.title}」（id ${tk.id}）只剩${wt ? '合回' : '验收'}了：计划其余步骤都做完、后台命令都结束、没有待回答的提问。
${wt ? `它在独立分支 ${wt.branch} 里的验证` : '它和你共用目录（改动已经在你的目录里，没有分支要合），它的验证'}：${tests.slice(0, 600)}${note ? `\n它的说明：${note.slice(0, 300)}` : ''}${triage.length ? `\n它对评审意见的处置（评审只出意见，采不采纳是它核实后定的；驳回或留作已知问题的理由站不住时打回给它）：\n${triageText(triage).slice(0, 1500)}` : ''}${bypass ? `\n⚠️ 它这次的收尾用了**显式放行**：评审门禁被绕过，记录如下（谁、什么时候、为什么、原本拦住什么）——用户要求带着这个问题先合并，你如果觉得理由站不住，打回给它或者直接问用户：\n${overrideText(bypass)}` : ''}
${
  wt
    ? `请你收尾：调用 finish_child（id ${tk.id}），面板把它的分支合回「${wt.baseBranch || '你所在的分支'}」、把它计划里的收尾步骤标完成、结束它并删除独立分支和分支。`
    : `请你验收：核对它的验证和改动，没问题就调用 finish_child（id ${tk.id}），面板把它计划里的收尾步骤标完成、结束它。`
}验证不够、你看出问题时不要收，用 send_to_conversation 把要补的交回给它。`,
      {
        panel: 'wrapup',
        child,
        peer: await sc.peerOf(tk, 'child', 'wrapup', note || (wt ? '只剩合回，请收尾' : '只剩验收，请收尾')),
      },
    )
    return {
      ok: true,
      info: wt
        ? '已请父对话收尾：它会把你的分支合回原分支、标完成并删除独立分支，结果推回给你。现在结束这一轮，不要再改文件（这次提交之后再改的不在这次合并里）；父对话退回要你补的，按它说的做完再调用 submit_merge。'
        : '已请父对话验收：它核对后标完成，结果推回给你。现在结束这一轮，不要再改文件；父对话退回要你补的，按它说的做完再调用 submit_merge。',
    }
  }

  /**
   * 把面板的消息交给一个对话并让它马上处理（按 runningConv 交付，见 wakeConv）；
   * 交不出去（这一轮没正常结束、被别的操作占着）就退回收件箱，它下一轮开始时一起处理
   */
  async function wakeTask(
    id: string,
    from: Task,
    text: string,
    meta: {
      panel?: TaskMessage['panel']
      child?: { id: string; title: string; state: ConvState }
      /** 发件对话：收件方画成一行「接收消息」 */
      peer?: PeerFrom
    } = {},
  ) {
    try {
      await sc.wakeConv(id, text, {
        panel: meta.panel ?? 'child',
        ...(meta.child && { child: meta.child }),
        ...(meta.peer && { peer: meta.peer }),
      })
    } catch (e) {
      log.warn('task', '没能马上交给对话，放进收件箱', { task: id, error: (e as Error).message })
      sc.alertOn(id, 'delivery', t('一条消息没能马上交给这个对话，已放进收件箱'))(e)
      await sc.noteParent(id, from, text, text, undefined, meta.child, meta.peer)
    }
  }

  /**
   * UE 项目的编译归父对话（见 EngineHost.ueBuild）：子对话的申请交给父对话马上处理，
   * 什么时候编、几个申请合成一次由父对话决定，它再向面板占位
   */
  async function askParentBuild(child: Task, note: string, checks = '') {
    if (!child.parentTaskId) return
    await wakeTask(
      child.parentTaskId,
      child,
      `【编译申请】子对话「${child.title}」（id ${child.id}）申请 UE 编译：${note}${checks ? `\n它做过的检查：${checks.slice(0, 400)}` : ''}
按申请处理：还有别的子对话的申请没编时合成一次，用 request_build 向面板申请编译，children 写上这些子对话的 id；编译结果面板会同时推给你和它们，失败时它们自己修好再申请。`,
      {
        panel: 'wrapup',
        child: { id: child.id, title: child.title, state: 'waiting' },
        peer: await sc.peerOf(child, 'child', 'build', `申请 UE 编译：${note}`),
      },
    )
  }

  async function childRequestBuild(child: Task, note: string): Promise<{ ok: boolean; info: string }> {
    if (!child.parentTaskId) return { ok: false, info: '只有子对话向父对话申请编译' }
    if (isolated(child))
      return {
        ok: false,
        info: '你在独立分支里，改动要先合回父对话的目录才编得到：调用 submit_merge（build 保持 true），合进去后面板替你向父对话申请编译。',
      }
    await askParentBuild(child, note)
    return {
      ok: true,
      info: '已向父对话申请编译。现在可以结束这一轮，编译结果出来面板会直接推给你；报错就修好再申请，通过了再接着做（合并前的验证以这次编译结果为准）。',
    }
  }

  /**
   * 父对话向面板申请编译：编译是占位的资源，交给后台命令的独占队列，按编译目录排队，
   * 同一目录同一时间只编译一次；各自 worktree 的目录是不同的队，不互相占位。
   * 目录被别的父对话占着时告诉申请方占着的是谁，也告诉占着的一方后面有人在等
   */
  async function parentRequestBuild(
    parent: Task,
    project: Project,
    note: string,
    /** 申请这次编译的子对话：结果同时推给它们，不用父对话转述 */
    children: string[] = [],
  ): Promise<{ ok: boolean; info: string; id?: string }> {
    const steps = buildSteps(project.testSteps)
    if (!steps.length)
      return {
        ok: false,
        info: '项目测试步骤里没有编译步骤（勾「合并时编译」或名字带「编译」的）：请用户在项目设置 → 测试步骤里补上，补好之前不要自己拼命令编译。',
      }
    const dir = await sc.taskDir(parent)
    // 先看占着的再排：排进去以后自己的也算在里面
    const before = sc.background.occupants(dir)
    const ids: string[] = []
    for (const st of steps) {
      const r = sc.background.start({
        taskId: parent.id,
        name: `UE 编译：${st.name}`,
        command: stepCommand(st, process.platform, project.wslDistro),
        cwd: st.cwd,
        root: dir,
        exclusive: true,
      })
      if (!r.ok) return { ok: false, info: r.info }
      ids.push(r.id!)
    }
    // 结果也推给申请的子对话：只认父对话名下的
    const mine = new Set((await sc.store.list()).filter((x) => x.parentTaskId === parent.id).map((x) => x.id))
    const to = children.map((x) => x.trim()).filter((x) => mine.has(x))
    if (to.length) for (const id of ids) sc.buildFor.set(id, { parent: parent.id, children: to })
    const queuedMine = before.filter((j) => j.taskId === parent.id).length
    const holders: Task[] = []
    for (const id of new Set(before.map((j) => j.taskId).filter((x) => x !== parent.id))) {
      const tk = sc.live.get(id)?.task ?? (await sc.store.get(id))
      if (tk) holders.push(tk)
    }
    // 占着的是别的父对话：告诉它后面有人在等（不叫醒它，执行中就实时送达，空闲就放进收件箱）
    for (const h of holders.filter((x) => !x.parentTaskId))
      await sc.noteParent(
        h.id,
        parent,
        `【编译占位】父对话「${parent.title}」（id ${parent.id}）申请了编译（${note.slice(0, 200)}），排在你占着的编译后面，你的编译跑完它会自动开始。你还要连着编、或者需要它等你的改动时，用 message_peer 告诉它。`,
        undefined,
        undefined,
        undefined,
        await sc.peerOf(parent, 'peer', 'build', `排在你后面等编译：${note}`),
      )
    const who = holders.map((x) => `「${x.title}」`).join('、')
    return {
      ok: true,
      id: ids.at(-1),
      info: [
        `已申请编译（${steps.map((x) => x.name).join('、')}），编号 ${ids.join('、')}。`,
        who
          ? `这个编译目录现在被${who}占着，你排在后面${holders.some((x) => !x.parentTaskId) ? '，已告诉对方' : ''}。`
          : queuedMine
            ? `你前面还有 ${queuedMine} 条自己的编译在排队。`
            : '编译目录空闲，马上开始。',
        to.length
          ? `结果会推回给你，也会直接推给申请的子对话（${to.join('、')}）；等的时候接着处理别的消息，不要另外跑编译。`
          : '结果会推回给你；等的时候接着处理别的消息，不要另外跑编译。',
      ].join(''),
    }
  }

  /** 同一项目里的其他父对话（顶层对话），最近活动的在前 */
  async function peerList(self: Task) {
    return (
      (await sc.store.list())
        // 进了回收站的对话不算同项目里能互相发消息的一条（它在列表里也已经看不到了）
        .filter(
          (x) =>
            x.projectId === self.projectId && !x.parentTaskId && x.id !== self.id && !x.archived && !taskDeleted(x),
        )
        .map((x) => sc.live.get(x.id)?.task ?? x)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 20)
    )
  }

  /**
   * 合并成功（共用目录的子对话是父对话验收通过）：只更新分支状态（「已在「dev」里」）和计划最后一步，不等于这个子对话做完了。
   * 还在一轮里的把结果交给它，等这一轮结束再按 childFlowOf 收口；已经停下的马上试一次，
   * 计划、后台命令、提问还没完就保留独立分支（见 advanceChildTo）。返回收口的结果（还在一轮里时为空）
   */
  async function childMerged(
    childId: string,
    text: string,
    opts: { quiet?: boolean; peer?: PeerFrom } = {},
  ): Promise<{ holds: ChildHold[]; info: string } | undefined> {
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
    if (entry) entry.rev++
    await sc.store.update(tk.id, tk)
    if (entry?.task.working) return undefined
    return sc.advanceChildTo(childId, opts)
  }

  /**
   * finish_child 的唯一入口：每次收尾（合进去、没合进去、早就完成了、还不能收）结束后都强制刷新一次父对话的计划，
   * 并把刷新后的计划附在工具结果里。用户 2026-10-24 定的硬要求：「每次子对话请求收尾，父对话收尾完成都需要刷新一下计划列表」。
   * 以前只有独立分支合进去的那条路改父计划、而且一合进去就把那一步标完成（子对话还没收口也算），
   * 共用目录的子对话收尾完父计划一直挂着等待，父对话的 Agent 也看不到计划变成什么样
   */
  /**
   * 父对话开始就地微改动（shared/inline-edit.ts）：子对话正在合回、要改的文件有子对话在用（共用目录的认领、
   * 独立分支划的范围或已经改了的文件）时拒绝；能开始就记下声明的范围和工作区基线，结束时按它核对真实改动
   */
  async function beginInlineEdit(parent: Task, dir: string, files: string[], reason: string) {
    const kids = (await sc.store.list())
      .filter((x) => x.parentTaskId === parent.id)
      .map((k) => sc.live.get(k.id)?.task ?? k)
    const merging = kids
      .filter((k) => k.wrapRequest && (k.wrapRequest.state === 'merging' || k.wrapRequest.state === 'testing'))
      .map((k) => k.title)
    const want = files.map(normClaimPath).filter(Boolean)
    const held: { path: string; by: string }[] = []
    for (const c of sc.claims.list(parent.id))
      if (c.taskId !== parent.id && want.some((w) => overlaps(c.path, w))) held.push({ path: c.path, by: c.title })
    const declared = sc.scopes.get(parent.id)
    for (const k of kids) {
      if (k.resolved) continue
      const busy = [...(declared?.get(k.id)?.files ?? []), ...k.changes.map((c) => c.path)]
      for (const p of want) if (busy.some((b) => overlaps(b, p))) held.push({ path: p, by: k.title })
    }
    const why = inlineEditBlocker({ files, reason, merging, held, active: !!parent.inlineEdit })
    if (why) return { ok: false, info: why }
    const head = await gitHead(dir)
    const baseline = await gitNumstat(dir, head, placedFiles(parent))
    if (!baseline) return { ok: false, info: '这个目录不是 git 仓库，没法核对就地改动：交给子对话做' }
    parent.inlineEdit = { files, reason, startedAt: new Date().toISOString(), head, baseline }
    return {
      ok: true,
      info: `可以改了：${files.join('、')}。改完跑项目测试步骤里标「快速」的检查，按版本控制的规则本地提交（只提交这几个文件），再调用 end_inline_edit。改动期间不能收尾子对话、不能派子对话。`,
    }
  }

  /** 结束就地微改动：按真实改动核对文件数、行数和没声明的文件，越界写一条醒目警告；没提交的改动列出来 */
  async function endInlineEdit(parent: Task, dir: string) {
    const st = parent.inlineEdit
    if (!st) return { ok: true, info: '没有进行中的就地改动' }
    const changes = (await gitChanges(dir, st.baseline, st.head, placedFiles(parent))) ?? []
    // 清字段写 undefined（见 docs/lessons/data.md）
    parent.inlineEdit = undefined
    const r = inlineEditOverrun(st.files, changes)
    const now = (await gitNumstat(dir, '', placedFiles(parent))) ?? {}
    const uncommitted = changes.map((c) => c.path).filter((p) => p in now && st.baseline[p] !== now[p])
    if (r.over) await sc.panelAlert(parent.id, 'panel', inlineEditOverrunText(r), r.undeclared.join('、') || '')
    return {
      ok: true,
      info: [
        `就地改动结束：改了 ${r.files} 个文件、${r.lines} 行。`,
        uncommitted.length ? `还没提交：${uncommitted.join('、')}——按版本控制的规则提交，或者说明为什么不提交。` : '',
        r.over ? inlineEditOverrunText(r) : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  /**
   * 共用目录的子对话（P4、没有版本管理、项目设成共用目录）收尾：没有分支要合，父对话收下就是验收。
   * 改过文件的和独立分支一样要先请求收尾（submit_merge 里校验了评审、测试和交接），没请求的不收：
   * 以前这里直接标完成，评审、验证、交接全被跳过（用户 2026-10-31 报的 P4 子对话改完不评审）
   */
  async function acceptShared(parent: Task, tk: Task): Promise<{ ok: boolean; info: string }> {
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

  async function finishChild(parent: Task, childId: string): Promise<{ ok: boolean; info: string }> {
    const r = await finishChildStep(parent, childId)
    const plan = await syncParentPlan(parent.id, childId).catch((e) => {
      log.warn('task', '收尾后刷新父对话计划失败', { task: parent.id, error: (e as Error).message })
      sc.alertOn(parent.id, 'panel', t('收尾子对话后刷新计划失败'))(e)
      return ''
    })
    return plan ? { ok: r.ok, info: `${r.info}\n\n${plan}` } : r
  }

  /**
   * 收尾之后把父计划里等这个子对话的那一步对齐到子对话现在的状态，和 reportChild 用同一个判据（childReport）：
   * 已完成标完成，失败、中断退回进行中，其余（合进去了还在收口、没合进去退回给它了）继续等并写清在等什么。
   * 不按上报去重：每次收尾都刷新、都落盘并推给界面。返回给父对话 Agent 看的计划文字（没有计划时为空）
   */
  /** 名下的子对话（计划对齐用，见 plan.ts 的 linkKids）：正在跑的用内存里的最新状态 */
  async function planKids(parentId: string): Promise<PlanKid[]> {
    const kids = (await sc.store.list()).filter((x) => x.parentTaskId === parentId)
    return kids.map((k) => {
      const cur = sc.live.get(k.id)?.task ?? k
      return {
        id: cur.id,
        title: cur.title,
        createdAt: cur.createdAt,
        done: !!cur.resolved,
        endedAt: cur.resolved ? cur.updatedAt : '',
      }
    })
  }

  async function syncParentPlan(parentId: string, childId: string): Promise<string> {
    const pEntry = sc.live.get(parentId)
    const pTask = pEntry?.task ?? (await sc.store.get(parentId))
    if (!pTask) return ''
    const tk = sc.live.get(childId)?.task ?? (await sc.store.get(childId))
    let report: ReturnType<typeof childReport> | undefined
    if (tk?.parentTaskId === parentId) {
      const jobs = sc.background
        .list(childId)
        .filter((j) => j.state === 'queued' || j.state === 'running')
        .map((j) => j.name)
      const project = isolated(tk) ? await sc.deps.projects.get(tk.projectId) : null
      report = childReport(tk, {
        background: jobs,
        more: sc.startQueue.has(childId) || hasHeld(childId),
        unmerged: await sc.childUnmerged(tk, project ?? null),
      })
    }
    const text = refreshChildWait(pTask, { id: childId, title: tk?.title ?? childId }, report)
    // 顺带把计划和名下所有子对话对齐：别的步骤等的子对话早就完成了、或者 Agent 只在备注里写了「等 xxx」也一起收口
    syncKids(pTask, await planKids(parentId))
    // 计划没变也写一次：rev 变了界面才会重取，保证每次收尾后看到的都是最新的计划
    pTask.updatedAt = new Date().toISOString()
    if (pEntry) pEntry.rev++
    await sc.store.update(pTask.id, pTask, { now: true })
    return text
  }

  /**
   * 收尾一个子对话的实际动作（finish_child，见 ADR 0005）：子对话已经请求收尾（submit_merge），
   * 面板按父对话排队把它的分支合回父对话所在的分支（git 操作是确定的，交给面板做，父对话只决定收不收），
   * 合进去后把它计划里的收尾步骤标完成、按 childFlowOf 收口（结束进程、删独立分支和分支、置完成），
   * 父对话计划里等它的那一步由 finishChild 收尾后统一刷新。没合进去（冲突、原目录有挡路的改动）退回给子对话处理，它处理好会再请求。
   * 合并就是验收：没请求收尾（没交验证结果）的不收
   */
  async function finishChildStep(parent: Task, childId: string): Promise<{ ok: boolean; info: string }> {
    const tk = sc.live.get(childId)?.task ?? (await sc.store.get(childId))
    if (!tk || tk.parentTaskId !== parent.id)
      return { ok: false, info: '找不到这个子对话：id 从 list_conversations 取，只能收尾你自己名下的子对话' }
    if (tk.resolved) return { ok: true, info: `子对话「${tk.title}」已经完成了，不用再收尾` }
    if (!isolated(tk)) return acceptShared(parent, tk)
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
    let r: { ok: boolean; info: string }
    try {
      r = await sc.mergeLock(parent.id, async () => sc.integrate(tk, sc.live.get(parent.id)?.task ?? parent))
    } catch (e) {
      r = { ok: false, info: `合并出错：${(e as Error).message}` }
    } finally {
      merging.delete(childId)
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
      return { ok: false, info: `没能合回子对话「${tk.title}」：${r.info}\n已经退回给它处理，它处理好会再请你收尾。` }
    }
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
            ? `这是 UE 项目：编译仍按 ADR 0004 由你调用 request_build 申请（child 写 ${tk.id}），和这批测试共用独占队。`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    }
    const done = await childMerged(
      childId,
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
          ? `这是 UE 项目：改动已经进了你的目录，现在调用 request_build 编译（child 写 ${tk.id}），编译结果面板会转给它。`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  return {
    PLAN_NUDGE_MS,
    beginInlineEdit,
    childRequestBuild,
    endInlineEdit,
    finishChild,
    mergeNudged,
    merging,
    parentRequestBuild,
    peerList,
    planNudged,
    stuckAfterNudge,
    submitMerge,
    wakeTask,
    planKids,
    childMerged,
  }
}
