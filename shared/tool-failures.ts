/**
 * 工具调用的失败分类。
 *
 * 失败本身已经由各 CLI 的解析器记在 `ToolUse.failed` 上，这里只把「在陌生环境里探路」的那部分挑出来：
 * 找不到工具、路径、命令，以及给 MCP 工具传错参数（参数名、必填、取值不对：Agent 没照工具真实的参数表传）。它和断言没过、编译错、权限不够不是同一种成本——探路失败说明 Agent 不认识
 * 这个仓库的目录结构或 CLI 的工具表（复盘时要补说明或换做法），所以单独计数。
 *
 * 探路失败仍然是失败调用的一部分：`failed` 含它，不另算一次调用，报告里写成「失败 N 次（其中探路 M 次）」。
 */
import type { ToolUse } from './schema.ts'

export type ProbeKind = 'tool' | 'arg' | 'path' | 'command'

/** 分类的固定顺序：报告和界面都按它列，新增一类只加一行 */
export const PROBE_KINDS: ProbeKind[] = ['tool', 'arg', 'path', 'command']

/** 探路失败按原因分开的计数 */
export type ProbeFailures = Record<ProbeKind, number>

export const NO_PROBES: ProbeFailures = { tool: 0, arg: 0, path: 0, command: 0 }

export interface ToolFailureStats {
  /** 工具调用总数（失败的和成功的都算） */
  calls: number
  /** 标了 failed 的调用数，含探路失败 */
  failed: number
  /** 失败里属于探路的，按原因分开 */
  probeBy: ProbeFailures
}

/** 报告里的说法：和界面的 t('工具不存在') 是同一条文案的中文原文 */
export const PROBE_LABELS: Record<ProbeKind, string> = {
  tool: '工具不存在',
  arg: '参数传错',
  path: '路径不存在',
  command: '命令不存在',
}

/**
 * MCP 工具「参数传错了」的报错写法（A2，设计稿 designs/Agent写代码能力-提升与扩展分析.md）：
 * 统计里归成探路失败的「参数传错」，工具后提醒（server/hooks/tool-after-hints.ts）按它把工具真实的参数表推给模型。
 * 一种写法一行，新服务的报错写法对不上时在这里加一行，不在调用的地方另写判断
 */
export const ARG_ERROR_RULES: { name: string; re: RegExp }[] = [
  // UEToVS、EmmyLua（lua_code）按 ADR 0067 的错误码
  { name: 'invalid_argument', re: /\binvalid_argument\b|"error"\s*:\s*"invalid_params"/i },
  {
    name: '未知参数',
    re: /\bunknown (?:argument|parameter|param|property|field|key)s?\b|\bunrecognized (?:argument|parameter|key)s?\b/i,
  },
  {
    name: '多余参数',
    re: /\bunexpected (?:argument|parameter|keyword argument|property)\b|must NOT have additional properties|additional propert(?:y|ies) .{0,40}not allowed/i,
  },
  {
    name: '缺必填参数',
    re: /\bmissing required (?:argument|parameter|property|field)\b|\brequired (?:argument|parameter|property) .{0,40}(?:missing|not provided)/i,
  },
  // zod 校验失败（MCP SDK 的服务端用 zod 校验参数）：报错里是 issue 数组
  { name: 'zod', re: /"code"\s*:\s*"(?:invalid_type|unrecognized_keys|invalid_enum_value|invalid_value)"/ },
  // JSON-RPC 的「参数无效」
  { name: 'json-rpc', re: /\binvalid (?:arguments?|params?|parameters?)\b(?: for tool)?|MCP error -32602/i },
  { name: '中文', re: /未知参数|参数(?:不对|错误|无效|不合法)|缺少(?:必填)?参数/ },
]

/** 这段输出是不是「参数传错了」的报错；是的话返回对上的那一行的名字 */
export function argErrorIn(text: string): string {
  return ARG_ERROR_RULES.find((r) => r.re.test(text))?.name ?? ''
}

/** 一次调用里能拿来判断的文本：工具名、对象、参数和输出 */
const textOf = (tool: ToolUse) => [tool.name ?? '', tool.label, tool.detail, tool.output ?? ''].join('\n')

/**
 * 分类表：按从窄到宽的顺序匹配，命中第一条就停（tool → arg → command → path）。
 * - 工具名不在 CLI 的工具表里时，输出里常同时带着文件提示，所以 tool 必须排在 path 前面；
 * - arg 只认 MCP 这类「别的工具」（kind 为 other）：命令、测试的输出里也会出现 invalid_type 这类字样，那是断言失败；
 * - 127 是 shell 约定的「命令不存在」，比从输出里认字符串更准；
 * - path 放最后，因为 `No such file or directory` 也可能是命令本身的路径不存在，两种都算探路。
 */
