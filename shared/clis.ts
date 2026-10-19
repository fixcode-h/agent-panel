/**
 * 本机 CLI 注册表。CLI 的一切差异都写在定义里（怎么拼参数、怎么解析输出、支持哪些能力、Skill 和说明文件在哪），
 * 面板其他地方按定义里的能力走，不按 CLI 的名字分支。
 *
 * 新增一种 CLI：写一份 JSON 配置（格式见 shared/cli-spec.ts 和 docs/cli-config.md）。
 * - 内置：放在 shared/clis/ 下，在下面的 BUILTIN_SPECS 里引入，再在 shared/locales/en/ 里补上文案的英文（也可以写在配置的 i18n 里）
 * - 用户自己加：放在数据目录的 config/clis/ 下，面板启动时读取，不用改代码
 * Claude Code 和 Codex 有自己的通信协议（stdin 控制消息、app-server），直接写在这个文件里。
 *
 * CLI 都用「非交互 + 结构化输出」模式运行，任务描述通过 stdin 传入，
 * 避免长文本、换行和引号在不同系统的命令行里转义出错。
 */
import { t } from './i18n.ts'
import { CliSpec, specToDefinition, type CliSpecInput } from './cli-spec.ts'
import commandcode from './clis/commandcode.json'
import gemini from './clis/gemini.json'
import pi from './clis/pi.json'

/** 写成配置文件的内置 CLI，按这个顺序排在 Claude Code、Codex 后面 */
const BUILTIN_SPECS = [commandcode, gemini, pi]
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
  /** 工作目录之外还允许读写的目录（例如附件所在的目录） */
  addDirs?: string[]
  /**
   * 从 resume 的会话分叉出一个新会话（原会话不动）；给了 turn 时只保留到那一轮（含）：
   * Codex 用 turn id，Claude Code 用那一轮最后一条回复的 uuid
   */
  fork?: { turnId?: string; end?: string }
  /** 不是普通的一轮对话：压缩上下文，或者审查代码 */
  op?: { kind: 'compact' } | { kind: 'review'; target: ReviewTarget }
  /** 上下文达到这么多 token 时自动压缩（Codex 的 model_auto_compact_token_limit） */
  autoCompactTokens?: number
  /** 设置里手动改过的上下文窗口和最大输出（token）；自动时为空，不传，让 CLI 用模型自己的 */
  contextWindow?: number
  maxOutput?: number
}

/** 审查什么：未提交的改动、和某个分支的差异，或者按说明审查 */
export type ReviewTarget =
  | { type: 'uncommitted' }
  | { type: 'base'; branch: string }
  | { type: 'custom'; instructions: string }

export type ModelTier = 'high' | 'medium' | 'low'

