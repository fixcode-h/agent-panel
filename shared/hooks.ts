import { z } from 'zod'
import type { TaskMessage } from './schema.ts'
import { NOTIFY_EVENTS, type HookEventName, type ToolKind } from './hook-defs.ts'
import { panelToolName } from './panel-tools.ts'

/**
 * 钩子（ADR 0049）：模型准备结束这一轮时（turn.beforeEnd），CLI 先问面板；计划没做完、也没在等任何结果时
 * 面板答「拦住」并给出下一步，CLI 在同一轮里接着做，对话里不再另起一轮【面板】提醒。第二期加了工具前、工具后、
 * 上下文恢复（压缩之后）三个事件，内置钩子和用户钩子都挂在它们上（规范见 shared/hook-defs.ts）。
 *
 * 这里放和 CLI 无关的部分：CLI 定义里的 hooks 字段、面板的判断结果、给 Claude Code 这类「钩子是一条命令」的 CLI
 * 用的转发脚本。怎么装进 CLI（参数、扩展、mod）写在各自的 CLI 定义里，代码按字段走，不按 CLI 的名字分支。
 *
 * 硬规则：面板只按结构化状态判断（计划、提问、子对话、后台命令、submit_* 交没交），不读模型回复的文字。
 * 转发脚本发给面板之前就把原生输入里的回复文字（last_assistant_message 这类）丢掉，面板根本拿不到
 */

/**
 * CLI 定义里的「结束前钩子」怎么装：
 * - via=command：CLI 的钩子是一条命令（Claude Code 的 Stop）。面板在这一轮的临时目录写转发脚本（{hookScript}）
 *   和 files 里的配置；拦住时转发脚本把 block 模板（{reason} 填好）原样打印给 CLI。
 * - via=extension：钩子写在面板每轮已经装进 CLI 的扩展里（Pi 的 -e 桥接扩展、Command Code 的 --mod），
 *   扩展自己按 HOOK_URL_ENV 或 {url}/hook 问面板，这里只声明「这个 CLI 支持」。
 * 钩子配置可以写进文件（files，Claude Code 的 --settings），也可以直接写成参数（args，Codex 的 -c hooks.Stop=…）
 */
export const BeforeEndSpec = z.object({
  via: z.enum(['command', 'extension']),
  files: z.record(z.string(), z.unknown()).default({}),
  /** 装这个事件要加的参数（钩子配置直接写在参数里的 CLI） */
  args: z.array(z.string()).default([]),
  /** 实测过的最低版本：本机装的更老时不装，退回一轮结束后的提醒（读不到版本时照装） */
  minVersion: z.string().optional(),
  /** 拦住时 CLI 要的输出（via=command）；里面的 {reason} 换成面板给的说明 */
  block: z.unknown().optional(),
  why: z.string().default(''),
})
export type BeforeEndSpec = z.infer<typeof BeforeEndSpec>

/**
 * 工具前、工具后、上下文恢复。命令类（Claude Code、Codex）：files 是要合进钩子配置的那一段，args 是要加的参数，
 * deny / context 是 CLI 要的输出模板。写在扩展里的（Pi、Command Code）不写 files / args，deny / context 写成 "{reason}" / "{text}"，
 * 只表示这个 CLI 能拒绝、能补说明；扩展自己读面板回的 deny / reason / context
 */
export const EventSpec = z.object({
  files: z.record(z.string(), z.unknown()).default({}),
  args: z.array(z.string()).default([]),
  minVersion: z.string().optional(),
  /** 拒绝这次工具调用时 CLI 要的输出（tool.before），{reason} 换成原因 */
  deny: z.unknown().optional(),
  /** 补给模型的一段说明（{text}）；没有这一项表示这个事件不能补说明 */
  context: z.unknown().optional(),
  why: z.string().default(''),
})
export type EventSpec = z.infer<typeof EventSpec>

