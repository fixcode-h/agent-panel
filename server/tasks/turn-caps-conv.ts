// 一轮执行交给引擎的「对话」类能力（重构文档第 3、5 条：从 createRun 的 start 里拆出来，按 EngineHost 的小接口分组）。
import type { Agent, Project, Settings, Task } from '../../shared/schema.ts'
import type { Live } from './types.ts'
import type { TasksScope } from './scope.ts'
import type { RealContext } from '../exec/real-context.ts'
import { randomUUID } from 'node:crypto'
import { waitingAfter } from '../../shared/child-after.ts'
import { afterTurnCleanup } from './bug-cleanup.ts'
import { recheckAfterTurn } from './bug-recheck.ts'
import {
  childActivity,
  childActivityText,
  childLastActivity,
  childWait,
  childWaitText,
  childFacts,
  convState,
  convStateText,
} from '../../shared/task.ts'
import { isChatMode } from '../../shared/conv-mode.ts'
import { log } from '../log.ts'
import { inboxWithFile } from './inbox-file.ts'
import { taskCliAlive } from '../exec/process.ts'
import { upgradeChildToBug } from './bug-upgrade.ts'
import { dirtyParentBlock, dirtyParentNote } from './dirty-parent.ts'

/**
 * 拼一轮宿主能力要用到的：执行位、这一轮开始时的任务快照和项目、角色。
 * 注意：返回的对象会被展开进 runRealTurn 的参数，所以这里不能写 getter（展开时就取值了，保活期间不会再变）；
 * 要现取的写成函数，或者留在 run.ts 里直接写在参数上
 */
export interface TurnCapsCtx {
  sc: TasksScope
  entry: Live
  /** 这一轮开始时的任务对象（和 entry.task 是同一个，除非中途被换掉；原来怎么用就怎么用） */
  task: Task
  project: Project
  /** 项目设置原样（不含合并进来的教训） */
  found: Project | null
  agents: Agent[]
  settings: Settings
  /** 这个对话实际执行的目录 */
  dir: string
  /** 对话树的根 id */
  rootId: string
  /** 项目里用分派角色的顶层对话 */
  coordinatorRole: boolean
  /** UE 项目里编译归谁 */
  ueRole: 'child' | 'parent' | undefined
  startAgent: Agent | undefined
  changed: (f?: boolean) => void
  spawnChild: ReturnType<typeof import('./spawn-child.ts').createSpawnChild>['spawnChild']
}

