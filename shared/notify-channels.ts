/**
 * 面板外的通知渠道（设置 →「通知渠道」）：对话等你处理、失败、做完、快到用量上限时，往用户填的 Webhook 发一条。
 * 浏览器通知和标签页标题计数（web/src/lib/notify.ts）在页面关了、人不在电脑前时收不到，这里补上出得了浏览器的那一路。
 *
 * 这个文件只放结构定义和纯函数（消息怎么拼、地址怎么打码、去重），前后端和演示版共用；
 * 什么时候发、怎么投递在 server/notify-channels.ts。schema.ts 贴着行数上限，设置里只引用这里的定义。
 * 不引用 shared/task.ts：schema.ts 要引这个文件，反过来引会成环。
 */
import { z } from 'zod'
import { t } from './i18n.ts'

/**
 * 计划的 Webhook 出站（老配置）：计划跑到终态（成功启动 / 启动失败 / 错过 / 上游没成功）时 POST 一份 JSON。
 * 已经迁成钩子事件 schedule.finished（server/hooks/store.ts 的 migrateWebhook），字段留着只为读老设置。
 * 地址属于外部配置，只存在数据目录的设置里，不写进代码和测试数据；为空时即使打开也不投递
 */
export const ScheduleWebhook = z
  .object({
    enabled: z.boolean().default(false),
    /** 接收地址（http / https）：投递规则见 server/webhook.ts */
    url: z.string().trim().default(''),
  })
  .prefault({})

/**
 * 能勾选的事件：needs 等你处理、failed 失败、done 做完一轮、budget 快到用量上限。
 * 顺序就是界面上勾选框的顺序：最需要人到场的排前面
 */
export const NOTIFY_EVENTS = ['needs', 'failed', 'done', 'budget'] as const
export const NotifyEvent = z.enum(NOTIFY_EVENTS)
export type NotifyEvent = z.infer<typeof NotifyEvent>

/**
 * 消息格式。只做格式确认无误的几种：json 是面板自己的通用 JSON，接到自己的服务、自动化平台上用；
 * 飞书、钉钉、企业微信的群机器人都收纯文本消息（各家的字段名不一样，见 notifyPayload）
 */
export const NOTIFY_TEMPLATES = ['json', 'feishu', 'dingtalk', 'wecom'] as const
export const NotifyTemplate = z.enum(NOTIFY_TEMPLATES)
export type NotifyTemplate = z.infer<typeof NotifyTemplate>

export const NotifyChannel = z.object({
  /** 界面生成：行的 key，也是「最近一次失败」对到哪一行的依据 */
  id: z.string().min(1).max(40),
  name: z.string().trim().max(40).default(''),
  /** Webhook 地址。里面带着机器人的 key，是凭据：只存在数据目录的设置里，日志和报错里一律打码（见 maskUrl） */
  url: z.string().trim().max(1000).default(''),
  template: NotifyTemplate.catch('json').default('json'),
  /** 勾了哪些事件；默认勾「等你处理」和「失败」：这两种不到场就一直卡着 */
  events: z.array(NotifyEvent).max(NOTIFY_EVENTS.length).catch(['needs', 'failed']).default(['needs', 'failed']),
  enabled: z.boolean().catch(true).default(true),
})
export type NotifyChannel = z.infer<typeof NotifyChannel>

/** 设置里的整份列表；手改坏了按空列表读，不连累整份设置被当成损坏文件 */
export const NotifyChannels = z.array(NotifyChannel).max(20).catch([]).default([])

/** 请求最多等多久：接收方挂了不能拖住面板 */
export const NOTIFY_TIMEOUT_MS = 5000
/** 同一个对话同一事件这么久之内不重复发：状态来回抖（请求一条接一条、连着失败）时不刷屏 */
export const NOTIFY_DEDUPE_MS = 60_000

