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
  /** 思考强度，取值见各 CLI 的 efforts；为空不传 */
  effort?: string
  permission: string
  extraArgs: string[]
  /** 续接的会话 id；为空表示新会话 */
  resume?: string
  /** 追加的系统提示词（只有支持的 CLI 会用到，其余拼进任务描述） */
  systemPrompt?: string
  maxTurns?: number
}

export type ModelTier = 'high' | 'medium' | 'low'

/** 模型档位：Agent 可以只选档位，执行时换成当前 CLI 在设置里对应的模型 */
export const MODEL_TIERS: { id: ModelTier; label: string; hint: string }[] = [
  { id: 'high', label: '高', hint: '复杂任务、架构设计' },
  { id: 'medium', label: '中', hint: '日常开发' },
  { id: 'low', label: '低', hint: '简单改动、速度优先' },
]

export interface CliDefinition {
  id: string
  name: string
  /** 默认可执行文件名；可以在设置里改成完整路径 */
  command: string
  versionArgs: string[]
  /** 模型建议；用户仍可以手填任意模型名 */
  models: { id: string; label: string; isDefault?: boolean; defaultEffort?: string; origin?: 'cli' | 'config' }[]
  /** 支持的思考强度（从低到高）；为空表示不支持 */
  efforts: { id: string; label: string }[]
  /** 高 / 中 / 低三档默认对应的模型和思考强度，设置里可以改 */
  tiers: Record<ModelTier, { model: string; effort: string }>
  permissions: PermissionOption[]
  defaultPermission: string
  /** 是否支持 --append-system-prompt 这类参数 */
  systemPromptFlag: boolean
  /** 非交互执行的参数（不含任务描述，任务描述走 stdin） */
  buildArgs: (o: BuildOptions) => string[]
  installHint: string
  /** 用 npm 全局安装的包名；设置里的「安装 / 卸载」按钮用它 */
  npmPackage: string
  docsUrl: string
}

const opt = (cond: unknown, ...args: string[]) => (cond ? args : [])