export const HooksSpec = z.object({
  /** 装钩子要加的参数（命令类钩子的配置文件路径），有任何一个命令类事件要装时才加 */
  args: z.array(z.string()).default([]),
  /**
   * 钩子要先「信任」才会跑的 CLI 怎么信任面板自己的钩子：rpc 表示开始前用常驻协议查一遍钩子、
   * 只把命令里引用了 HOOK_SCRIPT_ENV 的那几条（面板的转发脚本）记成信任（Codex 的 hooks/list + config/batchWrite）
   */
  trust: z.enum(['rpc']).optional(),
  beforeEnd: BeforeEndSpec.optional(),
  events: z
    .object({
      'tool.before': EventSpec.optional(),
      'tool.after': EventSpec.optional(),
      'context.restored': EventSpec.optional(),
    })
    .default({}),
  /** 原生输入里要丢掉、不交给面板的字段（模型回复的文字），见上面的硬规则 */
  dropInput: z.array(z.string()).default([]),
  /** 各家工具名对照到面板的工具类别（用户钩子按类别匹配） */
  toolNames: z.record(z.string(), z.array(z.string())).default({}),
  /** 以这些开头的 shell 命令算改文件（Codex 的模型有时用 shell 跑 apply_patch，钩子收到的工具名是 Bash） */
  editCommands: z.array(z.string()).default([]),
  /** 原生输入里工具名、参数、文件路径在哪个字段 */
  toolFields: z
    .object({
      name: z.string().default('tool_name'),
      input: z.string().default('tool_input'),
      path: z.array(z.string()).default(['file_path']),
      /** 工具后：执行结果在哪个字段（取第一个有的，对象转成文字） */
      output: z.array(z.string()).default([]),
      /** 工具后：这些字段有值（非空、为真）就是执行失败；没有这一项的 CLI 报不出失败 */
      failed: z.array(z.string()).default([]),
    })
    .default({ name: 'tool_name', input: 'tool_input', path: ['file_path'], output: [], failed: [] }),
  /**
   * 命令类钩子能直接 POST 到面板（不用每次起一个 node 跑转发脚本）：本机版本不低于 minVersion 时，
   * 配置里引用 {hookScript} 的那一项换成 entry（{url} 换成这个事件的地址，原生输入直接交给面板，回的就是 CLI 要的输出）。
   * 读不到本机版本时不换：老版本不认这种钩子会静静地不跑，守卫就失效了
   */
  http: z.object({ minVersion: z.string(), entry: z.unknown() }).optional(),
})
export type HooksSpec = z.infer<typeof HooksSpec>

/**
 * 工具前 / 工具后这一轮实际关心哪几类工具（内置守卫、提醒和用户钩子合起来）：配置里写了 {toolMatcher} 的 CLI
 * 只对这几类工具触发钩子，读文件、搜索这类没人管的工具不再每次多跑一趟。不给、含 any 时所有工具都触发
 */
export type HookToolScope = Partial<Record<'tool.before' | 'tool.after', ToolKind[]>>

/** 面板对「结束前」的回答：block 时 reason 是交给 Agent 的说明（不翻译），why 是写进日志的原因 */
export interface BeforeEndDecision {
  block: boolean
  reason?: string
  why: string
}

/** 转发时带上的原生输入里，面板唯一会看的字段：CLI 告诉面板这次是不是已经被钩子续过一次 */
export interface BeforeEndInput {
  again?: boolean
}

/** 工具前、工具后、上下文恢复交给面板的事实：都从原生输入里按 CLI 定义取，不含模型回复的文字 */
export interface HookFacts {
  /** path 是第一个文件（相对项目根判断范围时用）；paths 是这次要改的全部文件（补丁一次可以改好几个） */
  tool?: {
    kind: ToolKind
    name: string
    input: Record<string, unknown>
    path: string
    paths: string[]
    /** 面板自己的工具（submit_merge 这些）去掉前缀后的名字；不是面板工具为空 */
    panel?: string
    /** 工具后才有：执行结果（截短）和是不是失败了；CLI 报不出失败时 failed 为 undefined */
    result?: { output: string; failed?: boolean }
  }
  /** 上下文恢复的来由：compact（压缩之后）、resume（续接）、startup（新开） */
  source?: string
}

/** 面板对其余事件的回答：deny 只对 tool.before，context 是补给模型的一段说明 */
export interface HookAnswer {
  deny?: boolean
  reason?: string
  context?: string
}

/** 放行：不表态 */
export const allowEnd = (why: string): BeforeEndDecision => ({ block: false, why })

/** 转发地址的环境变量：面板起 CLI 时放进去，钩子命令、Command Code 的 mod 从这里取 */
export const HOOK_URL_ENV = 'AGENT_PANEL_HOOK_URL'

