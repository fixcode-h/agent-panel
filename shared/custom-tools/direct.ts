/**
 * 自建工具直接当一等工具调（ADR 0082 第 9 节，用户 2026-11-28）：每个能用的自建工具在面板 MCP 的清单里各出一项
 * `tool_<id>`，参数 schema 按工具的参数定义生成，Agent 像调内置工具一样一步填参数执行，不用先 custom_tool list / show。
 * 以前都挤在通用入口 custom_tool（action + id + args）里，模型看不到参数，总是 list → show → run 三步，
 * 弱模型还会因此去翻目录找程序。执行仍走 custom_tool action=run 同一条路（server/custom-tools/agent.ts 的 runOne）。
 * 前后端和演示共用：名字换算、清单、说明都在这里，提示词和面板的提醒按 callHint 写调用方式
 */
import type { CustomTool, ToolEntry, ToolParam } from './schema.ts'

/** 工具名前缀：和面板自己的工具、插件的 ue_ / blender_ 不撞名 */
export const DIRECT_PREFIX = 'tool_'
/** 直接列出的上限：清单每个会话都整份带着，太多了模型选不准；更多的照旧经 custom_tool action=run 调 */
export const DIRECT_MAX = 12
/** 一个工具说明的上限（ADR 0067 定义不超过 3000 字，参数 schema 另算，这里只给说明留一半不到） */
const DESC_MAX = 1200

/** 工具 id（小写字母数字和 -）换成 MCP 工具名：- 换成 _（id 里没有 _，换回来不会错） */
export const directName = (id: string) => `${DIRECT_PREFIX}${id.replaceAll('-', '_')}`
/** MCP 工具名换回工具 id；不是自建工具的名字返回空串 */
export const directId = (name: string) =>
  /^tool_[a-z][a-z0-9_]{1,47}$/.test(name) ? name.slice(DIRECT_PREFIX.length).replaceAll('_', '-') : ''

/** 交给 CLI 的定义（形状和面板工具的 ToolDef 一样） */
export interface DirectToolDef {
  name: string
  title: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

const EFFECT: Record<CustomTool['effect'], string> = { read: '只读', write: '会改文件', external: '影响外部' }

/**
 * 工具名的上限：CLI 拼成 mcp__<服务名>__tool_<id> 交给模型，API 限 64 字；服务名带后缀（panel-xxxx）时也要放得下。
 * id 太长的不直接列出，照旧经 custom_tool 调
 */
const NAME_MAX = 40

/** 直接列出的那几个工具：能用的、名字放得下、按最近用过排（提示词清单同一份），最多 DIRECT_MAX 个 */
export function directEntries(entries: ToolEntry[]): ToolEntry[] {
  return entries
    .filter((e) => e.tool && !e.shadowed && directName(e.tool.id).length <= NAME_MAX)
    .sort((a, b) => (b.last?.at ?? '').localeCompare(a.last?.at ?? ''))
    .slice(0, DIRECT_MAX)
}

export const directTools = (entries: ToolEntry[]): DirectToolDef[] =>
  directEntries(entries).map((e) => directDef(e.tool!, e.scope))

/** 一个自建工具的定义：说明写清做什么、什么时候用 / 别用，参数按定义出 schema（有默认值的不算必填） */
export function directDef(t: CustomTool, scope: ToolEntry['scope'] = 'project'): DirectToolDef {
  const rep = t.role?.replaces.length ? `代替自己跑 ${t.role.replaces.join('、')}。` : ''
  const auto =
    t.role?.kind === 'verify' && t.role.paths.length
      ? `改完 ${t.role.paths.join('、')} 后面板会自己跑它、只推报错。`
      : ''
  const lines = [
    `用户做好的${scope === 'global' ? '全局' : '项目'}自建工具「${t.name}」（${EFFECT[t.effect]}）：${t.summary || t.useWhen}`,
    t.useWhen && `什么时候用：${t.useWhen}`,
    t.avoidWhen && `什么时候别用：${t.avoidWhen}`,
    rep + auto,
    t.params.some((p) => p.required && p.default === undefined)
      ? '按参数说明填好直接调，不要先查用法、也不要自己拼同样的命令。'
      : '参数都有默认值，没特别要求时不填参数直接调；不要先查用法、也不要自己拼同样的命令。',
    '面板会校验参数、P4 先签出，结果只回报错和输出尾部，完整日志给路径。',
  ]
  const required = t.params.filter((p) => p.required && p.default === undefined).map((p) => p.name)
  return {
    name: directName(t.id),
    title: t.name,
    description: clip(lines.filter(Boolean).join('\n'), DESC_MAX),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(t.params.map((p) => [p.name, paramSchema(p)])),
      ...(required.length && { required }),
      additionalProperties: false,
    },
  }
}

function paramSchema(p: ToolParam): Record<string, unknown> {
  const desc =
    [p.label, p.desc].filter(Boolean).join('：') + (p.type === 'path' ? '（路径，相对项目根或完整路径）' : '')
  const type = p.type === 'number' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string'
  return {
    type,
    ...(desc && { description: desc }),
    ...(p.type === 'enum' && p.options.length && { enum: p.options }),
    ...(p.default !== undefined && { default: p.default }),
    ...(p.type === 'number' && p.min !== undefined && { minimum: p.min }),
    ...(p.type === 'number' && p.max !== undefined && { maximum: p.max }),
    ...(p.type === 'string' && p.pattern && { pattern: p.pattern }),
  }
}

/**
 * 提示词、面板提醒里写「怎么调它」的那一段：直接调 tool_<id>；超过上限没列出的工具清单里没有这个名字，
 * 所以带上经 custom_tool 调的写法兜底。args 写成 {"file": "<文件>"} 这类示例
 */
export function callHint(id: string, args = '') {
  return `${directName(id)}${args ? `（参数 ${args}）` : ''}（工具清单里没有这个名字时用 custom_tool action=run id=${id}${args ? ` args=${args}` : ''}）`
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

/**
 * 对话里自建工具那一行的标题（web/src/lib/tasks.ts 的 panelTool）：直接调的写工具的中文名
 * （运行结果第一行「中文名 id · …」里取，取不到写 id），经 custom_tool 的写「动作 + id」；
 * 展开看参数。raw 是 CLI 报上来的工具名和标题
 */
export function customToolView(
  raw: string,
  args: Record<string, unknown>,
  output = '',
): { label: string; input?: string } {
  const id = directId(/\btool_[a-z][a-z0-9_]+/.exec(raw)?.[0] ?? '')
  if (id) {
    const name = new RegExp(`^(.+?) ${id} · `).exec(output.split('\n', 1)[0] ?? '')?.[1]
    return { label: name || id, input: Object.keys(args).length ? JSON.stringify(args, null, 2) : '' }
  }
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const target = s(args.id) || s(args.query) || s(args.program) || s((args.draft as { id?: unknown } | undefined)?.id)
  const more = args.args && typeof args.args === 'object' ? JSON.stringify(args.args, null, 2) : undefined
  return { label: [s(args.action), target].filter(Boolean).join(' '), ...(more && { input: more }) }
}
