import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { Task, type TaskMessage, type Workflow, defaultAgent } from '../../../../shared/schema.ts'
import { blockedStep, taskFlow, taskWorkflows } from '../../../../shared/flow/index.ts'
import { taskSnapshot } from '../../../../shared/builtin/default.ts'
import { exposeSlots } from '../../../../shared/expose.ts'
import { settleWait } from '../../../../shared/plan/index.ts'
import { kidsSkipNote, rearmKidWait, resumeNote, sortStoppedKids } from '../../../../shared/resume-kids.ts'
import { closeFlow, diagnosisPending, dropEndNotes, taskDeleted, withAttachments } from '../../../../shared/task.ts'
import { withTaskModel, retryModelPatch } from '../../../../shared/tasks/run.ts'
import { rewaitDiagnosis } from '../../../../shared/tasks/settle.ts'
import { agentRun } from '../../../../shared/settings.ts'
import { getSettings } from '../../../settings.ts'
import { taskLog } from '../../log.ts'
import { log } from '../../../log.ts'
import { t } from '../../../../shared/i18n.ts'
import type { TasksScope } from '../../scope.ts'
import { settleBefore } from '../../helpers.ts'
import { pausedHelpers } from '../../../../shared/run/stops.ts'

/** 结束工作流，和失败或停止后的「继续执行」（连带拉起一起被打断的子对话） */
export function resumeRoutes(s: TasksScope): Hono {
  const app = new Hono()
  // 结束工作流：没完成的节点不再执行，之后的要求由主 Agent 直接处理
  app.post('/:id/end-flow', async (c) => {
    const id = c.req.param('id')
    const prev = s.live.get(id)
    await settleBefore(prev)
    if (s.live.has(id)) return s.bad(c, t('任务正在执行，请先停止'), 409)
    const tk = await s.store.get(id)
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    if (tk.imported) return s.bad(c, s.READONLY, 409)
    if (tk.mode !== 'workflow') return s.bad(c, t('只有工作流任务可以结束流程'))
    closeFlow(tk, randomUUID())
    return c.json(await s.store.update(id, tk))
  })

  // 失败或停止后继续：不加新消息，从没完成的节点接着跑；工作流已完成时重做最后一条要求
  app.post('/:id/resume', async (c) => {
    const id = c.req.param('id')
    const prev = s.live.get(id)
    await settleBefore(prev)
    if (s.live.has(id)) return s.bad(c, t('任务正在执行'), 409)
    const task = await s.store.get(id)
    if (!task) return s.bad(c, t('任务不存在'), 404)
    if (task.imported) return s.bad(c, s.READONLY, 409)
    // 占执行位要在后面的 await 之前：否则两条「继续」请求会各自检查通过、各启动一遍
    const got = s.reserve(task)
    if (!got.fresh) return s.bad(c, t('任务正在执行'), 409)
    const entry = got.value
    const users = task.messages.filter((m) => m.role === 'user' && !m.step)
    try {
      // 停在某个节点结论上的工作流（例如前置检查不通过）也能继续：从那个节点重新检查
      const blocked = !!blockedStep(task, taskFlow(task, taskWorkflows(task, await s.deps.workflows.list()).workflow))
      if (task.status !== 'failed' && task.status !== 'stopped' && !blocked) {
        s.release(entry)
        return s.bad(c, t('只有失败或停止的任务可以继续'), 409)
      }
      // 诊断报告还在等用户确认（ADR 0045）：继续就是回到等确认这一步，不拉起 CLI 让它自己往下跑；
      // 用户确认或提意见后，审阅弹窗发的消息才拉起它（用户 2026-11-04 要求）
      if (task.mode !== 'workflow' && diagnosisPending(task)) {
        const saved = await s.store.update(id, rewaitDiagnosis(entry.task))
        s.release(entry)
        if (task.parentTaskId) await rearmInParent(s, task.parentTaskId, id)
        taskLog(id, '继续：诊断报告还在等确认，回到等确认')
        return c.json(saved ?? task)
      }
      // latest：改用现在的工作流（任务创建后工作流改过，想按新的流程接着跑）
      const { latest, model, efforts } = (await c.req.json().catch(() => ({}))) as {
        latest?: boolean
        model?: string
        efforts?: string[]
      }
      // 换个模型重试：用户在失败提示上选的（不是面板自己换的，不违反「不悄悄重试」）。先把这个对话的模型改成选的那个，
      // 再走下面同一条继续的路，失败的那一轮原样重发。放在这里而不是先 PATCH 再继续：PATCH 换模型会顺手预热一个进程，
      // 紧跟着的「继续」会撞上它被当成「任务正在执行」
      if (typeof model === 'string' && model.trim()) {
        if (task.mode === 'workflow') {
          s.release(entry)
          return s.bad(c, t('只有对话可以换模型重试'))
        }
        const agent = task.agentId
          ? (await s.deps.agents.list()).find((a) => a.id === task.agentId)
          : { ...defaultAgent(), id: '' }
        // 角色被删了也能重试（按内置助手跑，见 turnRole），这时没有角色的 CLI 可比，用对话定下的
        const cli = agent
          ? agentRun(withTaskModel(agent, task), await getSettings()).cli
          : task.cli || task.sessionCli || ''
        Object.assign(
          entry.task,
          retryModelPatch(task, { cli, model: model.trim(), efforts: Array.isArray(efforts) ? efforts : undefined }),
        )
        taskLog(id, '换个模型重试', { model: model.trim() })
      }
      let fresh: Workflow | undefined
      if (latest && task.workflowId) {
        fresh = (await s.deps.workflows.get(task.workflowId)) ?? undefined
        if (!fresh) {
          s.release(entry)
          return s.bad(c, t('工作流已经被删除，只能按任务创建时的工作流继续'))
        }
      }
      dropEndNotes(entry.task)
      if (fresh) {
        const project = task.projectId ? await s.deps.projects.get(task.projectId) : null
        const params = project ? s.paramsOf(project, fresh.id) : {}
        await s.refreshAgents()
        entry.task.workflows = taskSnapshot(
          fresh,
          await s.deps.workflows.list(),
          params,
          project ? s.testOpts(project) : { agents: s.liveAgents },
        )
        entry.task.skillSlots = exposeSlots(fresh, params)
        entry.task.workflowName = fresh.name
        // 测试步骤跟着一起换成项目现在的配置：这里明确是「按最新的工作流继续」
        if (project) {
          entry.task.testSteps = project.testSteps
          entry.task.platform = process.platform
        }
      }
      // 对话：一起被中断的子对话由面板连带拉起来（先拉，父对话的续接提示里才写得清哪些已经在接着做）。
      // 子对话被用户直接继续时也一样：它名下连带停下的孙对话一起拉起，它在父计划里的等待恢复成等待中（ADR 0042）
      const kids = task.mode !== 'workflow' ? await resumeKids(s, entry.task) : undefined
      if (task.mode !== 'workflow' && task.parentTaskId) await rearmInParent(s, task.parentTaskId, id)
      // 名下随它停的工作流运行接着跑（design.md D4）；运行不是子对话，不在 resumeKids 里
      if (task.mode !== 'workflow' && !task.parentTaskId) await s.flowRuns.resumeRunsOf(id)
      // 这次继续拉起了谁、没拉起谁、哪些子任务由面板接着跑：写进对话日志，「状态」诊断里看得到（ADR 0042）
      if (task.mode !== 'workflow')
        taskLog(id, '继续计划', {
          kids: kids?.resumed.join('、') || undefined,
          failed: kids?.failed.map((k) => k.title).join('、') || undefined,
          helpers:
            pausedHelpers(entry.task)
              .map((s) => s.title)
              .join('、') || undefined,
        })
      const prompt = resumePrompt(task, users, kids?.resumed, kids?.failed, kids?.notes)
      const agents = await s.deps.agents.list()
      return c.json(await withoutStoppedJobs(entry.task, () => s.start(entry, prompt, false, agents, undefined, true)))
    } catch (e) {
      s.release(entry)
      throw e
    }
  })
  return app
}