/**
 * 转发脚本路径的环境变量：钩子命令写成 node "$AGENT_PANEL_HOOK_SCRIPT" 时，命令本身每轮都一样。
 * Codex 按命令内容算信任的哈希，路径每轮换（临时目录）的话每轮都要重新信任；引用环境变量就只需信任一次
 */
export const HOOK_SCRIPT_ENV = 'AGENT_PANEL_HOOK_SCRIPT'

/**
 * 这一轮装了哪些事件（逗号分隔）：钩子写在扩展里的 CLI（Pi 的桥接扩展、Command Code 的 mod）每轮装的是同一份代码，
 * 按它决定问不问面板，没人用的工具前 / 工具后不必每次工具调用都多问一次
 */
export const HOOK_EVENTS_ENV = 'AGENT_PANEL_HOOK_EVENTS'

/** Pi 扩展续跑时追加的那条消息的类型：面板的输出解析按它认出来，不画成用户消息 */
export const HOOK_CONTINUE_TYPE = 'agent-panel-continue'

/** 转发超时：面板没回就放行，钩子坏了不能把对话卡住（用户钩子自己可以设到 60 秒，转发就按它放宽） */
export const HOOK_TIMEOUT_MS = 5000
/** 转发脚本最多等面板这么久：用户钩子的超时上限 60 秒再留一点余量 */
export const FORWARD_TIMEOUT_MS = 65_000

/** 按模板填 {reason} / {text}：模板里的字符串原样替换，对象、数组逐层替换 */
export function fillTpl(tpl: unknown, vars: { reason?: string; text?: string; event?: string }): unknown {
  if (typeof tpl === 'string')
    return tpl
      .replace(/\{reason\}/g, () => vars.reason ?? '')
      .replace(/\{text\}/g, () => vars.text ?? '')
      .replace(/\{event\}/g, () => vars.event ?? '')
  if (Array.isArray(tpl)) return tpl.map((x) => fillTpl(x, vars))
  if (tpl && typeof tpl === 'object')
    return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, fillTpl(v, vars)]))
  return tpl
}

/** 转发脚本在这一轮临时目录里的文件名 */
export const HOOK_SCRIPT = 'agent-panel-hook.mjs'

/** 用户钩子在这个 CLI 的对话里能用哪些事件：CLI 能装的，加上面板自己发、只通知的那几个（对哪个 CLI 都一样） */
export const hookEventsFor = (spec: HooksSpec | undefined, version?: string): HookEventName[] => [
  ...supportedEvents(spec, version),
  ...NOTIFY_EVENTS,
]

/** 版本号里的第一段 x.y.z（CLI 的 --version 常带名字：「codex-cli 0.166.0」「2.1.318 (Claude Code)」） */
const semver = (v: string) => /(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number)

/** v 不低于 min；读不出版本（没检测过、格式认不出）时当成够 */
export function versionAtLeast(v: string | undefined, min: string | undefined): boolean {
  const a = v ? semver(v) : undefined
  const b = min ? semver(min) : undefined
  if (!a || !b) return true
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}

/** 这个 CLI（按定义）能装哪些事件：结束前看 beforeEnd，其余看 events；给了本机版本时按 minVersion 去掉不够的 */
export function supportedEvents(spec: HooksSpec | undefined, version?: string): HookEventName[] {
  if (!spec) return []
  return [
    ...(spec.beforeEnd && versionAtLeast(version, spec.beforeEnd.minVersion) ? (['turn.beforeEnd'] as const) : []),
    ...(Object.keys(spec.events) as (keyof HooksSpec['events'])[]).filter(
      (k) => spec.events[k] && versionAtLeast(version, spec.events[k]!.minVersion),
    ),
  ]
}

/** 同一个配置文件的几段合在一起：对象逐层合并，数组接在一起（几个事件各自往 hooks 下面加自己的那一项） */
function mergeConfig(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = k in out ? mergeConfig(out[k], v) : v
    return out
  }
  return b
}

/**
 * 命令类钩子这一轮要加的参数和要写的文件：只装 active 里的事件（没人用的工具前 / 工具后不装，免得每次工具调用都多跑一次脚本）。
 * {dir} 换成面板这一轮的临时目录，{hookScript} 换成转发脚本。路径一律用正斜杠：钩子命令在 Windows 上也可能交给 bash 执行，
 * 反斜杠会被当成转义。没有要装的返回空
 */
