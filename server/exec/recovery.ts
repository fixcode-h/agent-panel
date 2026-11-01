import type { TaskMessage } from '../../shared/schema.ts'
import { t } from '../../shared/i18n.ts'
import { clip } from '../../shared/text.ts'
import { getCli } from '../../shared/clis.ts'

// 面板自己换做法重跑（丢会话重开、去掉思考强度、断流续接）时写进对话的说明和收口。
// 从 runner.ts 拆出来：纯文字和判断，不碰进程和会话，单测直接测

/**
 * 续接不到原来的会话：Claude Code「No conversation found with session ID」、Pi「No session found matching」、
 * Command Code「No session "x" found to resume」「Session not found」、Codex「no rollout found for thread id」
 * 及 codex.ts 包装的「（thread not found）」。只认「no 会话 … found」「会话 … not found」：宽写法会把
 * cannot / Unknown / Rust 的 thread 'main' panicked 之类误判成会话没了——丢会话重开后算重试过，
 * 断流续接、环境性重试、上下文降级这些自救都不再走
 */
export const SESSION_NOT_FOUND =
  /\bno (?:session|conversation|thread)s?\b[^\n]{0,60}\bfound\b|\b(?:session|conversation|thread)\b(?!\s+'[^'\n]*'\s+panicked)[^\n]{0,40}\bnot found\b|\bno rollout found\b/i

/** 说明后面附上 CLI 的原始报错：面板的判断是按报错文字猜的，猜错了用户要能看出真正出了什么事 */
const withRaw = (text: string, detail: string) => [text, t('原始输出：'), clip(detail.trim(), 300)].join('\n')

/**
 * 丢掉会话重开那一行：前半句是原因，后半句按对话 / 节点、有没有带上之前的对话说明怎么接着做。
 * 写的是已经做了的事，重跑成败都成立，不用收口
 */
export function restartNoteText(why: string, o: { chat: boolean; carried: boolean; detail: string }) {
  const text = !o.chat
    ? t('{why}。已丢掉旧会话、开新会话用完整提示重新执行这一步。', { why })
    : o.carried
      ? t('{why}。已丢掉旧会话、开新会话重新执行这一轮，之前的对话按长度裁剪后一起带上了。', { why })
      : t('{why}。已丢掉旧会话、开新会话重新执行这一轮。', { why })
  return withRaw(text, o.detail)
}

/** CLI 说这个模型不能调思考强度、面板去掉强度重跑那一行 */
export const noEffortRetryText = (model: string, effort: string, detail: string) =>
  withRaw(
    t('模型 {model} 不支持设置思考强度（{effort}），已去掉思考强度重新执行；面板重启前这个模型都不再传思考强度。', {
      model,
      effort,
    }),
    detail,
  )

/**
 * 已经在哪些对话里说过「这个模型的思考强度不传了」（对话 id + CLI + 模型）：markNoEffort 记在进程里、
 * 对所有对话生效，每个对话第一次碰到时说一次。返回 true 表示这次该说（同时记下，之后不再重复）
 */
const noEffortTold = new Set<string>()
export function firstNoEffortTell(key: string) {
  if (noEffortTold.has(key)) return false
  noEffortTold.add(key)
  return true
}

/** 之前被拒过、这一轮没传思考强度那一行：不说的话用户在下拉里选的强度悄悄失效 */
export const noEffortSkippedText = (model: string, effort: string) =>
  t('模型 {model} 之前报过不支持设置思考强度，这一轮没有传思考强度（{effort}）；面板重启前这个模型都不再传。', {
    model,
    effort,
  })

/** 对话换了 CLI 那一行：旧会话是另一个 CLI 的，接不上，新会话带上之前的对话。不说的话看起来像悄悄换了人 */
export const cliSwitchedText = (from: string, to: string) =>
  t('已从 {from} 换成 {to}，之前的会话不再续用，之前的对话会带给新会话。', {
    from: getCli(from)?.name ?? from,
    to: getCli(to)?.name ?? to,
  })

/** 自动续接前写进对话的报错：续接成功后要收回成普通说明 */
export interface NetNote {
  msg: TaskMessage
  base: string
  n: number
}

/**
 * 续接成功了：之前那次断开的报错已经不成立，收成普通说明。
 * 不收的话对话里会一直挂着一张红色的「执行失败」卡片，用户以为这一轮失败了。
 * restarted：续接时原会话没了、换新会话重新执行，不能说「从中断的地方继续了」，新会话是从头做的
 */
export function settleNetNotes(notes: NetNote[], restarted = false) {
  for (const { msg, base, n } of notes) {
    msg.error = undefined
    msg.transient = true
    const done = restarted
      ? t('连接中断后续接不上原来的会话，已开新会话重新执行。')
      : t('已自动续接会话（第 {n} 次），从中断的地方继续了。', { n })
    msg.text = [base, '', done].join('\n')
    const resolved = restarted ? t('续接不上，已开新会话重新执行') : t('已自动续接，从中断的地方继续了')
    if (msg.alert) msg.alert = { ...msg.alert, level: 'warn', resolved }
  }
}
