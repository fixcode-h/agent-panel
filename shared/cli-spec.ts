/**
 * CLI 的配置文件格式。新增一种 CLI 只要写一份 JSON（格式见 docs/cli-config.md）：
 * 内置的放在 shared/clis/ 下并在 shared/clis.ts 里引入；用户自己加的放在数据目录的 config/clis/ 下，启动时读取。
 *
 * 配置描述的是「怎么调」：命令、参数怎么拼、输出的每种事件对应面板的什么、支持哪些能力（插话、压缩、分叉……），
 * 以及 Skill、自定义命令、项目说明文件在哪。面板的代码按这些能力走，不再按 CLI 的名字分支。
 */
import { z } from 'zod'
import type { BuildOptions, CliDefinition, ModelTier } from './clis.ts'
import { getLang, t } from './i18n.ts'
import { CliAuth } from './accounts.ts'

const Tier = z.object({ model: z.string().default(''), effort: z.string().default('') })

/**
 * 一条参数规则：条件都满足时加上 args。
 * if：「model」有值、「!resume」没值、「permission=yolo」等于、「permission!=yolo」不等于；多个条件写成数组，全部满足才加
 * args 里的占位：{model}、{effort}、{permission}、{resume}、{systemPrompt}、{maxTurns}、{title}；
 * {addDirs|,} 把数组用逗号连起来；{maxTurns:200} 没值时用 200。each：对数组的每一项加一次，{item} 是那一项
 */
export const ArgRule = z.object({
  if: z.union([z.string(), z.array(z.string())]).optional(),
  each: z.enum(['addDirs']).optional(),
  args: z.array(z.string()),
})
export type ArgRule = z.infer<typeof ArgRule>

/**
 * 输出里的一种事件：when 里的字段都相等时，按 emit 产生面板的事件（按顺序找第一条对上的）。
 * emit 里的值：「$.a.b」取事件里的字段，「$.status == success」「$.x != y」比较，其余是字面值
 */
export const EventRule = z.object({
  when: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  emit: z.array(z.record(z.string(), z.unknown()).and(z.object({ type: z.string() }))),
})
export type EventRule = z.infer<typeof EventRule>

export const OutputSpec = z.object({
  /** 一行一个 JSON 事件 */
  format: z.literal('ndjson').default('ndjson'),
  events: z.array(EventRule),
})
export type OutputSpec = z.infer<typeof OutputSpec>

export const McpSpec = z.object({
  args: z.array(z.string()).default([]),
  files: z.record(z.string(), z.unknown()).default({}),
})
export type McpSpec = z.infer<typeof McpSpec>

/**
 * 用户自己装的 MCP 工具存在 CLI 的哪个配置文件里、怎么写：面板的「MCP 工具」页按这个读写。
 * 不写表示这个 CLI 的 MCP 配置不归面板管
 */
export const McpStore = z.object({
  /** 配置文件，~ 开头，可以用 ${ENV:-默认值} */
  file: z.string(),
  format: z.enum(['json', 'toml']),
  /** json 里放工具表的键（toml 固定是 mcp_servers） */
  key: z.string().default('mcpServers'),
  /** 远程（HTTP）工具的地址写在哪个字段 */
  urlKey: z.string().default('url'),
  /** 远程工具要不要写 type；stdio 的要不要写 type: "stdio" */
  remoteType: z.string().default(''),
  stdioType: z.boolean().default(false),
  /** 请求头写在哪个字段 */
  headersKey: z.string().default('headers'),
})
export type McpStore = z.infer<typeof McpStore>

/**
 * 扩展包（例如 Pi 的 pi install）：已装的从配置文件 file 的 key 数组里读（每项是来源字符串，或带 source 字段的对象），
 * 装、删、更新跑 CLI 自己的命令，{source} 是包的来源。相对路径的来源按配置文件所在目录换成绝对路径再交给命令
 */
export const CliPackages = z.object({
  file: z.string(),
  key: z.string().default('packages'),
  install: z.array(z.string()).min(1),
  remove: z.array(z.string()).min(1),
  /** 更新一个；updateAll 更新全部 */
  update: z.array(z.string()).optional(),
  updateAll: z.array(z.string()).optional(),
  /** 输入框的示例 */
  placeholder: z.string().default(''),
})
export type CliPackages = z.infer<typeof CliPackages>
/** 已装的一个包：source 是配置里写的，target 是交给命令用的（相对路径换成了绝对路径） */
export interface InstalledPackage {
  source: string
  target: string
}