/** 模型档位：Agent 可以只选档位，执行时换成当前 CLI 在设置里对应的模型 */
export const MODEL_TIERS: { id: ModelTier; label: string; hint: string }[] = [
  { id: 'high', label: t('高'), hint: t('复杂任务、架构设计') },
  { id: 'medium', label: t('中'), hint: t('日常开发') },
  { id: 'low', label: t('低'), hint: t('简单改动、速度优先') },
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
  /** 内置了生成图片的工具（UI 设计里用） */
  images?: boolean
  /** Homebrew 的包（brew install 的参数） */
  brew?: string[]
  /**
   * 怎么调用：claude-stream 是 Claude Code 的 stdin / stdout 控制协议（插话、审批、中断），
   * codex-app 是 codex app-server 的 JSON-RPC，stdin 是任务描述从 stdin 传入、stdout 一行一个 JSON 事件
   */
  protocol: 'claude-stream' | 'codex-app' | 'stdin'
  /** stdout 的解析：内置解析器的名字，或者配置文件里的事件映射（protocol 为 stdin、claude-stream 时用） */
  parser: string | import('./cli-spec.ts').OutputSpec
  /** 执行中能插话 */
  steer: boolean
  /** 压缩上下文：native 走协议，slash 发「/compact」，summary 让它写摘要、下一轮开新会话 */
  compact: 'native' | 'slash' | 'summary'
  /** 审查改动：native 走 CLI 的审查模式，prompt 按审查要求跑一轮 */
  review: 'native' | 'prompt'
  /** 会话分叉：turn 能截到某一轮（Codex），end 能截到某条回复（Claude Code），latest 只能从最后分叉，none 不能 */
  fork: 'turn' | 'end' | 'latest' | 'none'
  /** 自动压缩：config 是告诉 CLI token 数（Codex），env 是用环境变量告诉百分比，panel 是面板在一轮结束后压缩 */
  autoCompact: 'config' | 'env' | 'panel'
  autoCompactEnv?: string
  /** 会话里认识「/命令」「/Skill」，原样发过去；否则面板展开成普通要求 */
  slash: boolean
  /** 上下文窗口的默认估计 */
  contextWindow: number
  /** 手动设的上下文窗口、最大输出用哪个环境变量告诉 CLI；没有的项 CLI 不接受，只用于面板估算 */
  limitEnv?: { context?: string; maxOutput?: string }
  /** buildArgs 里会把这几项写成参数（BuildOptions 的 contextWindow、maxOutput） */
  limitArgs?: ('context' | 'maxOutput')[]
  /** 账号额度：query 能主动查，push 执行时才报告，none 没有 */
  limits: 'query' | 'push' | 'none'
  /** 项目里每次启动会读的说明文件；第一个是还没有文件时新建的那个 */
  docs: string[]
  /** 项目设置里说明文件那一页的说明 */
  docsNote: string
  /** 用户目录里的全局说明文件（所有项目都读），设置的「部署」页往这里写；为空表示不支持 */
  globalDoc?: string
  /** Skill 目录：user 相对用户目录（~ 开头，可以用 ${ENV:-默认值}），repo 相对项目目录 */
  skills: { user: string[]; repo: string[] }
  /** 自定义命令的目录和格式 */
  commands: { user: string[]; repo: string[]; format: 'md' | 'toml'; prefix: string }
  /** 界面上的标识色 */
  color: string
  /** 设置里环境变量的示例 */
  envExample: string
  /** 每次运行都加的环境变量，用户在设置里写的同名变量优先 */
  env?: Record<string, string>
  /** 从哪里读可用模型：codex（app-server）、commandcode（安装包里的模型目录）、pi（pi --list-models）、claude（配置和环境变量）；为空时只用 models 里写的 */
  modelsFrom: string
  /** 只读的权限：在用户的项目里只分析不改文件时用（例如优化说明文件）；为空时用设置里的权限 */
  readOnly: string
  /** 账号和 API：怎么登录、凭据存在哪、怎么改用 API（见 shared/accounts.ts） */
  auth?: import('./accounts.ts').CliAuth
  /** 怎么把面板的工具（MCP）交给它，见 cli-spec.ts 的 mcp；没有时用不了 UI 设计的 AI */
  mcp?: import('./cli-spec.ts').McpSpec
  /** 用户自己装的 MCP 工具存在哪（「MCP 工具」页读写）；没有时不管 */
  mcpStore?: import('./cli-spec.ts').McpStore
  /** 来自配置文件（不是写在代码里的） */
  spec?: boolean
  /** 用户放在数据目录里的配置（不是面板内置的） */
  user?: boolean
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
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    ],
    permissions: [
      {
        id: 'acceptEdits',
        label: t('自动接受改文件'),
        hint: t('可以直接读写文件；需要审批的命令会在任务页上请你确认'),
      },
      { id: 'bypassPermissions', label: t('跳过所有确认'), hint: t('可以执行任意命令，只在信任的项目里用') },
      { id: 'plan', label: t('只读规划'), hint: t('只分析和出方案，不改文件') },
      { id: 'default', label: t('逐项确认'), hint: t('改文件和需要审批的命令都会在任务页上请你确认') },
    ],
    efforts: [
      { id: 'low', label: t('低') },
      { id: 'medium', label: t('中') },
      { id: 'high', label: t('高') },
      { id: 'xhigh', label: t('很高') },
      { id: 'max', label: t('最高') },
    ],
    tiers: {
      high: { model: 'claude-opus-5-5', effort: 'high' },
      medium: { model: 'claude-sonnet-5-5', effort: 'medium' },
      low: { model: 'claude-haiku-5-5', effort: 'low' },
    },
    defaultPermission: 'acceptEdits',
    systemPromptFlag: true,
    buildArgs: (o) => [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // 任务描述走 stdin 上的 JSON，执行中还能插话、中断；需要审批的操作也通过 stdin / stdout 上的控制消息发给面板
      '--input-format',
      'stream-json',
      ...(o.permission === 'bypassPermissions' ? [] : ['--permission-prompt-tool', 'stdio']),
      ...opt(o.model, '--model', o.model),
      ...opt(o.effort, '--effort', o.effort!),
      ...(o.permission === 'bypassPermissions'
        ? ['--dangerously-skip-permissions']
        : // 「逐项确认」也要明确传 default，否则会沿用 ~/.claude/settings.json 里的 defaultMode
          opt(o.permission, '--permission-mode', o.permission)),
      ...opt(o.resume, '--resume', o.resume!),
      ...opt(o.resume && o.fork, '--fork-session'),
      ...opt(o.resume && o.fork?.end, '--resume-session-at', o.fork?.end ?? ''),
      ...opt(o.systemPrompt, '--append-system-prompt', o.systemPrompt!),
      ...opt(o.maxTurns, '--max-turns', String(o.maxTurns)),
      ...(o.addDirs ?? []).flatMap((d) => ['--add-dir', d]),
      ...o.extraArgs,
    ],
    installHint: 'npm install -g @anthropic-ai/claude-code',
    npmPackage: '@anthropic-ai/claude-code',
    brew: ['--cask', 'claude-code'],
    docsUrl: 'https://code.claude.com/docs',
    protocol: 'claude-stream',
    parser: 'claude',
    steer: true,
    compact: 'slash',
    review: 'prompt',
    fork: 'end',
    autoCompact: 'env',
    autoCompactEnv: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    limitEnv: { context: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', maxOutput: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS' },
    slash: true,
    contextWindow: 200_000,
    limits: 'push',
    docs: ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'],
    globalDoc: '${CLAUDE_CONFIG_DIR:-~/.claude}/CLAUDE.md',
    docsNote: t(
      'Claude Code 每次启动读 CLAUDE.md 和 .claude/CLAUDE.md；CLAUDE.local.md 是个人的说明，一般不提交。想和其他 CLI 共用 AGENTS.md，可以在 CLAUDE.md 里写一行 @AGENTS.md。',
    ),
    skills: { user: ['~/.claude/skills'], repo: ['.claude/skills'] },
    commands: { user: ['~/.claude/commands'], repo: ['.claude/commands'], format: 'md', prefix: '' },
    modelsFrom: 'claude',
    readOnly: 'default',
    auth: {
      login: ['auth', 'login'],
      home: '${CLAUDE_CONFIG_DIR:-~/.claude}',
      files: ['.credentials.json'],
      // 账号信息（邮箱）记在 .claude.json 里
      fields: [{ file: '${CLAUDE_CONFIG_DIR:-~}/.claude.json', keys: ['oauthAccount'] }],
      keychain: 'Claude Code-credentials',
      identity: 'claude',
      loginEdits: [],
      loginStdin: '',
      accountNote: '',
      api: {
        protocols: ['anthropic'],
        env: { ANTHROPIC_BASE_URL: '{baseUrl}', '{keyEnv}': '{apiKey}' },
        args: [],
        edits: [],
        accountEdits: [],
        wire: {},
      },
      // 环境变量和 settings.json 的 env 里配的网关、密钥
      apiSources: [
        {
          file: '',
          format: 'json',
          at: '',
          each: false,
          protocol: 'anthropic',
          wire: {},
          baseUrl: ['ANTHROPIC_BASE_URL'],
          defaultBaseUrl: 'https://api.anthropic.com',
          apiKey: ['ANTHROPIC_API_KEY'],
          bearerKey: ['ANTHROPIC_AUTH_TOKEN'],
          keyEnv: [],
          models: [
            'ANTHROPIC_MODEL',
            'ANTHROPIC_DEFAULT_OPUS_MODEL',
            'ANTHROPIC_DEFAULT_SONNET_MODEL',
            'ANTHROPIC_DEFAULT_HAIKU_MODEL',
          ],
          wireKey: [],
          name: [],
        },
        {
          file: '${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json',
          format: 'json',
          at: 'env',
          each: false,
          protocol: 'anthropic',
          wire: {},
          baseUrl: ['ANTHROPIC_BASE_URL'],
          defaultBaseUrl: 'https://api.anthropic.com',
          apiKey: ['ANTHROPIC_API_KEY'],
          bearerKey: ['ANTHROPIC_AUTH_TOKEN'],
          keyEnv: [],
          models: [
            'ANTHROPIC_MODEL',
            'ANTHROPIC_DEFAULT_OPUS_MODEL',
            'ANTHROPIC_DEFAULT_SONNET_MODEL',
            'ANTHROPIC_DEFAULT_HAIKU_MODEL',
          ],
          wireKey: [],
          name: [],
        },
      ],
    },
    // 只放行这个工具服务，不用逐个确认
    mcp: {
      args: [
        '--mcp-config',
        '{"mcpServers":{"{name}":{"type":"http","url":"{url}"}}}',
        '--allowedTools',
        'mcp__{name}',
      ],
      files: {},
    },
    mcpStore: {
      file: '${CLAUDE_CONFIG_DIR:-~}/.claude.json',
      format: 'json',
      key: 'mcpServers',
      urlKey: 'url',
      remoteType: 'http',
      stdioType: true,
      headersKey: 'headers',
    },
    color: '#c96442',
    envExample: 'ANTHROPIC_API_KEY=sk-ant-...',
  },
  {
    id: 'codex',
    name: 'Codex',
    images: true,
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
        label: t('可写项目目录'),
        hint: t('沙箱内运行，可以改项目目录里的文件；需要越过沙箱时在任务页上请你确认'),
      },
      { id: 'read-only', label: t('只读'), hint: t('只能读文件和跑只读命令') },
      { id: 'danger-full-access', label: t('完全访问'), hint: t('不使用沙箱、不确认，只在信任的项目里用') },
    ],
    efforts: [
      { id: 'low', label: t('低') },
      { id: 'medium', label: t('中') },
      { id: 'high', label: t('高') },
      { id: 'xhigh', label: t('很高') },
      { id: 'max', label: t('最高') },
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
      ...opt(o.autoCompactTokens, '-c', `model_auto_compact_token_limit=${o.autoCompactTokens}`),
      // Codex 只有上下文窗口的配置（model_context_window），没有最大输出的
      ...opt(o.contextWindow, '-c', `model_context_window=${o.contextWindow}`),
      '-c',
      `sandbox_mode="${o.permission === 'danger-full-access' ? 'danger-full-access' : o.permission || 'workspace-write'}"`,
      // 和 thread/start 里传的一致：完全访问不确认，其余越过沙箱时请用户确认
      '-c',
      `approval_policy="${o.permission === 'danger-full-access' ? 'never' : 'on-request'}"`,
      ...appServerArgs(o.extraArgs),
    ],
    installHint: 'npm install -g @openai/codex',
    npmPackage: '@openai/codex',
    brew: ['codex'],
    docsUrl: 'https://github.com/openai/codex',
    protocol: 'codex-app',
    parser: '',
    steer: true,
    compact: 'native',
    review: 'native',
    fork: 'turn',
    autoCompact: 'config',
    limitArgs: ['context'],
    slash: false,
    contextWindow: 272_000,
    limits: 'query',
    docs: ['AGENTS.md', 'AGENTS.override.md'],
    globalDoc: '${CODEX_HOME:-~/.codex}/AGENTS.md',
    docsNote: t(
      'Codex 每次启动读 AGENTS.md，同目录有 AGENTS.override.md 时用它代替。AGENTS.md 和「项目说明」是同一个文件。',
    ),
    // Skill 由 app-server 的 skills/list 给出（含系统自带和插件的），这里不用列目录
    skills: { user: [], repo: [] },
    // 自定义提示在 $CODEX_HOME/prompts，界面里用「/prompts:名字」调用
    commands: { user: ['${CODEX_HOME:-~/.codex}/prompts'], repo: [], format: 'md', prefix: 'prompts:' },
    modelsFrom: 'codex',
    readOnly: 'read-only',
    auth: {
      login: ['login'],
      home: '${CODEX_HOME:-~/.codex}',
      files: ['auth.json'],
      fields: [],
      keychain: '',
      identity: 'codex',
      loginEdits: [],
      loginStdin: '',
      accountNote: '',
      api: {
        protocols: ['openai-responses'],
        env: { AGENT_PANEL_API_KEY: '{apiKey}' },
        args: [
          '-c',
          'model_providers.agentpanel.name={name|json}',
          '-c',
          'model_providers.agentpanel.base_url={baseUrl|json}',
          '-c',
          'model_providers.agentpanel.env_key="AGENT_PANEL_API_KEY"',
          '-c',
          'model_providers.agentpanel.wire_api="responses"',
          '-c',
          'model_provider="agentpanel"',
        ],
        edits: [],
        accountEdits: [],
        wire: {},
      },
      // config.toml 里自己接的 model_providers，环境变量和 auth.json 里的 OPENAI_API_KEY
      apiSources: [
        {
          file: '${CODEX_HOME:-~/.codex}/config.toml',
          format: 'toml',
          at: 'model_providers',
          each: true,
          protocol: 'openai-responses',
          wire: { responses: 'openai-responses', chat: 'openai-chat' },
          baseUrl: ['base_url'],
          defaultBaseUrl: '',
          apiKey: ['experimental_bearer_token'],
          bearerKey: [],
          keyEnv: ['env_key'],
          models: [],
          wireKey: ['wire_api'],
          name: ['name'],
        },
        {
          file: '',
          format: 'json',
          at: '',
          each: false,
          protocol: 'openai-responses',
          wire: {},
          baseUrl: ['OPENAI_BASE_URL'],
          defaultBaseUrl: 'https://api.openai.com/v1',
          apiKey: ['OPENAI_API_KEY'],
          bearerKey: [],
          keyEnv: [],
          models: [],
          wireKey: [],
          name: [],
        },
        {
          file: '${CODEX_HOME:-~/.codex}/auth.json',
          format: 'json',
          at: '',
          each: false,
          protocol: 'openai-responses',
          wire: {},
          baseUrl: [],
          defaultBaseUrl: 'https://api.openai.com/v1',
          apiKey: ['OPENAI_API_KEY'],
          bearerKey: [],
          keyEnv: [],
          models: [],
          wireKey: [],
          name: [],
        },
      ],
    },
    mcp: { args: ['-c', 'mcp_servers.{name}.url="{url}"'], files: {} },
    mcpStore: {
      file: '${CODEX_HOME:-~/.codex}/config.toml',
      format: 'toml',
      key: 'mcp_servers',
      urlKey: 'url',
      remoteType: '',
      stdioType: false,
      headersKey: 'http_headers',
    },
    color: '#0e8a6b',
    envExample: 'OPENAI_API_KEY=sk-...',
  },
]