const PROBE_RULES: { kind: ProbeKind; match: (tool: ToolUse, text: string) => boolean }[] = [
  {
    kind: 'tool',
    match: (_, text) => /\b(?:unknown tool|tool not found|no such tool|invalid tool|unrecognized tool)\b/i.test(text),
  },
  { kind: 'arg', match: (tool, text) => tool.kind === 'other' && !!argErrorIn(text) },
  {
    kind: 'command',
    match: (tool, text) =>
      tool.exitCode === 127 ||
      /command not found|is not recognized as an internal or external command|is not recognized as the name of a cmdlet/i.test(
        text,
      ),
  },
  {
    kind: 'path',
    match: (_, text) =>
      /no such file or directory|enoent|cannot find (?:the )?path|the system cannot find the (?:file|path)|系统找不到指定的(?:文件|路径)/i.test(
        text,
      ) ||
      // 「xx does not exist」只认前面带 file / directory / folder / path 的：
      // TS 的「Property 'foo' does not exist on type」和 Jest 的「Expected element does not exist」
      // 是断言/编译失败，不是探路
      /(?:file|directory|folder|path)\b[^\n]{0,40}?does not exist/i.test(text),
  },
]

/** 这次调用是不是探路失败，是的话属于哪一类；正常的执行失败返回 undefined */
export function probeKind(tool: ToolUse): ProbeKind | undefined {
  if (!tool.failed) return undefined
  const text = textOf(tool)
  return PROBE_RULES.find((r) => r.match(tool, text))?.kind
}

/** 一组工具调用：总数、失败数、探路分类，一次遍历算完 */
export function toolFailures(tools: ToolUse[]): ToolFailureStats {
  const out: ToolFailureStats = { calls: tools.length, failed: 0, probeBy: { ...NO_PROBES } }
  for (const tool of tools) {
    if (!tool.failed) continue
    out.failed++
    const kind = probeKind(tool)
    if (kind) out.probeBy[kind]++
  }
  return out
}

/** 两组探路计数相加（节点合计、任务合计、含子对话合计都用它，相加只在这里做） */
export function addProbes(a: ProbeFailures, b: ProbeFailures): ProbeFailures {
  // 旧记录里存的计数没有后来加的类别（arg）：缺的按 0
  return Object.fromEntries(PROBE_KINDS.map((k) => [k, (a[k] ?? 0) + (b[k] ?? 0)])) as ProbeFailures
}

/** 探路失败的合计次数 */
export function probeTotal(by: ProbeFailures): number {
  return PROBE_KINDS.reduce((n, k) => n + (by[k] ?? 0), 0)
}

/**
 * 不属于任何节点的工具调用：任务级算的是全部消息，节点表只按 `m.step` 分组，
 * 两者对不上时（系统消息、已删节点的历史消息）要写明差额，不能让读者拿总数去对节点相加。
 * 传进来的节点统计可以是 NodeStat 里那几个字段。
 */
export function toolsOutsideNodes(
  all: ToolFailureStats,
  nodes: Pick<ToolFailureStats, 'calls' | 'failed' | 'probeBy'>[],
): ToolFailureStats {
  const sum = (pick: (n: (typeof nodes)[number]) => number) => nodes.reduce((n, x) => n + pick(x), 0)
  const sub = (a: number, b: number) => Math.max(0, a - b)
  const calls = sub(
    all.calls,
    sum((n) => n.calls),
  )
  const failed = Math.min(
    calls,
    sub(
      all.failed,
      sum((n) => n.failed),
    ),
  )
  // 探路分类的差额可能比失败差额大（手改过的数据）：按固定顺序截断，不出现「失败 1 次、探路 2 次」
  const probeBy: ProbeFailures = { ...NO_PROBES }
  let left = failed
  for (const k of PROBE_KINDS) {
    const n = sub(
      all.probeBy[k] ?? 0,
      sum((x) => x.probeBy[k] ?? 0),
    )
    probeBy[k] = Math.min(n, left)
    left -= probeBy[k]
  }
  return { calls, failed, probeBy }
}

/** 不带括号的探路说明（和节点外的差额拼在同一个括号里用）：「探路失败 2 次：工具不存在 1」 */
export function probeDetail(by: ProbeFailures): string {
  const total = probeTotal(by)
  if (!total) return ''
  const parts = PROBE_KINDS.filter((k) => by[k]).map((k) => `${PROBE_LABELS[k]} ${by[k]}`)
  const detail = parts.join('、')
  return detail ? `探路失败 ${total} 次：${detail}` : `探路失败 ${total} 次`
}

/** 括号包好的探路说明（含子对话合计行等单独用的地方）：「（其中探路失败 2 次：工具不存在 1）」 */
export function probeText(by: ProbeFailures): string {
  const detail = probeDetail(by)
  return detail ? `（其中${detail}）` : ''
}
