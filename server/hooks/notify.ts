import { isNotifyEvent, hookApplies, type HookDef, type HookEventName, type HookInput } from '../../shared/hook-defs.ts'
import { WEBHOOK_MAX_ATTEMPTS, type ScheduleDelivery, type ScheduleEvent } from '../../shared/schedule.ts'
import { activePlan } from '../../shared/plan.ts'
import type { Task } from '../../shared/schema.ts'
import { t } from '../../shared/i18n.ts'
import { readHooks } from './store.ts'
import { noteTrigger, runHook } from './run.ts'
import { log } from '../log.ts'

/**
 * 只通知的面板事件（ADR 0049 第三期）：对话完成、失败、等你回复、子对话请求收尾、计划完成一步、计划任务跑完。
 * 面板自己发，不经过 CLI，所以四个 CLI 都一样；钩子的输出不看，出错也只记进「最近触发」，不影响对话本身。
 * HTTP 钩子按原来「计划 Webhook」的规矩投递：超时有限、失败最多试 WEBHOOK_MAX_ATTEMPTS 次，接收方挂了不能拖住面板。
 * 原来设置里的「计划 Webhook」就是 schedule.finished 上的一个 HTTP 钩子，老配置在启动时迁过来（store.ts 的 migrateWebhook）
 */

/** 两次投递之间等多久：连着重试多半还是同一个原因失败 */
export const NOTIFY_RETRY_DELAY_MS = 2000

/** 测试注入：默认真的跑钩子、真的发请求 */
export interface NotifyDeps {
  fetchImpl?: typeof fetch
  retryDelayMs?: number
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 一次 HTTP 投递：非 2xx、连不上都按上限重试，结果原样交回（不抛出） */
async function post(def: Extract<HookDef['action'], { type: 'http' }>, input: HookInput, ms: number, deps: NotifyDeps) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  // 请求头的值只引用环境变量：密钥不进钩子定义
  for (const h of def.headers) headers[h.key] = process.env[h.env] ?? ''
  const doFetch = deps.fetchImpl ?? fetch
  let status = 0
  let error = ''
  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    try {
      const r = await doFetch(def.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(ms),
      })
      status = r.status
      if (r.ok) return { ok: true, status, error: '', attempts: attempt }
      error = t('地址返回 {status}', { status: r.status })
    } catch (e) {
      error = (e as Error).message || t('投递失败')
    }
    if (attempt < WEBHOOK_MAX_ATTEMPTS) await delay(deps.retryDelayMs ?? NOTIFY_RETRY_DELAY_MS)
  }
  return { ok: false, status, error, attempts: WEBHOOK_MAX_ATTEMPTS }
}

/**
 * 跑这个事件上所有对得上的用户钩子。返回 HTTP 钩子的投递结果（计划任务记进 lastDelivery 用）；
 * 没有 HTTP 钩子时返回空数组
 */
export async function notifyHooks(
  input: HookInput,
  cwd: string,
  deps: NotifyDeps = {},
): Promise<{ hook: HookDef; ok: boolean; status: number; error: string; attempts: number }[]> {
  if (!isNotifyEvent(input.event)) return []
  const data = await readHooks()
  const out: { hook: HookDef; ok: boolean; status: number; error: string; attempts: number }[] = []
  for (const h of data.hooks.filter((x) => hookApplies(x, input))) {
    const t0 = Date.now()
    let error = ''
    if (h.action.type === 'http') {
      const r = await post(h.action, input, h.timeoutSec * 1000, deps)
      out.push({ hook: h, ...r })
      error = r.error
    } else error = (await runHook(h, input, cwd)).error ?? ''
    noteTrigger({
      at: new Date().toISOString(),
      hookId: h.id,
      name: h.name,
      event: input.event,
      taskId: input.task.id,
      result: error ? 'error' : 'none',
      detail: error,
      ms: Date.now() - t0,
    })
  }
  return out
}

