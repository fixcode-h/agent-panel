/**
 * 任务页以外的 AI 会话（UI 设计对话、生图、AI 创建 Agent / 工作流、优化项目说明…）的审批和提问。
 * 按会话放在内存里（scope，例如 design:<设计 id>、assist:<生成 id>），页面轮询取回显示成卡片，
 * 用户回答后交回 CLI，CLI 一直等着。任务页的请求跟着任务存（task.requests），规则和这里一样：
 * 审批按设置里的权限，CLI 要确认时才弹出；提问看这个会话的「提问」开关，关着时让 CLI 自己选。
 */
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { RequestAnswer, type TaskRequest } from '../shared/schema.ts'
import type { AskReply, CliEvent } from './exec/parsers.ts'
import { t } from '../shared/i18n.ts'

type AskEvent = Extract<CliEvent, { type: 'ask' }>

/**
 * 「提问」开关关着时交回给 CLI 的话：让它自己选最合适的做法，接着做。
 * 要说清问题根本没交给用户：以前写「用户现在不回答问题」，实测模型会对用户说「你选了不回答、让我按判断继续」，
 * 把自己定的事说成用户的选择（2026-11-15 长对话实测，用户在消息里明确要求用提问卡片问他）
 */
export const AUTO_ANSWER: AskReply = {
  allow: false,
  message:
    '「提问」开关关着，这个问题没有交给用户，用户看不到它，也没有做任何选择：请按你的判断选最合适的方案直接继续，不要再提问。' +
    '向用户说明时写清这是你自己定的（不要说成用户的回答或选择），以及选了什么、不对怎么改；' +
    '用户明确要求由他来决定的，提醒他打开输入框旁的「提问」开关，下次的问题才会交给他。',
}

const pending = new Map<string, { scope: string; req: TaskRequest; reply: (r: AskReply) => void; stop: () => void }>() // 模块状态：会话，跟着进程或连接一起没
const askUser = new Map<string, boolean>() // 模块状态：运行时，提问交不交给用户，重启后回到默认

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

/** 提问窗口的关闭：这个问题不回答，这次会话终止（和点停止一样） */
export function closeAsk(id: string) {
  const p = pending.get(id)
  if (!p) return false
  pending.delete(id)
  p.reply({ allow: false, message: '用户不回答这个问题，终止了这次会话。' })
  p.stop()
  return true
}

/**
 * 一次 CLI 调用用的：askUser、onAsk 直接交给 invokeCli，调用结束后 done() 把没回答的作废
 * （进程已经结束，回答也交不回去了）。
 * stop 是这次会话的停止（和页面上的停止按钮一样）；不给时用 signal：调用方把它并进 invokeCli 的 signal
 */
export function askSession(scope: string, stop?: () => void) {
  const ids: string[] = []
  const ctl = new AbortController()
  return {
    signal: ctl.signal,
    askUser: () => wantsAnswers(scope),
    onAsk: (ev: AskEvent) => {
      const id = randomUUID()
      ids.push(id)
      pending.set(id, {
        scope,
        reply: ev.reply,
        stop: stop ?? (() => ctl.abort()),
        req: {
          id,
          step: '',
          agentId: '',
          kind: ev.kind,
          title: ev.title,
          detail: ev.detail,
          options: ev.options ?? [],
          ...(ev.questions ? { questions: ev.questions } : {}),
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
        const p = RequestAnswer.safeParse(await c.req.json().catch(() => ({})))
        if (!p.success) return c.json({ error: z.prettifyError(p.error) }, 400)
        if (!answerAsk(c.req.param('id'), p.data)) return c.json({ error: t('这个请求已经结束了') }, 404)
        return c.json({ ok: true })
      })
      .post('/:id/close', (c) => {
        if (!closeAsk(c.req.param('id'))) return c.json({ error: t('这个请求已经结束了') }, 404)
        return c.json({ ok: true })
      })
  )
}
