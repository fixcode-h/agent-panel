import { z } from 'zod'
import { compactTree, usedImages, walk, type Widget } from './umg.ts'
import type { ToolUse } from './schema.ts'
import type { Design, DesignMessage, ReplyPart } from './design.ts'
import { fmtDuration } from './duration.ts'

/**
 * AI 分析：检查当前设计对话和生成的 UI 是否合理，以及 AI 生成能力还能加强哪里。
 * 提示词、结果解析和设计状态摘要都放在这里，服务端、演示和前端共用。
 */

export const ANALYSIS_AREAS = ['process', 'ui', 'capability'] as const
export type AnalysisArea = (typeof ANALYSIS_AREAS)[number]

export const ANALYSIS_PRIORITIES = ['high', 'medium', 'low'] as const
export type AnalysisPriority = (typeof ANALYSIS_PRIORITIES)[number]

export const AnalysisFinding = z.object({
  area: z.enum(ANALYSIS_AREAS),
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(3000).default(''),
  /** 依据：引用具体的工具调用、控件名、尺寸或图片名 */
  evidence: z.string().trim().max(2000).default(''),
  /** 能直接发给对话执行的修改要求 */
  suggestion: z.string().trim().max(4000).default(''),
  /** 只有生成能力改进建议用得到；同一段里按高中低排 */
  priority: z.enum(ANALYSIS_PRIORITIES).default('medium'),
})
export type AnalysisFinding = z.infer<typeof AnalysisFinding>

export const DesignAnalysis = z.object({
  /** 总体结论，解析时优先用 JSON 前面那段话 */
  summary: z.string().trim().max(8000).default(''),
  findings: z.array(AnalysisFinding).max(40).default([]),
})
export type DesignAnalysis = z.infer<typeof DesignAnalysis>

const AREA_ALIAS: Record<string, AnalysisArea> = {
  process: 'process',
  对话: 'process',
  对话过程: 'process',
  过程: 'process',
  ui: 'ui',
  UI: 'ui',
  界面: 'ui',
  结果: 'ui',
  界面结果: 'ui',
  'ui 结果': 'ui',
  capability: 'capability',
  能力: 'capability',
  生成能力: 'capability',
  改进: 'capability',
  improve: 'capability',
}