export function hookInstall(spec: HooksSpec, dir: string, active: HookEventName[], opts: HookInstallOptions = {}) {
  const d = dir.replace(/\\/g, '/')
  const script = `${d}/${HOOK_SCRIPT}`
  const fill = (v: unknown): unknown =>
    typeof v === 'string'
      ? v.replace(/\{dir\}/g, () => d).replace(/\{hookScript\}/g, () => script)
      : Array.isArray(v)
        ? v.map(fill)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [fill(k) as string, fill(x)]))
          : v
  const parts: { event: HookEventName; files: Record<string, unknown>; args: string[] }[] = []
  if (active.includes('turn.beforeEnd') && spec.beforeEnd?.via === 'command')
    parts.push({ event: 'turn.beforeEnd', ...spec.beforeEnd })
  // 写在扩展里的事件（Pi、Command Code）既没有文件也没有参数：不算命令类，不写转发脚本
  for (const ev of ['tool.before', 'tool.after', 'context.restored'] as const) {
    const e = spec.events[ev]
    if (active.includes(ev) && e && (e.args.length || Object.keys(e.files).length)) parts.push({ event: ev, ...e })
  }
  if (!parts.length)
    return {
      args: [] as string[],
      files: [] as { path: string; content: unknown }[],
      env: {} as Record<string, string>,
    }
  // 每个事件先填自己的那几处：工具过滤（{toolMatcher}），能直接 POST 时把转发脚本那一项换成 HTTP 钩子
  const own = (p: (typeof parts)[number]) => {
    const scope = p.event === 'tool.before' || p.event === 'tool.after' ? opts.tools?.[p.event] : undefined
    const matcher = toolMatcher(spec, scope)
    const url = opts.httpUrl && spec.http ? `${opts.httpUrl}/${p.event}` : ''
    const each = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const s = v.replace(/\{toolMatcher\}/g, () => matcher)
        return opts.curlUrl ? toCurl(s, opts.curlUrl) : s
      }
      if (Array.isArray(v)) return v.map(each)
      if (!v || typeof v !== 'object') return v
      const o = v as Record<string, unknown>
      if (url && typeof o.command === 'string' && o.command.includes('{hookScript}'))
        return fillHttp(spec.http!.entry, url)
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, each(x)]))
    }
    return { files: each(p.files) as Record<string, unknown>, args: each(p.args) as string[] }
  }
  const filled = parts.map(own)
  const merged = new Map<string, unknown>()
  for (const p of filled)
    for (const [k, v] of Object.entries(p.files)) merged.set(k, merged.has(k) ? mergeConfig(merged.get(k), v) : v)
  const args = [...spec.args, ...filled.flatMap((p) => p.args)]
  // 全换成 HTTP 钩子、curl 以后没人再引用转发脚本：不写脚本、不加环境变量
  const refs = JSON.stringify([args, [...merged]])
  const needScript = refs.includes('{hookScript}') || refs.includes(HOOK_SCRIPT_ENV)
  return {
    args: args.map((a) => fill(a) as string),
    env: needScript ? { [HOOK_SCRIPT_ENV]: script } : ({} as Record<string, string>),
    files: [
      ...(needScript ? [{ path: script, content: hookForwarderSource(spec.dropInput) as unknown }] : []),
      ...[...merged].map(([p, content]) => ({ path: fill(p) as string, content: fill(content) })),
    ],
  }
}

export interface HookInstallOptions {
  /** 这一轮工具前 / 工具后实际关心哪几类工具：配置里的 {toolMatcher} 按它填 */
  tools?: HookToolScope
  /** 本机 CLI 支持 HTTP 钩子时，面板这一轮的钩子地址（{url} 是它加上 /事件名）；空时用转发脚本 */
  httpUrl?: string
  /**
   * 本机有 curl 时面板这一轮的钩子地址：CLI 不支持 HTTP 钩子的，调转发脚本的命令换成 curl 直接 POST 到面板（见 toCurl），
   * 不再每次起一个 node。空时用转发脚本
   */
  curlUrl?: string
}

/** curl 的参数：-f 面板回错误时不打印（CLI 当成不表态），--max-time 和转发脚本的超时一致 */
const CURL = '-s -f --max-time 65 -H "content-type: application/json" --data-binary @-'
const esc = (s: string) => s.replace(/[$%{}]/g, (c) => `\\${c}`)