/**
 * 用户直接继续一个子对话：父计划里等它、已经收成失败的等待恢复成等待中（ADR 0042），它做完时父对话才会被叫醒。
 * 父对话在执行就改执行位里那一份，否则改落盘的
 */
async function rearmInParent(s: TasksScope, parentId: string, kidId: string) {
  const live = s.live.get(parentId)
  const parent = live?.task ?? (await s.store.get(parentId))
  if (!parent || !rearmKidWait(parent, kidId)) return
  parent.updatedAt = new Date().toISOString()
  if (live) live.rev++
  await s.store.update(parentId, parent).catch(() => {})
  taskLog(parentId, '子对话接着做，计划恢复等它', { kid: kidId })
}

/**
 * 继续执行时交给 CLI 的话：最后一条要求原样再交一遍；对话模式前面写清这是续接、中断时还有什么没跑完（见 resumeNote）。
 * 工作流模式由引擎按节点续接，不加
 */
function resumePrompt(
  task: Task,
  users: TaskMessage[],
  resumed: string[] = [],
  failed: KidFailure[] = [],
  notes: string[] = [],
) {
  const last = users.at(-1)
  const text = withAttachments(last?.prompt || last?.text || '', last?.attachments)
  if (task.mode === 'workflow') return text
  const note = [resumeNote(task, resumed, failed), ...notes].join('\n')
  // 会话接得上：原来的要求已经在会话里，不再原样发一遍，免得模型当成新要求从头重做（ADR 0042）。
  // 接不上（会话找不到、换了 CLI / 目录）时 runner 会把之前的对话整段带过去，原来的要求也在里面；
  // 只有这一轮还没拿到会话就被停下（没有会话可接）时才附上原文
  if (task.sessions[task.agentId]) return note
  return `${note}\n\n原来的要求：\n${text}`
}