/** 设置里的额外参数是按 codex exec 写的；app-server 只认配置类参数（-c、--enable、--disable），其余丢掉免得启动失败 */
function appServerArgs(args: string[]) {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (/^(-c|--config|--enable|--disable)$/.test(a) && i + 1 < args.length) out.push(a, args[++i])
    else if (/^(--config|--enable|--disable)=/.test(a)) out.push(a)
  }
  return out
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
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    ],
    permissions: [
      { id: 'acceptEdits', label: '自动接受改文件', hint: '可以直接读写文件；需要审批的命令会在任务页上请你确认' },
      { id: 'bypassPermissions', label: '跳过所有确认', hint: '可以执行任意命令，只在信任的项目里用' },
      { id: 'plan', label: '只读规划', hint: '只分析和出方案，不改文件' },
      { id: 'default', label: '逐项确认', hint: '改文件和需要审批的命令都会在任务页上请你确认' },
    ],
    efforts: [
      { id: 'low', label: '低' },
      { id: 'medium', label: '中' },
      { id: 'high', label: '高' },
      { id: 'xhigh', label: '很高' },
      { id: 'max', label: '最高' },
    ],
    tiers: {
      high: { model: 'opus', effort: 'high' },
      medium: { model: 'sonnet', effort: 'medium' },
      low: { model: 'haiku', effort: 'low' },
    },
    defaultPermission: 'acceptEdits',
    systemPromptFlag: true,
    buildArgs: (o) => [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // 需要审批的操作通过 stdin / stdout 上的控制消息发给面板，在任务页上让用户确认；任务描述也改走 stdin 上的 JSON
      ...(o.permission === 'bypassPermissions'
        ? []
        : ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']),
      ...opt(o.model, '--model', o.model),
      ...opt(o.effort, '--effort', o.effort!),
      ...(o.permission === 'bypassPermissions'
        ? ['--dangerously-skip-permissions']
        : opt(o.permission && o.permission !== 'default', '--permission-mode', o.permission)),
      ...opt(o.resume, '--resume', o.resume!),
      ...opt(o.systemPrompt, '--append-system-prompt', o.systemPrompt!),
      ...opt(o.maxTurns, '--max-turns', String(o.maxTurns)),
      ...o.extraArgs,
    ],
    installHint: 'npm install -g @anthropic-ai/claude-code',
    npmPackage: '@anthropic-ai/claude-code',
    docsUrl: 'https://code.claude.com/docs',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    versionArgs: ['--version'],
    // 读不到本机 Codex 时的建议；能读到时以 `codex app-server` 返回的为准
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
      { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna' },
    ],
    permissions: [
      {
        id: 'workspace-write',
        label: '可写项目目录',
        hint: '沙箱内运行，可以改项目目录里的文件；需要越过沙箱时在任务页上请你确认',
      },
      { id: 'read-only', label: '只读', hint: '只能读文件和跑只读命令' },
      { id: 'danger-full-access', label: '完全访问', hint: '不使用沙箱、不确认，只在信任的项目里用' },
    ],
    efforts: [
      { id: 'low', label: '低' },
      { id: 'medium', label: '中' },
      { id: 'high', label: '高' },
      { id: 'xhigh', label: '很高' },
      { id: 'max', label: '最高' },
    ],
    tiers: {
      high: { model: 'gpt-6-astra', effort: 'high' },
      medium: { model: 'gpt-6.1-sol', effort: 'medium' },
      low: { model: 'gpt-6-luna', effort: 'low' },
    },
    defaultPermission: 'workspace-write',
    // 角色说明通过 app-server 的 developerInstructions 传入
    systemPromptFlag: true,
    // 用 app-server 执行才能拿到流式输出；模型、思考强度、沙箱也会在 thread/start、turn/start 里再传一次，
    // 写在参数里是为了让「环境」里显示的命令看得出用了什么。任务描述和续接的会话走协议，不在参数里
    buildArgs: (o) => [
      'app-server',
      ...opt(o.model, '-c', `model="${o.model}"`),
      ...opt(o.effort, '-c', `model_reasoning_effort="${o.effort}"`),
      '-c',
      `sandbox_mode="${o.permission === 'danger-full-access' ? 'danger-full-access' : o.permission || 'workspace-write'}"`,
      '-c',
      'approval_policy="never"',
      ...appServerArgs(o.extraArgs),
    ],
    installHint: 'npm install -g @openai/codex',
    npmPackage: '@openai/codex',
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
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', isDefault: true },
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
    // 思考强度是否生效取决于模型
    efforts: [
      { id: 'low', label: '低' },
      { id: 'medium', label: '中' },
      { id: 'high', label: '高' },
    ],
    tiers: {
      high: { model: 'claude-sonnet-5-5', effort: 'high' },
      medium: { model: 'deepseek/deepseek-v4-pro', effort: '' },
      low: { model: 'deepseek/deepseek-v4-flash', effort: '' },
    },
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
      ...opt(o.effort, '--effort', o.effort!),
      ...opt(o.permission, '--permission-mode', o.permission),
      ...opt(o.resume, '--resume', o.resume!),
      '--max-turns',
      String(o.maxTurns ?? 200),
      ...o.extraArgs,
    ],
    installHint: 'npm install -g command-code',
    npmPackage: 'command-code',
    docsUrl: 'https://www.npmjs.com/package/command-code',
  },
]

export const getCli = (id: string) => CLIS.find((c) => c.id === id)

const quote = (a: string) => (/[\s"'<>|&]/.test(a) || a === '' ? JSON.stringify(a) : a)

/** 拼成一行便于展示的命令（任务描述通过 stdin 传入） */
export function previewCommand(command: string, args: string[]): string {
  return [quote(command), ...args.map(quote)].join(' ')
}
