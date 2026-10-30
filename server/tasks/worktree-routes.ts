import { randomUUID } from 'node:crypto'
import { Task, type Project } from '../../shared/schema.ts'
import { childHoldsOf } from '../../shared/task.ts'
import { cancelWait } from '../exec/runner.ts'
import { CHATS_DIR } from '../store.ts'
import { mergeSidesText, mergeWorktree, removeWorktree, worktreeStatus } from '../exec/worktree.ts'
import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import { markWrapUp } from '../../shared/plan.ts'
import { isolated } from './helpers.ts'
import type { TasksScope } from './scope.ts'

/**
 * 对话的工作目录和独立分支：取目录、列出 / 合并 / 丢弃独立分支、删除对话时清理分支。
 */
export function registerWorktreeRoutes(s: TasksScope) {
  /**
   * 任务的工作目录：项目目录，聊天是它自己的目录。
   * 子对话不建独立分支：父对话在独立分支里时用父的那个目录（旧版本建过独立分支的子对话仍用自己的）
   */
  const taskDir = async (
    tk: Pick<Task, 'worktree' | 'projectId' | 'id'> & { parentTaskId?: string },
  ): Promise<string> => {
    if (isolated(tk)) return tk.worktree!.path
    if (tk.parentTaskId) {
      const parent = s.live.get(tk.parentTaskId)?.task ?? (await s.store.get(tk.parentTaskId))
      if (parent && isolated(parent) && existsSync(parent.worktree!.path)) return parent.worktree!.path
    }
    return tk.projectId ? ((await s.deps.projects.get(tk.projectId))?.path ?? '') : path.join(CHATS_DIR, tk.id)
  }

  /** 独立分支合回去的目录：子对话合进父对话的目录（父也在独立分支时是父的那个），顶层对话合进项目目录 */
  async function worktreeHome(tk: Task, project: Project) {
    const parent = tk.parentTaskId ? (s.live.get(tk.parentTaskId)?.task ?? (await s.store.get(tk.parentTaskId))) : null
    return parent ? (await taskDir(parent)) || project.path : project.path
  }

  /** 正在动手（不是停在等下一句）的对话不能动它的独立分支，免得 Agent 还在往里写 */
  const busyWith = (id: string) => !!s.live.get(id)?.task.working

  /**
   * 这个对话和它名下子对话的独立分支，带上 git 里的实际情况（有没有合进原分支、几个提交没合、几个文件没提交）。
   * 合并编译、AI 合并都会改变这些，所以每次现查，不存在任务上
   */
  s.routes.get('/:id/worktrees', async (c) => {
    const id = c.req.param('id')!
    const tk = await s.current(id)
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    const project = tk.projectId ? await s.deps.projects.get(tk.projectId) : null
    const kids = (await s.store.list()).filter((x) => x.parentTaskId === id).map((k) => s.live.get(k.id)?.task ?? k)
    const list = [tk, ...kids].filter((x) => x.worktree)
    const items = await Promise.all(
      list.map(async (x) => {
        const wt = x.worktree!
        const st = project && wt.state === 'active' ? await worktreeStatus(project.path, wt).catch(() => null) : null
        return {
          taskId: x.id,
          title: x.title,
          // 列表按创建时间排，前端不再依赖接口返回的顺序
          createdAt: x.createdAt,
          child: x.id !== id,
          working: !!x.working,
          branch: wt.branch,
          baseBranch: wt.baseBranch,
          path: wt.path,
          state: wt.state,
          note: wt.note,
          home: project && wt.state === 'active' ? await worktreeHome(x, project) : '',
          exists: st?.exists ?? false,
          ahead: st?.ahead ?? 0,
          dirty: st?.dirty ?? 0,
          merged: st ? st.merged : wt.state === 'merged',
          // 已经合回去了却还留着目录（计划、后台命令、提问、这一轮还没完）：把原因带到分支状态行上
          holds:
            x.id === id
              ? undefined
              : childHoldsOf(s.live.get(x.id)?.task ?? x, {
                  background: s.pendingJobs(x.id),
                  merged: st ? st.merged : wt.state === 'merged',
                }),
        }
      }),
    )
    return c.json({ items })
  })

  /**
   * 合并独立分支：没提交的改动先提交到任务分支，再合进开分支的那个目录（原分支）。
   * 合完分支和目录都留着，对话还能接着在里面改；不要了再单独删除。
   */
  s.routes.post('/:id/worktree/merge', async (c) => {
    const id = c.req.param('id')!
    if (busyWith(id)) return s.bad(c, t('对话正在执行，等这一轮结束后再合并'), 409)
    const tk = await s.current(id)
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    if (!isolated(tk)) return s.bad(c, t('这个任务没有待处理的独立分支'))
    const project = await s.deps.projects.get(tk.projectId)
    if (!project) return s.bad(c, t('任务所属的项目已经不存在'))
    // 子对话已经请父对话收尾：用户在界面上点合并就是替父对话收尾，走同一条路（合回、标完成、删分支）
    if (tk.parentTaskId && tk.wrapRequest?.state === 'requested') {
      const parent = await s.current(tk.parentTaskId)
      if (!parent) return s.bad(c, t('父对话已经不存在'))
      const r = await s.finishChild(parent, id)
      if (!r.ok) return c.json({ error: r.info, conflict: true }, 409)
      return c.json({ task: await s.current(id), into: tk.worktree!.baseBranch, overlap: [] })
    }
    const wt = tk.worktree!
    try {
      const { into, overlap, sides } = await mergeWorktree(
        project.path,
        wt,
        `Agent 面板：合并「${tk.title}」`,
        await worktreeHome(tk, project),
        true,
      )
      log.info('task', '合并了独立分支', { task: id, branch: wt.branch, into, overlap })
      // 同一个文件两边都改过时，git 可能自动合上、不报冲突：在对话里留一条，用户才知道要核对内容
      if (overlap.length) {
        // 任务可能还在 live 里（保活等下一句）：current() 优先读内存那份，
        // 只写 store 的话界面读不到这条提醒，引擎下一次落盘还会把它盖掉
        const entry = s.live.get(id)
        const base = entry?.task ?? (await s.store.get(id)) ?? tk
        const note =
          t(
            '这次合并里两边都改了这些文件：{list}。git 已经自动合并，但必须逐文件核对有没有盖掉对方的改动，把核对结论写进合并结论（对方为什么这么改见下面的提交记录）。',
            { list: overlap.join('、') },
          ) + (sides ? `\n\n${mergeSidesText(sides)}` : '')
        const messages = [
          ...base.messages,
          {
            id: randomUUID(),
            role: 'system',
            agentId: '',
            step: '',
            text: note,
            tools: [],
            at: new Date().toISOString(),
          },
        ] as Task['messages']
        if (entry) entry.task.messages = messages
        // 这条提醒是合并后马上要看的：不走 400ms 的消息写盘节流，否则紧接着的刷新（和 e2e）读不到它
        await s.store.update(id, { ...base, messages }, { now: true })
      }
      return c.json({ task: await s.current(id), into, overlap, sides })
    } catch (e) {
      return c.json({ error: (e as Error).message, conflict: !!(e as { conflict?: boolean }).conflict }, 409)
    }
  })

  /** 删除独立分支：连目录和分支一起删；还没合并的改动就丢了（界面上先确认过） */
  s.routes.post('/:id/worktree/discard', async (c) => {
    const id = c.req.param('id')!
    if (busyWith(id)) return s.bad(c, t('对话正在执行，等这一轮结束后再删除独立分支'), 409)
    // 父对话正在合并这个子对话：先让它合完（或失败）再丢弃，否则两边同时动分支和工作目录
    if (s.merging.has(id)) return s.bad(c, t('父对话正在合并这个子对话，等结果出来再删除独立分支'), 409)
    const tk = await s.current(id)
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    if (!isolated(tk)) return s.bad(c, t('这个任务没有待处理的独立分支'))
    const project = await s.deps.projects.get(tk.projectId)
    if (!project) return s.bad(c, t('任务所属的项目已经不存在'))
    const wt = tk.worktree!
    const st = await worktreeStatus(project.path, wt).catch(() => null)
    const into = st?.merged ? wt.baseBranch : ''
    // 对话还停在等下一句：先结束这一轮，CLI 的工作目录马上就没了；下一轮按原目录开新会话
    const entry = s.live.get(id)
    if (entry) {
      if (!cancelWait(id)) s.stopTask(id, 'archive')
      await entry.done?.catch(() => {})
    }
    // 父对话测试（ADR 0018）：分支要丢了，父对话不再替它跑这些步骤——取消这一批，父对话目录里那条命令一起停掉，
    // 否则 testing / test-failed 的 hold 会让它永远标不了完成（评审 R4）
    const canceledTest = s.parentTests.cancel(id)
    if (canceledTest && tk.parentTaskId) s.background.stopOne(tk.parentTaskId, canceledTest)
    // 后台命令跑在这个目录里：先停掉并等进程退出，目录删掉后它的结果也没意义了
    await s.background.stop(id)
    try {
      await removeWorktree(project.path, wt, true)
    } catch (e) {
      return s.bad(c, (e as Error).message, 409)
    }
    const cur = (await s.store.get(id)) ?? tk
    // 分支丢弃后没有「合回」这一步了：收尾请求和父对话测试的状态一并清掉，按普通「没有分支可合」的路径收尾。
    // 四种状态里任何一个留着都会让后面某条收尾入口按旧状态说话（评审 R3 / R4）
    if (cur.wrapRequest) cur.wrapRequest = undefined
    // 计划里的收尾步骤也要收口：它停在「已合回，等父对话跑测试」，不收的话 plan hold 会一直拦住完成（评审 R2）
    markWrapUp(cur, 'merge', 'done', '独立分支已删除，不需要合回')
    const next = { ...wt, state: st?.merged ? ('merged' as const) : ('discarded' as const), note: into }
    // 内存里那份任务副本也要一起改：current()、列表摘要（idle）和子对话栏（/children）读的都是它，
    // 只写 store 的话接口还会按旧的 active 算（gone 一直是 false，运行区和计数继续挂着），
    // 而且下一次 PATCH 会拿旧 worktree 把 store 里的 discarded 写回去
    if (entry) {
      entry.task.worktree = next
      entry.rev++
    }
    return c.json(await s.store.update(id, { ...cur, worktree: next }))
  })

  /** 删除对话时，没合并的独立分支一起清掉（只在永久删除时调用，进回收站时目录还留着，见 enterTrash） */
  async function dropWorktree(tk: Task, repo?: string) {
    if (!isolated(tk)) return
    repo ??= (await s.deps.projects.get(tk.projectId))?.path
    if (repo) await removeWorktree(repo, tk.worktree!, true).catch(() => {})
    else await rm(tk.worktree!.path, { recursive: true, force: true }).catch(() => {})
  }

  return { dropWorktree, taskDir, worktreeHome }
}
