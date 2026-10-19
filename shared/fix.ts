import { z } from 'zod'

/**
 * 「AI 处理」：哪里报错，就把报错、执行的命令和输出、相关的情况交给本机 CLI（设置里「AI 创建」用的那个），
 * 让它分析原因并动手解决。页面上所有报错的地方用同一个按钮和弹窗（web/src/components/ui/ai-fix.tsx）。
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
  /** 在哪个目录里处理；不写时用用户目录 */
  cwd: z.string().max(1000).default(''),
  /**
   * 报错属于哪一块：服务端据此补上更多情况、选工作目录、处理完后刷新，
   * 例如 cli:<CLI id>（安装、登录）、local-image（本机生图环境）
   */
  topic: z.string().max(100).default(''),
})
export type FixInput = z.infer<typeof FixInput>

export interface FixJob {
  id: string
  title: string
  topic: string
  /** 用哪个 CLI 处理 */
  cli: string
  status: 'running' | 'done' | 'failed'
  /** CLI 的说明（原因、做了什么） */
  text: string
  error?: string
  thinking?: string
  /** 最近用过的工具 */
  tools?: string[]
  startedAt: number
}

/** 给 CLI 的提示词：先找原因再动手，改动要小，最后说清楚结果。提示词固定用中文 */
export function fixPrompt(input: FixInput, env: { os: string; cwd: string; extra?: string }) {
  const block = (title: string, body: string) => (body.trim() ? [`${title}：`, body.trim(), ''] : [])
  return [
    '本机的 Agent 面板（调度 Claude Code、Codex 等编码 CLI 的网页控制台）在操作时出错了，请帮忙分析原因并解决。',
    '',
    `出了什么问题：${input.title}`,
    '',
    ...block('报错', input.error),
    ...(input.command ? ['执行的命令：', '```', input.command, '```', ''] : []),
    ...(input.output.trim() ? ['输出（最后一段）：', '```', input.output.trim().slice(-12_000), '```', ''] : []),
    ...block('其他情况', [input.context, env.extra ?? ''].filter(Boolean).join('\n')),
    `环境：${env.os}；当前目录 ${env.cwd}`,
    '',
    '要求：',
    '1. 先查清楚原因（可以运行只读的命令看文件、版本、路径、环境变量），再动手解决。',
    '2. 只做解决这个问题需要的改动；删除文件、卸载软件、改系统设置前先确认是这个问题相关的东西，不要动用户的项目代码和数据。',
    '3. 需要用户自己做的（例如要管理员权限、要登录、要付费）说清楚具体怎么做，可以给出能直接复制运行的命令。',
    '4. 最后用几句话说明：原因是什么、你做了什么、现在好了没有、还需要用户做什么。',
  ].join('\n')
}