/**
 * 常驻协议里的一条消息：JSON-RPC 写 method + params，按 type 区分的记录流写 record。
 * 里面的字符串可以用 {input}、{text}、{model}、{resume}、{maxTurns} 这些占位；
 * 整条就是占位、运行时又没有值时，这个字段直接不传（例如没设置回合上限时的 maxTurns）。
 */
export const RpcAction = z.object({
  /** 条件：resume、fork、model 等；写数组时全部满足才发 */
  if: z.union([z.string(), z.array(z.string())]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  /** 记录流直接写整条记录（例如 Pi 的 { "type": "prompt", "message": "{input}" }） */
  record: z.record(z.string(), z.unknown()).optional(),
  /** 只发不等回复（通知） */
  notify: z.boolean().default(false),
  /** 失败了也不影响这一轮（例如查统计、起会话名这种锦上添花的请求） */
  optional: z.boolean().default(false),
  /** 回复也交给输出映射（output.events），例如 Pi 的 get_session_stats 回复里有准确的上下文占用 */
  parse: z.boolean().default(false),
  /** 回复存进变量，后面的 id 路径和条件可以用 */
  save: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
})
export type RpcAction = z.infer<typeof RpcAction>

export const RpcDone = z.object({
  /** 收到这样的记录算这一轮结束（键可以是 method、type、message.role 这样的路径） */
  when: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  /** 成功的条件；路径以 $. 开头是这条记录里的字段，否则是 remember 存下的记录 */
  ok: z.union([z.string(), z.array(z.string())]).optional(),
  error: z.union([z.string(), z.array(z.string())]).optional(),
})
export type RpcDone = z.infer<typeof RpcDone>

export const RpcRemember = z.object({
  when: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  as: z.string(),
})
export type RpcRemember = z.infer<typeof RpcRemember>

/**
 * CLI 发来的、要用户回答的请求（例如 Pi 扩展的确认框、选择框）：按 when 认出来，交给页面的提问卡片，
 * 用户的选择按 allow / deny 的模板回给 CLI。模板里 {id} 是请求的 id，{answer} 是用户选的或填的内容；
 * title、detail、options 写「$.路径」取请求里的字段
 */
export const RpcAsk = z.object({
  when: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  kind: z.enum(['command', 'file', 'tool', 'question']).default('question'),
  title: z.string().default(''),
  detail: z.string().default(''),
  options: z.string().optional(),
  allow: z.record(z.string(), z.unknown()),
  deny: z.record(z.string(), z.unknown()),
})
export type RpcAsk = z.infer<typeof RpcAsk>

/**
 * 常驻 RPC 的配置。kind 为 spec 时完全按这里的声明执行；codex / claude
 * 用各自适配器处理协议里特殊的地方（审批请求、控制消息），但同样走统一的会话引擎。
 */
export const RpcSpec = z.object({
  kind: z.enum(['spec', 'codex', 'claude']).default('spec'),
  /** 发出去的请求带 jsonrpc: "2.0"（标准 JSON-RPC） */
  jsonrpc: z.boolean().default(false),
  /** 进程起来后的握手，按顺序发 */
  handshake: z.array(RpcAction).default([]),
  /** 开始一轮；续接、分叉时可以用 resume / fork 换一套 */
  start: z.array(RpcAction).default([]),
  resume: z.array(RpcAction).optional(),
  fork: z.array(RpcAction).optional(),
  steer: RpcAction.optional(),
  interrupt: RpcAction.optional(),
  /** 压缩上下文（features.compact 为 native 时）：续接会话后按顺序发，最后一个回复成功就算压缩完了 */
  compact: z.array(RpcAction).optional(),
  /** 这一轮结束、交结果之前再发的请求（例如查一次准确的用量），一般配 optional 和 parse */
  after: z.array(RpcAction).default([]),
  /** CLI 发来的要用户回答的请求；没对上的请求当普通记录交给输出映射 */
  asks: z.array(RpcAsk).default([]),
  /** 这一轮结束后、关 stdin 前发的消息（例如 Command Code 的 session/exit） */
  exit: RpcAction.optional(),
  /** 会话 id、轮次 id 从哪个回复的哪个字段取（路径相对 save 的变量） */
  sessionId: z.string().default(''),
  turnId: z.string().default(''),
  /** 事件包了一层时解开的路径，例如 Command Code 的 $.event */
  unwrap: z.string().default(''),
  /** 记住某类记录，供 done 里的成功条件使用（例如 Pi 最后的 assistant 消息） */
  remember: z.array(RpcRemember).default([]),
  /** 这一轮怎么算结束 */
  done: z.array(RpcDone).default([]),
  /** 结束后等多久再关 stdin；期间有新输出会取消 */
  closeDelayMs: z.number().int().nonnegative().default(0),
  /** 没设置回合上限时的默认值（0 表示不传） */
  defaultMaxTurns: z.number().int().nonnegative().default(0),
  /**
   * CLI 自己没有回合上限参数时，面板数这类记录（一次模型请求一条，例如 Pi 的 turn_start），
   * 超过设置里的回合上限就按 interrupt 停下，这一轮算失败
   */
  turnLimit: z.object({ when: z.record(z.string(), z.unknown()) }).optional(),
  /** 插话要等 CLI 的下一个模型请求才取走，页面上先显示成「待取走」 */
  deferSteer: z.boolean().default(false),
  /** 协议自己处理提问和审批，不用面板的 MCP 工具 */
  nativeAsk: z.boolean().default(false),
  /** 能主动查账号额度、列 Skill */
  limitsQuery: z.boolean().default(false),
  skillsQuery: z.boolean().default(false),
  /** Skill 列表里包含已安装插件的 */
  pluginSkills: z.boolean().default(false),
  /** 内置 Skill 装到哪个目录（列表走协议、不从目录读时用） */
  skillsDir: z.string().default(''),
  /** 只查询、不跑任务时的启动参数（例如 Codex 的 ["app-server"]） */
  queryArgs: z.array(z.string()).default([]),
})
export type RpcSpec = z.infer<typeof RpcSpec>
export type RpcSpecInput = z.input<typeof RpcSpec>

/**
 * 把工具的名字和地址填进 CLI 定义里的 MCP 配置，得到参数和要写的文件。
 * dir 是面板这一轮自己的临时目录（绝对路径），配置里写 {dir} 的文件放这里，不进用户的项目
 */
export function mcpConfig(spec: McpSpec, name: string, url: string, dir = '') {
  const fillStr = (s: string) => s.replaceAll('{name}', name).replaceAll('{url}', url).replaceAll('{dir}', dir)
  const fillAny = (v: unknown): unknown =>
    typeof v === 'string'
      ? fillStr(v)
      : Array.isArray(v)
        ? v.map(fillAny)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [fillStr(k), fillAny(x)]))
          : v
  return {
    args: spec.args.map(fillStr),
    files: Object.entries(spec.files).map(([p, content]) => ({ path: fillStr(p), content: fillAny(content) })),
  }
}

