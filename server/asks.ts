/**
 * 任务页以外的 AI 会话（UI 设计对话、生图、AI 创建 Agent / 工作流、优化项目说明…）的审批和提问。
 * 按会话放在内存里（scope，例如 design:<设计 id>、assist:<生成 id>），页面轮询取回显示成卡片，
 * 用户回答后交回 CLI，CLI 一直等着。任务页的请求跟着任务存（task.requests），规则和这里一样：
 * 审批按设置里的权限，CLI 要确认时才弹出；提问看这个会话的「提问」开关，关着时让 CLI 自己选。
 */
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import type { TaskRequest } from '../shared/schema.ts'
import type { AskReply, CliEvent } from './exec/parsers.ts'
import { t } from '../shared/i18n.ts'

type AskEvent = Extract<CliEvent, { type: 'ask' }>

/** 「提问」开关关着时交回给 CLI 的话：让它自己选最合适的做法，接着做 */
export const AUTO_ANSWER: AskReply = {
  allow: false,
  message: '用户现在不回答问题：请按你的判断选最合适的方案直接继续，不要再提问，最后在说明里写一句你选了什么。',
}

const pending = new Map<string, { scope: string; req: TaskRequest; reply: (r: AskReply) => void }>()
const askUser = new Map<string, boolean>()

/** 这个会话的问题要不要交给用户；没设置过时不交（CLI 自己选） */
export const wantsAnswers = (scope: string) => askUser.get(scope) ?? false

/** 开关提问；关掉时还在等回答的问题直接让 CLI 自己选 */
export function setAskUser(scope: string, on: boolean) {
  askUser.set(scope, on)
  if (on) return
  for (const [id, p] of pending)
    if (p.scope === scope && p.req.kind === 'question') {
      pending.delete(id)
      p.reply(AUTO_ANSWER)
    }
}

export const asksOf = (scope: string) => [...pending.values()].filter((p) => p.scope === scope).map((p) => p.req)

/** 某一类会话里有没有在等用户的：例如 design: 开头的，侧栏据此显示感叹号 */
export const askingScopes = () => new Set([...pending.values()].map((p) => p.scope))

export function answerAsk(id: string, r: AskReply) {
  const p = pending.get(id)
  if (!p) return false
  pending.delete(id)
  p.reply(r)
  return true
}

/**
 * 一次 CLI 调用用的：askUser、onAsk 直接交给 invokeCli，调用结束后 done() 把没回答的作废
 * （进程已经结束，回答也交不回去了）
 */
export function askSession(scope: string) {
  const ids: string[] = []
  return {
    askUser: () => wantsAnswers(scope),
    onAsk: (ev: AskEvent) => {
      const id = randomUUID()
      ids.push(id)
      pending.set(id, {
        scope,
        reply: ev.reply,
        req: {
          id,
          step: '',
          agentId: '',
          kind: ev.kind,
          title: ev.title,
          detail: ev.detail,
          options: ev.options ?? [],
          at: new Date().toISOString(),
        },
      })
    },
    done: () => {
      for (const id of ids) pending.delete(id)
    },
  }
}

export function asksApi() {
  const Answer = z.object({ allow: z.boolean(), answer: z.string().max(20000).optional() })
  const Flag = z.object({ scope: z.string().min(1).max(200), askUser: z.boolean() })
  return (
    new Hono()
      .get('/', (c) => c.json(asksOf(c.req.query('scope') ?? '')))
      // 会话的「提问」开关：执行中改也马上生效
      .put('/flag', async (c) => {
        const p = Flag.safeParse(await c.req.json().catch(() => ({})))
        if (!p.success) return c.json({ error: z.prettifyError(p.error) }, 400)
        setAskUser(p.data.scope, p.data.askUser)
        return c.json({ ok: true })
      })
      .post('/:id', async (c) => {
        const p = Answer.safeParse(await c.req.json().catch(() => ({})))
        if (!p.success) return c.json({ error: z.prettifyError(p.error) }, 400)
        if (!answerAsk(c.req.param('id'), p.data)) return c.json({ error: t('这个请求已经结束了') }, 404)
        return c.json({ ok: true })
      })
  )
}
