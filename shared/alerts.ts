import { t } from './i18n.ts'
import type { Alert, AlertKind } from './schema.ts'

/**
 * 对话里每一类报错、警告的说明：标题（一行里显示的那句）、这是什么、怎么办。
 * 界面上警告行点开就是这三段加原始信息，用户不用读日志也看得出哪里错了、该做什么。
 * 新加一类报错时在 schema.ts 的 AlertKind 和这里各加一项，docs/alerts.md 里补上说明
 */
export interface AlertInfo {
  title: string
  what: string
  fix: string
}

const INFO: Record<AlertKind, () => AlertInfo> = {
  network: () => ({
    title: t('网络错误'),
    what: t('连不上模型服务，或者连接中途断开了（超时、被代理或服务端断开）。'),
    fix: t(
      '检查网络和代理（Agent 设置里的环境变量，例如 HTTPS_PROXY）；面板会自动续接重试，仍然失败就点「继续执行」，或者换一个接口。',
    ),
  }),
  rate_limit: () => ({
    title: t('被限流'),
    what: t('模型服务返回「请求太多」或「服务过载」（429、529、overloaded），这一轮的请求被拒绝或在排队重试。'),
    fix: t('等一两分钟再继续；经常出现就换一个模型或接口，或者减少同时执行的子对话。'),
  }),
  auth: () => ({
    title: t('登录或密钥失效'),
    what: t('Agent 没有登录、登录过期，或者 API 密钥无效（401、403）。'),
    fix: t('在终端里运行这个 Agent 按提示重新登录，或者到设置的「API 配置」里检查密钥，然后点「继续执行」。'),
  }),
  quota: () => ({
    title: t('额度用完'),
    what: t('账号的余额或用量额度不够了（insufficient balance、quota、billing）。'),
    fix: t('到模型服务的后台充值或等额度恢复；也可以在输入框里换一个模型或接口接着做。'),
  }),
  context: () => ({
    title: t('上下文超长'),
    what: t('这次请求的内容超过了模型的上下文上限，模型拒绝处理。'),
    fix: t(
      '面板会丢掉旧会话、把对话裁剪后开新会话接着做（压缩请求本身也超长时走同一条路）；也可以新开一个对话只带必要的内容。',
    ),
  }),
  model: () => ({
    title: t('模型请求被拒绝'),
    what: t('模型服务拒绝了这次请求：模型名不对、不支持这个参数，或者请求内容不合格式（400、404）。'),
    fix: t('看下面的原始信息确认是哪个参数；在输入框里换一个模型或思考强度后重试。'),
  }),
  cli_missing: () => ({
    title: t('找不到 Agent'),
    what: t('面板找不到要用的 Agent 命令，或者它在设置里被停用了。'),
    fix: t('到设置里确认 Agent 已安装、命令路径正确并且已启用。'),
  }),
  cli_exit: () => ({
    title: t('Agent 执行失败'),
    what: t('Agent 没有正常完成这一轮：报了错，或者中途退出了（崩溃、配置错误）。'),
    fix: t('看下面的原始信息和 stderr；修好后点「继续执行」，也可以点「AI 处理」让 AI 帮你看。'),
  }),
  no_response: () => ({
    title: t('Agent 没有响应'),
    what: t(
      '消息已经交给 Agent，但它一直没有任何输出：多半是它向模型发的请求卡住了（网络、限流、服务没响应），也可能是 Agent 自己卡死了。',
    ),
    fix: t(
      '直接再发一条消息：面板会停掉卡住的 Agent，接着原来的会话重开，把没被处理的消息一起带上。也可以点停止后检查网络。',
    ),
  }),
  idle: () => ({
    title: t('长时间没有输出'),
    what: t('执行中的 Agent 很久没有任何输出，可能卡在登录、网络重连或交互式确认上。'),
    fix: t('再过同样长的时间还没有输出会自动停止；也可以现在点停止，检查网络和登录后再继续。'),
  }),
  timeout: () => ({
    title: t('超过时限'),
    what: t('这一步执行的时间超过了设置里的单步时限，被面板停掉了。'),
    fix: t('点「继续执行」接着做；经常超时就在设置里调大「单步时限」，或者把任务拆小。'),
  }),
  empty_turn: () => ({
    title: t('这一轮没有产出'),
    what: t('模型这一轮没有返回内容，或者只说了一句「我先…」就结束了，没有动手也没有结论。'),
    fix: t('面板会自动再推一次；仍然没有产出就换一个模型，或者把要求写得更具体。'),
  }),
  retry: () => ({
    title: t('正在重试'),
    what: t('Agent 向模型发的请求失败了，它正在自动重试。'),
    fix: t('一般会自己恢复，不用处理；反复重试失败时看原始信息里的原因。'),
  }),
  delivery: () => ({
    title: t('消息没有送到'),
    what: t('面板没能把一条消息（后台命令的结果、子对话的上报、提问的回答）交给这个对话的 Agent。'),
    fix: t('消息已经记在对话里；发一条消息或点「继续执行」，Agent 下一轮会看到它。'),
  }),
  worktree: () => ({
    title: t('独立分支出错'),
    what: t('建立、恢复或删除独立分支（git worktree）时失败了。'),
    fix: t('看原始信息里 git 的报错（常见是目录被占用、有未提交的改动），处理后再继续。'),
  }),
  budget: () => ({
    title: t('超过执行上限'),
    what: t('这次执行用掉的 token 或时长到了计划里设的上限，面板把它停下来了。不是出错：上限是你自己设的。'),
    fix: t('已经产出的内容都保留着。需要接着做就点「继续执行」（会重新计一份额度），或者把计划里的上限调大。'),
  }),
  panel: () => ({
    title: t('面板出错'),
    what: t('面板自己在处理这个对话时出了错。'),
    fix: t('点「继续执行」重试；反复出现请把原始信息复制给开发者，或者点「AI 处理」。'),
  }),
}

