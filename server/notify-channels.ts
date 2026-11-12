/**
 * 面板外的通知渠道（设置 →「通知渠道」，分析稿 A5）：对话等你处理、失败、做完、快到用量上限时往用户填的 Webhook 发一条。
 *
 * 挂在任务落盘的监听上（onTaskChange），和钩子的面板事件（server/hooks/notify.ts 的 taskTransitions）是同一个触发点，
 * 不另造一套事件判定：失败、做完直接取它比出来的 task.failed / task.done；「等你处理」按 shared/task.ts 的 taskState
 * 前后对比（和侧栏、标题栏同一个结论）；「快到用量上限」看 Task.budgetNotice 升级（server/tasks/budget.ts 写的）。
 *
 * 投递规矩：超时 NOTIFY_TIMEOUT_MS，失败只写日志、记到那一行的「最近一次」里，不重试、不等它、不影响对话本身。
 * 地址里带着机器人的 key：日志和报错里一律打码（maskUrl / maskUrlIn）。
 * 消息格式、打码、去重这些纯函数在 shared/notify-channels.ts。
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { Task } from '../shared/schema.ts'
import { taskState } from '../shared/task.ts'
import { t } from '../shared/i18n.ts'
import {
  channelWants,
  conversationLink,
  createNotifyDedupe,
  maskUrl,
  maskUrlIn,
  NOTIFY_TIMEOUT_MS,
  NotifyChannel,
  notifyPayload,
  notifyResponseError,
  notifyUrlProblem,
  type NotifyDelivery,
  type NotifyEvent,
  type NotifyMessage,
} from '../shared/notify-channels.ts'
import { taskTransitions } from './hooks/notify.ts'
import { onTaskChange } from './task-store.ts'
import { getSettings } from './settings.ts'
import { remotePublicUrl } from './remote.ts'
import { log } from './log.ts'

/** 测试注入：默认真的发请求 */
export interface SendDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * 面板地址：开了外网访问且连上了用外网地址（人不在电脑前才最需要这条通知），否则用本机地址。
 * 本机地址按 PORT 拼：服务起来后 index.ts 会把实际端口写回 process.env.PORT
 */
export const panelBase = () => remotePublicUrl() || `http://127.0.0.1:${process.env.PORT ?? 8787}`

/** 每个渠道最近一次投递的结果（只在内存里）：设置页在那一行显示失败原因 */
const last = new Map<string, NotifyDelivery>() // 模块状态：运行时，最近一次投递结果，重启后不再显示
export const notifyDeliveries = (): Record<string, NotifyDelivery> => Object.fromEntries(last)

/**
 * 发一条：只试一次。非 2xx、连不上、超时、机器人业务上拒收（HTTP 200 但响应体里是错误码）都算失败，
 * 原因打码后交回，不抛出
 */
export async function sendToChannel(
  channel: Pick<NotifyChannel, 'url' | 'template'>,
  msg: NotifyMessage,
  deps: SendDeps = {},
): Promise<{ ok: boolean; error: string }> {
  const bad = notifyUrlProblem(channel.url)
  if (bad) return { ok: false, error: bad }
  try {
    const r = await (deps.fetchImpl ?? fetch)(channel.url.trim(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(notifyPayload(channel.template, msg)),
      signal: AbortSignal.timeout(deps.timeoutMs ?? NOTIFY_TIMEOUT_MS),
    })
    if (!r.ok) return { ok: false, error: t('地址返回 {status}', { status: r.status }) }
    const error = notifyResponseError(channel.template, await r.text().catch(() => ''))
    return { ok: !error, error }
  } catch (e) {
    const err = e as Error
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError'
    const sec = Math.max(1, Math.round((deps.timeoutMs ?? NOTIFY_TIMEOUT_MS) / 1000))
    return {
      ok: false,
      error: timeout ? t('{sec} 秒内没有回应', { sec }) : maskUrlIn(err.message || t('投递失败'), channel.url),
    }
  }
}

/** 发一条并记下结果；失败写日志（地址打码）。给事件和「发一条测试」共用 */
export async function deliver(channel: NotifyChannel, msg: NotifyMessage, deps: SendDeps = {}) {
  const r = await sendToChannel(channel, msg, deps)
  last.set(channel.id, { at: new Date().toISOString(), ok: r.ok, error: r.error, event: msg.event, test: !!msg.test })
  if (!r.ok)
    log.warn('notify', '通知渠道投递失败', {
      channel: channel.name || channel.id,
      url: maskUrl(channel.url),
      event: msg.event,
      task: msg.taskId,
      error: r.error,
    })
  return r
}

