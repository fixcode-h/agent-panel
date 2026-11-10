import path from 'node:path'
import type { Task } from '../../shared/schema.ts'
import { sharesWorkdir } from '../../shared/task.ts'
import { dirBusy, dirPeers, editedLately, type DirFacts, type SharedDirInfo } from '../../shared/shared-dir.ts'
import { checkRepo } from '../exec/worktree.ts'
import { taskLog } from '../task-log.ts'
import { t } from '../../shared/i18n.ts'
import { openTaskWorktree } from './edit-worktree.ts'
import { settleBefore } from './helpers.ts'
import type { TasksScope } from './scope.ts'

/**
 * 几个对话共用一个目录时的提醒（规则见 shared/shared-dir.ts）：
 * 查「同一个目录里有没有别的对话正在改文件」，以及提醒上的「这个对话开独立分支」。
 */
export function registerSharedDirRoutes(s: TasksScope) {
  /** 这棵对话树的顶层对话：一家的（父对话和它的子对话）不互相提醒 */
  async function rootOf(tk: Task) {
    const seen = new Set<string>()
    let x = tk
    while (x.parentTaskId && !seen.has(x.id)) {
      seen.add(x.id)
      const p = await s.current(x.parentTaskId)
      if (!p) break
      x = p
    }
    return x.id
  }

  // 正在动手的对话一定在执行位上：只看它们，不用把整个项目的对话都从盘上读一遍
  async function facts(tk: Task): Promise<DirFacts> {
    const dir = await s.taskDir(tk)
    return {
      id: tk.id,
      title: tk.title,
      dir: dir ? path.resolve(dir) : '',
      root: await rootOf(tk),
      busy: dirBusy(tk),
      edited: editedLately(tk.messages),
    }
  }

  s.routes.get('/:id/shared-dir', async (c) => {
    const tk = await s.current(c.req.param('id')!)
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    const none: SharedDirInfo = { peers: [], canIsolate: false }
    // 只管项目里的对话；已经在（或者下一轮就会回到）自己分支里的不和别人共用目录
    if (!tk.projectId || tk.imported || !sharesWorkdir(tk)) return c.json(none)
    const me = await facts(tk)
    const others = await Promise.all(
      [...s.live.values()]
        .map((e) => e.task)
        .filter((x) => x.id !== tk.id && x.projectId === tk.projectId && dirBusy(x))
        .map(facts),
    )
    const peers = dirPeers(me, others)
    if (!peers.length) return c.json(none)
    // 只有顶层对话能自己开：子对话的目录跟着父对话和项目设置走
    const canIsolate =
      !tk.parentTaskId &&
      (await checkRepo(me.dir).then(
        () => true,
        () => false,
      ))
    return c.json({ peers, canIsolate } satisfies SharedDirInfo)
  })

  /**
   * 「这个对话开独立分支」：从项目现在的提交开出分支和目录，下一句起在里面做。
   * 挂着等下一句的旧进程不用在这里停：交付下一句时发现目录对不上会自己重开（runner 的 stillCurrent），
   * 会话接不上的 CLI 带上之前的对话开新会话（sessionMoved）。
   * 正在回复时不开：这一轮还在原目录里写，换了目录它写的东西就落在两边
   */
  s.routes.post('/:id/isolate', async (c) => {
    const id = c.req.param('id')!
    await settleBefore(s.live.get(id))
    const e = s.live.get(id)
    const tk = e?.task ?? (await s.store.get(id))
    if (!tk) return s.bad(c, t('任务不存在'), 404)
    if (tk.imported) return s.bad(c, s.READONLY, 409)
    if (!tk.projectId || tk.parentTaskId) return s.bad(c, t('只有项目里的顶层对话可以自己开独立分支'))
    if (!sharesWorkdir(tk)) return s.bad(c, t('这个对话已经在独立分支里了'), 409)
    if (dirBusy(tk)) return s.bad(c, t('对话正在执行，等这一轮结束后再开独立分支'), 409)
    const err = await openTaskWorktree(s, tk)
    if (err) return s.bad(c, t('开独立分支失败：{error}', { error: err }))
    taskLog(id, '用户让这个对话开独立分支', { branch: tk.worktree?.branch })
    return c.json(await s.store.update(id, tk, { now: true }))
  })
}
