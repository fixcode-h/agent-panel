/**
 * 计划的 Webhook 出站：计划跑到终态（成功启动 / 启动失败 / 错过 / 上游没成功）时，
 * POST 一份 JSON 到设置里填的地址，方便接飞书、Slack、自己的看板。
 *
 * - 地址属于外部配置：只存在数据目录的设置里，不写进代码，测试也用 example.com 这类占位地址
 * - 投递失败只记结果（Schedule.lastDelivery），不抛给调用方，不影响计划本身的执行
 * - 重试次数、超时都有限制：地址挂了不能把面板拖住，也不能一直重试
 */
import { t } from '../shared/i18n.ts'
import {
  WEBHOOK_MAX_ATTEMPTS,
  whenLabel,
  type Schedule,
  type ScheduleDelivery,
  type ScheduleEvent,
} from '../shared/schedule.ts'

/** 一次投递最多等多久（毫秒）：计划本身不等它，超时只记投递失败 */
export const WEBHOOK_TIMEOUT_MS = 5000
/** 两次投递之间等多久（毫秒）：连着重试多半还是同一个原因失败 */
export const WEBHOOK_RETRY_DELAY_MS = 2000

/** 设置里的 Webhook 配置（Settings.webhook） */
export interface WebhookConfig {
  enabled: boolean
  url: string
}

/**
 * 投递出去的 JSON：能对上是哪个计划、哪一轮、结果如何。
 * 字段名写全（不缩写成 pid / ts 这类），接的一方不用看代码猜。
 */
export interface WebhookPayload {
  /** run 成功启动 / fail 启动失败 / miss 错过 / blocked 上游没成功 */
  event: ScheduleEvent
  scheduleId: string
  name: string
  projectId: string
  /** 项目名；聊天模式或项目已被删掉时为空 */
  projectName: string
  repeat: string
  /** 这一轮到点的时间（ISO）：失败 / 错过 / 没启动时就是它 */
  at: string
  /** 成功启动时的对话 id，其余为空 */
  taskId: string
  /** 失败 / 没启动 / 错过的原因，成功时为空 */
  error: string
  /** 发出这份载荷的时间（ISO） */
  sentAt: string
}

/** 拼一份载荷：纯函数，服务端和单测都用它 */
export function webhookPayload(
  s: Schedule,
  event: ScheduleEvent,
  /** 这一轮到点的时间（计划成功后 at 已经推到下一次，不能再用 s.at） */
  at: string,
  projectName = '',
  now = Date.now(),
): WebhookPayload {
  return {
    event,
    scheduleId: s.id,
    name: s.name,
    projectId: s.projectId,
    projectName,
    repeat: s.repeat,
    at,
    taskId: event === 'run' ? s.lastTaskId : '',
    error: eventError(s, event, at),
    sentAt: new Date(now).toISOString(),
  }
}

/**
 * 这一轮事件的原因。别用 lastError 当通用兜底：启动失败后 lastError 会一直留着，
 * 后面一次的「错过」「上游没成功」会被写成上一次的失败原因，接的一方对不上号。
 * at 是这一轮的到点时间：用户同时改过排期时 writeBack 会丢掉 missedAt，
 * 这时用 at 当错过的那一次，不能把时间位置空着。
 */
function eventError(s: Schedule, event: ScheduleEvent, at: string): string {
  switch (event) {
    case 'run':
      return ''
    case 'fail':
      return s.lastError
    case 'miss':
      return t('错过 {time}（面板当时没在跑，不补跑）', { time: whenLabel(s.missedAt || at) })
    case 'blocked':
      return s.blockedReason || t('上游没有成功，没有启动')
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 地址能不能用：只接受 http / https，别的协议不当 Webhook 发 */
function parseUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/**
 * 投递一次，失败按 WEBHOOK_MAX_ATTEMPTS 重试。
 * 返回 null 表示没开或者没填地址（不记录，免得界面上一直挂一条「未配置」）；
 * 其余情况一定返回结果，不抛异常——调用方只负责把它记进计划。
 */
export async function deliverWebhook(
  config: WebhookConfig,
  event: ScheduleEvent,
  payload: WebhookPayload,
  opts: {
    /** 测试注入：默认用全局 fetch */
    fetchImpl?: typeof fetch
    /** 测试注入：默认 WEBHOOK_RETRY_DELAY_MS */
    retryDelayMs?: number
  } = {},
): Promise<ScheduleDelivery | null> {
  if (!config.enabled) return null
  const raw = config.url.trim()
  // 开了但还没填地址：当没配置，不记录，免得界面上一直挂一条「地址无效」
  if (!raw) return null
  const url = parseUrl(raw)
  if (!url) {
    // 填了但不是 http / https：记一条结果，用户在计划卡片上能看到投递没有生效
    return { at: new Date().toISOString(), event, ok: false, status: 0, error: t('Webhook 地址无效'), attempts: 0 }
  }
  const doFetch = opts.fetchImpl ?? fetch
  const retryDelayMs = opts.retryDelayMs ?? WEBHOOK_RETRY_DELAY_MS
  let error = ''
  let status = 0
  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        // 超时用 signal：地址不响应时不能把这次投递一直挂着
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })
      status = res.status
      if (res.ok) return { at: new Date().toISOString(), event, ok: true, status, error: '', attempts: attempt }
      error = t('地址返回 {status}', { status: res.status })
    } catch (e) {
      error = (e as Error).message || t('投递失败')
    }
    if (attempt < WEBHOOK_MAX_ATTEMPTS) await delay(retryDelayMs)
  }
  return { at: new Date().toISOString(), event, ok: false, status, error, attempts: WEBHOOK_MAX_ATTEMPTS }
}