const PRIORITY_ALIAS: Record<string, AnalysisPriority> = {
  high: 'high',
  高: 'high',
  高优先级: 'high',
  medium: 'medium',
  中: 'medium',
  中优先级: 'medium',
  low: 'low',
  低: 'low',
  低优先级: 'low',
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n)}…` : v)

/** 模型偶尔会把 area / priority 写成中文或别的写法，尽量认出来；认不出按对话过程处理 */
function normalizeArea(v: unknown): AnalysisArea {
  const s = str(v).trim()
  return AREA_ALIAS[s] ?? AREA_ALIAS[s.toLowerCase()] ?? 'process'
}

function normalizePriority(v: unknown): AnalysisPriority {
  const s = str(v).trim()
  return PRIORITY_ALIAS[s] ?? PRIORITY_ALIAS[s.toLowerCase()] ?? 'medium'
}

function normalizeFinding(raw: any): AnalysisFinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const title = str(raw.title ?? raw.name ?? raw.issue).trim()
  const detail = str(raw.detail ?? raw.description ?? raw.desc).trim()
  const evidence = str(raw.evidence ?? raw.reason ?? raw.proof).trim()
  const suggestion = str(raw.suggestion ?? raw.fix ?? raw.prompt ?? raw.action).trim()
  // 标题、说明、证据、建议全空的不算一条
  if (!title && !detail && !evidence && !suggestion) return null
  return {
    area: normalizeArea(raw.area ?? raw.section ?? raw.kind),
    title: (title || detail).slice(0, 200),
    detail: detail.slice(0, 3000),
    evidence: evidence.slice(0, 2000),
    suggestion: suggestion.slice(0, 4000),
    priority: normalizePriority(raw.priority),
  }
}

/** 从一段文字里取最后一个能解析的 JSON 对象/数组（模型可能把它放在代码块里） */
function lastJson(text: string): { data: any; block: string } | undefined {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim())
  for (const body of [...blocks].reverse()) {
    try {
      return { data: JSON.parse(body), block: body }
    } catch {}
  }
  // 没有代码块：从第一个 { 或 [ 到最后一个 } 或 ] 试一次
  const start = text.search(/[[{]/)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  if (start >= 0 && end > start) {
    const body = text.slice(start, end + 1)
    try {
      return { data: JSON.parse(body), block: body }
    } catch {}
  }
  return undefined
}

/**
 * 把 AI 的分析回复拆成总体结论文本和结构化的检查项。
 * 没有按格式输出 JSON 时，整段作为结论，findings 为空（界面照样把文字显示出来）。
 */
export function parseDesignAnalysis(text: string): DesignAnalysis {
  const raw = text.trim()
  if (!raw) return { summary: '', findings: [] }
  const found = lastJson(raw)
  if (!found) return { summary: raw, findings: [] }
  const data = found.data
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.findings)
      ? data.findings
      : Array.isArray(data?.suggestions)
        ? data.suggestions
        : []
  const findings = (list as any[])
    .map((x) => normalizeFinding(x))
    .filter((x): x is AnalysisFinding => !!x)
    .slice(0, 40)
  // JSON 前面那段话是总体结论；删掉 JSON 代码块，别在回复里重复显示
  const before = found.block ? raw.replace(found.block, '').replace(/```(?:json)?\s*```/gi, '') : raw
  const summary = before.trim() || str(data?.summary).trim()
  return { summary: summary.slice(0, 8000), findings }
}

/** 显示时去掉 JSON：分析卡片会单独显示检查项，回复里不用再出现一遍原始 JSON */
export function stripAnalysisJson(text: string) {
  let s = text.replace(/```(?:json)?\s*[\s\S]*?```/gi, '')
  // 没有代码块时，把末尾那段能解析出 findings / suggestions 的 JSON 也去掉
  const at = s.search(/{\s*"(?:summary|findings|suggestions)"/)
  if (at >= 0) {
    try {
      const data = JSON.parse(s.slice(at).trim())
      if (data && (Array.isArray(data.findings) || Array.isArray(data.suggestions))) s = s.slice(0, at)
    } catch {}
  }
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

/** 回复的分段同样去掉 JSON 代码块，思考和工具调用照常保留 */
export function cleanAnalysisParts(parts: ReplyPart[]): ReplyPart[] {
  return parts.map((p) => ({ ...p, text: p.text ? stripAnalysisJson(p.text) : p.text }))
}

/** 对话和这一轮的输出按顺序写进提示词：从最近的对话里看出哪一步重复、哪一步在等 */
export function conversationTrace(messages: DesignMessage[], limit = 8): string {
  const list = messages.slice(-limit)
  const lines: string[] = []
  for (const m of list) {
    const who = m.role === 'user' ? '用户' : m.role === 'agent' ? 'AI' : '系统'
    lines.push(`${who}：${clip(m.text.replace(/\s+/g, ' ').trim(), 500) || '（没有文字）'}`)
    const tools: ToolUse[] = m.parts?.length
      ? m.parts.flatMap((p) => p.tools as ToolUse[])
      : ((m.tools ?? []) as ToolUse[])
    for (const t of tools) {
      const name = [t.name, t.label].filter(Boolean).join(' · ') || '工具'
      const ms = t.ms ? `，耗时 ${fmtDuration(t.ms)}` : ''
      const input = t.input ? ` 参数：${clip(t.input.replace(/\s+/g, ' '), 160)}` : ''
      const output = t.output ? ` → ${clip(t.output.replace(/\s+/g, ' '), 220)}` : ''
      lines.push(`  - ${name}${input}${output}${ms}${t.failed ? '（失败）' : ''}`)
    }
  }
  return lines.join('\n')
}

/**
 * 当前设计的客观数据摘要：控件数、图片和切图状态、没用上的图、九宫格和默认文字等。
 * 这部分不依赖模型判断，直接写进分析提示词，也方便单测。
 */
export function designStateSummary(d: Design) {
  const roots: Widget[] = [d.root, ...d.components.map((c) => c.Root)]
  const types = new Map<string, number>()
  const dups = new Set<string>()
  const defaults: string[] = []
  let widgets = 0
  for (const root of roots) {
    const names = new Map<string, number>()
    walk(root, (w) => {
      widgets++
      types.set(w.Type, (types.get(w.Type) ?? 0) + 1)
      names.set(w.Name, (names.get(w.Name) ?? 0) + 1)
      const text = w.Properties?.Text
      if ((w.Type === 'TextBlock' || w.Type === 'Text') && (!text || text === 'Text Block' || text === 'Text'))
        defaults.push(w.Name)
    })
    for (const [name, n] of names) if (n > 1) dups.add(name)
  }
  const used = usedImages(roots)
  const images = d.images
  const generated = images.filter((i) => i.variants.length > 0)
  const failed = images.filter((i) => i.status === 'failed')
  const pending = images.filter((i) => i.status === 'pending' || i.status === 'generating')
  const unused = images.filter((i) => !used.has(i.id))
  const concept = d.concept ?? { images: [], approved: '' }
  const toolMsgs = d.messages.filter(
    (m) => m.role === 'agent' && ((m.parts ?? []).some((p) => p.tools.length) || (m.tools?.length ?? 0) > 0),
  )
  const typeText = [...types.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join('、')
  return [
    `- 设计稿尺寸：${d.designSize.X}×${d.designSize.Y}`,
    `- 控件：主界面 ${count(d.root)} 个，子控件 ${d.components.length} 个（${d.components.map((c) => c.Name).join('、') || '没有'}），合计 ${widgets} 个；类型分布：${typeText || '没有控件'}`,
    `- 控件树里重复的控件名：${dups.size ? [...dups].join('、') : '没有'}`,
    `- 还是默认文字的文本控件：${defaults.length ? defaults.slice(0, 12).join('、') : '没有'}`,
    `- 图片：${images.length} 张，已生成 ${generated.length} 张，生成中/排队 ${pending.length} 张，失败 ${failed.length} 张；设了九宫格 ${images.filter((i) => i.nineSlice).length} 张`,
    `- 没被控件树引用的图片：${unused.length ? unused.map((i) => `${i.name}（${i.id}，${i.width}×${i.height}）`).join('、') : '没有'}`,
    `- 原画：候选 ${concept.images.length} 张，${concept.approved ? `已确认模板 ${concept.approved}` : '还没有确认模板'}`,
    `- 对话：${d.messages.length} 条消息，其中 ${toolMsgs.length} 条 AI 回复带工具调用`,
  ].join('\n')
}

const count = (w: Widget): number => 1 + (w.Children ?? []).reduce((n, c) => n + count(c), 0)

/**
 * 给设计 AI 的分析提示词：只读、给出三段结论。
 * 当前控件树、图片、对话里的工具调用都直接写进去，模型不用再重复读一遍。
 */
export function buildDesignAnalysisPrompt(d: Design, history: DesignMessage[]) {
  const used = usedImages([d.root, ...d.components.map((c) => c.Root)])
  const images = d.images.map((i) => ({
    id: i.id,
    name: i.name,
    size: `${i.width}x${i.height}`,
    nineSlice: i.nineSlice ?? null,
    status: i.status,
    versions: i.variants.length,
    used: used.has(i.id),
    prompt: i.prompt.slice(0, 240),
  }))
  const comps = d.components.map((c) => ({ Name: c.Name, DesignSize: c.DesignSize, Root: compactTree(c.Root) }))
  const trace = conversationTrace(history)
  return `你是 UI 设计和 AI 工作流审核员。现在不修改设计，只检查这个${d.kind === 'web' ? '网页' : '游戏'} UI 设计：对话过程是否合理、生成的 UI 是否准确、AI 生成能力还能怎么加强。用户点「AI 分析」就是想要具体、能直接照着改的结论，不要泛泛而谈。

