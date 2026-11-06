/**
 * 失败后怎么办：断线续接、环境性卡住重试的次数和判定，报错里给用户的处理建议（failureHints）。从 runner.ts 拆出
 */
import { REQUEST_TIMEOUT_MS } from './rpc/session.ts'
import type { Task, TaskMessage } from '../../shared/schema.ts'
import { fmtDuration } from '../../shared/duration.ts'
import { getCli } from '../../shared/clis.ts'
import { isGatewayError } from '../../shared/alerts.ts'

import { t } from '../../shared/i18n.ts'
import { thrashHint } from './compaction.ts'

/** 连接断开时自动续接的次数上限 */
export const MAX_NET_RETRIES = 2

/**
 * 环境性失败（请求超时，但进程还活着、一个字都没输出）自动重试的次数上限。
 * 只重试一次：高负载时多等一会儿就能过，等两轮都过不了说明不是等待时间的问题
 */
const MAX_ENV_RETRIES = 1

/**
 * 桥接扩展加载预算：从 CLI 定义里读（mcp.vars.loadBudget），不在这里写死。
 * 没有这个变量的 CLI（codex / claude / commandcode）没有「启动时要把扩展装完」这段预算，返回 0
 */
export function envStallBudget(cliId: string) {
  const budget = Number(getCli(cliId)?.mcp?.vars.loadBudget)
  return Number.isFinite(budget) && budget > 0 ? budget : 0
}

/**
 * 环境性失败重试那一轮的请求超时。
 * 默认的 15 秒是「桥接扩展加载预算 10 秒 + 5 秒给 CLI 冷启动和回包」（见 docs/modules/server-exec/bugs/pi-bridge-tools-timeout.md），
 * 高负载时这段预算会被挤爆；重试轮再留一整份加载预算，25 秒足够覆盖，又不至于让用户白等更久
 */
export function envStallTimeout(cliId: string) {
  return REQUEST_TIMEOUT_MS + envStallBudget(cliId)
}

/**
 * 这一轮该不该因为环境性失败自动重试：只有「进程活着、没有任何响应」的超时算，
 * 模型明确报错、工具失败这些内容性失败不带标记，不会走到这里。
 * 没有加载预算的 CLI 不重试：放宽不了等待，原样重跑一遍既没用、也会让留痕里的「放宽到」说谎
 */
export function shouldRetryEnvStall(o: {
  /** 结果事件带的环境性卡住标记（session 层判定的） */
  stall: boolean
  /** 这一轮已经自动重试过几次 */
  retries: number
  aborted: boolean
  prewarm: boolean
  /** 桥接扩展加载预算（毫秒）：大于 0 才放宽得了 */
  budget: number
}) {
  return o.stall && !o.prewarm && !o.aborted && o.budget > 0 && o.retries < MAX_ENV_RETRIES
}

/** 环境性失败重试前写进对话的说明 */
export function envStallNote(timeoutMs: number, n = MAX_ENV_RETRIES) {
  return t('这一轮没有响应，已自动重试 {n} 次（等待放宽到 {wait}）…', { n, wait: fmtDuration(timeoutMs) })
}

/** 重试也没等到响应时，失败卡片上追加的原因：让用户知道面板已经试过一次 */
export function envStallFailure(n: number) {
  return t('已自动重试 {n} 次，仍然没有响应。', { n })
}

/**
 * 这一轮结束后要不要留着进程等用户下一句（面板保活）：对话模式、不是压缩/审查这类操作、CLI 定义开了 keepAlive。
 * 和 rpc.nativeAsk 无关：那只决定提问和审批走 CLI 自己的协议还是面板的 MCP 工具（见 invoke.ts 的 canTake），
 * 进程能不能留着开下一轮是另一件事；两者混在一起会让原生提问的常驻协议白白每轮重启。
 */
/** 会话压缩过：之前发过的规则段落只剩摘要，下一轮对话按完整提示重发（见 shared/prompt-delta.ts） */
export function forgetPromptSent(task: Task, sessionKey: string) {
  if (task.promptSent?.[sessionKey]) {
    const { [sessionKey]: _gone, ...rest } = task.promptSent
    task.promptSent = rest
  }
  // 没有系统提示词参数的 CLI 只在会话第一条消息里带角色设定：压缩后它也只剩摘要，下一轮要重发
  if (task.roleHashes?.[sessionKey]) {
    const { [sessionKey]: _role, ...roles } = task.roleHashes
    task.roleHashes = roles
  }
}

export function canKeepAlive(o: { chat: boolean; op: boolean; cliKeepAlive: boolean }) {
  return o.chat && !o.op && o.cliKeepAlive
}

/**
 * 这一轮是不是「什么都没收到」：CLI 报了一轮结束，却没有正文、没调工具、没改文件。
 * 这是 CLI 或网关出了问题（网关吞了请求、带图请求被拒），按错误显示给用户，不自动重试。
 * 不再按回复文字猜「只说了一句准备语」：用户 2026-10-29 要求去掉，寒暄、反问这类正常回复会被误判
 * 成没做完，还白白多跑一轮。只说了一句就收尾的回复照常收尾，由用户决定要不要接着说。
 * 「什么都没收到」仍然要拦：否则这一轮会被当成已完成并保活等下一句，
 * 用户发来的消息全落在死回合里，既没有回复也没有报错（见 docs/lessons/execution.md）。
 */
