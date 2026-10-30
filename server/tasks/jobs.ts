import { randomUUID } from 'node:crypto'
import { Task, type TaskMessage } from '../../shared/schema.ts'
import { getSettings } from '../settings.ts'
import { makeAlert } from '../../shared/alerts.ts'
import { holdForNextTurn, removeHeld } from '../exec/delivery.ts'
import { createBackground, jobDetail, jobMs, jobOutput, settleJobRow, uiJobs, type BgJob } from '../background.ts'
import { log } from '../log.ts'
import { t } from '../../shared/i18n.ts'
import { settleWait, waitNote } from '../../shared/plan.ts'
import { taskCliAlive } from '../exec/process.ts'
import type { TasksScope } from './scope.ts'

/**
 * 后台命令：交出去的命令跑完把结果推回对话（推不进去时排队重试，见 docs/modules/server/bugs/background-result-never-back.md）、对话的后台命令列表、结束一个对话的全部后台命令。
 */
export function createJobs(sc: TasksScope) {
  /**
   * 面板替后台命令说的话推回发起的对话：子对话按父对话投递的路子走（正在跑就实时送达，空闲就直接开新一轮），
   * 顶层对话正在跑就实时送达，空闲就直接开新的一轮接着干。送不到要留下记录，不能悄悄丢
   */
  async function pushJobNote(tk: Task, job: BgJob, text: string) {
    if (tk.parentTaskId) {
      const r = await sc.sendToChild(tk.parentTaskId, tk.id, text, 'background')
      if (!r.ok) throw new Error(r.info)
      log.info('background', '后台命令的消息已交给子对话', { task: tk.id, job: job.id, how: r.info })
      return
    }
    const how = await sc.wakeConv(tk.id, text, { panel: 'background' })
    log.info('background', '后台命令的消息已交给对话', { task: tk.id, job: job.id, how })
  }

  /**
   * 后台命令置终态：对话里发起它的那一行（run_background）换成真实的用时和结果。
   * 交出去那一刻 CLI 拿到的是「已放到后台」，那一行记的是 0.09 秒「完成」；不改的话命令跑完了界面也看不出结果
   */
  async function settleJobTool(job: BgJob) {
    const stored = sc.live.has(job.taskId) ? null : await sc.store.get(job.taskId)
    // 读盘期间对话可能开了新的一轮：有执行中的那份就改那份，别拿读出来的旧副本写回去
    const entry = sc.live.get(job.taskId)
    const tk = entry?.task ?? stored
    if (!tk) return
    if (settleJobRow(tk, job.id, jobOutput(job), job.state === 'done', jobMs(job), jobDetail(job))) {
      tk.updatedAt = new Date().toISOString()
      if (entry) entry.rev++
      await sc.store.update(tk.id, tk)
    }
  }

  /**
   * 正在把结果写回工具行的（后台命令编号 → 写回的过程）：推结果前、面板退出前都要等它写完。
   * 没在执行的对话是读出来改完再整份写回的，和推结果开的新一轮并发写会把新消息盖掉
   */
  const settling = new Map<string, Promise<void>>()
  const background = createBackground(
    (job, result) => {
      void (async () => {
        await settling.get(job.id)
        // 范围为 parent 的测试步骤（ADR 0018 / 0020）：结果直接回传给发起的子对话，不推给父对话（那是面板代它跑的）
        if (
          await sc.parentTests.finishJob(job.id, {
            ok: job.state === 'done',
            durationMs: jobMs(job),
            output: job.lines.join('\n').slice(-6000),
          })
        )
          return
        const tk = sc.live.get(job.taskId)?.task ?? (await sc.store.get(job.taskId))
        if (!tk || tk.archived) {
          log.warn('background', '后台命令跑完了，但发起的对话已经不在或已归档，结果没有推回', {
            task: job.taskId,
            job: job.id,
          })
          return
        }
        // 子对话自己跑的项目测试步骤：按后台命令的真实起止时间记耗时（收尾总结里的耗时表要它）
        await sc
          .recordSelfTestRun(job)
          .catch((e) =>
            log.warn('task', '记测试步骤耗时失败', { task: job.taskId, job: job.id, error: (e as Error).message }),
          )
        // 计划里有步骤在等这条命令：成功标完成、失败退回进行中，推回的结果点名先处理这一步
        const hit = settleWait(tk, 'background', job.id, job.state === 'done')
        // 子任务起的命令：结果照常推回这个对话，但要写清是哪个子任务起的，否则父对话看到一条命令不知道来源
        const owner = job.step ? tk.steps.find((s) => s.id === job.step && s.slot === 'sub') : undefined
        const from = owner ? t('这条后台命令是子任务「{title}」起的。\n', { title: owner.title }) : ''
        const text = waitNote(hit) + from + result
        if (hit.length) {
          const entry = sc.live.get(tk.id)
          if (entry) entry.rev++
          else await sc.store.update(tk.id, tk)
        }
        // 父对话替子对话申请的编译：结果直接推给申请的子对话（它们靠这个结果判断能不能请求收尾）
        const forward = sc.buildFor.get(job.id)
        if (forward) {
          sc.buildFor.delete(job.id)
          for (const kid of forward.children)
            await sc
              .sendToChild(
                forward.parent,
                kid,
                `【父对话编译结果】${result}`,
                'build',
                'build',
                /跑完了：失败|被停止了/.test(result),
              )
              .catch((e) => {
                log.warn('task', '编译结果推给子对话失败', { task: kid, error: (e as Error).message })
                sc.alertOn(kid, 'delivery', t('父对话的编译结果没能交给这个对话'), 'error')(e)
              })
        }
        // 结果交给 CLI，但不是用户说的话：记成面板消息，对话里显示成 AI 回复里的一行
        try {
          await pushJobNote(tk, job, text)
        } catch (e) {
          // 第一次没送到（刚好在收尾、执行位被占）：等一下再送一次，还不行就记进对话、留给下一轮，不能丢
          log.warn('background', '后台命令结果推回对话失败，稍后重试', {
            task: tk.id,
            job: job.id,
            error: (e as Error).message,
          })
          await new Promise((r) => setTimeout(r, 3000))
          const cur = sc.live.get(tk.id)?.task ?? (await sc.store.get(tk.id))
          if (!cur) return
          // 第一次没送到时，消息可能已经记进对话、排进了下一轮（wakeConv 先记再等这一轮结束）：撤掉再送，
          // 不然重试和最后的兜底会在对话里留两三条一模一样的结果
          const dup = (m: TaskMessage) => m.panel === 'background' && m.text === text
          for (const m of cur.messages.filter(dup)) removeHeld(cur.id, m.id)
          cur.messages = cur.messages.filter((m) => !dup(m))
          await pushJobNote(cur, job, text).catch(async (err) => {
            for (const m of cur.messages.filter(dup)) removeHeld(cur.id, m.id)
            cur.messages = cur.messages.filter((m) => !dup(m))
            log.error('background', '后台命令结果两次都没推回对话，记进对话留给下一轮', {
              task: tk.id,
              job: job.id,
              error: (err as Error).message,
            })
            const msg: TaskMessage = {
              id: randomUUID(),
              role: 'system',
              agentId: '',
              step: '',
              text,
              tools: [],
              panel: 'background',
              at: new Date().toISOString(),
            }
            const entry = sc.live.get(cur.id)
            cur.messages.push(msg)
            holdForNextTurn(cur.id, msg)
            cur.messages.push({
              id: randomUUID(),
              role: 'system',
              agentId: '',
              step: '',
              text: t('后台命令的结果两次都没能交给 Agent，已经记在对话里，下一轮会处理'),
              tools: [],
              alert: makeAlert('warn', (err as Error).message, 'delivery'),
              at: new Date().toISOString(),
            })
            if (entry) entry.rev++
            await sc.store.update(cur.id, cur)
          })
        }
        // 结果推回去会开新一轮；开不起来时（已停止、已经合并好的）就在这里再试一次回收独立分支
        if (tk.parentTaskId) void sc.settleChildWorktree(tk.id)
      })().catch((e) => {
        log.warn('task', '后台命令结果推回对话失败', { task: job.taskId, error: (e as Error).message })
        sc.alertOn(job.taskId, 'delivery', t('后台命令的结果没能推回这个对话'), 'error')(e)
      })
    },
    {
      onSettle: (job) => {
        const p = settleJobTool(job)
          .catch((e) => {
            log.warn('background', '更新后台命令那一行失败', { task: job.taskId, error: (e as Error).message })
            sc.alertOn(job.taskId, 'panel', t('后台命令跑完了，但没能更新它那一行的结果'))(e)
          })
          .finally(() => settling.get(job.id) === p && settling.delete(job.id))
        settling.set(job.id, p)
      },
      onNotice: (job, text) =>
        void (async () => {
          const tk = sc.live.get(job.taskId)?.task ?? (await sc.store.get(job.taskId))
          if (tk && !tk.archived) await pushJobNote(tk, job, text)
        })().catch((e) => {
          log.warn('background', '提醒对话后台命令没输出失败', { task: job.taskId, error: (e as Error).message })
          sc.alertOn(job.taskId, 'delivery', t('后台命令的提醒没能交给这个对话'))(e)
        }),
      // 同时跑几条在设置里改，改完下一条排名额时就按新的算
      maxRunning: async () => (await getSettings()).backgroundLimit,
    },
  )

  // 上次退出时还没结束的后台命令记录（只在同一个进程里中断时才会留到这时）：不再算「还在跑」，
  // 否则「彻底完成」和合并门禁会一直等一个永远不会来的结束
  void sc.ready.then(() => background.recover()).catch(() => {})
  // 重启前面板正在跑的父对话测试（ADR 0018）：内存里的队列没了，任务上的状态还在，重新排一遍
  void sc.ready
    .then(() => sc.recoverParentTests())
    .catch((e) => log.warn('task', '重启后恢复父对话测试失败', { error: (e as Error).message }))

  /** 发给界面的任务带上还在跑、排队的后台命令（不存盘：进程重启后这些命令也没了） */
  /**
   * 带上还在跑的后台命令。没有也写成空数组：界面靠「有没有这个字段」分辨这份任务是完整推送（带运行时字段）
   * 还是别的接口顺手返回的（没带），后者不能把列表和标题栏的转圈清掉（见 web/src/lib/live-fields.ts）
   */
  const withJobs = (task: Task): Task => ({
    ...task,
    jobs: uiJobs(background.list(task.id)),
    // CLI 进程真的还活着：按进程登记算（见 taskCliAlive），界面不再拿 status / awaitingUser 猜
    cliAlive: taskCliAlive(task.id),
  })

  /**
   * 结束对话的后台命令，连同它名下子对话的：对话停止、归档、删除时调用。
   * CLI 因为页面切走被回收、换 CLI 重启时不调用，那时对话还在，结果推回会接着开一轮
   */
  async function endBackground(id: string) {
    const kids = (await sc.store.list()).filter((x) => x.parentTaskId === id)
    await Promise.all([background.stop(id), ...kids.map((k) => endBackground(k.id))])
  }

  return { background, endBackground, withJobs, settling }
}