export const notifyEventLabel = (e: NotifyEvent): string =>
  ({ needs: t('等你处理'), failed: t('失败'), done: t('做完'), budget: t('快到用量上限') })[e]

export const notifyTemplateLabel = (x: NotifyTemplate): string =>
  ({ json: t('通用 JSON'), feishu: t('飞书机器人'), dingtalk: t('钉钉机器人'), wecom: t('企业微信机器人') })[x]

/** 一条通知要说的内容。project 为空是 Chat 页的聊天（没有项目） */
export interface NotifyMessage {
  event: NotifyEvent
  project: string
  title: string
  taskId: string
  /** 直达这个对话的地址；测试消息没有具体对话时是面板首页 */
  link: string
  /** budget 事件：已经到了上限、对话树被停下（没经过「快到」直接超的也要说一声），说明换一句 */
  over?: boolean
  /** 「发一条测试」发的：消息里写明，免得被当成真的 */
  test?: boolean
}

/** 事件说明（一句）：写给人看，不带对话标题 */
export function notifyEventText(m: Pick<NotifyMessage, 'event' | 'test' | 'over'>): string {
  const base = {
    needs: t('对话在等你处理：有提问或请求要你回复'),
    failed: t('对话这一轮失败了'),
    done: t('对话这一轮做完了'),
    budget: m.over ? t('对话到了用量上限，已经停下') : t('对话快到用量上限了'),
  }[m.event]
  return m.test ? t('测试消息：{text}', { text: base }) : base
}

/**
 * 每条消息开头固定的那几个字。钉钉、飞书机器人的安全设置选「自定义关键词」时，关键词填它就一定对得上；
 * 设置页的说明里写的也是这个函数的返回值（跟着界面语言变，两边不会对不上）
 */
export const notifyKeyword = () => t('Agent 面板')

/** 纯文本的消息：第一行以 notifyKeyword 开头，项目名和对话标题各占一行，最后一行是直达链接 */
export function notifyText(m: NotifyMessage): string {
  return [
    `${notifyKeyword()} · ${notifyEventText(m)}`,
    m.project ? t('项目：{name}', { name: m.project }) : '',
    m.title ? t('对话：{title}', { title: m.title }) : '',
    m.link,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 按模板拼请求体。三家群机器人的文本消息格式：
 * - 飞书自定义机器人：{ msg_type: 'text', content: { text } }
 * - 钉钉自定义机器人：{ msgtype: 'text', text: { content } }
 * - 企业微信群机器人：{ msgtype: 'text', text: { content } }
 * 通用 JSON 把各字段分开给（字段名写全），text 是和上面同一份拼好的文字，接的一方不想自己拼可以直接用
 */
export function notifyPayload(template: NotifyTemplate, m: NotifyMessage, now = Date.now()): Record<string, unknown> {
  const text = notifyText(m)
  switch (template) {
    case 'feishu':
      return { msg_type: 'text', content: { text } }
    case 'dingtalk':
    case 'wecom':
      return { msgtype: 'text', text: { content: text } }
    case 'json':
      return {
        source: 'agent-panel',
        event: m.event,
        test: !!m.test,
        project: m.project,
        title: m.title,
        taskId: m.taskId,
        message: notifyEventText(m),
        link: m.link,
        text,
        sentAt: new Date(now).toISOString(),
      }
  }
}

/**
 * 机器人接口业务上失败时也回 HTTP 200，原因在响应体里（飞书是 code / msg，钉钉、企业微信是 errcode / errmsg，
 * 例如关键词不对、机器人被停用）。只看 200 会把发不出去的当成成功，这里按模板读出原因；没问题返回空串。
 * 通用 JSON 不看响应体：接的是用户自己的服务，回什么都算收到
 */
export function notifyResponseError(template: NotifyTemplate, body: string): string {
  if (template === 'json') return ''
  let o: Record<string, unknown>
  try {
    o = JSON.parse(body) as Record<string, unknown>
  } catch {
    return ''
  }
  if (!o || typeof o !== 'object') return ''
  // 飞书老接口用 StatusCode，新接口用 code；钉钉、企业微信用 errcode
  const code = template === 'feishu' ? (o.code ?? o.StatusCode) : o.errcode
  if (code === undefined || code === 0) return ''
  const msg = String((template === 'feishu' ? (o.msg ?? o.StatusMessage) : o.errmsg) ?? '').slice(0, 200)
  return msg
    ? t('对方返回错误 {code}：{msg}', { code: String(code), msg })
    : t('对方返回错误 {code}', { code: String(code) })
}

/**
 * 地址打码：只留协议和主机，路径、查询串（机器人的 key 都在这两处）换成 ***。写日志、显示报错时用。
 * 读不懂的地址整个换掉，不冒险原样打出来
 */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url.trim())
    return `${u.protocol}//${u.host}/***`
  } catch {
    return '***'
  }
}

