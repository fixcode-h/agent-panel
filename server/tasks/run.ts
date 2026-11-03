import { withProjectParams } from '../../shared/builtin/core.ts'
import { randomUUID } from 'node:crypto'
import {
  NewTaskInput,
  Task,
  type Agent,
  type Attachment,
  type Project,
  type DeliveryHow,
  type TaskMessage,
} from '../../shared/schema.ts'
import { readGlobalLessons } from '../lessons.ts'
import { loadProjectLessons, projectWithLessons } from '../project-lessons.ts'
import { taskWorkflows } from '../../shared/flow.ts'
import {
  beginRun,
  childActivity,
  childActivityText,
  childLastActivity,
  childWait,
  childWaitText,
  childFacts,
  convState,
  convStateText,
  dropEndNotes,
  endRun,
  trackWait,
  newTask,
  runRunning,
  taskDeleted,
  withAttachments,
  withTaskModel,
} from '../../shared/task.ts'
import { isChatMode, settledTodos, turnRole } from '../../shared/conv-mode.ts'
import { agentRun, defaultCli } from '../../shared/settings.ts'
import { getCli } from '../../shared/clis.ts'
import { expandSlash } from '../slash.ts'
import { childAskInitial } from '../../shared/child-ask.ts'
import { getSettings } from '../settings.ts'
import { detectClis } from '../detect.ts'
import { gitHead, gitNumstat } from '../exec/git.ts'
import { noPushEnv, stalledTurn } from '../exec/runner.ts'
import { deliverWait, forgetNotes, steerTask } from '../exec/steering.ts'
import { runRealTurn } from '../exec/real-turn.ts'
import { type RealContext } from '../exec/real-context.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { dropHeld, hasHeld, holdForNextTurn, markHeld, takeHeld } from '../exec/delivery.ts'
import { resetIdleCountdown } from '../presence.ts'
import type { Live } from './types.ts'
import { placedFiles } from '../attachments.ts'
import { currentBranch, isBigProject } from '../exec/worktree.ts'
import { currentTestSteps, isUeBuildCommand } from '../../shared/test-steps.ts'
import { log } from '../log.ts'
import { sourceHeader } from '../../shared/peer-message.ts'
import { inboxWithFile } from './inbox-file.ts'
import { taskLog } from '../task-log.ts'
import { t } from '../../shared/i18n.ts'
import { markChildWrapUp } from '../../shared/plan.ts'
import { flowLine } from '../../shared/flow-child.ts'
import { statSync } from 'node:fs'
import path from 'node:path'
import {
  childFilesInfo,
  hitList,
  holdTurn,
  holderState,
  normClaimPath,
  ownP4Files,
  releaseUnchanged,
  scopeOverlaps,
} from '../claims.ts'
import { taskCliAlive } from '../exec/process.ts'
import { p4Runner, splitChangelists } from '../p4-split.ts'
import { projectDocRoot } from '../doc-root.ts'
import { cherryPickFor } from '../cherry-pick.ts'
import { TaskBusyError, isolated, parentRunRole, isP4, wrapUpFrom, wrapUpProbe } from './helpers.ts'
import type { TasksScope } from './scope.ts'
import { pauseHelper, pauseUnit } from '../../shared/run-stops.ts'

/**
 * 对话的执行：开始一轮（拼角色、项目、工作流、CLI 上下文，接 Orchestra 和面板工具）、接着说（followUp）、消息交付（插话 / 交给正在跑的 CLI / 排到这一轮结束后）、卡住重开。
 */
/**
 * 这条输入给对话一次新的推进机会（推进次数清零，ADR 0041）：用户亲自发的，或父对话交代的新任务（有新内容）。
 * 其他对话、子对话汇报、面板消息、父对话的状态询问不算：外部输入只改计划，计划变了指纹自然会变
 */
const freshChance = (m: { panel?: unknown; child?: unknown; peer?: { rel: string; kind: string } }) =>
  !m.panel && !m.child && (!m.peer || (m.peer.rel === 'parent' && m.peer.kind === 'task'))