export const alertInfo = (kind: AlertKind): AlertInfo => INFO[kind]()

/** 按报错的文字归类：CLI 报的错五花八门，按关键字认出最常见的几类 */
export function classifyError(text: string): AlertKind {
  const s = text.slice(0, 6000)
  if (
    /Please run \/login|Invalid API key|not logged in|log ?in (again|first)|authentication[_ ](error|failed)|token (has )?expired|\b401\b|Unauthorized|\b403\b|Forbidden|No API key found|登录.{0,6}(过期|失效)|未登录/i.test(
      s,
    )
  )
    return 'auth'
  if (/insufficient[_ ](balance|quota|funds)|quota|billing|credit balance|余额不足|额度/i.test(s)) return 'quota'
  if (/\b429\b|\b529\b|rate[_ ]?limit|too many requests|overloaded|限流|过载/i.test(s)) return 'rate_limit'
  if (
    /context[_ ]length|context window|prompt is too long|maximum context|too many tokens|上下文.{0,6}(超|上限)/i.test(s)
  )
    return 'context'
  if (
    /Connection error|APIConnectionError|Unable to connect|Stream connection failed|stream (disconnected|closed|error)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|timed? ?out|网络|连接(中断|失败|断开)/i.test(
      s,
    )
  )
    return 'network'
  if (/找不到命令|command not found|ENOENT|not recognized as an internal|被停用/i.test(s)) return 'cli_missing'
  if (/\b400\b|\b404\b|invalid[_ ]request|model.{0,30}(not found|does not exist|not supported)|未知的模型/i.test(s))
    return 'model'
  if (/worktree|独立分支/i.test(s)) return 'worktree'
  return 'cli_exit'
}

/** 一条报错或警告：kind 不写时按 detail 归类 */
export const makeAlert = (level: Alert['level'], detail: string, kind?: AlertKind): Alert => ({
  kind: kind ?? classifyError(detail),
  level,
  detail,
})
