/**
 * 额度用完、被限流后自动接上（Agent 模式扩展 1，判定在 shared/quota-resume.ts）。
 *
 * 对话这一轮失败收尾后（run.ts 的 finally）调 afterFail：按设置先换备用顺序里的下一个模型马上接着做，
 * 换完了再看能不能「等额度恢复」到点继续。每一步都在对话里写一行（换成了什么、等到几点、为什么没接），
 * 用户事先在设置里打开才会做，默认都关。
 * 接着做走和「继续执行」按钮同一个接口（/:id/resume）：连带拉起子对话、父计划里恢复等它，都不另写一遍。
 * 等的时刻存在对话上（Task.quotaResume.until），面板重启后 arm 时重新排上
 */
import { randomUUID } from 'node:crypto'
import { t } from '../../shared/i18n.ts'
import { defaultAgent, type Task } from '../../shared/schema.ts'
import { agentRun, cliSettings } from '../../shared/settings.ts'
import { canPickRun, withTaskModel } from '../../shared/tasks/run.ts'
import { taskDeleted } from '../../shared/task.ts'
import {
  QuotaResumeSettings,
  lastInputId,
  planQuotaResume,
  quotaFailure,
  untilText,
  type QuotaFallback,
} from '../../shared/quota-resume.ts'
import { getCli } from '../../shared/clis.ts'
import { getLimits } from '../cli-extras.ts'
import { getSettings } from '../settings.ts'
import { taskLog } from './log.ts'
import { log } from '../log.ts'
import type { TasksScope } from './scope.ts'

/** 「Claude Code / opus」：对话里那一行写清换的是哪个 CLI 的哪个模型 */
const runName = (f: { cli: string; model: string }) => `${getCli(f.cli)?.name ?? f.cli} / ${f.model || t('默认模型')}`