export function createRun(sc: TasksScope) {
  /** 每个子对话已经报给父对话的撞车（路径 + 对方 id），见 checkCollisions */
  const collided = new Map<string, Set<string>>()
  /**
   * 子对话一轮结束：认领不放（共用目录里改动要等父对话验收才算交出去），这一轮真改过的文件记到它名下（见 claims.ts 的 holdTurn）。
   * 已经归别的还没交出去的兄弟的就是撞了：子对话里留一行给用户看，给父对话写信并叫醒（过 holdWake）——能拍板的是父对话。
   * 不叫醒子对话：它这一轮刚结束，开新一轮会清掉它可能刚交的收尾请求，还会在父对话没决定时自己去「修」别人的文件。
   * 走独立分支的子对话各改各的，撞了是合并时的事，不提醒也不汇报父对话
   */
  async function checkCollisions(child: Task) {
    // changes 是累计的：同一处撞车下一轮结束还会再查出来，只报新的，别每轮都叫醒父对话
    const told = collided.get(child.id) ?? collided.set(child.id, new Set()).get(child.id)!
    const hit = holdTurn(sc.claims, child).filter((h) => !told.has(`${h.path}\n${h.byId}`))
    hit.forEach((h) => told.add(`${h.path}\n${h.byId}`))
    if (!hit.length) return
    const list = hitList(hit)
    child.messages.push({
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text: t(
        '这些文件已经归别的子对话、它的改动还没被父对话验收，你这一轮也改了：{list}。同一个目录里后写的会覆盖先写的，已经交给父对话安排先后。',
        { list },
      ),
      tools: [],
      at: new Date().toISOString(),
    })
    await sc.noteParent(
      child.parentTaskId,
      child,
      `【文件撞了】子对话「${child.title}」（id ${child.id}）这一轮改了已经归别的子对话、改动还没被你验收的文件：${list}。` +
        `它们和你共用一个目录，后写的会覆盖先写的（P4 里一个文件也分不进两个 changelist）。验收前先定谁的版本算数：` +
        `用 send_to_conversation 让一方撤回，或等另一方被你验收后再改，必要时自己核对文件内容；不要同时收下两边。`,
      undefined,
      undefined,
      undefined,
      await sc.peerOf(child, 'child', 'report', '和兄弟子对话改了同一批文件'),
      undefined,
      true,
    )
  }

  /**
   * 给父对话新建一个子对话并在后台开始执行：父对话的 create_conversation 和面板替卡住的子对话找人接手
   * （server/tasks/stuck-child.ts）都走这里。agentId 不写用「执行」角色
   */
  async function spawnChild(
    parent: Task,
    project: Project,
    agents: Agent[],
    {
      title,
      message,
      files,
      agentId,
      flow,
    }: { title: string; message: string; files?: string[]; agentId?: string; flow?: Task['flow'] },
  ) {
    const worker = agents.find((a) => a.origin === 'builtin:worker')
    const subId = randomUUID()
    const at = new Date().toISOString()
    const input = NewTaskInput.parse({
      projectId: parent.projectId,
      mode: 'chat',
      parentTaskId: parent.id,
      rootTaskId: parent.rootTaskId || parent.id,
      agentId: agentId || worker?.id || project.defaultAgentId,
      prompt: message,
      // 父对话的「子对话也提问」决定这条新子对话开不开提问
      askUser: childAskInitial(parent),
    })
    // 工作流子对话（ADR 0044）：第一轮由引擎按流程图跑，跑完交给执行角色收尾，所以角色固定用「执行」
    const draft = { ...newTask(input, undefined, at, subId, [], {}), id: subId, ...(flow && { flow }) }
    // 标题只在创建时由父对话的 Agent 分析后给一次，后续追加消息不再改标题；
    // 只有直接调接口没给时才退回用户消息开头
    if (title.trim()) draft.title = title.trim().slice(0, 80)
    // 第一条要求是父对话交代的：子对话里画成「接收消息 · 交代任务」，不当成用户说的话
    if (draft.messages[0]) draft.messages[0].peer = await sc.peerOf(parent, 'parent', 'task', message)
    // 共用目录模式：父对话划好的范围先替它认领，别的子对话改这些文件要等它做完
    // 独立分支模式不认领：两个子对话可以同时改同一个文件，各在自己的 worktree 里改互不影响
    const sharedDir = project.childIsolation !== 'worktree'
    const got =
      sharedDir && files?.length
        ? sc.claims.claim(parent.id, { taskId: subId, title: draft.title }, files)
        : { granted: [], held: [] }
    let both: { path: string; with: string }[] = []
    const round = (files ?? []).map(normClaimPath).filter(Boolean)
    if (round.length && !sharedDir) {
      const mine = sc.scopes.get(parent.id) ?? sc.scopes.set(parent.id, new Map()).get(parent.id)!
      const others: { title: string; files: string[] }[] = []
      for (const [otherId, s] of mine) {
        const other = sc.live.get(otherId)?.task
        if (!other || !isolated(other)) {
          mine.delete(otherId)
          continue
        }
        others.push({ title: s.title, files: s.files })
        // 兄弟没声明范围、但已经改了这些文件：同样算重叠
        others.push({ title: other.title, files: other.changes.map((c) => c.path) })
      }
      both = scopeOverlaps(round, others)
      mine.set(subId, { title: draft.title, files: round })
    }
    const sub = await sc.store.create({ ...draft, id: subId })
    void sc.startChild(sub, message, agents)
    return {
      ok: true,
      id: sub.id,
      title: sub.title,
      info: [
        `已新建子对话「${sub.title}」，它在后台执行，完成后会回报到这里`,
        ...childFilesInfo({
          isolation: sharedDir ? 'claim' : 'worktree',
          granted: got.granted,
          held: got.held,
          both,
        }),
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  /**
   * 工作流子对话把同一个工作流再跑一次（start_workflow 带 again，ADR 0044）：流程图状态改回「起一次新的运行」，
   * 之后照常把消息交给它，它的下一轮从头跑流程图。还在跑的不改，先等它停下或终止；返回空串是改好了
   */
  async function rerunChildFlow(parentId: string, id: string, input: string) {
    const cur = sc.live.get(id.trim())?.task ?? (await sc.store.get(id.trim()))
    if (!cur || cur.parentTaskId !== parentId) return `找不到你名下的子对话 ${id}`
    if (!cur.flow) return `子对话「${cur.title}」不是工作流子对话：要它接着做用 send_to_conversation`
    if (cur.working || runRunning(cur))
      return `工作流子对话「${cur.title}」还在跑：等它停下，或者先用 stop_workflow 终止再重跑`
    const flow = { ...cur.flow, input, run: 0, handed: false, cancelled: undefined }
    cur.flow = flow
    if (!sc.live.has(cur.id)) await sc.store.update(cur.id, { ...cur, flow })
    return ''
  }

  /** 面板自己替父对话新建子对话（不经父对话的那一轮）：按父对话所在项目和现在的角色列表来 */
  async function spawnChildOf(parentId: string, input: { title: string; message: string; agentId?: string }) {
    const parent = sc.live.get(parentId)?.task ?? (await sc.store.get(parentId))
    if (!parent || taskDeleted(parent)) return { ok: false, info: '找不到父对话' }
    const project = parent.projectId ? await sc.deps.projects.get(parent.projectId) : null
    if (!project) return { ok: false, info: '独立聊天没有项目，不能创建子对话' }
    const agents = withProjectParams(await sc.deps.agents.list(), project)
    // 点名的角色停用、删掉了：退回「执行」
    const agentId = agents.some((a) => a.id === input.agentId && a.enabled) ? input.agentId : undefined
    return spawnChild(parent, project, agents, { ...input, agentId })
  }

  async function start(
    entry: Live,
    prompt: string,
    first: boolean,
    agents: Agent[],
    op?: RealContext['op'],
    resume = false,
    prewarm = false,
  ) {
    const task = entry.task
    const before = task.status
    // 开了新的一轮：上次的停止不再挡自驱（见 drive.ts 的 noteStop）
    if (!prewarm) sc.clearStop(task.id)
    taskLog(task.id, prewarm ? '启动（预热）' : resume ? '启动（继续执行）' : first ? '启动（新对话）' : '启动', {
      from: before,
      op: op || undefined,
      prompt: prewarm ? undefined : prompt.trim().slice(0, 80),
    })
    const beforeUpdatedAt = task.updatedAt
    const beforeTurnDoneAt = task.turnDoneAt ?? ''
    // 先标成执行中，接口返回时页面就能开始轮询
    entry.task.status = 'running'
    // working 只表示 CLI 真的在处理这一轮；预热和等下一句时页面按空闲显示
    entry.task.working = !prewarm
    entry.task.awaitingUser = false
    entry.task.prewarming = prewarm
    // 对话新的一轮从 0 开始显示速度，接口返回时页面不会还停在上一轮的数字上
    const active = entry.task.mode === 'chat' ? entry.task.usage.agents[entry.task.agentId] : undefined
    if (active) {
      active.tps = 0
      active.lastTps = 0
    }
    beginRun(entry.task)
    const [settings, found] = await Promise.all([
      getSettings(),
      task.projectId ? sc.deps.projects.get(task.projectId) : sc.chatWorkspace(task.id),
    ]).catch((e) => {
      sc.release(entry)
      throw e
    })
    // 项目里给必备角色填的参数当作这个项目里的默认值（对话、节点、派出去的子 Agent 都按它）
    agents = withProjectParams(agents, found ?? undefined)
    if (task.projectId) await sc.ensureChildWorktree(entry, found)
    // 独立分支的工作区被回收后又继续（父对话交给子对话、面板重启后续接）：先建回来，再按新目录执行
    const restoreErr = !prewarm && found ? await sc.restoreWorktree(entry.task, found) : ''
    // 独立分支执行时，Agent 在任务自己的工作目录里改，不碰项目目录；
    // 子对话不建独立分支，和父对话用同一个目录（父对话在独立分支里时就是父的那个目录）
    const dir = found ? await sc.taskDir(task).catch(() => found.path) : ''
    // 真正拼进提示词的是 runner 里的 ctx.project.lessons（见 server/exec/runner.ts 的 lessonsPrompt 调用）：
    // 必须在这里挂上「文件 + 旧 JSON」的合并结果，否则写文件后项目 JSON 被清空，新会话的教训段会整段消失
    let project = found
    if (found && task.projectId) {
      const withLessons = await projectWithLessons(found, agents)
      project = dir && dir !== found.path ? { ...withLessons, path: dir } : withLessons
    } else if (found && dir && dir !== found.path) project = { ...found, path: dir }
    const parentTask = task.parentTaskId
      ? (sc.live.get(task.parentTaskId)?.task ?? (await sc.store.get(task.parentTaskId)) ?? undefined)
      : undefined
    // 全局规则、目标存在谁身上：顶层对话是自己，子对话是父对话。父对话在执行位上时那份最新（落盘的可能还没写），
    // 不在时取存储里已有的内存副本（/rule、改目标都会写回存储），都没有才用这一轮开始时读的
    const ruleOwner = () =>
      task.parentTaskId
        ? (sc.live.get(task.parentTaskId)?.task ?? sc.store.known(task.parentTaskId) ?? parentTask)
        : entry.task
    const rootId = task.parentTaskId || task.id
    // 父对话在对话设置里给子对话定了 CLI / 模型 / 思考强度：子对话的角色按它跑。
    // 换了 CLI 时角色原来的模型、强度是另一个 CLI 的，没另外指定就用新 CLI 的默认
    const childRun = parentTask?.childRun
    if (childRun && (childRun.cli || childRun.model || childRun.effort))
      agents = agents.map((a) => {
        if (a.id !== task.agentId) return a
        const cli = childRun.cli || a.cli
        const same = cli === a.cli
        return {
          ...a,
          cli,
          model: childRun.model || (same ? a.model : ''),
          effort: childRun.effort || (same ? a.effort : ''),
        }
      })
    // 这一轮启动时的选择，用来判断执行中用户有没有换 CLI/模型/强度。
    // 不用 Agent 角色的对话（agentId 为空）按默认 Agent 的配置算，CLI、模型取任务里选的那一套
    // Chat 页选的角色被删了也按内置助手的配置算（和 runner 的 turnRole 同一个口径）
    const startAgent = turnRole(task, agents, task.agentId)
    const startedRun = startAgent ? agentRun(withTaskModel(startAgent, task), settings) : undefined
    // 项目里用分派角色（主理）的顶层对话就是父对话：分诊、派单，只做护栏内的就地微改动
    const coordinatorRole = !task.parentTaskId && !!task.projectId && !!startAgent?.canDelegate
    // UE 项目（目录里有 .uproject）的编译归父对话：子对话申请，父对话按申请占位编译
    const ueProject = task.mode === 'chat' && !!found?.path && (await isBigProject(found.path).catch(() => false))
    const ueRole = !ueProject ? undefined : task.parentTaskId ? 'child' : coordinatorRole ? 'parent' : undefined
    let last = 0
    /**
     * 落盘。now：对话消息立即写，不等 400ms 合并窗口——关键节点（changed(true)、这一轮结束/失败/停止）
     * 用它，面板被强杀时不会丢最后一段。keepUpdatedAt：预热收尾要保留原来的列表时间
     */
    /** 这一轮已经报过写盘失败：磁盘满时每次落盘都会失败，只在对话里报一次，恢复后再失败再报 */
    let saveErrorShown = false
    const flush = (keepUpdatedAt = false, now = false) =>
      // 已被面板放弃的执行（见 keepalive.ts 的 abandonLive）：状态已经按停止落过盘，新的一轮可能已经开了，不再写旧快照
      (entry.orphaned ? Promise.resolve() : sc.store.update(task.id, entry.task, { keepUpdatedAt, now })).then(
        () => {
          saveErrorShown = false
        },
        (e) => {
          log.error('task', '保存任务失败', { task: task.id, error: (e as Error).message })
          if (saveErrorShown) return
          saveErrorShown = true
          // 写盘失败只写日志的话，对话在内存里照常跑，重启后这段全丢而用户毫不知情：在对话里如实报出来
          entry.task.messages.push({
            id: randomUUID(),
            role: 'system',
            agentId: '',
            step: '',
            text: t('保存对话失败，这之后的内容重启面板后可能丢失：{error}', { error: (e as Error).message }),
            tools: [],
            error: true,
            alert: makeAlert('error', (e as Error).stack ?? (e as Error).message, 'panel'),
            at: new Date().toISOString(),
          })
          entry.rev++
        },
      )
    const changed = (f?: boolean) => {
      entry.task.updatedAt = new Date().toISOString()
      trackWait(entry.task)
      entry.rev++
      // 对话的 CLI 回复完会常驻等下一句，不等进程结束：第一次回复完就起标题
      if (entry.task.turnDoneAt) sc.nameOnce(entry.task, startedRun?.cli ?? '')
      // 流式输出时最多每 3 秒落盘一次，关键节点（节点开始/结束、调用完成、提问、等用户决定、这一轮收尾）
      // 都走 changed(true) 立即落盘（消息文件也不走合并窗口），所以节流只影响正在输出途中的中间态。
      // 从 1 秒放宽到 3 秒：指纹已经是增量的（见 task-store 的 createStampTracker），
      // 但整份 messages 的序列化还是 O(全部消息)，3 秒一次把这个成本降下来，
      // 代价是面板被强杀时最多丢 3 秒的流式输出（正常结束、失败、停止都还会立即写一次）。
      if (f || Date.now() - last > 3000) {
        last = Date.now()
        void flush(false, f === true)
      }
    }
    log.info('task', first ? '开始执行任务' : '继续执行任务', {
      task: task.id,
      title: task.title,
      project: found?.name,
      workflow: task.workflowId,
    })
    const allWorkflows = await sc.deps.workflows.list()
    // 项目对话的子对话默认用项目的工作流；独立聊天没有项目工作流
    const defaultWf = project?.id ? ((await sc.projectWorkflow(project)) ?? undefined) : undefined
    const run = (async () => {
      // 项目被删掉后任务还在，这时没有目录可以执行
      if (!project) throw new Error(t('任务所属的项目已经不存在'))
      // 工作区建不回来就别再跑下去了：runRealTurn 里只会报「项目目录不存在」，用户不知道该怎么办
      if (restoreErr) throw new Error(restoreErr)
      if (first) entry.task.baseRef = await gitHead(project.path).catch(() => '')
      const snapshot = await gitNumstat(project.path, entry.task.baseRef, placedFiles(entry.task)).catch(() => null)
      if (first) entry.task.baseline = snapshot ?? {}
      // 收尾要的工作区探测只做一次；收尾种类本身按现在的推送授权现算（见下面的 wrapUp getter）
      const wrapProbe = await wrapUpProbe(entry.task, project.path, project.gitPolicy)
      await runRealTurn({
        task: entry.task,
        agents,
        // 用任务创建时存下的工作流：之后改了、删了工作流都不影响这个任务
        ...taskWorkflows(entry.task, allWorkflows),
        project,
        settings,
        clis: await detectClis(),
        prompt,
        signal: entry.abort.signal,
        // 停下这一轮的原因：engine 收尾时按它决定写「已暂停」还是写清是谁结束的（见 StopReason）
        stopReason: () => entry.stopReason,
        // 开始保活（CLI 停在等下一句）时把回收计时从现在起算满一整段
        onKeepAlive: (taskId) => {
          // 执行期间计时器被 busy 挡回去过，不重置会提前收掉刚空下来的会话
          resetIdleCountdown(taskId)
        },
        changed,
        newId: randomUUID,
        // 子对话这一轮真结束的地方收口父对话计划里等它的步骤（进程保活等下一句时 run 不返回，等不到收尾）
        // 顶层对话：计划没做完、也没在等结果就收尾时，面板推它接着做；动了手却没列计划，推它先列计划（见 nudgePlan）。
        // 判断做完没有只看计划，不看回复里的字眼（用户 2026-11-02 定）。Chat 页没动手的那一轮不推
        // 每一轮结束都按整棵对话树核一次用量上限（见 tasks/budget.ts）：到了上限就停下，也不再推它接着做
        onTurnEnd: task.parentTaskId
          ? (turn) => {
              sc.settleChildTurn(entry.task, turn)
              void sc.checkBudget(entry.task)
            }
          : (turn) =>
              void sc.checkBudget(entry.task).then((over) => {
                if (over || task.mode !== 'chat') return
                // Chat 页只回答了一句、没动手的那一轮不推；项目里的对话按计划推（计划没做完、或动了手却没列计划，见 nudgePlan）
                if (turn.tools <= 0 && isChatMode(entry.task)) return
                return sc
                  .nudgePlan(entry.task, turn)
                  .catch((e) =>
                    log.warn('task', '推对话接着做计划失败', { task: task.id, error: (e as Error).message }),
                  )
              }),
        isGit: snapshot !== null,
        op,
        resume,
        prewarm,
        prewarmFrom: before,
        prewarmTurnDoneAt: beforeTurnDoneAt,
        workflowCatalog: () => (defaultWf ? sc.workflowCatalog(project, allWorkflows, defaultWf) : []),
        resolveWorkflow: (id) => (project?.id ? sc.planWorkflow(project, allWorkflows, defaultWf, id) : undefined),
        // 全局规则和目标：父对话自己的，子对话用父对话的。写成 getter 每次拼提示时现取：CLI 保活时下一条消息
        // 由 engine 的 nextPrompt 按当前状态重拼，取一次的快照会让保活期间新发的规则、改的目标一直进不来
        //（实时推送只送给正在执行的子对话，停在等下一句的收不到）
        get rules() {
          return (ruleOwner()?.rules ?? []).map((r) => r.text)
        },
        get goal() {
          return ruleOwner()?.goal || ''
        },
        takeInbox: task.parentTaskId
          ? undefined
          : () => {
              const got = entry.task.inbox
              entry.task.inbox = []
              return got.map((m) => inboxWithFile(task.id, m))
            },
        messageParent: task.parentTaskId
          ? (text, question, options, kind, fix) => sc.messageParent(entry.task, text, question, options, kind, fix)
          : undefined,
        // 子对话点名「禁止子对话执行」的角色时，把它转交父对话创建（见 ADR 0019）
        forwardSpawn: task.parentTaskId ? (spec) => sc.forwardSpawn(entry.task, spec) : undefined,
        // 父对话排着的转交请求：每轮建 Orchestra 时直接派，不依赖 AI 自己想起来调 spawn_agents
        onOrchestra: (orch) => sc.attachOrchestra(task.id, orch),
        childIsolation: found?.childIsolation,
        worktreeHome: isolated(entry.task) && found ? await sc.worktreeHome(entry.task, found) : undefined,
        // getter：保活中用户在推送授权卡上点了「允许」，下一条消息的提示词和计划就带上推送收尾
        //（取一次的快照要等下次重开进程才看得到，见 docs/lessons/prompts.md「拼的时候读现值」）
        get wrapUp() {
          return wrapUpFrom(entry.task, wrapProbe, project?.gitPolicy)
        },
        // P4 项目里的对话和节点都能用：分 changelist 由面板照类型执行，不靠 Agent 自己记得分（见 p4-split.ts）
        p4Split:
          dir && project?.path && (await isP4(project.path))
            ? async (input) => {
                // 项目外的文档根里的文件不分（见 shared/doc-root.ts）：分之前现算，项目设置改了下一次就按新的
                const docs = await projectDocRoot(project.path, agents, 'p4')
                // 共用目录的子对话和兄弟在同一个 workspace、同一个 default changelist：没写 files 时只分它名下的认领和改过的文件，
                // 否则会把兄弟打开的文件一起分进它的 changelist
                const isDir = (p: string) => !!statSync(path.join(dir, p), { throwIfNoEntry: false })?.isDirectory()
                const own = input.files?.length ? [] : ownP4Files(sc.claims, entry.task, isDir)
                const opts = docs?.outside ? { skipUnder: docs.root } : {}
                return splitChangelists(p4Runner(dir), own.length ? { ...input, files: own } : input, opts)
              }
            : undefined,
        // 项目设了 cherry-pick 目标的顶层对话：由面板核对后搬，只收这个对话自己的提交 / 改动（用户 2026-10-31 定的强制要求）
        cherryPick:
          !task.parentTaskId && dir && project?.path && project.cherryPick?.trim()
            ? await cherryPickFor(dir, project.path, project.cherryPick.trim(), () => entry.task)
            : undefined,
        // 不管用哪种版本管理，子对话都要请父对话收尾：评审、测试、交接和父对话验收挂在这一步上（独立分支还要合回）
        submitMerge:
          task.parentTaskId && task.projectId
            ? (note, tests, build, handoff, triage, override) =>
                sc.submitMerge(task.id, note, tests, ueRole === 'child' && build !== false, handoff, triage, override)
            : undefined,
        isolated: !!task.parentTaskId && isolated(entry.task),
        ueBuild:
          ueRole === 'child'
            ? { role: 'child', request: (note) => sc.childRequestBuild(entry.task, note) }
            : ueRole === 'parent' && found
              ? { role: 'parent', request: (note, kids) => sc.parentRequestBuild(entry.task, found, note, kids) }
              : undefined,
        // 顶层项目对话收尾名下的子对话：子对话 submit_merge 请求后由它合回、标完成、删分支（ADR 0005）
        finishChild: !task.parentTaskId && task.projectId ? (id) => sc.finishChild(entry.task, id) : undefined,
        // 父对话之间：看同一项目里的其他父对话、给它们传话（编译占位时的协调就靠它）
        peers: coordinatorRole
          ? async () =>
              (await sc.peerList(entry.task)).map((p) => ({
                id: p.id,
                title: p.title,
                status: p.status,
                busy: !!p.working,
                building: sc.background
                  .list(p.id)
                  .filter((j) => j.exclusive && !j.endedAt)
                  .map((j) => `${j.name}（${j.state === 'running' ? '正在跑' : '排队中'}）`)
                  .join('、'),
              }))
          : undefined,
        messagePeer: coordinatorRole
          ? async (id, text) => {
              const peer = (await sc.peerList(entry.task)).find((p) => p.id === id)
              if (!peer) return { ok: false, info: '找不到这个父对话：id 从 list_peers 取，只能联系同一项目里的父对话' }
              await sc.wakeTask(
                peer.id,
                entry.task,
                `【父对话传话】来自「${entry.task.title}」（id ${entry.task.id}）：${text}\n要回话就用 message_peer 回给它；只协调，不用替它做决定。`,
                { peer: await sc.peerOf(entry.task, 'peer', 'chat', text) },
              )
              return { ok: true, info: `已交给父对话「${peer.title}」` }
            }
          : undefined,
        // 只有项目里的对话有：工作流的测试验收节点照常按快照里的完整步骤跑
        verify:
          task.mode === 'chat' && found?.id
            ? {
                // 按项目当前步骤拼这一轮的提示词（一次取一次，这一轮不再重读）；项目读不到才用任务快照
                steps: currentTestSteps(task.testSteps, found),
                platform: process.platform,
                wslDistro: found.wslDistro,
                scaled: found.scaledVerify,
                // 这次任务实际改了哪些文件：服务端算好「本轮该跑哪几条 + 命令」再交给模型，不靠它自己筛。
                // getter 现取：runner 在这一轮里会刷新 task.changes，保活的下一条消息要按新的改动清单算
                get changedFiles() {
                  return entry.task.changes.map((c) => c.path)
                },
                ...(await parentRunRole(entry.task, found)),
              }
            : undefined,
        // 父对话（主理）就地微改动：角色开了才有，护栏在 beginInlineEdit / endInlineEdit（shared/inline-edit.ts）
        inlineEdit:
          coordinatorRole && startAgent?.inlineEdit === 'tiny' && dir
            ? {
                begin: (files, reason) => sc.beginInlineEdit(entry.task, dir, files, reason),
                end: () => sc.endInlineEdit(entry.task, dir),
              }
            : undefined,
        // 父对话（主理）不开独立分支（靠角色说明约束，不关它的工具）：就在项目目录的当前分支上，子对话从这里开、合回这里
        beginEdit:
          task.mode === 'chat' && !coordinatorRole && entry.task.wantsWorktree && !isolated(entry.task)
            ? () => sc.beginEdit(entry, changed)
            : undefined,
        branch: coordinatorRole && dir ? await currentBranch(dir).catch(() => '') : undefined,
        // 这一轮的 CLI 自带待办会不会被面板显示：Chat 模式的提示词据此决定怎么说计划（CLI 定义的 todos）
        cliTodos: !!startedRun && !!getCli(startedRun.cli)?.todos,
        // 只给对话用：工作流节点一跑完就结束，结果没有地方推回
        runBackground:
          task.mode === 'chat' && dir
            ? async (input) => {
                // UE 的编译归父对话：子对话交来的编译命令不跑，父对话也走 request_build 占位，不从这里绕过排队
                if (ueRole && isUeBuildCommand(input.command))
                  return {
                    ok: false,
                    info:
                      ueRole === 'child'
                        ? 'UE 项目里子对话不编译：改完向父对话申请（独立分支里用 submit_merge 并保持 build 为 true，否则用 request_build）。'
                        : 'UE 编译要用 request_build 申请：面板按编译目录占位排队，不从后台命令直接跑。',
                  }
                return sc.background.start({
                  ...input,
                  taskId: task.id,
                  root: dir,
                  env: noPushEnv(entry.task, project?.gitPolicy),
                })
              }
            : undefined,
        checkBackground: (id) => sc.background.check(task.id, id),
        stopBackground: (id) => sc.background.stopOne(task.id, id),
        // 独立分支里的子对话改不到别人的文件，不用认领；要改时才开分支的也一样
        claimFiles:
          task.parentTaskId && !isolated(entry.task) && !entry.task.wantsWorktree
            ? (paths) => {
                const r = sc.claims.claim(rootId, { taskId: task.id, title: entry.task.title }, paths)
                // 被拒时写明对方现在怎样：停下等验收的要找父对话协调，不是「过一会儿再认领」
                const held = r.held.map((h) => ({ ...h, state: holderState(sc.live.get(h.byId)?.task) }))
                return { ...r, held }
              }
            : undefined,
        // 项目教训：每次查都读最新的（别的对话刚记的也能看到）；文件里的新教训和旧项目 JSON 合并后交给 Agent
        lessons: task.projectId
          ? {
              list: async () => {
                const p = await sc.deps.projects.get(task.projectId)
                return p ? (await loadProjectLessons(p, agents)).lessons : []
              },
              globals: readGlobalLessons,
              record: async (input) =>
                sc.deps.recordLesson
                  ? sc.deps.recordLesson(task.projectId, { ...input, source: 'agent', taskId: task.id })
                  : { ok: false, info: '这里记不了项目教训' },
            }
          : undefined,
        releaseFiles:
          task.parentTaskId && !isolated(entry.task) && !entry.task.wantsWorktree
            ? (paths) => releaseUnchanged(sc.claims, entry.task, paths)
            : undefined,
        listConversations: async () => {
          const kids = (await sc.store.list()).filter((x) => x.parentTaskId === entry.task.id)
          // 正在跑的对话用内存里的最新状态（标题只在创建时定，摘要随每一轮更新）
          return kids.map((k) => {
            const cur = sc.live.get(k.id)?.task ?? k
            // 在做什么、在等什么、多久没新输出：父对话问「是不是卡住了」时不用再去猜
            // 不在内存里的子对话只有摘要（store.list 只留用户消息），算不出准确的「在做什么」
            const doing = sc.live.has(k.id) ? childActivity(cur) : undefined
            return {
              id: cur.id,
              title: cur.title,
              // 状态用对话的 8 个状态说（见 ConvState），和子对话栏、状态上报是同一个结论
              status: convStateText(convState(childFacts(cur, { background: sc.pendingJobs(cur.id) }))),
              state: convState(childFacts(cur, { background: sc.pendingJobs(cur.id) })),
              // 收尾中也算忙：只看 working 时父对话会把收尾中的子对话当成空闲、反复重发
              busy: cur.working || sc.startQueue.has(cur.id) || sc.completing.has(cur.id),
              // 已完成的报关键文件：父对话按它判断新问题该交给谁，比最后一句回复准
              summary:
                cur.resolved && cur.handoff?.files
                  ? `关键文件：${cur.handoff.files.replace(/\s+/g, ' ')}`
                  : cur.summary || sc.lastReply(cur),
              at: cur.updatedAt,
              doing: childActivityText(doing),
              waiting: childWaitText(
                childWait(cur, { background: sc.pendingJobs(cur.id), cliAlive: taskCliAlive(cur.id) }),
              ),
              lastActivityAt: childLastActivity(cur),
              flow: flowLine(cur) || undefined,
              // 面板自动问过状态、还没回复：父对话不用再问一遍，也不用猜它有没有被叫过
              autoAsk: cur.autoAsk,
              createdAt: cur.createdAt,
              resolved: !!cur.resolved,
            }
          })
        },
        createConversation: async ({ title, message, files, agentId, flow }) => {
          if (!project?.id) return { ok: false, info: '独立聊天没有项目，不能创建子对话' }
          return spawnChild(entry.task, project, agents, { title, message, files, agentId, flow })
        },
        sendToConversation: async (id, message, opts) => {
          // 同一个工作流再跑一次（start_workflow 带 again）：先把子对话的流程图状态改回「起一次新的运行」
          if (opts?.rerun) {
            const bad = await rerunChildFlow(entry.task.id, id, message)
            if (bad) return { ok: false, info: bad }
          }
          // 父对话交给已有子对话：子对话里画成「接收消息 · 交代任务」，不当成用户说的话
          const r = await sc.sendToChild(entry.task.id, id, message, undefined, 'task')
          // 交给子对话就算回答了它的提问：父对话里的提问卡片收起
          if (r.ok && sc.settleAsks(entry.task, id, message, 'parent')) entry.rev++
          return r
        },
      })
    })()
    const settled = run
      .catch((e) => {
        log.error('task', '任务执行出错', { task: task.id, error: e })
        taskLog(task.id, '执行出错', { error: e as Error })
        // 预热失败不打扰对话：恢复原来的状态，等用户发消息时再按正常流程报错
        if (prewarm) {
          entry.task.status = before
          return
        }
        entry.task.status = 'failed'
        // 还画成在跑的节点、子任务一起收口：不然它们一直转圈、没有输出，终止按钮又说已经结束了
        // 子任务中断并暂停（继续执行时在原记录里接着跑，ADR 0042），工作流节点记失败
        const at = new Date().toISOString()
        for (const s of entry.task.steps)
          if (s.status !== 'running') continue
          else if (pauseHelper(task.id, s)) pauseUnit(s)
          else [s.status, s.endedAt] = ['failed', at]
        entry.task.messages.push({
          id: randomUUID(),
          role: 'system',
          agentId: '',
          step: '',
          text: t('执行出错：{error}', { error: (e as Error).message }),
          tools: [],
          error: true,
          alert: makeAlert('error', (e as Error).stack ?? (e as Error).message, 'panel'),
          at: new Date().toISOString(),
        })
      })
      .finally(async () => {
        // 面板已经放弃了这份执行（杀了进程、落了停止、让出了执行位）：后面的收尾都已经做过，再做会盖掉新的一轮
        if (entry.orphaned) {
          taskLog(task.id, '已放弃的执行这时才收完，不再收尾', { status: entry.task.status })
          return
        }
        log.info('task', `任务结束：${entry.task.status}`, { task: task.id })
        taskLog(task.id, '执行结束', {
          status: entry.task.status,
          stopReason: entry.stop ? entry.stopReason : undefined,
          restart: entry.restart || undefined,
          held: hasHeld(task.id) || undefined,
        })
        entry.task.working = false
        entry.task.awaitingUser = false
        entry.task.prewarming = false
        // 排队等 API 名额的标记在 runner 里拿到或停止时就去掉；这里兜底，免得停下的对话还显示在排队
        // 写 undefined、不用 delete：落盘按字段合并，delete 掉的字段在盘上还留着，停止时排队标记已经落过盘就清不掉
        entry.task.apiWait = undefined
        for (const s of entry.task.steps) s.apiWait = undefined
        // 预热收尾要把原来的列表时间写回去，不能让它变成现在
        let keepTime = false
        // 预热只是把 CLI 启动好，没有处理新消息就退出时不要算完成，也不要把列表时间改成现在
        if (prewarm && (entry.task.turnDoneAt ?? '') === beforeTurnDoneAt) {
          // 引擎这时不会标完成，任务还停在 running；状态和时间都回到打开前
          if (entry.task.status === 'done' || entry.task.status === 'running') entry.task.status = before
          entry.task.updatedAt = beforeUpdatedAt
          // 引擎收尾没有走 changed，这里补一次推送
          entry.rev++
          keepTime = true
        }
        // 工作流跑完一整轮才算完成；对话在 CLI 回复完时已经记了 turnDoneAt
        if (!prewarm && entry.task.mode !== 'chat' && entry.task.status === 'done')
          entry.task.turnDoneAt = new Date().toISOString()
        // 执行中用户换了 CLI/模型/强度：旧进程的命令和上下文不能留给新的选择
        const nowRun =
          !prewarm && entry.task.mode === 'chat' && startAgent
            ? agentRun(withTaskModel(startAgent, entry.task), settings)
            : undefined
        const switchedRun =
          !!startedRun &&
          !!nowRun &&
          (startedRun.cli !== nowRun.cli || startedRun.model !== nowRun.model || startedRun.effort !== nowRun.effort)
        if (switchedRun) {
          entry.task.command = []
          delete entry.task.usage.agents[entry.task.agentId]
        }
        endRun(entry.task)
        // 工作流跑完（成功或失败）才有结果可看，这时起标题
        if (!prewarm) sc.nameOnce(entry.task, startedRun?.cli ?? '')
        // 子对话这一轮结束：认领不放、改过的文件记到它名下，撞了交给父对话（见 checkCollisions）。预热的一轮什么都不动
        if (entry.task.parentTaskId && !prewarm) await checkCollisions(entry.task).catch(() => {})
        // 更新摘要并回报父对话（父对话卡片和消息流据此显示进度）
        if (!prewarm && entry.task.parentTaskId) {
          entry.task.summary = sc.lastReply(entry.task)
          // 这一轮结束：消息立即落盘，不等合并窗口（进程保活等下一句时这可能是最后一次写）
          await flush(keepTime, true)
          await sc.reportToParent(entry.task)
        } else await flush(keepTime, true)
        // 只删自己的执行位：这一轮收尾时如果已经有新的一轮占住了，不能把它删掉
        sc.release(entry)
        // 整轮结束了，没被节点取走的补充不会再有人取
        forgetNotes(task.id)
        // 这一轮顺利完成：执行中收不下的消息，马上开始新一轮接着处理；失败或暂停时消息留在对话里等用户决定
        // 收尾停掉的（父对话 finish_child、用户点解决：stopReason finish）不是出错：收尾时交来的新任务照样接着处理
        const endedOk = entry.task.status === 'done' || (entry.stop && entry.stopReason === 'finish')
        if (endedOk && hasHeld(task.id) && !sc.shuttingDown) {
          // 这一轮跑着的时候对话被删了（进了回收站或彻底删掉）：排着的消息没有对话可接，直接丢掉，不当成故障报
          const cur = await sc.store.peek(task.id)
          if (!cur || taskDeleted(cur)) dropHeld(task.id)
          else {
            const next = followUp(task.id).catch((e) => {
              // 并发进来的另一条已经开了新的一轮：排着的这条由那一轮接着处理，不是故障
              if (e instanceof TaskBusyError) return
              log.error('task', '接着处理执行中收到的消息失败', { task: task.id, error: (e as Error).message })
              sc.alertOn(task.id, 'delivery', t('收尾后没能接着处理排着的消息'))(e)
            })
            // 正在收尾（completeChild 在等这一份执行收完）：followUp 要先等收尾结束，收尾又在等这里结束，
            // 在这里 await 就互相等死——子对话永远停在「收尾那一刻」，父对话交代的任务也永远开不起来。
            // 这时不等，让这一份执行先收完，收尾结束后 followUp 再开新一轮
            if (!sc.completing.has(task.id)) await next
          }
        } else if (!endedOk) {
          // 这一轮没能正常结束（失败、被停止）：排着的消息不会再被自动处理了。
          // 在对话里把它们改成「没送出去」，用户才知道要重新发一次，而不是一直等着
          const lost = dropHeld(task.id)
          if (lost.length) {
            markHeld(entry.task.messages, lost, 'lost')
            await sc.store
              .update(task.id, entry.task)
              .catch((e) => log.warn('task', '标记没送出去的消息失败', { task: task.id, error: (e as Error).message }))
          }
        }
        // 没在等下一轮时按新的选择直接预热，下一条消息不会再交给旧 CLI；
        // PATCH 自己负责的重启不要在这里重复做
        if (switchedRun && !entry.restart && entry.task.status === 'done' && !hasHeld(task.id) && !sc.shuttingDown)
          void sc
            .prewarmChat(entry.task, true)
            .catch((e) => console.error(`按新的选择预热失败：${(e as Error).message}`))
      })
    // 面板放弃这份执行时 done 马上结束：等它的人不用陪着卡住的引擎一直等（见 keepalive.ts 的 abandonLive）
    entry.done = entry.abandoned ? Promise.race([settled, entry.abandoned]) : settled
    return entry.task
  }

  /**
   * 工作流里输入的「/命令」：节点和追加要求都用默认 CLI，按它把命令、Skill 展开成普通的要求。
   * 没有展开（不是命令、找不到）时返回空
   */
  async function expandForWorkflow(tk: Pick<Task, 'mode' | 'worktree' | 'projectId' | 'id'>, text: string) {
    if (tk.mode !== 'workflow' || !text.trim().startsWith('/')) return ''
    const out = await expandSlash(text, defaultCli(await getSettings()), await sc.taskDir(tk), false).catch(() => text)
    return out === text ? '' : out
  }

  /**
   * 发一条追加要求。msg 为空时取这一轮结束后要接着处理的那条（CLI 执行中收不下的消息）。
   * recorded：这条消息已经在对话里了（执行中收到时就记下了），不要再加一条。
   * placed：附件已经拷进任务目录的那一份（只给 CLI）；记进对话的永远是 msg.attachments 里的原路径。
   */
  async function followUp(
    id: string,
    msg?: {
      text: string
      attachments: Attachment[]
      placed?: Attachment[]
      recorded?: boolean
      panel?: TaskMessage['panel']
      /** 子对话状态上报、收尾请求：是哪个子对话、什么状态（见 TaskMessage.child） */
      child?: TaskMessage['child']
      /** 另一个对话发来的：界面画成「接收消息」（见 TaskMessage.peer） */
      peer?: TaskMessage['peer']
      /** 交给 CLI 的内容和对话里显示的不一样时（例如重启卡住的 CLI 时补上没被处理的那条）：交给 CLI 的这份 */
      prompt?: string
      /** 这条消息是怎么交给 CLI 的：新记一条时直接写上去，界面据此说「排到下一轮」这类事实（见 DeliveryHow） */
      delivery?: DeliveryHow
      /**
       * 页面生成的 id：点发送时它已经在本地按这个 id 插了一条「待认领」的消息，
       * 这里沿用它，推送和响应到达时按 id 换成真实的一份，不会出现两条
       */
      messageId?: string
      /** 停下时独立分支里还有没提交的改动（见 stopWorktreeNote）：父对话里那一行直接写几个文件、目录在哪 */
      worktree?: TaskMessage['worktree']
      /** 面板在父对话里自动画出的子对话总结卡（见 TaskMessage.summaryCards） */
      summaryCards?: TaskMessage['summaryCards']
    },
  ) {
    // 上一次收尾还在删独立分支的目录：等它结束再继续，不然它会在重建之后把新目录和同名分支删掉
    await sc.completing.get(id)?.catch(() => {})
    const task = await sc.store.get(id)
    // 进了回收站的对话当不存在：别的对话（message_peer）或后台结果不能再把它拉起来跑一轮
    if (!task || taskDeleted(task)) throw new Error('任务不存在')
    const got = sc.reserve(task)
    // 已经有了执行位：并发进来的两条消息只能有一条启动，另一条交给路由按 409 处理
    if (!got.fresh) {
      taskLog(id, '新开一轮被拒：执行位已被占', { messageId: msg?.messageId })
      throw new TaskBusyError('任务正在执行，请等它完成或先停止')
    }
    const entry = got.value
    const next = entry.task
    let m = msg
    if (!m) {
      const q = takeHeld(id)
      if (!q) {
        sc.release(entry)
        return next
      }
      taskLog(id, '接着处理排着的消息', { messageId: q.id })
      m = { text: q.text, attachments: q.attachments, recorded: true }
      // 这一轮已经结束、马上按新的一轮交给 CLI：把消息上的交付状态从将来的「结束后自动处理」改成实际发生的事
      // 合进来的几封信一起改（见 holdForNextTurn）
      markHeld(next.messages, [q], 'next')
      // 排着的消息只记了正文：面板替别人说的（后台结果、子对话上报、面板说明）要按对话里记下的那条认出来，
      // 不然会被当成用户的新要求，计划提醒追着它要改计划
      const rec = next.messages.find((x) => x.id === q.id)
      if (rec && (rec.role !== 'user' || rec.panel || rec.child)) m = { ...m, panel: rec.panel ?? 'note' }
    }
    sc.notePlanInput(next, !!m.panel || !!m.child)
    // 用户发了新消息：上一轮已经全部做完的 CLI 待办收起，不再一直挂着「待办已完成」
    if (!m.panel && !m.child && !m.peer) next.todos = settledTodos(next.todos)
    if (freshChance(m)) sc.resetNudge(next.id)
    // 父对话、其他对话发来的：交给 CLI 的那份前面写明来源（见 sourceHeader），对话里记的原文不变
    const head = m.panel ? '' : sourceHeader({ peer: m.peer })
    const raw = await expandForWorkflow(next, m.text)
    const expanded = head ? head + (raw || m.text) : raw
    dropEndNotes(next)
    // 已完成的子对话又被继续：重新算进行中，这次的改动要再合一次才算完成
    if (next.parentTaskId && next.resolved) {
      next.resolved = false
      // 一律用 --resume 接回原会话，不管上下文多大（用户 2026-10-31 定的，取代 ADR 0007 的「上下文大就开新会话带摘要」）
      // 又要接着做：再完成一次时该重新上报父对话
      sc.reportedDone.delete(id)
      sc.mergeNudged.delete(id)
    }
    // 请过收尾又开始干活（父对话退回、用户追加要求）：收尾请求作废，做完要重新请求；正在合并的不动
    // （记录上是 merging、内存里却没在合并的是残留：旧版本完成时没清掉，留着它 submit_merge 会一直被拒）
    if (next.wrapRequest && !sc.merging.has(id)) {
      if (next.wrapRequest.state === 'requested')
        markChildWrapUp(next, 'running', '又有新的要求：做完、验证后再请父对话收尾')
      next.wrapRequest = undefined
      sc.reportedState.delete(id)
    }
    // 这条消息新记进对话时一并记下交付方式和独立分支的改动情况：界面读它就能说清「已排到下一轮」「N 个文件未提交」。
    // 页面上发的消息（带 messageId）排到这里就是马上交给 CLI（start 在后面），先记成 wait，
    // 界面从「待认领」改成「已交给 CLI」；启动失败时再改成 lost（见下面的 catch）。
    // 面板推给对话的消息（panel / child / peer、内部补发的）不画在用户气泡上，不记交付方式
    const how = m.delivery ?? (m.messageId ? 'wait' : undefined)
    const stamp = {
      ...(how ? { delivery: { how, at: new Date().toISOString() } } : {}),
      ...(m.worktree ? { worktree: m.worktree } : {}),
    }
    const newMessage = () => ({
      id: m.messageId ?? randomUUID(),
      role: m.panel ? ('system' as const) : ('user' as const),
      agentId: '',
      step: '',
      text: m.text,
      ...(m.panel ? { panel: m.panel } : {}),
      ...(m.child ? { child: m.child } : {}),
      ...(m.peer ? { peer: m.peer } : {}),
      ...(m.summaryCards?.length ? { summaryCards: m.summaryCards } : {}),
      ...(expanded ? { prompt: expanded } : {}),
      tools: [],
      ...(m.attachments.length ? { attachments: m.attachments } : {}),
      ...stamp,
      at: new Date().toISOString(),
    })
    // 独立分支的工作区被回收后又被继续：先建回来，附件落盘和这一轮执行才有目录
    const project = next.projectId ? await sc.deps.projects.get(next.projectId) : null
    const restoreErr = project ? await sc.restoreWorktree(next, project) : ''
    if (restoreErr) {
      taskLog(id, '独立分支没建起来，消息没交出去', { messageId: m.messageId, error: restoreErr })
      // 独立分支没建起来，这一轮没跑：这条消息没能交给 CLI，不能标成「已交给 CLI」
      if (!m.recorded) next.messages.push({ ...newMessage(), delivery: { how: 'lost', at: new Date().toISOString() } })
      sc.recordWorktreeError(next, restoreErr)
      await sc.store.update(id, next)
      sc.release(entry)
      return next
    }
    // 附件拷进这个对话的对话目录，交给 Agent 的是这一份（对话里显示、导出仍用原来的那份）
    const placed = m.placed ?? (await sc.placeInTask(next, m.attachments))
    if (!m.recorded) next.messages.push(newMessage())
    taskLog(id, '新开一轮', {
      messageId: m.messageId,
      recorded: m.recorded || undefined,
      panel: m.panel,
      delivery: how,
    })
    // start 一进去就把任务标成执行中（status / working / 速度 / runStartedAt，见它的开头）。
    // 失败时执行位已经释放，落盘前要把这些恢复回去，不然任务会停在「执行中」却没有进程在跑
    const usage = next.usage.agents[next.agentId]
    const beforeRun = {
      status: next.status,
      working: next.working,
      awaitingUser: next.awaitingUser,
      prewarming: next.prewarming,
      runStartedAt: next.runStartedAt,
      tps: usage?.tps,
      lastTps: usage?.lastTps,
    }
    try {
      return await start(
        entry,
        withAttachments(m.prompt || expanded || m.text, placed),
        false,
        await sc.deps.agents.list(),
      )
    } catch (e) {
      taskLog(id, '新开一轮启动失败', { messageId: m.messageId, error: e as Error })
      // 启动失败：这条消息没交给 CLI，别让对话里一直写着「已交给 CLI」；
      // 同时把 start 标上的执行中状态恢复过来（执行位已经释放，留着它就自相矛盾）
      next.status = beforeRun.status
      next.working = beforeRun.working
      next.awaitingUser = beforeRun.awaitingUser
      next.prewarming = beforeRun.prewarming
      next.runStartedAt = beforeRun.runStartedAt
      const active = next.usage.agents[next.agentId]
      if (active && beforeRun.tps !== undefined && beforeRun.lastTps !== undefined) {
        active.tps = beforeRun.tps
        active.lastTps = beforeRun.lastTps
      }
      const mine = next.messages.find((x) => x.id === (m.messageId ?? '') && x.delivery)
      if (mine) {
        mine.delivery = { how: 'lost', at: new Date().toISOString() }
        await sc.store.update(id, next).catch(() => {})
      }
      sc.release(entry)
      throw e
    }
  }

  /**
   * 一条消息交给正在跑的任务，先试能实时送到 CLI 的办法：
   * CLI 正停在等下一句 → 直接交回同一个进程；支持插话 → 插话；
   * 能用面板工具取补充 → 登记给它取；都收不下就记下来，这一轮结束后马上开始新一轮。
   * 返回的 how 是这条消息实际去了哪里：调用方把它落到那条消息上，界面才知道该说「插进当前轮」还是「排到下一轮」
   */
  async function deliver(
    entry: Live,
    msg: TaskMessage,
    text: string,
    attachments: Attachment[],
    placed: Attachment[] = attachments,
  ): Promise<{ task: Task; how: DeliveryHow }> {
    const task = entry.task
    sc.notePlanInput(task, msg.role !== 'user' || !!msg.panel || !!msg.child, msg.at)
    // 已标完成的子对话 CLI 还停在等下一句时（例如完成和这条消息撞在一起，进程还没收掉），消息直接交给它接着做：
    // 不清掉完成标记的话它明明在跑，界面和父对话看到的还是「已完成」，做完也不会再上报（reportedDone 挡着）
    if (task.parentTaskId && task.resolved && !msg.panel) {
      task.resolved = false
      sc.reportedDone.delete(task.id)
      sc.reportedState.delete(task.id)
      sc.mergeNudged.delete(task.id)
      entry.rev++
    }
    // CLI 收到上一条后一直没有任何输出（卡住了）：再往这一轮里插话也不会有回应，停掉它、接回会话重开
    const stuck = stalledTurn(task.id)
    if (stuck) {
      taskLog(task.id, '交付：CLI 卡住，重开', { messageId: msg.id })
      return restartStalled(entry, msg, text, placed, stuck.input)
    }
    // 交给 CLI 的是拷进任务目录的那一份（placed）；记进对话的 msg 仍是用户原来的附件，缩略图从附件目录读
    const wait = deliverWait(task, msg, placed)
    taskLog(task.id, '交付：等下一句', {
      messageId: msg.id,
      role: msg.role === 'user' && !msg.panel ? undefined : msg.panel || msg.role,
      wait,
      awaitingUser: task.awaitingUser,
      working: task.working,
    })
    if (wait === 'ok') {
      // CLI 停在等下一句（上一轮已结束）：用户的新消息同样收起全部做完的待办
      if (msg.role === 'user' && !msg.panel && !msg.child && !msg.peer) task.todos = settledTodos(task.todos)
      if (msg.role === 'user' && freshChance(msg)) sc.resetNudge(task.id)
      task.updatedAt = new Date().toISOString()
      markDelivery(task, msg, 'wait')
      await sc.store.update(task.id, task)
      return { task, how: 'wait' as const }
    }
    // 等着的还是旧 CLI：让它退出，按输入框里现在的选择重新开始这一轮
    if (wait === 'stale') {
      taskLog(task.id, '交付：等着的是旧 CLI，按现在的选择重开', { messageId: msg.id })
      entry.restart = true
      if (entry.done) await entry.done
      const next = sc.live.get(task.id)
      if (next) {
        if (deliverWait(next.task, msg, placed) === 'ok') {
          next.task.updatedAt = new Date().toISOString()
          markDelivery(next.task, msg, 'wait')
          await sc.store.update(task.id, next.task)
          return { task: next.task, how: 'wait' as const }
        }
        return intoTurn(next, msg, text, placed)
      }
      // 这次要记进对话的是用户原来的附件（上传目录的绝对路径），拷进任务目录的那份只给 CLI。
      // panel / child / peer / worktree 也要带过去：不带的话面板推给父对话的那条（例如「子对话停止 + 未提交改动」）
      // 会变成一条普通用户消息，行上的「N 个文件未提交」和「继续」都没了
      return {
        task: await followUp(task.id, {
          text,
          attachments: msg.attachments ?? [],
          placed,
          // 沿用页面本地那条待认领消息的 id：推送到达时按 id 换成这一份
          messageId: msg.id,
          delivery: 'next',
          ...(msg.panel ? { panel: msg.panel } : {}),
          ...(msg.child ? { child: msg.child } : {}),
          ...(msg.peer ? { peer: msg.peer } : {}),
          ...(msg.worktree ? { worktree: msg.worktree } : {}),
        }),
        how: 'next' as const,
      }
    }
    return intoTurn(entry, msg, text, placed)
  }

  /**
   * 重启卡住的 CLI：停掉这一轮（原因记成 stalled，不说成用户暂停），接回原会话开新的一轮，
   * 把没得到回应的那条和新消息一起交过去；对话里只显示新消息本身
   */
  async function restartStalled(entry: Live, msg: TaskMessage, text: string, placed: Attachment[], missed: string) {
    const id = entry.task.id
    log.warn('task', 'CLI 没有响应，停掉它接回会话重开', { task: id })
    // 「没有响应」那一行记下结果：停下的说明是临时的，开新一轮时会被去掉
    for (const m of entry.task.messages)
      if (m.alert?.kind === 'no_response' && !m.alert.resolved)
        m.alert = { ...m.alert, resolved: t('收到新消息时停掉了卡住的 Agent，接回会话重新开始') }
    sc.stopTask(id, 'stalled')
    if (entry.done) await entry.done
    // 停下的这段时间里别的消息已经开了新的一轮：交给那一轮
    const next = sc.live.get(id)
    if (next) return deliver(next, msg, text, [], placed)
    const prompt =
      `（面板说明：上一条交给你的消息你一直没有回应，CLI 卡住了，面板已经停掉它并接回这个会话。没被处理的那条是：\n${missed}\n\n` +
      `先处理它，再处理下面这条新消息。）\n\n${text}`
    const task = await followUp(id, {
      text: msg.text,
      attachments: msg.attachments ?? [],
      placed,
      // 沿用页面本地那条待认领消息的 id（和其余交付路径一样）
      messageId: msg.id,
      ...(msg.panel ? { panel: msg.panel } : {}),
      ...(msg.child ? { child: msg.child } : {}),
      ...(msg.peer ? { peer: msg.peer } : {}),
      prompt,
      delivery: 'restart',
    })
    return { task, how: 'restart' as const }
  }

  /**
   * 把交付结果记到那条消息上（界面按它说清消息去了哪里）。按 id 找：插话那条记在节点的消息上，
   * 是异步之前就 push 进去的一份拷贝，改手里这个 msg 不会反映到对话里
   */
  function markDelivery(task: Task, msg: TaskMessage, how: DeliveryHow) {
    const at = new Date().toISOString()
    for (const m of task.messages)
      if (m.id === msg.id && m.role === 'user') {
        m.delivery = { how, at }
        return
      }
  }

  /** CLI 没在等下一句：插话 → 登记给 read_user_notes → 记下来这一轮结束后接着处理 */
  async function intoTurn(entry: Live, msg: TaskMessage, text: string, attachments: Attachment[]) {
    const task = entry.task
    const how = await steerTask(task, withAttachments(text, attachments), msg)
    if (!how) {
      task.messages.push(msg)
      holdForNextTurn(task.id, msg)
    }
    taskLog(task.id, '交付：插进这一轮', { messageId: msg.id, how: how || 'held' })
    markDelivery(task, msg, how || 'held')
    task.updatedAt = new Date().toISOString()
    await sc.store.update(task.id, task)
    return { task, how: how || ('held' as const) }
  }

  return { deliver, expandForWorkflow, followUp, spawnChildOf, start }
}
