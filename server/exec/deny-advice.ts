/**
 * 用户拒绝了 Agent 的权限请求（运行命令、改文件、用工具）之后交给模型的提醒。
 * 只回一句「用户拒绝了这个操作」时，有的模型会把同一条命令原样再发几遍（实测 40 秒里同一条 git commit 被拒 6 次），
 * 用户只能一遍遍点拒绝。所以拒绝时带上「不要重试同样或等价的命令，需要就直接问」；同一个操作被拒到第 2 次，
 * 改成要它停下这一轮、向用户说明需要什么。
 *
 * 面板不替用户拒绝、也不替它停：每次请求照样弹给用户，用户点了才回 CLI（规则：错误要显示、不悄悄重试）。
 * 这里只决定交回去的话怎么说，以及对话里那行「你拒绝了」写不写第几次。
 */
import type { Task, TaskRequest } from '../../shared/schema.ts'
import { t } from '../../shared/i18n.ts'
import type { AskReply } from './parsers.ts'

/** 同一个操作被拒到这一次就要它停下来问用户 */
export const STOP_AFTER_DENIALS = 2

/** 对话 id → 操作 → 拒绝次数。只在内存里：服务重启后 CLI 进程也换了，从头数没关系 */
const denied = new Map<string, Map<string, number>>()

/** 认「同一个操作」：卡片标题里就是命令原文 / 文件路径 / 工具名；详情里有 CLI 写的理由，每次措辞可能不同，不算进去 */
const keyOf = (req: Pick<TaskRequest, 'kind' | 'title'>) => `${req.kind}\n${req.title.replace(/\s+/g, ' ').trim()}`

/** 提示词发给 Agent，不翻译 */
const FIRST =
  '不要用同样或等价的命令重试，也不要换个写法绕过这次拒绝；确实需要这一步的话，直接问用户为什么不行、要怎么做。'
const stopText = (n: number) =>
  `同一个操作用户已经拒绝了 ${n} 次。停下这个做法：不要再请求它或等价的操作，也不要换别的命令绕过；` +
  '结束这一轮，向用户说明你为什么需要它、打算怎么做，等用户决定。'

/**
 * 用户回答了一个请求：拒绝权限请求时在回给 CLI 的话里加上提醒（advice，适配器按协议交给模型），
 * 并返回对话里那行说明要不要改写（第 2 次起写明已让它停下来问）。允许了就把这个操作的计数清掉。
 * 节点确认、提问、面板自己的授权卡（推送）不管：那些拒绝不是「这条命令不许跑」
 */
export function denyAdvice(
  task: Pick<Task, 'id'>,
  req: Pick<TaskRequest, 'kind' | 'title' | 'purpose'>,
  r: AskReply,
): { reply: AskReply; what?: string } {
  if (req.kind === 'confirm' || req.kind === 'question' || req.purpose) return { reply: r }
  const key = keyOf(req)
  const mine = denied.get(task.id)
  if (r.allow) {
    mine?.delete(key)
    if (mine && !mine.size) denied.delete(task.id)
    return { reply: r }
  }
  const n = (mine?.get(key) ?? 0) + 1
  denied.set(task.id, (mine ?? new Map()).set(key, n))
  if (n < STOP_AFTER_DENIALS) return { reply: { ...r, advice: FIRST } }
  return {
    reply: { ...r, advice: stopText(n) },
    what: t('你拒绝了：{title}（第 {n} 次，已让它停下来问你）', { title: req.title, n }),
  }
}
