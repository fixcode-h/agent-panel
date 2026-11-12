import type { TaskBug } from './bug/task-bug.ts'
import { z } from 'zod'
import { BugCollect } from './bug/diagnosis-schema.ts'
import { t } from './i18n.ts'

/**
 * 等你操作（request_user_action）：Agent 要用户离开对话去做一件事（跑一次 PIE、复现、在设备上看效果、
 * 给一个只在用户手里的文件），做完交回结果再接着做。提问只用来让用户拿主意，这类事不走提问
 * （用户 2026-11-05 定的，见 docs/openspec/changes/user-action-wait/design.md）。
 *
 * 不阻塞进程：发起后这一轮正常结束，对话状态归到「等你处理」；用户在输入框发送（交回）、点「完成了」「做不了」「跳过」
 * 时由面板把结果推回去，开新一轮接着做。判定只看用户按了什么，不看贴的内容像不像日志。
 * 只放结构和纯函数（schema.ts 经 task-request.ts 引用它），不引 task.ts，免得循环
 */

/** 要交回什么：步骤和日志写法复用 Bug 复现的那一套（BugCollect），kind 区分只要确认还是要交回东西 */
export const UserActionCollect = BugCollect.extend({
  kind: z.enum(['confirm', 'result']).catch('result').default('result'),
})
export type UserActionCollect = z.infer<typeof UserActionCollect>

export const UserActionStatus = z.enum(['waiting', 'done', 'returned', 'cannot', 'skipped', 'cancelled'])
export type UserActionStatus = z.infer<typeof UserActionStatus>

export const UserAction = z.object({
  id: z.string(),
  title: z.string().max(200),
  why: z.string().max(1000).default(''),
  collect: UserActionCollect,
  /** 最多一个「也可以这样」：拿同一份东西的另一种办法 */
  alternative: z
    .object({ title: z.string().max(200), steps: z.array(z.string().max(500)).max(8).default([]) })
    .optional()
    .catch(undefined),
  /** 用户点「跳过」时它怎么继续：必填，用户才敢跳过 */
  fallback: z.string().max(1000).default(''),
  status: UserActionStatus.default('waiting'),
  /** 交回的文字（输入框里发的原文，截断）和附带的文件路径；做不了时 text 是原因 */
  reply: z
    .object({ text: z.string().max(4000).default(''), files: z.array(z.string()).default([]) })
    .optional()
    .catch(undefined),
  /** 撤掉的原因（对话被停止、发起了新的） */
  reason: z.string().max(300).default(''),
  at: z.string(),
  endedAt: z.string().optional(),
})
export type UserAction = z.infer<typeof UserAction>

/** 一个对话最多留这么多条记录（最近的在最后） */
export const USER_ACTION_KEEP = 20
/** 步骤数上限：再多就该拆成几件事，或者 Agent 自己先做掉一部分 */
const MAX_STEPS = 8

type WithActions = { userActions?: UserAction[] }

/** 这个对话正在等用户做的那一件（一次只挂一件） */
export const pendingAction = (tk: WithActions) =>
  [...(tk.userActions ?? [])].reverse().find((a) => a.status === 'waiting')

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const strs = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : [])
    .map((x) => str(x, max))
    .filter(Boolean)
    .slice(0, MAX_STEPS)

/**
 * request_user_action 的参数整理和校验：返回给 Agent 的话不翻译。
 * bug：用户报的 Bug 对话，复现贴日志、交验证结果都在诊断报告弹窗里，不另开一套
 */
export function requestAction(
  tk: WithActions & { bug?: Pick<TaskBug, 'kind'> },
  input: Record<string, unknown> | undefined,
  id: string,
  now = new Date().toISOString(),
): { ok: boolean; info: string; action?: UserAction } {
  const a = input ?? {}
  if (tk.bug?.kind === 'report')
    return {
      ok: false,
      info: '这是用户报的 Bug：要用户复现贴日志、交验证结果，按流程用 submit_diagnosis / request_logs，在诊断报告弹窗里交，不用 request_user_action。',
    }
  if (pendingAction(tk))
    return {
      ok: false,
      info: '已经有一件在等用户做了：一次只挂一件。几件有先后的事写成同一个请求的几步；等用户交回后再发下一件。',
    }
  const title = str(a.title, 200)
  const c = (a.collect ?? {}) as Record<string, unknown>
  const steps = strs(c.steps ?? a.steps, 500)
  const fallback = str(a.fallback, 1000)
  const miss = [!title && 'title', !steps.length && 'collect.steps', !fallback && 'fallback'].filter(Boolean)
  if (miss.length)
    return {
      ok: false,
      info: `${miss.join('、')} 没写：title 一句话写要用户做什么，collect.steps 写 1~${MAX_STEPS} 步具体动作，fallback 写用户跳过时你怎么继续。`,
    }
  const alt = (a.alternative ?? undefined) as Record<string, unknown> | undefined
  const altTitle = str(alt?.title, 200)
  const action = UserAction.parse({
    id,
    title,
    why: str(a.why, 1000),
    collect: {
      steps,
      where: str(c.where, 500),
      filter: str(c.filter, 300),
      expect: str(c.expect, 2000),
      kind: c.kind === 'confirm' ? 'confirm' : 'result',
    },
    alternative: altTitle ? { title: altTitle, steps: strs(alt?.steps, 500) } : undefined,
    fallback,
    at: now,
  })
  tk.userActions = [...(tk.userActions ?? []), action].slice(-USER_ACTION_KEEP)
  return {
    ok: true,
    info: '已登记，等用户操作。不依赖结果的事可以先做完；做完就结束这一轮，不用调用 end_turn。用户交回、做完、做不了或跳过时，面板会作为新消息推给你。',
    action,
  }
}