const Dirs = z.object({ user: z.array(z.string()).default([]), repo: z.array(z.string()).default([]) })

export const CliSpec = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,30}$/, 'id 只能是小写字母、数字和 -')
    .describe('唯一标识，写进设置和 Agent 配置里'),
  name: z.string().min(1),
  command: z.string().min(1),
  versionArgs: z.array(z.string()).default(['--version']),
  npmPackage: z.string().default(''),
  /** 改了包名之后，以前用过的包名：安装新包前先卸掉旧的，否则两个包都提供同一个命令，npm 会报 EEXIST */
  npmRenameFrom: z.array(z.string()).default([]),
  brew: z.array(z.string()).default([]),
  installHint: z.string().default(''),
  docsUrl: z.string().default(''),
  /** 界面上的标识色 */
  color: z.string().default('#64748b'),
  models: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean().optional() })).default([]),
  efforts: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
  /** 思考强度跟着模型走，不用 efforts 的全局列表过滤 */
  effortsFromModel: z.boolean().default(false),
  /** 会话不支持中途换思考强度：换了强度也开新会话 */
  effortBoundSession: z.boolean().default(false),
  tiers: z.object({ high: Tier, medium: Tier, low: Tier }).optional(),
  permissions: z.array(z.object({ id: z.string(), label: z.string(), hint: z.string().default('') })).min(1),
  defaultPermission: z.string().optional(),
  /** 从哪里读可用模型：内置读取方式的名字（commandcode、pi）；不写时只用 models 里列的 */
  modelsFrom: z.string().default(''),
  /** 只读的权限（只分析不改文件时用，例如优化项目说明）；非交互时会拦下改动的权限也算 */
  readOnlyPermission: z.string().default(''),
  args: z.array(ArgRule),
  /**
   * 怎么调用：默认 stdin（任务描述从 stdin 传入、进程一轮后退出）；
   * rpc 是常驻的双向协议（stdin/stdout 一行一条 JSON），可以执行中插话、中断，具体写法见 rpc
   */
  protocol: z.enum(['stdin', 'rpc']).default('stdin'),
  /** 常驻协议怎么握手、开始一轮、插话、判断结束，见 RpcSpec */
  rpc: RpcSpec.optional(),
  /** protocol 为 rpc 时用这套参数（不带 -p / --output-format） */
  rpcArgs: z.array(ArgRule).optional(),
  /** stdout 怎么解析：内置解析器的名字（claude、commandcode），或者事件映射 */
  output: z.union([z.string(), OutputSpec]),
  /** 角色说明怎么给：flag 是追加系统提示词的参数（如 --append-system-prompt），不给时拼进任务描述 */
  systemPromptFlag: z.string().default(''),
  features: z
    .object({
      /** 执行中能插话 */
      steer: z.boolean().default(false),
      /** 没有插话协议，但能用面板的 MCP 工具（read_user_notes）取执行中的补充 */
      notes: z.boolean().default(false),
      /**
       * 回复完不关进程，把下一条消息交回同一个进程开下一轮（面板保活）。
       * 与 notes 无关：notes 管「怎么取补充」，这里管「进程能不能留着等下一句」。
       * 常驻协议（rpc.next）的 CLI 都该开，否则每轮都要重启 + 恢复会话，首字延迟明显
       */
      keepAlive: z.boolean().default(false),
      /** 压缩上下文：native 走协议（rpc.compact），slash 是发「/compact」，summary 是让它写摘要、下一轮开新会话 */
      compact: z.enum(['native', 'slash', 'summary']).default('summary'),
      /** 会话中途能换模型（换了模型续接同一个会话，不用开新会话带上对话记录） */
      modelSwitch: z.boolean().default(false),
      /**
       * 会话能分叉到哪：before 能分叉到任意一轮之前（rpc.turnId 记下每轮的位置，分叉时 {forkBefore} 是要丢掉的第一轮），
       * latest 只能从最后分叉（要有分叉参数，见 args 里的 fork 条件），none 不能分叉（带上对话记录开新会话）
       */
      fork: z.enum(['before', 'latest', 'none']).default('none'),
      /** 自动压缩：env 是用环境变量告诉 CLI 百分比（autoCompactEnv），panel 是面板在一轮结束后压缩 */
      autoCompact: z.enum(['env', 'panel']).default('panel'),
      autoCompactEnv: z.string().default(''),
      /** 会话里认识「/命令」和「/Skill」，原样发过去；否则面板展开 */
      slash: z.boolean().default(false),
      /** 设置里手动改的上下文窗口、最大输出用哪个环境变量传给 CLI；不写表示 CLI 不接受 */
      limitEnv: z.object({ context: z.string().optional(), maxOutput: z.string().optional() }).default({}),
      /**
       * 或者写进 CLI 的配置文件（账号方式下用，API 方式由 auth.api.modelLimits 写）：只在这一轮里加上，结束后还原。
       * at 是模型条目的位置，{provider}、{model} 是模型 ID「provider/model」的两段，例如 Pi 的
       * providers.{provider}.modelOverrides.{model}；context / maxOutput 是写进条目的键名
       */
      limitFile: z
        .object({
          file: z.string(),
          at: z.string(),
          context: z.string().optional(),
          maxOutput: z.string().optional(),
        })
        .optional(),
    })
    .default({
      steer: false,
      notes: false,
      keepAlive: false,
      compact: 'summary',
      fork: 'none',
      autoCompact: 'panel',
      autoCompactEnv: '',
      slash: false,
      limitEnv: {},
      modelSwitch: false,
    }),
  /** 项目里每次启动会读的说明文件；第一个是还没有文件时新建的那个 */
  docs: z.array(z.string().regex(/^(?!\/)(?!.*\.\.)[\w.\-/]+$/, '只能是项目目录里的相对路径')).default(['AGENTS.md']),
  /** 项目设置里说明文件那一页的说明 */
  docsNote: z.string().default(''),
  /** 用户目录里的全局说明文件（~ 开头，可以用 ${ENV:-默认值}），设置的「部署」页往这里写 */
  globalDoc: z.string().default(''),
  /** Skill 目录（每个子目录一个 SKILL.md）：user 是相对用户目录（~ 开头），repo 是相对项目目录 */
  skills: Dirs.default({ user: [], repo: [] }),
  /** 自定义命令：目录下每个文件一个命令；md 是 Markdown（$ARGUMENTS 换成参数），toml 是 prompt 字段（{{args}} 换成参数） */
  commands: Dirs.extend({ format: z.enum(['md', 'toml']).default('md'), prefix: z.string().default('') }).default({
    user: [],
    repo: [],
    format: 'md',
    prefix: '',
  }),
  /** 设置里环境变量的示例 */
  envExample: z.string().default(''),
  /**
   * 设置里给用户的开关：打开时加上 env，参数规则里用条件「opt.<id>」判断（例如 Pi 的离线运行、codemode）。
   * default 是没改过时的状态
   */
  options: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
        label: z.string(),
        hint: z.string().default(''),
        default: z.boolean().default(false),
        env: z.record(z.string(), z.string()).default({}),
      }),
    )
    .default([]),
  /** 每次运行都加的环境变量（用户在设置里写的同名变量优先）：例如让无界面运行信任工作目录 */
  env: z.record(z.string(), z.string()).default({}),
  /**
   * 怎么把面板提供的工具（MCP，例如 UI 设计的设计工具）交给 CLI：args 是加的参数，files 是写进工作目录的配置文件
   * （路径 → JSON 内容；内容是字符串时原样写成文本文件，例如 Pi 的扩展脚本）。里面的 {url} 换成工具地址，{name} 换成工具名。
   * 不写表示这个 CLI 用不了面板的工具
   */
  mcp: McpSpec.optional(),
  /** 用户自己装的 MCP 工具存在哪个配置文件里；不写时面板不管这个 CLI 的 MCP 工具 */
  mcpStore: McpStore.optional(),
  packages: CliPackages.optional(),
  /** 账号和 API：怎么登录、凭据存在哪、怎么改用 API；不写时设置里没有账号和 API 的选项 */
  auth: CliAuth.optional(),
  /** 界面文案的翻译：{ "en": { "中文": "English" } } */
  i18n: z.record(z.string(), z.record(z.string(), z.string())).default({}),
})
export type CliSpec = z.infer<typeof CliSpec>
export type CliSpecInput = z.input<typeof CliSpec>