/** 对话之间的能力：子对话的创建、交代、列表，父子之间传话，父对话之间协调，一轮结束的回调 */
export async function conversationCaps(c: TurnCapsCtx) {
  const { sc, entry, task, project, found, agents, coordinatorRole, spawnChild } = c
  return {
    // 子对话这一轮真结束的地方收口父对话计划里等它的步骤（进程保活等下一句时 run 不返回，等不到收尾）
    // 顶层对话：计划没做完、也没在等结果就收尾时，面板推它接着做；动了手却没列计划，推它先列计划（见 nudgePlan）。
    // 判断做完没有只看计划，不看回复里的字眼（用户 2026-11-02 定）。Chat 页没动手的那一轮不推
    // 每一轮结束都按整棵对话树核一次用量上限（见 tasks/budget.ts）：到了上限就停下，也不再推它接着做
    onTurnEnd: task.parentTaskId
      ? (turn) => {
          sc.settleChildTurn(entry.task, turn)
          void sc.checkBudget(entry.task)
          // 用户取消修复后叫它删临时日志：这一轮结束就核对，通过了关闭诊断报告（shared/bug/cleanup.ts）
          void afterTurnCleanup(sc, entry, randomUUID).catch((e) =>
            log.warn('task', '核对临时日志失败', { task: task.id, error: (e as Error).message }),
          )
          // 交了修复 / 验证、写了回归测试命令：面板在改前和现在的代码上各跑一次（分析稿 B9）
          recheckAfterTurn(sc, task.id, randomUUID)
        }
      : (turn) => {
          // 经验学习按「一轮结束」排，不等 run 返回：CLI 保活时进程停在等下一句，run 一直不返回，
          // 只在 run 收尾处排的话要等闲置回收才学，用户看到的就是「对话完成了却不学」。
          // 面板接着推它做（nudgePlan / nudgeWrapUp）会在几秒内让它跑起来，learn 到点见它没完成就不学，等下一轮结束再排
          if (entry.task.projectId) void sc.learnExperience(task.id)
          void sc.checkBudget(entry.task).then((over) => {
            if (over || task.mode !== 'chat') return
            // Chat 页只回答了一句、没动手的那一轮不推；项目里的对话按计划推（计划没做完、或动了手却没列计划，见 nudgePlan）
            if (turn.tools <= 0 && isChatMode(entry.task)) return
            // 有子对话在等它收尾时先推收尾：这时计划那一步写着「等子对话」，nudgePlan 会当成在等别人而不推
            return sc
              .nudgeWrapUp(entry.task)
              .then((pushed) => pushed || sc.nudgePlan(entry.task, turn))
              .catch((e) => log.warn('task', '推对话接着做计划失败', { task: task.id, error: (e as Error).message }))
          })
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
    // 结束前钩子（ADR 0049）：模型准备结束这一轮时，计划没做完、收尾请求没处理就在同一轮里拦住
    beforeEnd: (input) => sc.beforeEnd(task.id, input),
    // 顶层项目对话收尾名下的子对话：子对话 submit_merge 请求后由它合回、标完成、删分支（ADR 0005）
    finishChild: !task.parentTaskId && task.projectId ? (id) => sc.finishChild(entry.task, id) : undefined,
    // 名下的工作流运行（不是子对话）：起、补充、退回、代答、终止、合回（server/tasks/flow-runs.ts）
    runs: !task.parentTaskId && !task.flowRun && found?.id ? sc.flowRuns.hostFor(() => entry.task, found) : undefined,
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
    listConversations: async () => {
      const kids = await sc.store.childrenOf(entry.task.id)
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
          waiting: waitingAfter(cur)
            ? `排在 ${cur.waitAfter!.map((id) => `「${kids.find((x) => x.id === id)?.title ?? id}」`).join('、')} 之后，它们合回后面板自动启动`
            : childWaitText(childWait(cur, { background: sc.pendingJobs(cur.id), cliAlive: taskCliAlive(cur.id) })),
          lastActivityAt: childLastActivity(cur),
          // 面板自动问过状态、还没回复：父对话不用再问一遍，也不用猜它有没有被叫过
          autoAsk: cur.autoAsk,
          createdAt: cur.createdAt,
          resolved: !!cur.resolved,
        }
      })
    },
    createConversation: async ({ title, message, files, agentId, bug, fix, edits, ignoreDirty, level, after }) => {
      if (!project?.id) return { ok: false, info: '独立聊天没有项目，不能创建子对话' }
      // 独立分支看不到父对话没提交的改动：要改代码的先拦下交回清单，其余在返回里提醒（见 dirty-parent.ts）
      const dirty = ignoreDirty ? '' : await (edits ? dirtyParentBlock : dirtyParentNote)(sc, entry.task, project)
      if (dirty && edits) return { ok: false, info: dirty }
      const r = await spawnChild(entry.task, project, agents, {
        title,
        message,
        files,
        agentId,
        bug,
        fix,
        edits,
        level,
        after,
      })
      return dirty ? { ...r, info: `${r.info}\n${dirty}` } : r
    },
    sendToConversation: async (id, message, bug) => {
      // 写了 kind: "bug"：先把子对话标成用户报的 Bug，交过去的话前面带上说明（bug-upgrade.ts）
      const up = bug && (await upgradeChildToBug(sc, entry.task.id, id, message, bug.level))
      if (up && !up.ok) return up
      // 父对话交给已有子对话：子对话里画成「接收消息 · 交代任务」，不当成用户说的话
      const r = await sc.sendToChild(entry.task.id, id, up ? up.message : message, undefined, 'task')
      if (up && r.ok) r.info = `${r.info}\n${up.note}`
      // 交给子对话就算回答了它的提问：父对话里的提问卡片收起
      if (r.ok && sc.settleAsks(entry.task, id, message, 'parent')) entry.rev++
      return r
    },
  } satisfies Partial<RealContext>
}
