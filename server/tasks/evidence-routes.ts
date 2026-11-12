/**
 * Bug 诊断「取证」的两组接口（分析稿 B1、B3）：
 * - 排查补丁放到用户工作区 / 还原（server/tasks/bug-patch.ts）；
 * - 面板自己取日志：开始复现记起点、复现完了取新增（server/tasks/bug-log-watch.ts）。
 * 都只在诊断报告等用户的那一步用，状态存对话数据目录（TASK_FILES_DIR/<对话>/evidence），不进任务数据
 */
import path from 'node:path'
import { z } from 'zod'
import { t } from '../../shared/i18n.ts'
import { patchFilesOf, patchKindOf, type PatchResult, type PatchStatus } from '../../shared/bug-patch.ts'
import type { Task } from '../../shared/schema.ts'
import { TASK_FILES_DIR } from '../store.ts'
import { appliedOf, applyPatch, forgetPatch, loadPatch, restorePatch } from './bug-patch.ts'
import { fetchWatch, loadMark, startWatch } from './bug-log-watch.ts'
import type { LogWatchStatus } from '../../shared/bug-log-watch.ts'
import { isGit } from './helpers.ts'
import type { TasksScope } from './scope.ts'

const PatchAction = z.object({ action: z.enum(['apply', 'restore', 'forget']) })
const WatchAction = z.object({
  action: z.enum(['start', 'fetch']),
  /** 报告里写的日志文件在项目目录外面：用户在页面上点了确认 */
  confirm: z.boolean().default(false),
})

const stateDir = (taskId: string, kind: 'patch' | 'log') => path.join(TASK_FILES_DIR, taskId, 'evidence', kind)

export function registerEvidenceRoutes(s: TasksScope) {
  const taskOf = async (id: string) => s.live.get(id)?.task ?? (await s.store.get(id))

  /** 只对 Git 项目、对话在独立分支里时有补丁这回事（P4 / SVN / 共用目录：改动本来就在工作区，或没法保证还原干净） */
  const patchCtx = async (task: Task) => {
    const wt = task.worktree?.state === 'active' ? task.worktree : null
    const project = wt && !task.imported ? await s.deps.projects.get(task.projectId) : null
    if (!wt || !project?.path || !(await isGit(project.path))) return null
    return {
      wt: wt.path,
      project: project.path,
      baseRef: task.baseRef,
      baseBranch: wt.baseBranch,
      stateDir: stateDir(task.id, 'patch'),
    }
  }
  const statusOf = async (task: Task, eligible: boolean): Promise<PatchStatus> => ({
    eligible,
    // 分支已经合并 / 丢弃了、补丁还在工作区的也要报出来：取消确认框靠它提醒先还原
    applied: appliedOf(await loadPatch(stateDir(task.id, 'patch'))),
  })

  s.routes.get('/:id/diagnosis-patch', async (c) => {
    const task = await taskOf(c.req.param('id'))
    if (!task) return s.bad(c, t('任务不存在'), 404)
    return c.json(await statusOf(task, !!(await patchCtx(task))))
  })

  s.routes.post('/:id/diagnosis-patch', async (c) => {
    const body = PatchAction.safeParse(await c.req.json())
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const task = await taskOf(c.req.param('id'))
    if (!task) return s.bad(c, t('任务不存在'), 404)
    const ctx = await patchCtx(task)
    const dir = stateDir(task.id, 'patch')
    const reply = async (r: { ok: boolean; reason: string; files: string[] }) =>
      c.json({ ...r, status: await statusOf(task, !!ctx) } satisfies PatchResult)
    if (body.data.action === 'forget') {
      await forgetPatch(dir)
      return reply({ ok: true, reason: '', files: [] })
    }
    if (body.data.action === 'restore') {
      // 还原只要项目目录和快照：分支后来合并、丢弃了也要能还原
      const project = ctx?.project ?? (await s.deps.projects.get(task.projectId))?.path
      if (!project) return s.bad(c, t('找不到项目目录'), 409)
      return reply(await restorePatch({ project, stateDir: dir }))
    }
    if (!ctx) return s.bad(c, t('只有 Git 项目里开了独立分支的对话才能把改动放到你的工作区'), 409)
    // 放哪种、放哪些文件由服务端按报告算（不信页面传的）：等你复现时是日志计划里的文件，验证时是方案里的文件
    const list = task.bug?.diagnoses ?? []
    const kind = patchKindOf(list.at(-1))
    if (!kind) return s.bad(c, t('现在不是等你复现或验证的时候，没有要放的改动'), 409)
    // 它还在改文件时取出来的是改到一半的内容
    if (task.working) return s.bad(c, t('它正在回复，等这一轮结束再放'), 409)
    return reply(await applyPatch(ctx, kind, patchFilesOf(list, kind)))
  })

  s.routes.get('/:id/diagnosis-log', async (c) => {
    const m = await loadMark(stateDir(c.req.param('id'), 'log'))
    return c.json({ started: m && { path: m.path, at: m.at } } satisfies LogWatchStatus)
  })

  s.routes.post('/:id/diagnosis-log', async (c) => {
    const body = WatchAction.safeParse(await c.req.json())
    if (!body.success) return s.bad(c, z.prettifyError(body.error))
    const task = await taskOf(c.req.param('id'))
    if (!task) return s.bad(c, t('任务不存在'), 404)
    const d = task.bug?.diagnoses?.at(-1)
    const where = (d?.awaiting?.collect ?? d?.collect)?.where
    const project = task.imported ? undefined : (await s.deps.projects.get(task.projectId))?.path
    if (!project) return s.bad(c, t('找不到项目目录'), 409)
    const dirs = {
      project,
      work: await s.taskDir(task).catch(() => project),
      stateDir: stateDir(task.id, 'log'),
    }
    // 拒绝也按 200 回（带 ok: false 和说明）：页面要区分「要你确认」和别的原因，把说明显示在面板里
    return c.json(
      body.data.action === 'start'
        ? await startWatch(where, dirs, body.data.confirm)
        : await fetchWatch(where, dirs, body.data.confirm),
    )
  })
}
