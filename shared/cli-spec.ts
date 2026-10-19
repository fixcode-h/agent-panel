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
 * args 里的占位：{model}、{effort}、{permission}、{resume}、{systemPrompt}、{maxTurns}；
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

/** 把工具的名字和地址填进 CLI 定义里的 MCP 配置，得到参数和要写的文件 */
export function mcpConfig(spec: McpSpec, name: string, url: string) {
  const fillStr = (s: string) => s.replaceAll('{name}', name).replaceAll('{url}', url)
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
  brew: z.array(z.string()).default([]),
  installHint: z.string().default(''),
  docsUrl: z.string().default(''),
  /** 界面上的标识色 */
  color: z.string().default('#64748b'),
  models: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean().optional() })).default([]),
  efforts: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
  tiers: z.object({ high: Tier, medium: Tier, low: Tier }).optional(),
  permissions: z.array(z.object({ id: z.string(), label: z.string(), hint: z.string().default('') })).min(1),
  defaultPermission: z.string().optional(),
  /** 从哪里读可用模型：内置读取方式的名字（commandcode、pi）；不写时只用 models 里列的 */
  modelsFrom: z.string().default(''),
  /** 只读的权限（只分析不改文件时用，例如优化项目说明）；非交互时会拦下改动的权限也算 */
  readOnlyPermission: z.string().default(''),
  args: z.array(ArgRule),
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
      /** 压缩上下文：slash 是发「/compact」，summary 是让它写摘要、下一轮开新会话 */
      compact: z.enum(['slash', 'summary']).default('summary'),
      /** 会话能分叉到哪：latest 只能从最后分叉（要有分叉参数，见 args 里的 fork 条件），none 不能分叉（带上对话记录开新会话） */
      fork: z.enum(['latest', 'none']).default('none'),
      /** 自动压缩：env 是用环境变量告诉 CLI 百分比（autoCompactEnv），panel 是面板在一轮结束后压缩 */
      autoCompact: z.enum(['env', 'panel']).default('panel'),
      autoCompactEnv: z.string().default(''),
      /** 会话里认识「/命令」和「/Skill」，原样发过去；否则面板展开 */
      slash: z.boolean().default(false),
      /** 上下文窗口的默认估计 */
      contextWindow: z.number().int().positive().default(200_000),
      /** 设置里手动改的上下文窗口、最大输出用哪个环境变量传给 CLI；不写表示 CLI 不接受 */
      limitEnv: z.object({ context: z.string().optional(), maxOutput: z.string().optional() }).default({}),
    })
    .default({
      steer: false,
      notes: false,
      compact: 'summary',
      fork: 'none',
      autoCompact: 'panel',
      autoCompactEnv: '',
      slash: false,
      contextWindow: 200_000,
      limitEnv: {},
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
    default:
      return undefined
  }
}

function holds(o: BuildOptions, cond: string) {
  const m = /^(!?)(\w+)(?:(!?=)(.*))?$/.exec(cond.trim())
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
    tiers: { high: tier('high'), medium: tier('medium'), low: tier('low') },
    permissions: spec.permissions.map((p) => ({ id: p.id, label: tr(p.label), hint: tr(p.hint) })),
    defaultPermission: spec.defaultPermission ?? spec.permissions[0].id,
    systemPromptFlag: !!spec.systemPromptFlag,
    buildArgs: (o) =>
      buildFromRules(
        spec.systemPromptFlag
          ? [...spec.args, { if: 'systemPrompt', args: [spec.systemPromptFlag, '{systemPrompt}'] }]
          : spec.args,
        o,
      ),
    installHint: spec.installHint || (spec.npmPackage ? `npm install -g ${spec.npmPackage}` : ''),
    npmPackage: spec.npmPackage,
    brew: spec.brew,
    docsUrl: spec.docsUrl,
    protocol: 'stdin',
    parser: spec.output,
    steer: f.steer,
    notes: f.notes,
    compact: f.compact,
    review: 'prompt',
    fork: f.fork,
    autoCompact: f.autoCompact,
    autoCompactEnv: f.autoCompactEnv,
    slash: f.slash,
    contextWindow: f.contextWindow,
    limitEnv: f.limitEnv,
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
    mcp: spec.mcp,
    mcpStore: spec.mcpStore,
    auth: spec.auth && { ...spec.auth, accountNote: tr(spec.auth.accountNote) },
    spec: true,
  }
}