/**
 * 调转发脚本的命令换成 curl：原生输入从 stdin 直接 POST 到面板的 /hook/<事件>，面板回的就是 CLI 要的输出（server/ask-mcp.ts）。
 * 认三种写法：配置文件里的 node "{hookScript}"（地址直接写进这一轮的配置），参数里的 node "$转发脚本变量" 和
 * Windows 的 node "%转发脚本变量%"（换成地址的环境变量：命令每轮不变，要信任的 CLI 信任一次就够）
 */
export function toCurl(cmd: string, url: string): string {
  const swap = (from: string, to: (ev: string) => string) => (s: string) =>
    s.replace(new RegExp(`node "${esc(from)}" ([\\w.]+)`, 'g'), (_, ev: string) => to(ev))
  return [
    swap('{hookScript}', (ev) => `curl ${CURL} "${url}/${ev}"`),
    swap(`$${HOOK_SCRIPT_ENV}`, (ev) => `curl ${CURL} "$${HOOK_URL_ENV}/${ev}"`),
    swap(`%${HOOK_SCRIPT_ENV}%`, (ev) => `curl.exe ${CURL} "%${HOOK_URL_ENV}%/${ev}"`),
  ].reduce((s, f) => f(s), cmd)
}

/**
 * {toolMatcher} 的值：这几类工具在这个 CLI 里的工具名，用 | 连起来；要所有工具时为空（Claude Code 的 matcher 为空即全部）。
 * 面板自己的工具（panel）和任意工具（any）列不全名字，按全部算；对照表里某一类一个名字都没有时也按全部算，宁可多跑也不漏
 */
export function toolMatcher(spec: HooksSpec, kinds: ToolKind[] | undefined): string {
  if (!kinds?.length || kinds.includes('any') || kinds.includes('panel')) return ''
  if (kinds.some((k) => !spec.toolNames[k]?.length)) return ''
  // 用 shell 跑改文件命令的 CLI（editCommands）：改文件也可能以 shell 工具的名字出现
  const all = kinds.includes('edit') && spec.editCommands.length ? [...kinds, 'shell' as const] : kinds
  return [...new Set(all.flatMap((k) => spec.toolNames[k] ?? []))].join('|')
}

/** HTTP 钩子那一项：{url} 换成这个事件的地址 */
function fillHttp(tpl: unknown, url: string): unknown {
  if (typeof tpl === 'string') return tpl.replace(/\{url\}/g, () => url)
  if (Array.isArray(tpl)) return tpl.map((x) => fillHttp(x, url))
  if (tpl && typeof tpl === 'object')
    return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, fillHttp(v, url)]))
  return tpl
}

/** 从原生输入里取「结束前」要的那一点：只认几个已知的「已经续过」标记，其余（含回复文字）一律不要 */
export function beforeEndInput(native: unknown, drop: string[] = []): BeforeEndInput {
  if (!native || typeof native !== 'object') return {}
  const o = { ...(native as Record<string, unknown>) }
  for (const k of drop) delete o[k]
  return { again: o.stop_hook_active === true }
}

/**
 * 工具名在这个 CLI 里属于哪一类（shell / edit / read），没登记的返回 undefined。
 * 「哪个工具名是跑命令、改文件、读文件」只认 CLI 定义的 hooks.toolNames 这一份：钩子的 matcher、守卫（hookFacts）
 * 和对话记录的解析（server/exec/parsers.ts）都从这里取，不在代码里另写一份名单。
 * 以前解析层写死 `case 'Bash'`，Windows 上 Claude Code 的 PowerShell 工具被记成 other，收尾自检数不到动作、
 * 守卫也管不到（用户 2026-11-05 报）
 */
export function toolKindOf(spec: Pick<HooksSpec, 'toolNames'> | undefined, name: string): ToolKind | undefined {
  if (!spec || !name) return undefined
  return Object.entries(spec.toolNames).find(([, names]) => names.includes(name))?.[0] as ToolKind | undefined
}

