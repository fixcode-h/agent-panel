/**
 * 新建子对话（父对话的 create_conversation、面板替卡住的子对话找人接手）和子对话改了兄弟名下文件时的撞车提醒。
 * 从 run.ts 拆出来（那边顶到了行数上限），只依赖 TasksScope
 */
import { randomUUID } from 'node:crypto'
import { withProjectParams } from '../../shared/builtin/core.ts'
import { BugCase, type BugLevel } from '../../shared/bug-diagnosis-schema.ts'
import { childAskInitial } from '../../shared/child-ask.ts'
import { afterDecision, checkAfter } from '../../shared/child-after.ts'
import { t } from '../../shared/i18n.ts'
import { NewTaskInput, type Agent, type Project, type Task } from '../../shared/schema.ts'
import { newTask, taskDeleted } from '../../shared/task.ts'
import { childFilesInfo, hitList, holdTurn, normClaimPath, scopeOverlaps } from '../claims.ts'
import { isolated } from './helpers.ts'
import { linkRelapse } from './bug-relapse.ts'
import type { TasksScope } from './scope.ts'

export function createSpawnChild(sc: TasksScope) {
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
      bug,
      fix,
      edits,
      level,
      after,
    }: {
      title: string
      message: string
      files?: string[]
      agentId?: string
      bug?: boolean
      /** 直接修的用户 Bug（kind: "fix"）：收尾时留简版报告 */
      fix?: boolean
      /** Bug 的级别初判：档案从它开始，子对话查下来不符可以改 */
      level?: BugLevel
      /** 一定要改代码：第一次执行前就开好独立分支（只在独立分支模式下有用） */
      edits?: boolean
      /** 排在哪些兄弟子对话之后（shared/child-after.ts）：它们都合回后才启动 */
      after?: string[]
    },
  ) {
    // 先后依赖：前置都已经合回的照常马上开始；还没的先建好、停在 after，由 after-deps.ts 在前置合回时启动
    let wait: ReturnType<typeof afterDecision> | undefined
    let waitIds: string[] = []
    if (after?.length) {
      const kids = (await sc.store.childrenOf(parent.id)).map((k) => sc.live.get(k.id)?.task ?? k)
      const ok = checkAfter(after, kids, parent.id)
      if (!ok.ok) return { ok: false, info: ok.info }
      waitIds = ok.ids
      wait = afterDecision(waitIds, (id) => kids.find((k) => k.id === id))
    }
    const waiting = !!wait && !wait.start
    const worker = agents.find((a) => a.origin === 'builtin:worker')
    const subId = randomUUID()
    const at = new Date().toISOString()
    // 观察期里的偶发 Bug 又报了（分析稿 B13）：关联到原来那个，派单附上它的根因和修法
    const relapse = bug
      ? await linkRelapse(sc, { id: subId, title, projectId: parent.projectId, text: `${title}\n${message}` })
      : undefined
    if (relapse) message += relapse.note
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
    // 父对话派来的 Bug（ADR 0045）：修之前要交诊断报告给用户确认
    const draft = {
      ...newTask(input, undefined, at, subId, [], {}),
      id: subId,
      ...(bug && {
        bug: {
          kind: 'report' as const,
          ...((level || relapse) && {
            case: BugCase.parse({
              ...(level && { level, levelNote: '父对话初判' }),
              ...(relapse && { relapseOf: relapse.origId }),
            }),
          }),
        },
      }),
      ...(fix && !bug && { bug: { kind: 'fix' as const } }),
      ...(edits && project.childIsolation === 'worktree' && { editFirst: true }),
      ...(waiting && { status: 'stopped' as const, stopReason: 'after' as const, waitAfter: waitIds }),
    }
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
    if (waiting && wait && !wait.start)
      draft.messages.push({
        id: randomUUID(),
        role: 'system',
        agentId: '',
        step: '',
        text: t('排在{list}之后：它们合回后面板自动开始，要改文件时从合回后的提交开独立分支。', {
          list: afterNames(waitIds, wait),
        }),
        tools: [],
        at,
      })
    const sub = await sc.store.create({ ...draft, id: subId })
    if (!waiting) void sc.startChild(sub, message, agents)
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
        relapse?.info,
        waiting && wait && !wait.start ? afterInfo(wait) : '',
        wait?.start ? '它排在后面的子对话都已经合回，直接开始了。' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    }
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

  return { checkCollisions, spawnChild, spawnChildOf }
}

/** 前置子对话的标题，写进等待中的子对话里给用户看 */
function afterNames(ids: string[], wait: Extract<ReturnType<typeof afterDecision>, { start: false }>) {
  const titles = [...wait.pending, ...wait.bad.map((b) => b.title)]
  return titles.length ? titles.map((x) => t('「{name}」', { name: x })).join(t('、')) : ids.join(t('、'))
}

/** 新建时就等不到的前置（失败、没了）：当场告诉父对话，不等下一次上报 */
function afterInfo(wait: Extract<ReturnType<typeof afterDecision>, { start: false }>) {
  const lines = [
    `它排在 ${[...wait.pending, ...wait.bad.map((b) => b.title)].map((x) => `「${x}」`).join('、')} 之后，先不启动：前置都合回你的分支后面板自动启动它（要开独立分支时从合回后的提交开），不用你再派；前置失败或没了会告诉你。`,
  ]
  if (wait.bad.length)
    lines.push(
      `注意：${wait.bad.map((b) => `「${b.title}」（id ${b.id}）${b.why}`).join('；')}。它修好合回前这个子对话不会开始；不想等了就用 send_to_conversation 交给它，它马上开始。`,
    )
  return lines.join('\n')
}