const rank = (x?: string) => (x === 'over' ? 2 : x === 'warn' ? 1 : 0)

/**
 * 任务前后两份状态之间该发哪些通知。纯函数，单测直接喂两份任务。
 * - needs：taskState 从别的状态变成「等你处理」（提问、确认请求出现）；已经在等的时候又多一条请求不再发
 * - failed：钩子事件 task.failed
 * - done：钩子事件 task.done（CLI 完成一轮）。只发顶层对话：子对话做完一轮是交给父对话的，一棵树十几个子对话
 *   各发一条等于刷屏；这一轮结束时正好在等你处理或失败了的不算做完，那两种各有各的通知
 * - budget：用量提醒升级（没到 → 快到 → 到了），回落（调高了上限）不发
 */
export function channelEvents(old: Task | null, next: Task): { event: NotifyEvent; over?: boolean }[] {
  if (!old) return []
  const out: { event: NotifyEvent; over?: boolean }[] = []
  const hooks = new Set(taskTransitions(old, next).map((e) => e.event))
  const now = taskState(next)
  if (now === 'needs' && taskState(old) !== 'needs') out.push({ event: 'needs' })
  if (hooks.has('task.failed')) out.push({ event: 'failed' })
  if (hooks.has('task.done') && !next.parentTaskId && now !== 'needs' && next.status !== 'failed')
    out.push({ event: 'done' })
  if (rank(next.budgetNotice) > rank(old.budgetNotice))
    out.push({ event: 'budget', over: next.budgetNotice === 'over' })
  return out
}

/**
 * 接到任务存储上。回调同步返回，投递都在后台：一个渠道慢或挂了不拖住落盘，也不拖住别的渠道。
 * 没配渠道时只比几个字段、读一次设置（内存里有缓存）
 */
export function watchNotifyChannels(
  deps: { projectName: (id: string) => Promise<string> },
  send: SendDeps = {},
): (old: Task | null, next: Task) => void {
  const dedupe = createNotifyDedupe()
  return (old, next) => {
    // 导入的、进了回收站的对话不会再有人处理，不通知
    if (next.imported || next.deletedAt) return
    const evs = channelEvents(old, next)
    if (!evs.length) return
    void (async () => {
      const channels = (await getSettings()).notifyChannels
      if (!channels.some((c) => c.enabled)) return
      let project: string | undefined
      for (const e of evs) {
        const want = channels.filter((c) => channelWants(c, e.event))
        if (!want.length) continue
        // 去重按对话 + 事件；用量的「快到」和「到了」是两回事，分开记，不然刚提醒完就超的那条会被吞掉
        if (!dedupe.pass(`${next.id}|${e.event}${e.over ? '|over' : ''}`)) continue
        project ??= next.projectId ? await deps.projectName(next.projectId).catch(() => '') : ''
        const msg: NotifyMessage = {
          event: e.event,
          over: e.over,
          project,
          title: next.title,
          taskId: next.id,
          link: conversationLink(panelBase(), next),
        }
        for (const c of want) void deliver(c, msg, send)
      }
    })().catch((e: Error) => log.warn('notify', '通知渠道出错', { error: e.message }))
  }
}

const TestBody = z.object({ channel: NotifyChannel })

/** 设置页用的接口：各行最近一次投递结果、发一条测试。给了 deps 时顺带接上任务事件 */
export function notifyChannelsApi(deps?: { projects: { get: (id: string) => Promise<{ name: string } | null> } }) {
  if (deps) onTaskChange(watchNotifyChannels({ projectName: async (id) => (await deps.projects.get(id))?.name ?? '' }))
  return new Hono()
    .get('/status', (c) => c.json(notifyDeliveries()))
    .post('/test', async (c) => {
      // 用界面上正在编辑的这一行发（可能还没自动保存下去），不读已存的设置
      const p = TestBody.safeParse(await c.req.json().catch(() => null))
      if (!p.success) return c.json({ error: t('渠道信息不完整') }, 400)
      const r = await deliver(p.data.channel, {
        event: 'needs',
        test: true,
        project: t('示例项目'),
        title: t('这是一条测试消息，收到说明这个渠道通了'),
        taskId: '',
        link: conversationLink(panelBase()),
      })
      return c.json({ ...r, status: notifyDeliveries() })
    })
}
