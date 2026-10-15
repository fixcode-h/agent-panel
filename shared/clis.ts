/**
 * 本机 CLI 注册表。新增一种 Agent CLI 只需要在这里加一项：
 * 前端的下拉框、模型建议、命令预览和后端的安装检测都会自动生效。
 */
export interface CliDefinition {
  id: string
  name: string
  /** 可执行文件名，用于检测是否安装以及之后真正启动 */
  command: string
  /** 检测版本时追加的参数 */
  versionArgs: string[]
  /** 模型建议；用户仍可以手填任意模型名 */
  models: { id: string; label: string }[]
  /** 非交互执行时的命令模板，供预览与后续执行器使用 */
  buildArgs: (opts: { model: string; prompt: string; extraArgs: string[] }) => string[]
  docsUrl: string
}

export const CLIS: CliDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    models: [
      { id: 'opus', label: 'Opus（别名，跟随最新）' },
      { id: 'sonnet', label: 'Sonnet（别名，跟随最新）' },
      { id: 'haiku', label: 'Haiku（别名，跟随最新）' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    ],
    buildArgs: ({ model, prompt, extraArgs }) => [
      '-p',
      prompt,
      ...(model ? ['--model', model] : []),
      ...extraArgs,
    ],
    docsUrl: 'https://code.claude.com/docs',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    models: [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { id: 'gpt-5', label: 'GPT-5' },
    ],
    buildArgs: ({ model, prompt, extraArgs }) => [
      'exec',
      ...(model ? ['--model', model] : []),
      ...extraArgs,
      prompt,
    ],
    docsUrl: 'https://github.com/openai/codex',
  },
]

export const getCli = (id: string) => CLIS.find((c) => c.id === id)

/** 把参数拼成一行便于展示的命令 */
export function previewCommand(cliId: string, model: string, extraArgs: string[]): string {
  const cli = getCli(cliId)
  if (!cli) return ''
  const args = cli.buildArgs({ model, prompt: '<任务描述>', extraArgs })
  return [cli.command, ...args.map((a) => (/[\s"'<>]/.test(a) ? JSON.stringify(a) : a))].join(' ')
}
