import { z } from 'zod'

/**
 * 「AI 处理」：哪里报错，就把报错、执行的命令和输出、相关的情况交给本机 CLI（设置里「AI 创建」用的那个），
 * 让它分析原因并动手解决。页面上所有报错的地方用同一个按钮和弹窗（web/src/components/ui/ai-fix.tsx），
 * 每次处理都是聊天里的一个对话，以后能接着看。
 */
export const FixInput = z.object({
  /** 出了什么问题，例如「卸载 Pi 没有成功」 */
  title: z.string().trim().min(1).max(200),
  /** 报错 */
  error: z.string().max(8000).default(''),
  /** 出错时执行的命令 */
  command: z.string().max(2000).default(''),
  /** 命令或过程的输出（只取最后一段） */
  output: z.string().max(40_000).default(''),
  /** 其他有用的情况：在做什么、用的配置 */
  context: z.string().max(8000).default(''),
  /** 报错所在的那一段对话（节选）：让 AI 知道出错时在做什么 */
  conversation: z.string().max(20_000).default(''),
  /** 相关的目录（写进提示里）；不写时用用户目录 */
  cwd: z.string().max(1000).default(''),
  /**
   * 报错属于哪一块：服务端据此补上更多情况、选工作目录、处理完后刷新，
   * 例如 cli:<CLI id>（安装、登录）、local-image（本机生图环境）
   */
  topic: z.string().max(100).default(''),
})
export type FixInput = z.infer<typeof FixInput>

/** 开始处理：在聊天里新建对话用的标题、CLI、模型和第一句话 */
export interface FixStart {
  title: string
  cli: string
  model: string
  prompt: string
}

/**
 * 报错前后的对话：交给 AI 判断「出错时在做什么」。取报错那条前后几条消息，
 * 每条压成一行（太长截断），Agent 的工具调用只留名字，够看出卡在哪一步。
 * 任务的对话和 UI 设计的对话都能用
 */
export interface ConversationLine {
  role: 'user' | 'agent' | 'system'
  text: string
  tools?: { kind?: string; name?: string; label?: string; failed?: boolean }[]
  answers?: { question: string; answer: string }[]
  error?: boolean
}

export function conversationAround(msgs: ConversationLine[], index: number, max = 12_000) {
  const from = Math.max(0, index - 8)
  const to = Math.min(msgs.length, index + 3)
  const line = (m: ConversationLine) => {
    const who = m.role === 'user' ? '用户' : m.role === 'agent' ? 'AI' : m.error ? '报错' : '面板'
    const answers = m.answers?.map((a) => `${a.question}：${a.answer}`).join('；')
    const body = (answers || m.text).trim().replace(/\n{3,}/g, '\n\n')
    const tools = m.tools?.length
      ? `\n（工具：${m.tools
          .map((x) => `${x.name || x.kind} ${x.label}${x.failed ? ' 失败' : ''}`)
          .join('；')
          .slice(0, 600)}）`
      : ''
    return `${who}：${body.slice(0, 1200)}${body.length > 1200 ? '…' : ''}${tools}`
  }
  const text = msgs
    .slice(from, to)
    .filter((m) => m.role !== 'system' || m.error || m.answers?.length)
    .map(line)
    .join('\n\n')
  const tail = '\n…（后面省略）'
  return text.length > max ? `${text.slice(0, max - tail.length)}${tail}` : text
}

/** 给 CLI 的提示词：先找原因再动手，改动要小，最后说清楚结果。提示词固定用中文 */
export function fixPrompt(input: FixInput, env: { os: string; cwd: string; extra?: string }) {
  const block = (title: string, body: string) => (body.trim() ? [`${title}：`, body.trim(), ''] : [])
  return [
    '本机的 Agent 面板（调度 Claude Code、Codex 等编码 CLI 的网页控制台）在操作时出错了，请帮忙分析原因并解决。',
    '',
    `出了什么问题：${input.title}`,
    '',
    ...block('报错', input.error.slice(0, 3000)),
    ...(input.command ? ['执行的命令：', '```', input.command, '```', ''] : []),
    ...(input.output.trim() ? ['输出（最后一段）：', '```', input.output.trim().slice(-8000), '```', ''] : []),
    ...block('其他情况', [input.context, env.extra ?? ''].filter(Boolean).join('\n').slice(0, 5000)),
    ...block('报错前后的对话', input.conversation.slice(-8000)),
    `环境：${env.os}；相关目录（项目路径）：${env.cwd || '未提供'}`,
    '',
    ...(input.conversation.trim()
      ? ['上面是出错前后的对话节选：先看它当时在做什么、哪一步出的错，再判断原因，不要只看报错文字猜。', '']
      : []),
    '要求：',
    '1. 先查清楚原因：相关项目路径见上面，需要时按绝对路径去看项目里的文件、提交记录和日志（这个排查对话本身不在项目里）；也可以运行只读的命令看版本、路径、环境变量。',
    '2. 只做解决这个问题需要的改动；删除文件、卸载软件、改系统设置前先确认是这个问题相关的东西，不要动用户的项目代码和数据。',
    '3. 需要用户自己做的（例如要管理员权限、要登录、要付费）说清楚具体怎么做，可以给出能直接复制运行的命令。',
    '4. 最后用几句话说明：原因是什么、你做了什么、现在好了没有、还需要用户做什么。用户之后可能在这个对话里接着问。',
  ].join('\n')
}