/** 用户怎么结束等待：returned 是在输入框里发送了交回的内容 */
export type ActionSettle = 'returned' | 'done' | 'cannot' | 'skipped'

/**
 * 用户结束等待：记下结果，返回推给 Agent 的话（不翻译）。不是在等的那一件时报错（已经交过、被撤掉了）
 */
export function settleAction(
  tk: WithActions,
  actionId: string,
  how: ActionSettle,
  reply: { text?: string; files?: string[] } = {},
  now = new Date().toISOString(),
): { ok: true; action: UserAction; prompt: string } | { ok: false; error: string } {
  const a = tk.userActions?.find((x) => x.id === actionId)
  if (!a) return { ok: false, error: t('这件事已经不在了') }
  if (a.status !== 'waiting') return { ok: false, error: t('这件事已经结束了') }
  const text = (reply.text ?? '').trim()
  if (how === 'cannot' && !text) return { ok: false, error: t('写一下做不了的原因') }
  a.status = how
  a.endedAt = now
  if (text || reply.files?.length) a.reply = { text: text.slice(0, 4000), files: (reply.files ?? []).slice(0, 20) }
  return { ok: true, action: a, prompt: actionPrompt(a) }
}

/** 推给 Agent 的话：交回的内容本身是用户消息的原文，这里只写前面那一句 */
export function actionPrompt(a: Pick<UserAction, 'title' | 'status' | 'fallback' | 'reply'>): string {
  const head = `【面板】`
  switch (a.status) {
    case 'returned':
      return `${head}用户完成了你请求的操作「${a.title}」，下面是交回的内容（附件按路径给出）。按你发起时写的 why 接着做。`
    case 'done':
      return `${head}用户完成了你请求的操作「${a.title}」，没有要交回的内容。接着做。`
    case 'cannot':
      return `${head}用户做不了「${a.title}」：${a.reply?.text ?? ''}。换个办法，或者按你写的退路继续：${a.fallback}`
    case 'skipped':
      return `${head}用户跳过了「${a.title}」。按你写的退路继续：${a.fallback}`
    default:
      return ''
  }
}

/** 对话停止、发起新的一件时撤掉还在等的：返回撤掉的那件 */
export function cancelAction(tk: WithActions, reason: string, now = new Date().toISOString()) {
  const a = pendingAction(tk)
  if (!a) return undefined
  a.status = 'cancelled'
  a.reason = reason.slice(0, 300)
  a.endedAt = now
  return a
}

/** 等了多久（分钟，向下取整） */
export const waitedMinutes = (a: Pick<UserAction, 'at' | 'endedAt'>, now = Date.now()) =>
  Math.max(0, Math.floor(((a.endedAt ? Date.parse(a.endedAt) : now) - Date.parse(a.at)) / 60000))

/** 等待时长的说法：不到 1 分钟单独说，免得写成「0 分钟」 */
export function waitedText(a: Pick<UserAction, 'at' | 'endedAt'>, now = Date.now()): string {
  const m = waitedMinutes(a, now)
  if (m < 1) return t('不到 1 分钟')
  if (m < 60) return t('{n} 分钟', { n: m })
  return t('{h} 小时 {m} 分钟', { h: Math.floor(m / 60), m: m % 60 })
}

/**
 * 提问卡上的「这需要我去操作」：用户觉得这不是要他拿主意，而是要他去做一件事。提问按拒绝结束，
 * 交给 Agent 的就是这句（不翻译）。面板不替用户判断，只给这个出口
 */
export const NOT_A_CHOICE =
  '这不是要用户选的问题，而是要用户去做的事：改用 request_user_action 写清步骤（做什么、交回什么、跳过时你怎么继续），不要再用提问问这件事。'

/** 撤掉的原因：停止对话时写进记录 */
export const CANCEL_STOPPED = () => t('对话被停止了')