/**
 * 父对话继续执行时，把和它一起被打断的子对话也拉起来接着做，返回拉起来的标题和没能拉起来的（写进续接说明）。
 * parent 是执行位里那份（s.start 用它落盘）：拉不起来的子对话，计划里等它的那一步在这份上收口
 * 只拉被连带打断的（父对话结束时一起停的、面板重启、卡住重开时停的），用户亲手停的、已经收尾的、在回收站的不拉。
 * 待收尾、父对话已经收下结果的也不拉：实测里已交付的子对话被拉起后把做完的事又做了一遍（见 sortStoppedKids）。
 * 用户单独停掉的写进续接说明，让父对话问用户，而不是当成失败去重派。
 * 以前继续父对话不管子对话：父对话看子对话没动静，就另建一个子对话重做（用户报过，要求尽量用原来的子对话）
 */
async function resumeKids(
  s: TasksScope,
  parent: Task,
): Promise<{ resumed: string[]; failed: KidFailure[]; notes: string[] }> {
  const parentId = parent.id
  // 停父对话后马上点继续：子对话已经落成「已中断」，但这一份执行还在收尾（写盘、上报）、执行位没放，
  // 下面按「不在执行」筛就会漏掉它，既不拉起也不在续接说明里出现。先等在停的那些收完，最多等几秒
  // 等多久和「继续执行」先等停稳是同一个上限（settleBefore）：停下的执行最迟这么久一定收口（见 keepalive.ts 的 watchStop），
  // 以前只等 5 秒，进程退得慢的子对话会被漏掉，既不拉起也不写进续接说明
  const settling = [...s.live.values()].filter((e) => e.task.parentTaskId === parentId && e.stop)
  await Promise.all(settling.map((e) => settleBefore(e)))
  const stopped = (await s.store.list()).filter(
    (k) =>
      k.parentTaskId === parentId &&
      !taskDeleted(k) &&
      !k.archived &&
      !k.resolved &&
      !k.imported &&
      k.status === 'stopped' &&
      !s.live.has(k.id),
  )
  // 诊断报告在等用户确认的子对话（ADR 0045）：回到等确认，不拉起 CLI；用户亲手停的也一样，它等的本来就是用户
  const notes: string[] = []
  for (const meta of stopped.filter((k) => diagnosisPending(k))) {
    const kid = await s.store.get(meta.id)
    if (!kid || s.live.has(kid.id)) continue
    await s.store.update(kid.id, rewaitDiagnosis(kid))
    if (rearmKidWait(parent, kid.id)) taskLog(parentId, '子对话的诊断报告还在等确认，计划恢复等它', { kid: kid.id })
    notes.push(
      `子对话「${kid.title}」（${kid.id}）的诊断报告还在等用户确认，没有拉起它：用户确认或提意见后它会自己接着做，不要另派子对话重做。`,
    )
  }
  const sorted = sortStoppedKids(
    parent,
    stopped.filter((k) => !diagnosisPending(k)),
  )
  const kids = sorted.resume
  notes.push(...kidsSkipNote(sorted.userStopped, sorted.skipped))
  const agents = await s.deps.agents.list()
  const titles: string[] = []
  const failed: KidFailure[] = []
  for (const meta of kids) {
    const kid = await s.store.get(meta.id)
    if (!kid) continue
    const got = s.reserve(kid)
    if (!got.fresh) continue
    try {
      dropEndNotes(got.value.task)
      const users = kid.messages.filter((m) => m.role === 'user' && !m.step)
      // 递归：它名下一起停下的孙对话先拉起来，它自己的续接说明里才写得清（ADR 0042）
      const sub = await resumeKids(s, got.value.task)
      const prompt = resumePrompt(kid, users, sub.resumed, sub.failed, sub.notes)
      await withoutStoppedJobs(got.value.task, () => s.start(got.value, prompt, false, agents, undefined, true))
      titles.push(kid.title)
      // 父计划里等它的那一步接着等：它做完时结果对得上、父对话会被叫醒
      if (rearmKidWait(parent, kid.id)) taskLog(parentId, '连带拉起的子对话接着做，计划恢复等它', { kid: kid.id })
      log.info('task', '父对话继续执行，连带拉起被打断的子对话', { parent: parentId, task: kid.id })
    } catch (e) {
      s.release(got.value)
      // 起不来要报出来：父对话据此决定另建子对话接手（见 resumeNote 和分派规则）
      log.error('task', '父对话继续执行时子对话没能拉起来', {
        parent: parentId,
        task: kid.id,
        error: (e as Error).message,
      })
      s.alertOn(kid.id, 'panel', t('这个子对话没能开始执行'), 'error')(e)
      failed.push({ id: kid.id, title: kid.title, error: (e as Error).message })
      // 计划里等它的那一步不会再等到结果：退回进行中、写「需要修复」，父对话才会处理（不然永远等待中、面板也不推）
      settleWait(parent, 'child', kid.id, false)
    }
  }
  return { resumed: titles, failed, notes }
}

/** 父对话继续执行时没能拉起来的子对话（见 resumeNote） */
type KidFailure = { id: string; title: string; error: string }

/**
 * 被停掉的后台命令已经写进续接说明：交出去就清掉，下次中断只列那时候停的。
 * 没能启动（CLI 没装、目录不在）时放回去，下次继续还要再说一遍
 */
async function withoutStoppedJobs<T>(task: Task, start: () => Promise<T>): Promise<T> {
  const kept = task.stoppedJobs
  task.stoppedJobs = undefined
  try {
    return await start()
  } catch (e) {
    if (kept && !task.stoppedJobs) task.stoppedJobs = kept
    throw e
  }
}