// 写成配置文件的内置 CLI
CLIS.push(...BUILTIN_SPECS.map((s) => specToDefinition(s as CliSpecInput)))

export const getCli = (id: string) => CLIS.find((c) => c.id === id)

/**
 * 换上用户自己加的 CLI（数据目录 config/clis/ 下的配置）：服务端启动和重新读取时调用，页面从接口拿到后也调一遍。
 * 之前加的先去掉（配置文件可能删了）；和内置的 id 相同的不加。返回加不进来的原因
 */
export function registerCliSpecs(specs: unknown[]): string[] {
  for (let i = CLIS.length - 1; i >= 0; i--) if (CLIS[i].user) CLIS.splice(i, 1)
  const errors: string[] = []
  for (const raw of specs) {
    const id = (raw as { id?: string })?.id ?? '?'
    const p = CliSpec.safeParse(raw)
    if (!p.success) {
      errors.push(`${id}：${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`)
      continue
    }
    if (getCli(p.data.id)) {
      errors.push(`${id}：${t('和已有的 CLI 重名')}`)
      continue
    }
    CLIS.push({ ...specToDefinition(p.data), user: true })
  }
  return errors
}

const quote = (a: string) => (/[\s"'<>|&]/.test(a) || a === '' ? JSON.stringify(a) : a)

/** 拼成一行便于展示的命令（任务描述通过 stdin 传入） */
export function previewCommand(command: string, args: string[]): string {
  return [quote(command), ...args.map(quote)].join(' ')
}

/** 命令行里的一个参数：有空白或引号时加引号 */
export const quoteArg = (t: string) => (/[\s"]/.test(t) ? JSON.stringify(t) : t)

/** 复制出来的完整命令：任务描述通过 stdin 传入，所以写成管道形式 */
export const commandText = (argv: string[]) => `echo "${t('<任务描述>')}" | ${argv.map(quoteArg).join(' ')}`