/** 报错文字里万一带着地址（有的网络库会把请求地址写进错误说明），连同它的路径、查询串一起打码 */
export function maskUrlIn(text: string, url: string): string {
  const raw = url.trim()
  if (!raw) return text
  let out = text.split(raw).join(maskUrl(raw))
  try {
    const u = new URL(raw)
    // 地址被拆开写（只带路径和查询串）的情况：路径够长才换，免得把「/」这种到处都有的片段换掉
    const tail = u.pathname + u.search
    if (tail.length > 8) out = out.split(tail).join('/***')
  } catch {}
  return out
}

/** 地址填得对不对：空着、不是 http(s) 返回说明，没问题返回空串 */
export function notifyUrlProblem(url: string): string {
  const s = url.trim()
  if (!s) return t('还没填地址')
  try {
    const u = new URL(s)
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return t('地址要以 http:// 或 https:// 开头')
    return ''
  } catch {
    return t('地址要以 http:// 或 https:// 开头')
  }
}

/** 这个渠道要不要收这个事件：开着、地址填对了、勾了这个事件 */
export const channelWants = (c: NotifyChannel, event: NotifyEvent) =>
  c.enabled && !notifyUrlProblem(c.url) && c.events.includes(event)

/**
 * 直达对话的地址：面板地址 + 对话的路由（和页面里的跳转同一个形状：项目里的对话是 #/projects/<项目>/<对话>，
 * Chat 页的聊天是 #/chat/<对话>）。没有对话（测试消息）时就是面板地址
 */
export function conversationLink(base: string, task?: { id: string; projectId?: string }): string {
  const origin = base.replace(/\/+$/, '')
  if (!task?.id) return origin
  const path = task.projectId ? ['projects', task.projectId, task.id] : ['chat', task.id]
  return `${origin}/#/${path.map(encodeURIComponent).join('/')}`
}

/**
 * 去重：同一个 key（对话 + 事件）在 windowMs 之内只放行第一次。
 * 只在内存里记：面板重启后重发一次无妨，不值得为它落盘；过期的 key 在每次放行时顺手清掉，不会越攒越多
 */
export function createNotifyDedupe(windowMs = NOTIFY_DEDUPE_MS) {
  const sent = new Map<string, number>()
  return {
    /** 返回 true 表示可以发（并记下这一次）；false 表示窗口内发过了 */
    pass(key: string, now = Date.now()): boolean {
      const last = sent.get(key)
      if (last !== undefined && now - last < windowMs) return false
      for (const [k, at] of sent) if (now - at >= windowMs) sent.delete(k)
      sent.set(key, now)
      return true
    },
    size: () => sent.size,
  }
}

/** 设置页每一行下面显示的最近一次投递结果（只在服务端内存里，重启清空） */
export interface NotifyDelivery {
  at: string
  ok: boolean
  /** 失败原因（已打码）；成功为空 */
  error: string
  event: NotifyEvent
  test: boolean
}