/** BuildOptions 里规则能用的字段 */
function value(o: BuildOptions, key: string): unknown {
  switch (key) {
    case 'model':
      return o.model
    case 'effort':
      return o.effort
    case 'permission':
      return o.permission
    case 'resume':
      return o.resume
    case 'systemPrompt':
      return o.systemPrompt
    case 'maxTurns':
      return o.maxTurns
    case 'addDirs':
      return o.addDirs?.length ? o.addDirs : undefined
    case 'fork':
      return o.fork
    case 'forkBefore':
      return o.fork?.before
    case 'title':
      return o.title
    default:
      // opt.<id>：设置里这个开关开着
      return key.startsWith('opt.') ? o.options?.[key.slice(4)] || undefined : undefined
  }
}

function holds(o: BuildOptions, cond: string) {
  const m = /^(!?)([\w.]+)(?:(!?=)(.*))?$/.exec(cond.trim())
  if (!m) return false
  const [, not, key, op, want] = m
  const v = value(o, key)
  if (op === '=') return String(v ?? '') === want
  if (op === '!=') return String(v ?? '') !== want
  return not ? !v : !!v
}

function fill(s: string, o: BuildOptions, item?: string) {
  return s.replace(/\{(\w+)(?:\|([^}]*)|:([^}]*))?\}/g, (_, key: string, sep?: string, def?: string) => {
    if (key === 'item') return item ?? ''
    const v = value(o, key)
    if (Array.isArray(v)) return v.join(sep ?? ',')
    return v === undefined || v === null || v === '' ? (def ?? '') : String(v)
  })
}

