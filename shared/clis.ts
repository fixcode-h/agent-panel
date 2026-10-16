/**
 * 本机 CLI 注册表。新增一种 Agent CLI 需要：
 * 1. 在这里加一项（命令、模型建议、权限选项、参数拼装）
 * 2. 在 server/exec/parsers.ts 里加它的输出解析
 * 3. 在 web/src/lib/cli-style.ts 里加一个标识色
 *
 * 所有 CLI 都用「非交互 + 结构化输出」模式运行，任务描述通过 stdin 传入，
 * 避免长文本、换行和引号在不同系统的命令行里转义出错。
 */
export interface PermissionOption {
  id: string
  label: string
  hint: string
}

export interface BuildOptions {
  model: string
  permission: string
  extraArgs: string[]
  /** 续接的会话 id；为空表示新会话 */
  resume?: string
  /** 追加的系统提示词（只有支持的 CLI 会用到，其余拼进任务描述） */
  systemPrompt?: string
  maxTurns?: number
}

export interface CliDefinition {
  id: string
  name: string
  /** 默认可执行文件名；可以在设置里改成完整路径 */
  command: string
  versionArgs: string[]
  /** 模型建议；用户仍可以手填任意模型名 */
  models: { id: string; label: string }[]
  permissions: PermissionOption[]
  defaultPermission: string
  /** 是否支持 --append-system-prompt 这类参数 */
  systemPromptFlag: boolean
  /** 非交互执行的参数（不含任务描述，任务描述走 stdin） */
  buildArgs: (o: BuildOptions) => string[]
  installHint: string
  docsUrl: string
}

const opt = (cond: unknown, ...args: string[]) => (cond ? args : [])

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
    permissions: [
      { id: 'acceptEdits', label: '自动接受改文件', hint: '可以直接读写文件；需要审批的命令会被拒绝' },
      { id: 'bypassPermissions', label: '跳过所有确认', hint: '可以执行任意命令，只在信任的项目里用' },
      { id: 'plan', label: '只读规划', hint: '只分析和出方案，不改文件' },
      { id: 'default', label: '默认', hint: '非交互模式下需要审批的操作都会被拒绝' },
    ],
    defaultPermission: 'acceptEdits',
    systemPromptFlag: true,
    buildArgs: (o) => [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...opt(o.model, '--model', o.model),
      ...(o.permission === 'bypassPermissions'
        ? ['--dangerously-skip-permissions']
        : opt(o.permission && o.permission !== 'default', '--permission-mode', o.permission)),
      ...opt(o.resume, '--resume', o.resume!),
      ...opt(o.systemPrompt, '--append-system-prompt', o.systemPrompt!),
      ...opt(o.maxTurns, '--max-turns', String(o.maxTurns)),
      ...o.extraArgs,
    ],
    installHint: 'npm install -g @anthropic-ai/claude-code',
    docsUrl: 'https://code.claude.com/docs',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    models: [
      { id: 'gpt-5.6', label: 'GPT-5.6' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    ],
    permissions: [
      { id: 'workspace-write', label: '可写项目目录', hint: '沙箱内运行，只能改项目目录里的文件' },
      { id: 'read-only', label: '只读', hint: '只能读文件和跑只读命令' },
      { id: 'danger-full-access', label: '完全访问', hint: '不使用沙箱、不确认，只在信任的项目里用' },
    ],
    defaultPermission: 'workspace-write',
    systemPromptFlag: false,
    // resume 子命令不支持 -s，沙箱统一用 -c 配置
    buildArgs: (o) => [
      'exec',
      ...opt(o.resume, 'resume', o.resume!),
      '--json',
      '--skip-git-repo-check',
      ...opt(o.model, '-m', o.model),
      ...(o.permission === 'danger-full-access'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['-c', `sandbox_mode="${o.permission || 'workspace-write'}"`]),
      ...o.extraArgs,
      '-',
    ],
    installHint: 'npm install -g @openai/codex',
    docsUrl: 'https://github.com/openai/codex',
  },
  {
    id: 'commandcode',
    name: 'Command Code',
    // npm 包同时提供 cmd / cmdc / commandcode；Windows 上 cmd 会和系统命令冲突，所以默认用 cmdc
    command: 'cmdc',
    versionArgs: ['--version'],
    // 完整列表见 cmdc --list-models
    models: [
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash（默认）' },
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
      { id: 'zai-org/glm-5.3', label: 'GLM-5.3' },
      { id: 'qwen/qwen3.8-max', label: 'Qwen 3.8 Max' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    ],
    permissions: [
      { id: 'accept-edits', label: '自动接受改文件', hint: '可以直接读写文件；需要审批的命令会被拒绝' },
      { id: 'yolo', label: '跳过所有确认', hint: '可以执行任意命令，只在信任的项目里用' },
      { id: 'plan', label: '只读规划', hint: '只分析和出方案，不改文件' },
      { id: 'standard', label: '标准', hint: '非交互模式下需要审批的操作都会被拒绝' },
    ],
    defaultPermission: 'accept-edits',
    systemPromptFlag: false,
    buildArgs: (o) => [
      '-p',
      '--output-format',
      'json',
      '--skip-onboarding',
      '--trust',
      '--no-auto-update',
      ...opt(o.model, '-m', o.model),
      ...opt(o.permission, '--permission-mode', o.permission),
      ...opt(o.resume, '--resume', o.resume!),
      '--max-turns',
      String(o.maxTurns ?? 200),
      ...o.extraArgs,
    ],
    installHint: 'npm install -g command-code',
    docsUrl: 'https://www.npmjs.com/package/command-code',
  },
]

export const getCli = (id: string) => CLIS.find((c) => c.id === id)

const quote = (a: string) => (/[\s"'<>|&]/.test(a) || a === '' ? JSON.stringify(a) : a)

/** 拼成一行便于展示的命令（任务描述通过 stdin 传入） */
export function previewCommand(command: string, args: string[]): string {
  return [quote(command), ...args.map(quote)].join(' ')
}