/** 从原生输入里取工具前 / 工具后、上下文恢复要的事实：工具名对照到类别，文件路径按定义里的字段取 */
export function hookFacts(spec: HooksSpec, native: unknown): HookFacts {
  if (!native || typeof native !== 'object') return {}
  const o = native as Record<string, unknown>
  const name = typeof o[spec.toolFields.name] === 'string' ? (o[spec.toolFields.name] as string) : ''
  const source = typeof o.source === 'string' ? o.source : undefined
  if (!name) return source ? { source } : {}
  const raw = o[spec.toolFields.input]
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  let kind: ToolKind = toolKindOf(spec, name) ?? 'any'
  const cmd = typeof input.command === 'string' ? input.command.trim() : ''
  if (kind === 'shell' && spec.editCommands.some((c) => cmd.startsWith(c))) kind = 'edit'
  const field = spec.toolFields.path.map((k) => input[k]).find((v) => typeof v === 'string') as string | undefined
  // 补丁（apply_patch）没有单独的路径参数：从补丁头「*** Add/Update/Delete File: 路径」里取
  const paths = field
    ? [field]
    : kind === 'edit'
      ? Object.values(input)
          .filter((v): v is string => typeof v === 'string')
          .flatMap((v) => [...v.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim()))
      : []
  // 面板自己的工具（各家前缀不一样，见 panel-tools.ts）：类别记成 panel，用户钩子按去掉前缀的名字匹配
  const panel = panelToolName(name)
  if (panel) kind = 'panel'
  const result = toolResult(spec, o)
  return {
    tool: { kind, name, input, path: paths[0] ?? '', paths, panel, ...(result ? { result } : {}) },
    ...(source ? { source } : {}),
  }
}

/** 结果最多留这么多字：钩子判断「是不是同一个错」够用，不把几 MB 的输出转来转去 */
const RESULT_MAX = 2000

/** 工具后的执行结果：按定义里的字段取，对象转成文字；没有结果字段（工具前）返回 undefined */
function toolResult(spec: HooksSpec, o: Record<string, unknown>): { output: string; failed?: boolean } | undefined {
  const f = spec.toolFields
  const raw = f.output.map((k) => o[k]).find((v) => v !== undefined && v !== null)
  const failedKnown = f.failed.length > 0
  const failed = f.failed.some((k) => {
    const v = o[k]
    return v === true || (typeof v === 'string' && v.trim() !== '')
  })
  if (raw === undefined && !failed) return undefined
  const text = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw)
  return { output: text.slice(0, RESULT_MAX), ...(failedKnown ? { failed } : {}) }
}

/**
 * 转发脚本（命令类钩子）：CLI 运行它时第一个参数是面板事件，stdin 进原生 JSON。
 * 只做转发，不判断：丢掉回复文字，POST 给面板，面板回了 output 就原样打印，其余（面板没起来、超时、出错）什么都不打印，
 * CLI 就照常往下走。用 node:http 不用 fetch：老版本 Node 没有 fetch，也省得被代理环境变量改道
 */
export function hookForwarderSource(drop: string[]) {
  return `// Agent 面板的钩子转发（ADR 0049）：只转发，不判断；面板没回就放行
import { request } from 'node:http'

const url = process.env.${HOOK_URL_ENV}
const event = process.argv[2] || 'turn.beforeEnd'
const DROP = ${JSON.stringify(drop)}
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  if (!url) return
  let native = {}
  try {
    native = JSON.parse(raw || '{}')
  } catch {}
  for (const k of DROP) delete native[k]
  const body = JSON.stringify({ event, native })
  const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let text = ''
    res.setEncoding('utf8')
    res.on('data', (c) => (text += c))
    res.on('end', () => {
      try {
        const r = JSON.parse(text)
        if (r && r.output) process.stdout.write(JSON.stringify(r.output))
      } catch {}
    })
  })
  req.setTimeout(${FORWARD_TIMEOUT_MS}, () => req.destroy())
  req.on('error', () => {})
  req.end(body)
})
`
}

/**
 * 拦住之后记进对话的那一行（panel: 'hook'）：界面画成回复里的一行「面板让它接着做」，点开看交给它的说明。
 * 只给人看，不交给 CLI（CLI 已经从钩子拿到了说明）
 */
export function hookMarker(reason: string, id: string, agentId: string, step: string): TaskMessage {
  return {
    id,
    role: 'system',
    agentId,
    step,
    text: reason,
    tools: [],
    panel: 'hook',
    at: new Date().toISOString(),
  }
}