/** 按规则拼参数；设置里的额外参数放在最后 */
export function buildFromRules(rules: ArgRule[], o: BuildOptions): string[] {
  const out: string[] = []
  for (const r of rules) {
    const conds = r.if === undefined ? [] : Array.isArray(r.if) ? r.if : [r.if]
    if (!conds.every((c) => holds(o, c))) continue
    if (r.each)
      for (const item of (value(o, r.each) as string[] | undefined) ?? [])
        out.push(...r.args.map((a) => fill(a, o, item)))
    else out.push(...r.args.map((a) => fill(a, o)))
  }
  return [...out, ...o.extraArgs]
}

/** 配置编译成面板用的 CLI 定义 */
export function specToDefinition(input: CliSpecInput): CliDefinition {
  const spec = CliSpec.parse(input)
  const dict = spec.i18n
  // 配置自己带的翻译优先，其次是面板的词典（内置 CLI 的文案大多已经在里面）
  const tr = (s: string) => (s ? (dict[getLang()]?.[s] ?? t(s)) : s)
  const first = spec.models.find((m) => m.isDefault) ?? spec.models[0]
  const tier = (k: ModelTier) => spec.tiers?.[k] ?? { model: first?.id ?? '', effort: '' }
  const f = spec.features
  return {
    id: spec.id,
    name: spec.name,
    command: spec.command,
    versionArgs: spec.versionArgs,
    models: spec.models.map((m) => ({ ...m, label: tr(m.label) })),
    efforts: spec.efforts.map((e) => ({ id: e.id, label: tr(e.label) })),
    effortsFromModel: spec.effortsFromModel,
    effortBoundSession: spec.effortBoundSession,
    tiers: { high: tier('high'), medium: tier('medium'), low: tier('low') },
    permissions: spec.permissions.map((p) => ({ id: p.id, label: tr(p.label), hint: tr(p.hint) })),
    defaultPermission: spec.defaultPermission ?? spec.permissions[0].id,
    systemPromptFlag: !!spec.systemPromptFlag,
    buildArgs: (o) => {
      // 常驻协议和一次性执行的参数不一样（不能再带 -p / --output-format）
      const rules = spec.protocol === 'rpc' ? (spec.rpcArgs ?? spec.args) : spec.args
      return buildFromRules(
        spec.systemPromptFlag
          ? [...rules, { if: 'systemPrompt', args: [spec.systemPromptFlag, '{systemPrompt}'] }]
          : rules,
        o,
      )
    },
    installHint: spec.installHint || (spec.npmPackage ? `npm install -g ${spec.npmPackage}` : ''),
    npmPackage: spec.npmPackage,
    npmRenameFrom: spec.npmRenameFrom,
    brew: spec.brew,
    docsUrl: spec.docsUrl,
    protocol: spec.protocol,
    rpc: spec.rpc,
    parser: spec.output,
    steer: f.steer,
    notes: f.notes,
    keepAlive: f.keepAlive,
    compact: f.compact,
    review: 'prompt',
    fork: f.fork,
    autoCompact: f.autoCompact,
    autoCompactEnv: f.autoCompactEnv,
    slash: f.slash,
    limitEnv: f.limitEnv,
    limitFile: f.limitFile,
    modelSwitch: f.modelSwitch,
    limits: 'none',
    docs: spec.docs,
    docsNote: tr(spec.docsNote),
    globalDoc: spec.globalDoc || undefined,
    skills: spec.skills,
    commands: spec.commands,
    modelsFrom: spec.modelsFrom,
    readOnly: spec.readOnlyPermission,
    color: spec.color,
    envExample: spec.envExample,
    env: spec.env,
    options: spec.options.map((x) => ({ ...x, label: tr(x.label), hint: tr(x.hint) })),
    mcp: spec.mcp,
    mcpStore: spec.mcpStore,
    packages: spec.packages && { ...spec.packages, placeholder: tr(spec.packages.placeholder) },
    auth: spec.auth && { ...spec.auth, accountNote: tr(spec.auth.accountNote) },
    spec: true,
  }
}