export function silentTurn(o: {
  /** 这一轮产生的所有回复 */
  texts: string[]
  /** 这一轮调用过的工具数 */
  tools: number
  /** 这一轮改过的文件数 */
  changed: number
}) {
  return !o.tools && !o.changed && !o.texts.some((x) => x.trim())
}

/** 环境性失败重试前写进对话的提示：重试成功要收成普通说明 */
export interface EnvStallNote {
  msg: TaskMessage
  base: string
}

/**
 * 重试成功了：这一轮其实做成了，那张红色卡片要收成普通说明，
 * 否则用户会以为这一轮失败了（和断流续接、空回合续一轮一个道理）
 */
export function settleEnvStallNotes(notes: EnvStallNote[]) {
  for (const { msg, base } of notes) {
    msg.error = undefined
    msg.transient = true
    msg.text = [base, '', t('已自动重试 {n} 次，这一轮继续做完了。', { n: MAX_ENV_RETRIES })].join('\n')
    if (msg.alert) msg.alert = { ...msg.alert, level: 'warn', resolved: t('已自动重试，继续做完了') }
  }
}

// Stream idle timeout：Claude Code 的输出中断判定（CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS）触发后以
// 「API Error: Stream idle timeout - no chunks received」结束这一轮，不像连接被断开那样自己重试（2.1.318 实测）
const NETWORK_ERROR =
  /Connection error|APIConnectionError|Unable to connect to the API|Failed to process successful response|Stream connection failed|stream (disconnected|closed|error)|Stream idle timeout|ECONNRESET|ETIMEDOUT|socket hang up|network (error|connection)/i

/** 断流和上游网关断开算同一种网络问题：给连接中断的说明，有会话时自动续接 */
export const isNetError = (detail: string) => NETWORK_ERROR.test(detail) || isGatewayError(detail)

/**
 * 会话在别的项目目录里，CLI 要求交互确认才继续（Pi 的「Session found in different project ... Fork this session into current directory?」）。
 * 面板里没有交互终端，答不了这个问，CLI 直接按 Aborted 退出。撞上了丢掉会话重开
 */
export const SESSION_OTHER_PROJECT = /Session found in different project|Fork this session into current directory/i

/** 模型不支持调整思考强度：去掉 --effort 重跑一次，并在进程内记住 */
export const EFFORT_REJECTED =
  /推理强度不可调整|推理强度.{0,10}(不支持|无法)|(effort|reasoning).{0,40}(not (supported|available|adjustable)|can't|cannot|unable)|(not (supported|adjustable)|can't|cannot|unable).{0,40}(effort|reasoning)/i

const NOT_LOGGED_IN =
  /Please run \/login|Invalid API key|not logged in|log ?in (again|first)|authentication[_ ](error|failed)|OAuth token (has )?expired|token (has )?expired|401 Unauthorized|codex login|refresh token|No API key found/i

/** 各个 CLI 登录的方法：在终端里照着做 */
const loginHow = (cli: string) =>
  ({
    claude: t('运行 claude，在里面输入 /login'),
    codex: t('运行 codex login'),
    commandcode: t('运行 cmdc，按提示登录'),
    pi: t('运行 pi，在里面输入 /login'),
  })[cli] ?? t('运行它并按提示登录')

/** 把常见的 CLI 报错翻译成能照着做的说明，原始输出另外附在后面 */
export function failureHints(detail: string, cli?: { id: string; name: string; compactThrash?: RegExp }) {
  const hints: string[] = []
  if (cli?.compactThrash?.test(detail)) hints.push(thrashHint(cli.name))
  if (NOT_LOGGED_IN.test(detail))
    hints.push(
      t('· {cli} 好像没有登录，或者登录已经过期。请在终端里{how}，登录后回来点「继续执行」。', {
        cli: cli?.name ?? 'Agent',
        how: loginHow(cli?.id ?? ''),
      }),
    )
  const byok =
    /"([^"]+)" routes via Command Code; your providers\.json also declares it — use ((?:"[^"]+"(?: or )?)+)/.exec(
      detail,
    )
  if (byok) {
    const alt = [...byok[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(t(' 或 '))
    hints.push(
      t(
        '· 模型「{model}」走的是 Command Code 官方服务，不是你在 providers.json 里接的接口。想用自己的接口，请把模型换成「{alt}」（模型下拉的「配置文件」分组里）。',
        { model: byok[1], alt },
      ),
    )
  }
  if (isNetError(detail))
    hints.push(
      t(
        '· 和模型服务的连接中途断开了。常见于一次要输出很长的内容（例如写入一个大文件）时，连接被服务端或代理断开；可以点「继续执行」重试，或者换一个接口、让角色分几次写。',
      ),
    )
  // Codex 的线程里存着上一个模型的工具调用时，换成别的模型后接口会一直拒绝这条历史
  if (/input\.content/i.test(detail))
    hints.push(
      t(
        '· 模型接口拒绝了这段聊天记录（input.content 无效或缺失）。常见于在同一个对话里换了模型：Codex 的会话里留着上一个模型的工具调用，新模型接不上。如果反复出现，请新建一个对话。',
      ),
    )
  return hints
}