## 当前设计
名称：${d.title}
美术风格：${d.style || '（没有写）'}
设计稿尺寸：${d.designSize.X}×${d.designSize.Y}
控件树：
${JSON.stringify(compactTree(d.root))}
子控件：
${comps.length ? JSON.stringify(comps) : '（没有）'}
图片（used 表示控件树里有没有引用）：
${images.length ? JSON.stringify(images) : '（没有）'}
动画：
${d.animations?.length ? JSON.stringify(d.animations.map((a) => ({ name: a.name, in: a.in, trigger: a.trigger, tracks: a.tracks.length }))) : '（没有）'}

## 客观数据摘要
${designStateSummary(d)}

## 最近的对话和工具调用（从旧到新）
${trace || '（还没有对话）'}

## 你可以用的工具（只读）
get_design、get_tree（in 写子控件名）、find_widgets、check、screenshot、inspect_image、view_image。
上面已经给出当前控件树、图片和工具调用记录，一般不用重复调用；只有需要看画布截图、量图片尺寸、跑一次 check 确认时再用。
**不要调用任何修改设计的工具**（add_widgets、update_widgets、remove_widgets、move_widgets、rename_widgets、replace_widget、duplicate_widgets、wrap_widget、create_components、resize_components、delete_components、add_images、add_animations、remove_animations、edit、undo、set_design、ask_user、generate_concepts）。这一轮只分析。

