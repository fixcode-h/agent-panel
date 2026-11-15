import { z } from 'zod'
import { McpServer } from '../library.ts'

/**
 * 插件接口 11 的四个可选字段和包装记录（设计稿：GitHub项目一键变插件与网页页签 第 5 节，ADR 0068）。
 * 都是声明式数据：插件不写代码也能给 Agent 带环境变量、外部 MCP 服务，由面板起停托管进程、出网页页面。
 * 从 GitHub 链接包装出来的插件（server/plugins/wrap/）就是靠这几个字段接进面板的，产物仍是标准插件包。
 *
 * 值里能用的占位符：`{config.<key>}` 换成插件参数（settings 里声明的），`{port}` 换成托管进程分到的端口，
 * `{dir}` 换成插件包目录，`{data}` 换成插件的数据目录（plugin-data/<id>/）
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 插件不能设置的环境变量：面板自己的变量、CLI 的凭据和会改变子进程身份的变量。写了直接拒装，
 * 免得一个包装来的插件悄悄换掉用户的 API key 或把 Agent 指到别的数据目录。
 * 账号设置里的变量另在运行时优先（插件的值不覆盖，见 server/plugins/env.ts）
 */
const RESERVED_ENV = [/^AGENT_PANEL_/, /^ANTHROPIC_/, /^OPENAI_/, /^CLAUDECODE$/, /^HOME$/, /^USERPROFILE$/, /^GIT_/]
const CREDENTIAL_ENV = /(^|_)(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)$|^GITHUB_TOKEN$|^GH_TOKEN$/

/** 这个变量名插件能不能写；不能时返回原因 */
export function reservedEnv(name: string): string {
  const up = name.toUpperCase()
  if (RESERVED_ENV.some((r) => r.test(up))) return `面板或 CLI 自己的变量：${name}`
  if (CREDENTIAL_ENV.test(up)) return `凭据变量不能由插件写：${name}（改成插件参数，让用户在插件页填）`
  return ''
}

const EnvName = z
  .string()
  .regex(ENV_NAME, '环境变量名只能有字母、数字和下划线')
  .refine((k) => k.toUpperCase() === 'PATH' || !reservedEnv(k), { error: (i) => reservedEnv(String(i.input)) })

/**
 * ① 给 Agent 的环境变量。只在这个插件对这一轮生效时带（全局插件每轮带，按项目的只在打开了它的项目带）。
 * PATH 只能前置目录（相对包根），不能整个换掉
 */
export const PluginEnv = z
  .record(EnvName, z.union([z.string(), z.object({ prepend: z.array(z.string().min(1)).min(1).max(10) })]))
  .refine((e) => Object.entries(e).every(([k, v]) => (k.toUpperCase() === 'PATH') === (typeof v !== 'string')), {
    error: 'PATH 只能写 { "prepend": [...] }，其他变量只能写字符串',
  })
  .refine((e) => Object.keys(e).length <= 30, { error: '环境变量最多 30 个' })
export type PluginEnv = z.infer<typeof PluginEnv>

/**
 * ② 外部 MCP 服务：不进插件进程，交给 MCP 库按插件的生效方式每轮注入（CLI 没有 inject 的退回全局写入）。
 * 形状和 MCP 库的条目一样（shared/library.ts McpServer），值里能用占位符
 */
export const PluginMcp = McpServer
export type PluginMcp = z.infer<typeof PluginMcp>

/** ③ 托管进程（网页应用、需要常驻的本地服务），由面板起停（server/plugins/services.ts） */
export const PluginService = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  /** 可执行文件：包里的相对路径，或 PATH 上的命令（node、python、npx） */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** 工作目录，相对包根；默认包根 */
  cwd: z.string().default('.'),
  env: z.record(EnvName, z.string()).default({}),
  /** auto：面板分一个空闲端口（只绑 127.0.0.1），通过 {port} 交给进程；数字：固定端口 */
  port: z.union([z.literal('auto'), z.number().int().min(1024).max(65535)]).default('auto'),
  /** 健康检查的路径：返回 2xx/3xx 才算起来了；不写只等端口能连上 */
  health: z.string().default('/'),
  /** on-open：打开它的网页页面时才起（默认）；on-load：插件加载就起 */
  start: z.enum(['on-open', 'on-load']).default('on-open'),
  /** 没有页面在看多少分钟后停，0 表示不自动停 */
  stopAfterIdleMin: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(30),
  /** 等多少秒还没起来就算失败 */
  startTimeoutSec: z.number().int().min(1).max(600).default(60),
})
export type PluginService = z.infer<typeof PluginService>

/**
 * ④ 声明式网页页面：不写网页代码，面板用网页页签的组件（web/src/components/ui/web-frame.tsx）画。
 * url：`service:<进程 id>/<路径>` 指托管进程；`file:<相对包根的路径>` 指包里的静态文件；`https://…` 外部网址
 */
export const PluginWebPage = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  label: z.string().min(1),
  icon: z.string().default('globe'),
  url: z
    .string()
    .regex(/^(service:[a-z][a-z0-9-]*\/|file:[^/\\]|https?:\/\/)/, '网址要以 service:、file: 或 http(s):// 开头'),
  /** 同接口 9 的 PluginPage.scope：global 进图标栏，project 进项目工具；不写按插件的 activation */
  scope: z.enum(['global', 'project']).optional(),
})
export type PluginWebPage = z.infer<typeof PluginWebPage>

/** 包装记录：界面上的「包装 · GitHub」徽标、更新时比对上游用 */
export const PluginWrap = z.object({
  /** owner/repo */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  /** 固定到的提交（更新永远是从提交 A 到提交 B） */
  commit: z.string().min(7),
  /** 查上游更新的方式：最新 Release、最新标签、分支（只建议自己的仓库用） */
  track: z.enum(['release', 'tag', 'branch']).default('release'),
  /** track 为 tag / branch 时的标签或分支名 */
  ref: z.string().optional(),
  /** 用的配方：插件仓库 wraps/ 里的路径；没有表示识别器自动生成的 */
  recipe: z.string().optional(),
  /** 识别出、并且用户勾选了的类型 */
  kinds: z.array(z.enum(['skills', 'claude-plugin', 'mcp', 'cli', 'web-app'])).default([]),
  /** 来源分级：官方配方 / 社区配方 / 任意链接（界面徽标「未经市场审核」） */
  trust: z.enum(['official', 'community', 'any']).default('any'),
})
export type PluginWrap = z.infer<typeof PluginWrap>

/** 清单里接口 11 的这几段（types.ts 的 PluginManifest 展开它） */
export const PluginRuntimeFields = {
  env: PluginEnv.default({}),
  mcp: z
    .array(PluginMcp)
    .max(20)
    .default([])
    .refine((l) => new Set(l.map((s) => s.name)).size === l.length, { error: 'mcp 里有重名的服务' }),
  services: z
    .array(PluginService)
    .max(5)
    .default([])
    .refine((l) => new Set(l.map((s) => s.id)).size === l.length, { error: 'services 里有重复的 id' }),
  webPages: z.array(PluginWebPage).max(10).default([]),
  wrap: PluginWrap.optional(),
}

/** 用到接口 11 字段的清单至少要声明 api 11（旧面板装它会提示先升级面板） */
export function usesApi11(m: {
  env: PluginEnv
  mcp: unknown[]
  services: unknown[]
  webPages: unknown[]
  wrap?: unknown
}) {
  return Object.keys(m.env).length > 0 || m.mcp.length > 0 || m.services.length > 0 || m.webPages.length > 0 || !!m.wrap
}