/** 计划任务跑到终态：跑 schedule.finished 的钩子，HTTP 钩子的结果合成一条投递记录（都没有时返回 null，界面不挂「未配置」） */
export async function notifySchedule(
  event: ScheduleEvent,
  payload: Record<string, string>,
  deps: NotifyDeps = {},
): Promise<ScheduleDelivery | null> {
  const input: HookInput = {
    event: 'schedule.finished',
    task: { id: payload.taskId ?? '', title: payload.name ?? '', parent: true },
    project: { id: payload.projectId ?? '', path: '' },
    agent: { id: '', name: '' },
    cli: '',
    schedule: payload,
  }
  const res = await notifyHooks(input, '', deps)
  if (!res.length) return null
  const bad = res.find((r) => !r.ok)
  const pick = bad ?? res[0]
  return {
    at: new Date().toISOString(),
    event,
    ok: !bad,
    status: pick.status,
    error: bad ? (res.length > 1 ? `${bad.hook.name}：${bad.error}` : bad.error) : '',
    attempts: Math.max(...res.map((r) => r.attempts)),
  }
}

/** 计划里做完的步骤（只看最新一份计划，按标题记，重排后也认得出） */
const doneSteps = (task: Pick<Task, 'plans'>) =>
  new Set((activePlan(task)?.steps ?? []).filter((s) => s.status === 'done').map((s) => s.title))

/**
 * 对话前后两份状态之间发生了哪些只通知的事件：和浏览器的「任务完成」通知同一套判断（web/src/lib/notify.ts），
 * 完成以 CLI 完成一轮为准（turnDoneAt 变了），失败看状态变成 failed，等你看 awaitingUser 打开、确认请求变多
 */
export function taskTransitions(
  old: Task | null,
  next: Task,
): { event: HookEventName; notice: NonNullable<HookInput['notice']> }[] {
  if (!old) return []
  const out: { event: HookEventName; notice: NonNullable<HookInput['notice']> }[] = []
  const notice = (step = '') => ({ status: next.status, step })
  if (next.turnDoneAt && next.turnDoneAt !== old.turnDoneAt) out.push({ event: 'task.done', notice: notice() })
  if (next.status === 'failed' && old.status !== 'failed') out.push({ event: 'task.failed', notice: notice() })
  if ((next.awaitingUser && !old.awaitingUser) || (next.requests?.length ?? 0) > (old.requests?.length ?? 0))
    out.push({ event: 'task.waitingUser', notice: notice() })
  if (next.wrapRequest?.state === 'requested' && old.wrapRequest?.state !== 'requested')
    out.push({ event: 'task.wrapRequested', notice: notice(next.wrapRequest.note) })
  const before = doneSteps(old)
  for (const s of doneSteps(next)) if (!before.has(s)) out.push({ event: 'plan.stepDone', notice: notice(s) })
  return out
}

/**
 * 接到任务存储上：每次落盘比一下前后状态，有事件就在后台跑钩子（不等，也不让钩子的错误影响落盘）。
 * 没有任何只通知的钩子时只比几个字段，不读钩子文件以外的东西
 */
export function watchTaskEvents(deps: {
  projectPath: (id: string) => Promise<string>
  agentName: (id: string) => Promise<string>
}): (old: Task | null, next: Task) => void {
  return (old, next) => {
    const evs = taskTransitions(old, next)
    if (!evs.length) return
    void (async () => {
      const data = await readHooks()
      if (!data.hooks.some((h) => h.enabled && isNotifyEvent(h.event))) return
      const cwd = await deps.projectPath(next.projectId).catch(() => '')
      const agentName = await deps.agentName(next.agentId).catch(() => '')
      for (const e of evs)
        await notifyHooks(
          {
            event: e.event,
            task: { id: next.id, title: next.title, parent: !next.parentTaskId },
            project: { id: next.projectId, path: cwd },
            agent: { id: next.agentId, name: agentName },
            cli: next.cli,
            notice: e.notice,
          },
          cwd,
        )
    })().catch((e: Error) => log.warn('hooks', '面板事件的钩子出错', { error: e.message }))
  }
}