## 要分析的三个方面（每一块都要有结论）
1. 对话过程（area 写 process）：最近这几轮对话和工具调用是否合理。重点看有没有无效等待（例如反复 sleep 等切图生成）、在同一个状态上重复轮询（反复 get_design / get_tree / check 却没有新信息）、漏掉必要的检查、消息和上下文组织混乱、目标不清、绕路。要指出具体是哪一步浪费了、浪费在哪。
2. UI 结果（area 写 ui）：结合控件树、尺寸、图片和截图判断层级是否清楚、命名是否一致（PascalCase、同一棵树不重名）、锚点和尺寸是否合理、九宫格和 DrawAs: Box 是否配套、图片与控件比例是否会被拉伸、切图是否按用途独立、列表和格子是否用了正确的控件、与用户对话里的要求是否一致，以及明显的重叠、跑出画面、大小为 0、默认文字等问题。
3. AI 生成能力（area 写 capability）：基于上面两块，按影响大小给改进建议。可以从提示词和系统上下文、可用的设计工具、生成后的自动校验规则、切图和图片生成流程、对话节奏这些方面写，能落地的给出具体做法（改哪条规则、加什么校验、哪个工具该怎么用）。

## 输出格式
先写 3~8 句中文总体结论（先说最严重的问题，再说整体是否可用），然后输出一个 \`\`\`json 代码块，不要输出别的：
{"summary":"一句总体结论，可以和上面重复","findings":[{"area":"process","title":"问题标题","detail":"具体哪里不合理、会造成什么","evidence":"引用具体的工具调用、控件名、尺寸或图片名","suggestion":"可以直接发给对话执行的修改要求，写清楚要改什么、改成什么","priority":"medium"}]}

要求：
- findings 一共 6~12 条，process、ui、capability 三块各至少 1 条；某一块确实没问题时也写一条说明「没有明显问题」，evidence 写检查了什么。
- priority 只对 capability 有意义，取 high / medium / low；其他两块写 medium。
- evidence 必须引用这次对话里的具体内容：第几次工具调用、工具名和参数、控件名、尺寸或图片名。不要写「存在一些问题」这种没有依据的话。
- suggestion 是能直接交给设计 AI 执行的完整要求，不要写「建议优化」「检查一下」；不需要改设计的设计/能力建议，也写清楚下一步该让 AI 做什么。
- 用中文回答。不要修改文件、不要运行命令、不要改设计。`
}

/** 「AI 分析」按钮当前该显示什么：可以开始分析、正在分析（可以取消）、还是这一轮结束后才能分析 */
export type AnalyzeButtonState = 'analyze' | 'stop' | 'busy' | 'disabled'

export function analysisButtonState(o: {
  running?: boolean
  /** 当前这一轮的任务类型：分析中的任务点按钮是取消 */
  mode?: 'chat' | 'analyze'
  sending?: boolean
  /** AI 正在等用户回答问题：先回答，别插一轮分析 */
  asking?: boolean
}): AnalyzeButtonState {
  if (o.sending) return 'disabled'
  if (o.running) return o.mode === 'analyze' ? 'stop' : 'busy'
  if (o.asking) return 'disabled'
  return 'analyze'
}