export function createQuotaResume(s: TasksScope) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const note = (task: Task, text: string, warn = false) =>
    task.messages.push({
      id: randomUUID(),
      role: 'system',
      agentId: '',
      step: '',
      text,
      tools: [],
      ...(warn && { alert: { kind: 'quota' as const, level: 'warn' as const, detail: text } }),
      at: new Date().toISOString(),
    })

  /** 走「继续执行」同一个接口；没拉起来时把原因写进对话（错误一律显示给用户） */
  async function resume(id: string) {
    const res = await s.routes.request(`/${id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (res.ok) return
    const why = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status)
    taskLog(id, '额度恢复后自动继续没能拉起', { error: why })
    const task = await s.store.get(id)
    if (!task || s.live.has(id)) return
    note(task, t('自动继续没能开始：{error}', { error: why }), true)
    await s.store.update(id, task)
  }

  function schedule(id: string, until: string) {
    clearTimeout(timers.get(id))
    const ms = Math.max(0, Date.parse(until) - Date.now())
    timers.set(
      id,
      setTimeout(
        () => void fire(id, until).catch((e) => log.warn('task', '到点自动继续出错', { task: id, error: e })),
        ms,
      ),
    )
  }

  async function fire(id: string, until: string) {
    timers.delete(id)
    if (s.shuttingDown || s.live.has(id)) return
    const task = await s.store.get(id)
    // 用户已经自己接着做了（重试、发了消息、换了模型）或者删了：这次等待作废
    if (!task || taskDeleted(task) || task.status !== 'failed' || task.quotaResume?.until !== until) return
    const settings = QuotaResumeSettings.parse((await getSettings()).quotaResume ?? {})
    task.quotaResume = { ...task.quotaResume, until: undefined }
    if (!settings.waitReset) {
      note(task, t('到了预计恢复的时间，但「到点自动继续」已经关了，没有自动继续'))
      await s.store.update(id, task)
      return
    }
    note(task, t('到了预计恢复的时间，自动继续'))
    await s.store.update(id, task)
    taskLog(id, '额度恢复，自动继续')
    await resume(id)
  }

  /** 把对话换到备用的那个 CLI / 模型上：不用角色的直接改对话的选择，用角色的记成 modelOverride（同「换个模型重试」） */
  function applySwitch(task: Task, to: QuotaFallback, current: { cli: string }) {
    if (canPickRun(task.agentId)) {
      task.cli = to.cli
      task.model = to.model
      // 换了 CLI 原来的思考强度不一定认，回到新模型的默认；同一个 CLI 留着（不认时 runner 会去掉强度重跑并写一行）
      if (to.cli !== current.cli) task.effort = ''
    } else {
      if (to.cli !== current.cli) task.cli = to.cli
      task.modelOverride = to.model ? { cli: to.cli, model: to.model } : undefined
    }
  }

  /** 对话这一轮失败收尾后调用：不是额度 / 限流、设置没开，什么都不做 */
  async function afterFail(id: string) {
    if (s.shuttingDown || s.live.has(id)) return
    const task = await s.store.get(id)
    if (!task || taskDeleted(task) || task.mode !== 'chat' || task.status !== 'failed' || task.imported) return
    const fail = quotaFailure(task.messages)
    if (!fail) return
    const all = await getSettings()
    const settings = QuotaResumeSettings.parse(all.quotaResume ?? {})
    const agents = await s.deps.agents.list()
    const agent = task.agentId ? agents.find((a) => a.id === task.agentId) : { ...defaultAgent(), id: '' }
    if (!agent) return
    const run = agentRun(withTaskModel(agent, task), all)
    const current = { cli: run.cli, model: run.model }
    const now = Date.now()
    const plan = planQuotaResume({
      settings,
      kind: fail.kind,
      detail: fail.detail,
      current,
      input: lastInputId(task.messages),
      state: task.quotaResume,
      limits: await getLimits(current.cli).catch(() => null),
      now,
      // 停用的 CLI 不换；角色固定了 CLI 时只能换这个 CLI 的模型（换 CLI 就不是这个角色了）
      usable: (f) =>
        !!getCli(f.cli) &&
        cliSettings(all, f.cli).enabled &&
        (canPickRun(task.agentId) || !agent.cli || f.cli === agent.cli),
    })
    const what = fail.kind === 'quota' ? t('额度用完') : t('被限流')
    if (plan.type === 'none') {
      if (plan.why === 'off') return
      if (plan.state) task.quotaResume = plan.state
      note(
        task,
        plan.why === 'max'
          ? t('{what}：这条要求之后已经自动接了 {n} 次，不再自动接，请你处理', { what, n: plan.state?.n ?? 0 })
          : plan.why === 'exhausted'
            ? t('{what}：备用顺序里的都用过了，没有自动继续', { what })
            : plan.why === 'far'
              ? t('{what}：恢复时间太远，没有自动继续', { what })
              : t('{what}：不知道什么时候恢复（可能要充值），没有自动继续', { what }),
        true,
      )
      await s.store.update(id, task)
      taskLog(id, '额度用完，没有自动接', { why: plan.why })
      return
    }
    task.quotaResume = plan.state
    if (plan.type === 'switch') {
      applySwitch(task, plan.to, current)
      note(
        task,
        t('{what}（{from}），按备用顺序换成 {to} 接着做', { what, from: runName(current), to: runName(plan.to) }),
      )
      await s.store.update(id, task)
      taskLog(id, '额度用完，按备用顺序换模型', { from: runName(current), to: runName(plan.to) })
      await resume(id)
      return
    }
    const at = untilText(plan.until, now)
    note(
      task,
      plan.known
        ? t('{what}：预计 {time} 恢复，到点自动继续', { what, time: at })
        : t('{what}：不知道什么时候恢复，{time} 自动再试一次', { what, time: at }),
    )
    await s.store.update(id, task)
    taskLog(id, '额度用完，等到点继续', { until: plan.state.until })
    schedule(id, plan.state.until!)
  }

  return {
    quotaAfterFail: (id: string) =>
      afterFail(id).catch((e) => log.warn('task', '额度用完后自动接上出错', { task: id, error: (e as Error).message })),
    /** 启动后把还在等的对话重新排上（面板重启前排的计时器没了） */
    async armQuota() {
      for (const tk of await s.store.list())
        if (tk.quotaResume?.until && tk.status === 'failed' && !taskDeleted(tk)) schedule(tk.id, tk.quotaResume.until)
    },
    disarmQuota() {
      for (const x of timers.values()) clearTimeout(x)
      timers.clear()
    },
  }
}
