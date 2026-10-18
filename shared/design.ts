import { z } from 'zod'
import {
  checkTree,
  compactTree,
  newWidget,
  normalizeTree,
  usedImages,
  walk,
  webRoot,
  widgetCatalogText,
  WIDGETS,
  type WidgetType,
  type Component,
  type Margin,
  type Widget,
} from './umg.ts'
import { Attachment, MAX_ATTACHMENTS, type ToolUse } from './schema.ts'
import { t } from './i18n.ts'
import { applyOps } from './design-ops.ts'
import { UiAnimation, animationsBrief, checkAnimations, presetCatalogText } from './anim.ts'

/**
 * UI 设计：一个设计属于一个项目，和任务分开存放、分开列出。
 * 现在只做游戏 UI（UE5 UMG）；网页 UI 之后再加，kind 先留好。
 */

const Vec2Schema = z.object({ X: z.number(), Y: z.number() })
const MarginSchema = z.object({ Left: z.number(), Top: z.number(), Right: z.number(), Bottom: z.number() })

export const ImageVariant = z.object({
  /** 设计目录 images/ 下的文件名 */
  file: z.string(),
  source: z.enum(['cli', 'browser', 'upload']),
  /** 实际尺寸（像素） */
  width: z.number().default(0),
  height: z.number().default(0),
  at: z.string(),
})
export type ImageVariant = z.infer<typeof ImageVariant>

export const DesignImage = z.object({
  id: z.string(),
  /** 贴图名（导出时加 T_ 前缀） */
  name: z.string(),
  /** 生成用的描述 */
  prompt: z.string().default(''),
  /** 反向提示词：图里不能出现的东西（英文，逗号分隔） */
  negative: z.string().default(''),
  /** 在界面上的尺寸（像素），也是生成时的比例 */
  width: z.number().int().min(1).max(4096).default(256),
  height: z.number().int().min(1).max(4096).default(256),
  transparent: z.boolean().default(true),
  /** 九宫格边距（比例 0~1）；有值时这张图按 Box 方式拉伸 */
  nineSlice: MarginSchema.optional(),
  /** 生成过的每一版，选中的那版用在设计里 */
  variants: z.array(ImageVariant).default([]),
  selected: z.number().int().default(0),
  status: z.enum(['idle', 'pending', 'generating', 'failed']).default('idle'),
  error: z.string().optional(),
})
export type DesignImage = z.infer<typeof DesignImage>

/**
 * 标注：在效果图上圈出要改的地方，发给 AI 时一起带上。坐标是设计稿像素。
 * kind 是标注的意思：修改、在这里新增、删掉、保持不变（参考）；shape 是画法。
 */
export const ANNOTATION_KINDS = ['change', 'add', 'remove', 'keep'] as const
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number]
export const Annotation = z.object({
  id: z.string(),
  kind: z.enum(ANNOTATION_KINDS).default('change'),
  shape: z.enum(['rect', 'arrow', 'pen', 'pin']),
  /** rect：[x, y, w, h]；arrow：[x1, y1, x2, y2]（箭头指向第二个点）；pen：[x, y, x, y, …]；pin：[x, y] */
  points: z.array(z.number()).max(4000),
  note: z.string().max(2000).default(''),
  /** 标在哪棵树上：空是主界面，否则是子控件名 */
  target: z.string().default(''),
  /** 标注范围里的控件名，给 AI 定位用 */
  widgets: z.array(z.string()).max(20).default([]),
})
export type Annotation = z.infer<typeof Annotation>

/** AI 在动手之前问用户的问题：每个选项有一句说明，style 是选了以后定下来的整体风格（英文） */
export const DesignQuestion = z.object({
  text: z.string().min(1).max(500),
  /** 很短的标签，多个问题时显示在页签上 */
  header: z.string().max(20).default(''),
  multiSelect: z.boolean().default(false),
  options: z
    .array(
      z.object({
        label: z.string().max(40),
        desc: z.string().max(300).default(''),
        style: z.string().max(2000).default(''),
      }),
    )
    .max(6)
    .default([]),
})
export type DesignQuestion = z.infer<typeof DesignQuestion>

/**
 * 原画（效果图）：「先出原画」时先画整屏的效果图给用户挑，一轮可以出几张候选；
 * 用户在图上标注、提意见再出下一轮，直到确认一张作为模板（approved），AI 再照着模板搭界面、出切图
 */
export const ConceptImage = z.object({
  id: z.string(),
  /** 设计目录 images/ 下的文件名 */
  file: z.string(),
  width: z.number().default(0),
  height: z.number().default(0),
  prompt: z.string().default(''),
  negative: z.string().default(''),
  /** 第几轮出的：同一轮的几张是一组候选 */
  round: z.number().int().default(1),
  /** 在哪张的基础上改的 */
  base: z.string().optional(),
  source: z.enum(['cli', 'browser', 'upload']),
  at: z.string(),
})
export type ConceptImage = z.infer<typeof ConceptImage>
export const ConceptState = z.object({
  images: z.array(ConceptImage).default([]),
  /** 正在看的那张 */
  selected: z.string().default(''),
  /** 确认作为模板的那张；空表示还在挑 */
  approved: z.string().default(''),
})
export type ConceptState = z.infer<typeof ConceptState>
export const emptyConcept = (): ConceptState => ({ images: [], selected: '', approved: '' })
/** 一次最多出几张候选 */
export const MAX_CONCEPTS = 4
/** 图上的标注（target）指的是哪张原画 */
export const conceptTarget = (id: string) => `concept:${id}`

export const DesignMessage = z.object({
  id: z.string(),
  role: z.enum(['user', 'agent', 'system']),
  text: z.string(),
  at: z.string(),
  /** 这条回复新建或重新生成的图片 */
  images: z.array(z.string()).optional(),
  run: z.object({ cli: z.string(), model: z.string(), effort: z.string() }).optional(),
  error: z.boolean().optional(),
  /** 用户这条消息带的标注 */
  annotations: z.array(Annotation).optional(),
  /** 用户这条消息带的附件（参考图、文档） */
  attachments: z.array(Attachment).optional(),
  /** AI 回复的过程：思考和工具调用，完成后收起来，点开能看（旧数据） */
  thinking: z.string().optional(),
  tools: z.array(z.any()).optional(),
  /** AI 回复按发生的顺序分段：每段是思考、工具调用、说明，和 Agent 的输出一样依次显示 */
  parts: z.array(z.object({ text: z.string(), thinking: z.string().optional(), tools: z.array(z.any()) })).optional(),
  /** AI 先问用户的问题（旧数据，只有一个） */
  question: DesignQuestion.optional(),
  /** AI 先问用户的问题（例如整体风格还没定），一次可以问几个；问题面板换掉输入框，全部回答后一起发出去 */
  questions: z.array(DesignQuestion).optional(),
  /** 用户这条消息是在回答 AI 的提问：每个问题和答案，像回答一样显示 */
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
  /** 用户这条消息选的整体风格（风格库里的名字），显示在消息上 */
  style: z.string().optional(),
})
export type DesignMessage = z.infer<typeof DesignMessage>

export const DESIGN_KINDS = ['game', 'web'] as const
export type DesignKind = (typeof DESIGN_KINDS)[number]

export const ComponentSchema = z.object({ Name: z.string(), DesignSize: Vec2Schema, Root: z.any() })

export const DesignDoc = z.object({
  title: z.string().trim().min(1).max(100),
  /** 设计稿尺寸（UE 里的 DPI 缩放基准，通常 1920×1080） */
  designSize: Vec2Schema.default({ X: 1920, Y: 1080 }),
  /** 整体美术风格，生成每张图时都带上，保持一致 */
  style: z.string().max(2000).default(''),
  root: z.any(),
  components: z.array(ComponentSchema).default([]),
  images: z.array(DesignImage).default([]),
  /** 还没发给 AI 的标注 */
  annotations: z.array(Annotation).max(200).default([]),
  /** 动画（UE 的 Widget Animation；网页是动效），见 anim.ts */
  animations: z.array(UiAnimation).max(300).default([]),
})
export type DesignDoc = Omit<z.infer<typeof DesignDoc>, 'root' | 'components' | 'animations'> & {
  root: Widget
  components: Component[]
  /** 旧数据没有 */
  animations?: UiAnimation[]
}

export const Design = DesignDoc.extend({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(DESIGN_KINDS).default('game'),
  messages: z.array(DesignMessage).default([]),
  /** AI 改过结构就加一，页面据此换掉本地的树 */
  rev: z.number().int().default(0),
  /** 原画：候选图和确认的模板 */
  concept: ConceptState.default(emptyConcept),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Design = DesignDoc & {
  id: string
  projectId: string
  kind: DesignKind
  messages: DesignMessage[]
  rev: number
  concept?: ConceptState
  createdAt: string
  updatedAt: string
}
/** 侧栏列表用：不带树和对话 */
export type DesignMeta = Pick<Design, 'id' | 'projectId' | 'kind' | 'title' | 'createdAt' | 'updatedAt'> & {
  running?: boolean
  /** AI 在等用户确认或回答 */
  asking?: boolean
}

/**
 * 项目提示词：按分类管理，界面上显示中文，发给生图 AI 时用英文（en）。
 * 关掉 enabled 的先不用，但留着方便再打开
 */
export const PROMPT_CATEGORIES = ['style', 'color', 'material', 'light', 'layout', 'avoid'] as const
export type PromptCategory = (typeof PROMPT_CATEGORIES)[number]
export const PROMPT_CATEGORY_LABEL: Record<PromptCategory, string> = {
  style: '画风',
  color: '色彩',
  material: '材质',
  light: '光影',
  layout: '构图',
  avoid: '避免',
}
/** 发给生图 AI 时每个分类的英文开头 */
const PROMPT_CATEGORY_EN: Record<PromptCategory, string> = {
  style: 'Art style',
  color: 'Color palette',
  material: 'Materials and textures',
  light: 'Lighting',
  layout: 'Composition',
  avoid: 'Avoid',
}
export const ProjectPrompt = z.object({
  id: z.string(),
  category: z.enum(PROMPT_CATEGORIES).catch('style'),
  zh: z.string().trim().min(1).max(500),
  en: z.string().trim().max(1000).default(''),
  enabled: z.boolean().default(true),
})
export type ProjectPrompt = z.infer<typeof ProjectPrompt>

/** 项目提示词换成发给生图 AI 的英文：按分类一行；没有英文的用中文顶上 */
export function projectPromptText(prompts: ProjectPrompt[]) {
  return PROMPT_CATEGORIES.map((c) => {
    const list = prompts.filter((p) => p.enabled && p.category === c).map((p) => p.en || p.zh)
    return list.length ? `${PROMPT_CATEGORY_EN[c]}: ${list.join(', ')}` : ''
  })
    .filter(Boolean)
    .join('\n')
}

/** 给设计 AI 看的项目提示词：中文和英文都给，方便它理解 */
function projectPromptBrief(prompts: ProjectPrompt[]) {
  return PROMPT_CATEGORIES.map((c) => {
    const list = prompts.filter((p) => p.enabled && p.category === c).map((p) => (p.en ? `${p.zh}（${p.en}）` : p.zh))
    return list.length ? `- ${PROMPT_CATEGORY_LABEL[c]}：${list.join('；')}` : ''
  })
    .filter(Boolean)
    .join('\n')
}

/** AI 生成或翻译出来的提示词 */
export const AiPrompts = z.object({
  prompts: z
    .array(
      z.object({ category: z.enum(PROMPT_CATEGORIES).catch('style'), zh: z.string().min(1), en: z.string().min(1) }),
    )
    .max(40),
})
export const PromptAiInput = z.object({
  /** generate：按描述生成一组；translate：把 items 里的中文整理、翻译成英文 */
  mode: z.enum(['generate', 'translate']).default('generate'),
  text: z.string().trim().max(4000).default(''),
  items: z
    .array(z.object({ category: z.enum(PROMPT_CATEGORIES).catch('style'), zh: z.string().max(500) }))
    .max(40)
    .default([]),
  /** 已经有的提示词，生成时避开重复 */
  existing: z.array(z.string().max(500)).max(300).default([]),
  /** 页面生成的会话 id：CLI 要确认时，页面按它取回请求显示 */
  scope: z.string().max(80).default(''),
})
export type PromptAiInput = z.infer<typeof PromptAiInput>

/**
 * 风格库：从做好的设计里让 CLI 总结出来的整体风格，存在设置里，别的项目、别的设计可以直接套用。
 * summary 是给人看的中文说明，en 是发给设计 AI 和生图 AI 的英文；prompts 套用到 UI 项目的美术提示词
 */
export const StylePrompt = z.object({
  category: z.enum(PROMPT_CATEGORIES).catch('style'),
  zh: z.string().trim().max(200),
  en: z.string().trim().max(300),
})
export const SavedStyleInput = z.object({
  name: z.string().trim().min(1).max(40),
  kind: z.enum(DESIGN_KINDS).default('game'),
  summary: z.string().trim().max(500).default(''),
  en: z.string().trim().max(4000).default(''),
  prompts: z.array(StylePrompt).max(30).default([]),
})
export type SavedStyleInput = z.input<typeof SavedStyleInput>
export const SavedStyle = SavedStyleInput.extend({
  id: z.string(),
  /** 程序内置的风格（shared/styles.ts）：只读，可以复制成自己的再改 */
  builtin: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SavedStyle = z.infer<typeof SavedStyle>

/** 让 CLI 从一个设计里总结整体风格：看风格说明、项目提示词、图片描述和对话 */
export function buildStyleExtractPrompt(d: Design, history: DesignMessage[], project: { prompts: ProjectPrompt[] }) {
  const imgs = d.images
    .filter((i) => i.prompt)
    .slice(0, 40)
    .map((i) => `- ${i.name}：${i.prompt}`)
    .join('\n')
  const chat = history
    .filter((m) => m.role !== 'system')
    .slice(-16)
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.text.slice(0, 600)}`)
    .join('\n\n')
  return `你在帮用户整理一个${d.kind === 'web' ? '网页' : '游戏'} UI 设计的整体美术风格，存进风格库，以后别的项目可以直接套用。
只总结风格（画风、配色、材质、光影、形状和装饰、字体气质、构图习惯），不要写这个界面具体有哪些内容（例如「背包」「开始按钮」）。

## 这个设计
名称：${d.title}
风格说明：${d.style || '（没有）'}
项目提示词：
${projectPromptBrief(project.prompts) || '（没有）'}
图片描述：
${imgs || '（没有）'}
${chat ? `\n## 对话\n${chat}\n` : ''}
## 输出格式
先用一句中文说明，然后输出一个 \`\`\`json 代码块：
{
  "name": "风格的名字（中文，12 个字以内，例如「暗黑奇幻·石刻金边」）",
  "summary": "一两句中文说明这个风格的特点",
  "en": "完整的英文风格描述，给设计 AI 和生图 AI 用（一段话，60~120 个词）",
  "prompts": [{"category":"style","zh":"中文要点","en":"English keywords"}]（6~12 条，category 是 ${PROMPT_CATEGORIES.join(' / ')} 之一）
}
不要修改文件、不要运行命令，只输出说明和 JSON。`
}

export const AiStyle = z.object({
  name: z.string().trim().min(1).max(40),
  summary: z.string().trim().max(500).default(''),
  en: z.string().trim().min(1).max(4000),
  prompts: z.array(StylePrompt).max(30).default([]),
})

export function buildPromptAiPrompt(input: PromptAiInput) {
  const cats = PROMPT_CATEGORIES.map((c) => `${c}（${PROMPT_CATEGORY_LABEL[c]}）`).join('、')
  const task =
    input.mode === 'translate'
      ? `把下面每条中文提示词翻译成给生图 AI 用的英文（简短的词组，不要句子），分类不对的帮忙改正，条数和顺序不变：
${JSON.stringify(input.items)}`
      : `用户在为一个游戏的 UI 定美术风格，按用户的描述整理出一组提示词，每条一个要点（例如一种画风、一组配色、一种材质），一般 6 到 15 条，分到合适的分类里。
用户的描述：
${input.text}
${input.existing.length ? `\n项目里已经有这些提示词，不要重复：\n${input.existing.join('、')}\n` : ''}`
  return `你在帮用户整理游戏 UI 生图用的提示词。${task}

分类只能用：${cats}。avoid 写不想要的东西（例如文字、水印、照片写实感）。
zh 是给用户看的中文（简短，几个字到一句话），en 是发给生图 AI 的英文（简短的词组）。

只输出一个 \`\`\`json 代码块：
{"prompts":[{"category":"style","zh":"暗黑奇幻","en":"dark fantasy"}]}
不要修改文件、不要运行命令。`
}

/**
 * UI 设计自己的项目：和 Agent 的项目分开，互不影响。path 是可选的本机目录，「导出到项目目录」写到这里
 */
export const DesignProject = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string().default(''),
  /** 项目级的提示词：这个项目里所有设计、所有图片都带上，保证整个游戏美术风格统一 */
  prompts: z.array(ProjectPrompt).max(300).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type DesignProject = z.infer<typeof DesignProject>
export const DesignProjectInput = z.object({
  name: z.string().trim().min(1).max(100),
  path: z.string().trim().max(1000).default(''),
  prompts: z.array(ProjectPrompt).max(300).default([]),
})
export type DesignProjectInput = z.input<typeof DesignProjectInput>

export const NewDesignInput = z.object({
  projectId: z.string().min(1),
  kind: z.enum(DESIGN_KINDS).default('game'),
  title: z.string().trim().min(1).max(100),
  designSize: Vec2Schema.default({ X: 1920, Y: 1080 }),
})
export type NewDesignInput = z.infer<typeof NewDesignInput>

/** 生成图片的来源：设置里的图片 CLI，或浏览器里登录好的 Gemini / ChatGPT 标签页 */
export const ImageSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cli') }),
  z.object({ kind: z.literal('browser'), tabId: z.string().min(1) }),
  z.object({ kind: z.literal('none') }),
])
export type ImageSource = z.infer<typeof ImageSource>

export const DesignChatInput = z.object({
  text: z.string().trim().min(1).max(20000),
  source: ImageSource.default({ kind: 'cli' }),
  /** 每张图生成几版备选 */
  count: z.number().int().min(1).max(4).default(1),
  /** 这次一起发的标注 */
  annotations: z.array(Annotation).max(200).default([]),
  /** 这次一起发的附件：参考图、需求文档等，AI 按路径读取 */
  attachments: z.array(Attachment).max(MAX_ATTACHMENTS).default([]),
  /** 对话用的 CLI、模型和思考强度；不给时用默认 CLI */
  run: z
    .object({ cli: z.string().max(40), model: z.string().max(200).default(''), effort: z.string().max(40).default('') })
    .optional(),
  /** 「提问」开关：AI 的提问交给用户回答；关着时让它自己选 */
  askUser: z.boolean().default(false),
  /** 用户在风格提问里选的整体风格（英文），发送前先存进设计 */
  style: z.string().max(4000).optional(),
  /** 选的风格的名字：显示在用户的消息上 */
  styleName: z.string().max(200).optional(),
  /** 这条消息是在回答 AI 的提问：每个问题和答案 */
  answers: z
    .array(z.object({ question: z.string().max(2000), answer: z.string().max(20000) }))
    .max(20)
    .optional(),
  /** 「先出原画」开关：没有确认的模板时，这一轮只出整屏的效果图给用户挑，不搭界面 */
  concept: z.boolean().default(false),
})
export type DesignChatInput = z.infer<typeof DesignChatInput>

export const GenerateImageInput = z.object({
  source: ImageSource,
  count: z.number().int().min(1).max(4).default(1),
  /** 换一个描述再生成 */
  prompt: z.string().max(4000).optional(),
  /** 这一次的修改意见（用户写的和在图上标的，见 imageRevisionText），只用在这一次生成 */
  revision: z.string().max(8000).optional(),
})

/** AI 回复里的一段：先思考，再调工具，再说明；后面又有思考或工具调用时开始新的一段 */
export interface ReplyPart {
  text: string
  thinking?: string
  tools: ToolUse[]
}

/** 收到一条输出事件，按顺序记进分段里（返回新的数组，页面轮询时能看出变化） */
export function addToParts(
  parts: ReplyPart[],
  ev:
    | { type: 'text'; text: string; delta?: boolean }
    | { type: 'thinking'; text: string; delta?: boolean }
    | { type: 'tool'; tool: ToolUse }
    | { type: 'tool_update'; at: [number, number]; patch: Partial<ToolUse> },
): ReplyPart[] {
  const list = [...parts]
  let cur = list.at(-1)
  const fresh = () => {
    cur = { text: '', tools: [] }
    list.push(cur)
    return cur
  }
  if (ev.type === 'thinking') {
    const p = !cur || cur.text || cur.tools.length ? fresh() : { ...cur }
    p.thinking = (ev.delta ? (p.thinking ?? '') + ev.text : ev.text).slice(-4000)
    list[list.length - 1] = p
  } else if (ev.type === 'tool') {
    const p = !cur || cur.text ? fresh() : { ...cur }
    p.tools = [...p.tools, ev.tool]
    list[list.length - 1] = p
  } else if (ev.type === 'text') {
    const p = cur ? { ...cur } : fresh()
    p.text = ev.delta ? p.text + ev.text : p.text ? `${p.text.trimEnd()}\n\n${ev.text}` : ev.text
    list[list.length - 1] = p
  } else {
    const [pi, ti] = ev.at
    const p = list[pi]
    if (p?.tools[ti]) list[pi] = { ...p, tools: p.tools.map((x, k) => (k === ti ? { ...x, ...ev.patch } : x)) }
  }
  return list
}

/** 生成图片时每张图的进度 */
export interface ImageJobItem {
  id: string
  name: string
  status: 'waiting' | 'generating' | 'done' | 'failed'
  /** 浏览器里的进度说明，或失败原因 */
  text?: string
  /** 已经取回几版 / 要几版 */
  got: number
  want: number
}

/** 生成原画的进度 */
export interface ConceptJob {
  want: number
  got: number
  /** 浏览器里的进度说明，或失败原因 */
  text?: string
}

/**
 * AI 要看当前画布的截图（screenshot 工具）：页面画出这棵树、截图后交回来。
 * 带着这一轮改到现在的树，页面不用等存下来
 */
export interface CaptureRequest {
  id: string
  /** 空是主界面，否则是子控件名 */
  target: string
  root: Widget
  components: Component[]
  size: { X: number; Y: number }
}

export interface DesignJob {
  status: 'running' | 'done' | 'failed'
  /** design：AI 在改结构；concepts：在出原画；images：在生成图片 */
  phase: 'design' | 'concepts' | 'images'
  concepts?: ConceptJob
  /** 等页面交回的画布截图 */
  capture?: CaptureRequest
  /** 正在说的话 */
  text: string
  /** 这一轮的输出按顺序分段（思考、工具调用、说明），和 Agent 的输出一样依次显示 */
  parts?: ReplyPart[]
  /** 这次对话用的 CLI、模型和思考强度 */
  run?: { cli: string; model: string; effort: string }
  /** 生成图片的进度 */
  images?: ImageJobItem[]
  outChars: number
  /** AI 用工具改的过程中，改到现在的样子；页面在 AI 改的过程中显示它，applied 是已经应用了几步 */
  preview?: { root: Widget; components: Component[]; animations?: UiAnimation[]; applied: number }
  attempt: number
  error?: string
  startedAt: number
}

/** 浏览器扩展报上来的标签页 */
export interface BrowserTab {
  id: string
  site: 'gemini' | 'chatgpt'
  title: string
  url: string
}
/** 浏览器扩展的连接状态 */
export interface BrowserStatus {
  connected: boolean
  /** 浏览器里装的扩展版本 */
  version: string
  /** 面板自带的扩展版本 */
  latestVersion: string
  tabs: BrowserTab[]
  extensionDir: string
  /** 本机装了的浏览器，用来打开扩展页面 */
  browsers: { id: string; name: string }[]
}

/** 1.3 起的扩展能按面板的要求自己重新加载（浏览器不会自己重新加载已解压的扩展），更早的只能去扩展页面点刷新 */
export const extensionSelfReload = (version: string) => {
  const [major, minor] = version.split('.').map(Number)
  return major > 1 || (major === 1 && minor >= 3)
}

/** 新设计的根控件：游戏 UI 是 CanvasPanel，网页是占满整页的 Frame */
export const emptyRoot = (kind: DesignKind = 'game'): Widget =>
  kind === 'web' ? webRoot() : newWidget('CanvasPanel', 'RootCanvas')

// ---- AI 对话 ----

export const AiImage = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'id 只能用字母、数字、下划线和连字符'),
  name: z.string().min(1),
  prompt: z.string().min(1),
  width: z.number().int().min(4).max(2048),
  height: z.number().int().min(4).max(2048),
  transparent: z.boolean().default(true),
  nineSlice: MarginSchema.optional(),
  /** 反向提示词：这张图里不能出现的东西（英文） */
  negative: z.string().max(2000).optional(),
  /** 同类的小图标（背包物品、技能、货币…）写成同一个 sheet：面板让图片模型把它们画在一张图上再切开，比一张张生成快很多 */
  sheet: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/, 'sheet 只能用字母、数字、下划线和连字符')
    .optional(),
})
export const AiDesignResult = z.object({
  reply: z.string().default(''),
  style: z.string().optional(),
  designSize: Vec2Schema.optional(),
  root: z.any().optional(),
  components: z
    .array(z.object({ Name: z.string().min(1), DesignSize: Vec2Schema.optional(), Root: z.any() }))
    .optional(),
  images: z.array(AiImage).default([]),
  /** 在现有设计上一步步改（见 design-ops.ts），和 root 二选一 */
  ops: z.array(z.any()).max(500).optional(),
  /** 这一轮改完的动画（MCP 会话里的），给了就整个换掉 */
  animations: z.array(UiAnimation).optional(),
  /** 先问用户（整体风格还没定时）；有它时这一轮不改设计 */
  questions: z.array(DesignQuestion).optional(),
})

const gameRules = (
  d: Design,
) => `- 游戏 UI 的视觉全部用图片：面板底框、按钮底图、高亮框、选中框、进度条底和填充、图标、分隔线、装饰都是独立的图片，用 Image 或画刷引用（"img:<图片 id>"），不要指望用纯色块拼出效果。文字用 TextBlock。
- 一张图只画一个元素（例如只画按钮底图，不带文字；高亮框单独一张），这样在 UE 里能分别替换和复用。按钮的 Normal / Hovered / Pressed 可以各一张图，也可以共用一张再用 TintColor 区分。
- 需要拉伸的框和底图（面板、按钮、进度条）给图片设 nineSlice，画刷用 DrawAs: "Box" 并把 Margin 设成同样的比例。
- 重复出现、结构复杂的部分（列表项、背包格子、技能按钮）用 create_components 提取成子控件，在树里用 {"Type":"UserWidget","Class":"<子控件名>"} 引用。
- 数量要等游戏运行时才知道的内容（背包和商店的格子、任务 / 邮件 / 好友列表、排行榜、Buff 图标）用 TileView、ListView 或 DynamicEntryBox，不要在里面预先摆子控件：条目做成子控件，写在 Properties.EntryWidgetClass，NumDesignerPreviewEntries 是设计器里预览几条。数量固定的等大格子（技能栏、快捷栏）用 UniformGridPanel，同样不放子控件，在属性里写 EntryWidgetClass、NumEntries、NumColumns。数量固定、各不相同的排列（主菜单的几个按钮、属性栏）才用 VerticalBox / HorizontalBox 直接放子控件。
- 用户附上了界面截图或参考图（附件里的图片）时，先打开看清楚再做：照着截图还原布局，控件的结构、位置和大小按截图和设计稿的比例换算；截图里的底框、按钮、图标、装饰都列成要生成的图片，prompt 照着截图里的样子描述；截图里的文字写进 TextBlock。
- 根控件一般是 CanvasPanel，尺寸就是设计稿尺寸 ${d.designSize.X}×${d.designSize.Y}；靠边的元素用对应的锚点，方便适配不同分辨率。
- 控件名用英文 PascalCase，同一棵树里不能重复；只写和默认值不一样的属性。
- 每个 TextBlock 的 Text 都写成它在游戏里要显示的内容，不要留默认的 "Text Block"：固定文字直接写（「开始游戏」「背包」）；运行时才知道的数值和名字写成真实格式的示例（等级「Lv.99」、金币「12,345」、倒计时「00:59」、数量「x99」、物品名「星辉宝石」），方便看出最终效果和排版。
`

const webRules = (
  d: Design,
) => `- 网页的视觉以 Frame 的背景色、圆角、边框、阴影和文字排版为主，配色要协调、留白充足、层次清楚；只有插图、头图、商品图、头像、图标这类真正的图片才用 Picture 或 BackgroundImage 引用（"img:<图片 id>"）。
- 用 Frame 一层层搭：页面（根控件 Page，竖排）→ 区块（导航栏、头图、内容区、页脚）→ 卡片、行、列。横排用 Direction "row"，间距用 Gap，内边距用 Padding，别用空的 Frame 占位。
- 宽高：要占满父控件剩下的空间写 "fill"（例如横排里自适应的那一列、竖排里撑开的内容区），按内容写 "auto"，固定大小写像素数。根控件 Page 的宽高是 "fill"，设计稿宽 ${d.designSize.X}，高 ${d.designSize.Y}。
- 重复出现的结构（卡片、列表项、导航项）用 create_components 提取成子控件，在树里用 {"Type":"UserWidget","Class":"<子控件名>"} 引用，子控件的根控件也是 Frame。
- 页面要能适配手机：横排的大区块（头图左右分栏、多列卡片）给 Mobile 改成竖排，固定的大宽度在手机上改成 "fill"，大标题在手机上调小。
- 按钮、链接、卡片这类能点的控件加上 Hover 样式。
- 用户附上了网页截图或参考图时，照着截图还原布局、配色和文字，截图里的插图、头像、图标列成要生成的图片。
- 控件名用英文 PascalCase，同一棵树里不能重复；只写和默认值不一样的属性。
- 每个 Text 的 Text 都写成页面上要显示的真实内容（标题、按钮文案、说明文字），不要留默认的 "Text"；动态的数据写成真实格式的示例（「¥1,299」「2026-10-17」「128 条评论」）。颜色一律写 "#RRGGBBAA"。
`

const GAME_MOTION = `- 参照 UE 的 UMG 动画：每个动画导出成 Widget Blueprint 里的一个 WidgetAnimation（轨道是控件的 RenderOpacity、RenderTransform），trigger 决定什么时候播（show 是 Construct 时、hover / click 绑到 source 控件上、manual 由蓝图调用）。
- 用户要动画、动效、过场，或者在做弹窗、奖励结算、提示条这类本来就该有动画的界面时加：弹窗 / 面板打开用 pop-in 或 zoom-in（主面板，trigger show），里面的列表项、奖励物品用 fade-in-up 加 stagger；关闭用 zoom-out / fade-out（trigger manual，名字写 Anim_Close）；
  重要按钮加 hover-grow（hover）和 press（click）；可领取、红点、新物品用 pulse-loop / breathe（loop 0）；加载转圈用 spin。用户没要求时不要给普通的静态界面硬加动画。
- 子控件（例如按钮、格子）自己的动画写 in（子控件名），轨道里写子控件里的控件名，每个用到它的地方都有。`

const WEB_MOTION = `- 网页导出时用浏览器自带的 Web Animations 播放（不依赖任何库），trigger：show 是页面打开时、scroll 是滚动到能看见时、hover 移上去播放移开倒放、click 点击时。
- 网页不要是完全静态的：搭页面时顺手加上合适的动效——首屏的标题、副标题、按钮用 fade-in-up 依次出现（trigger show，stagger 0.08）；下面的每个区块、卡片列表用 fade-in-up 或 zoom-in，trigger scroll（卡片 stagger 0.08）；
  卡片、主按钮加 hover-lift 或 hover-grow（trigger hover）。用户说不要动画时不加。
- 子控件（例如卡片）的悬停动画写在子控件里（in 写子控件名），每张卡片各自响应。`

const WEB_NOTES = `## 属性（Properties）
- 所有控件：Width、Height（"auto" | "fill" | 像素数）、Visibility(Visible|Hidden|Collapsed)、RenderOpacity
- Frame：Direction("row"|"column")、Gap、Padding{"Left","Top","Right","Bottom"}、AlignItems(stretch|start|center|end)、JustifyContent(start|center|end|between|around|evenly)、Wrap、Background、BackgroundImage("img:<id>")、Radius、BorderWidth、BorderColor、Shadow(none|sm|md|lg)、Overflow(visible|hidden|auto)
- Text：Text、Tag(h1|h2|h3|h4|p|span|label)、FontSize、FontWeight(300~800)、Color、TextAlign(left|center|right)、LineHeight、LetterSpacing
- Picture：Src("img:<id>")、Fit(cover|contain|fill|none)、Radius、Alt
- WebButton：Text、FontSize、FontWeight、Color、Background、BackgroundImage、Padding、Radius、BorderWidth、BorderColor
- Input：Placeholder、Value、InputType(text|password|email|number|search|tel)、Multiline、FontSize、Color、Background、BorderWidth、BorderColor、Radius、Padding
- Divider：Color、Thickness、Vertical
- Frame、Text、Picture、WebButton 写了 Href 就是链接（导出成 <a>）
- 插槽（Slot，放在 Frame 里的控件都有）：{"AlignSelf":"auto|start|center|end|stretch"}，在父控件的交叉轴上单独对齐；
  角标、浮层、悬浮按钮用绝对定位：{"Position":"absolute","Pin":"top-left|top-right|bottom-left|bottom-right|center","X":8,"Y":8,"ZIndex":1}，不占位置，贴在父控件的 Pin 角上（X、Y 是离那个角的距离）
- 悬停：Properties.Hover 里写鼠标移上去时要变的属性，例如按钮 {"Hover":{"Background":"#1D4ED8FF"}}、卡片 {"Hover":{"Shadow":"lg"}}
- 响应式：Properties.Tablet（宽度 ≤ 1023）、Properties.Mobile（≤ 767）里写这个宽度下要改的属性，例如横排的区块在手机上改竖排 {"Mobile":{"Direction":"column","Gap":16}}、手机上隐藏 {"Mobile":{"Visibility":"Collapsed"}}、字号变小 {"Mobile":{"FontSize":32}}
- 滚动区域：Frame 固定 Height（或 Width）再把 Overflow 设成 "scroll-y"（或 "scroll-x"）
- 颜色一律写 sRGB 的 "#RRGGBBAA"。`

const UMG_NOTES = `## 插槽（Slot）和常用属性（名字和取值都和 UE5 一致）
- CanvasPanelSlot：{"LayoutData":{"Offsets":{"Left","Top","Right","Bottom"},"Anchors":{"Minimum":{"X","Y"},"Maximum":{"X","Y"}},"Alignment":{"X","Y"}},"bAutoSize":false,"ZOrder":0}
  锚点不拉伸（Minimum = Maximum）时 Left/Top 是位置、Right/Bottom 是宽高；拉伸时四个值是到父控件各边的距离。Alignment 是自身的对齐点（0.5,0.5 为中心）。
- HorizontalBoxSlot / VerticalBoxSlot：{"Padding":{"Left","Top","Right","Bottom"},"Size":{"SizeRule":"Automatic"|"Fill","Value":1},"HorizontalAlignment":"HAlign_Fill|HAlign_Left|HAlign_Center|HAlign_Right","VerticalAlignment":"VAlign_Fill|VAlign_Top|VAlign_Center|VAlign_Bottom"}
- OverlaySlot、BorderSlot、ButtonSlot、SizeBoxSlot、ScaleBoxSlot、ScrollBoxSlot、WidgetSwitcherSlot、CheckBoxSlot：Padding + HorizontalAlignment + VerticalAlignment
- UniformGridSlot：Row、Column + 对齐；WrapBoxSlot：Padding、bFillEmptySpace + 对齐
- 画刷 Brush：{"ResourceObject":"img:<图片 id>","ImageSize":{"X","Y"},"DrawAs":"Image|Box|Border|RoundedBox|NoDrawType","Margin":{"Left","Top","Right","Bottom"},"TintColor":"#RRGGBBAA"}。DrawAs 为 Box 时按 Margin（0~1 的比例）九宫格拉伸。
- 颜色一律写 sRGB 的 "#RRGGBBAA"。
- Image：Brush、ColorAndOpacity
- TextBlock：Text、Font{"TypefaceFontName":"Regular|Bold|Italic","Size":24,"LetterSpacing":0,"OutlineSettings":{"OutlineSize":0,"OutlineColor"}}、ColorAndOpacity、ShadowOffset、ShadowColorAndOpacity、Justification(Left|Center|Right)、AutoWrapText。Size 是 UE 的字号，屏幕像素约为 Size × 4/3。
- Button：WidgetStyle{"Normal","Hovered","Pressed","Disabled"（都是 Brush）,"NormalPadding","PressedPadding"}、BackgroundColor
- Border：Background（Brush）、BrushColor、ContentColorAndOpacity
- ProgressBar：Percent(0~1)、BarFillType(LeftToRight|RightToLeft|BottomToTop|TopToBottom|FillFromCenter)、WidgetStyle{"BackgroundImage","FillImage"}、FillColorAndOpacity
- Slider：Value、MinValue、MaxValue、Orientation、WidgetStyle{"NormalBarImage","NormalThumbImage"}
- CheckBox：CheckedState(Unchecked|Checked)、WidgetStyle{"UncheckedImage","CheckedImage"}
- SizeBox：WidthOverride、HeightOverride（0 表示不限制）、Min/MaxDesiredWidth/Height
- UniformGridPanel：EntryWidgetClass（每个格子用的子控件名）、NumEntries（格子数）、NumColumns（每行几个）、SlotPadding（每个格子四周的间距）、MinDesiredSlotWidth / MinDesiredSlotHeight、EntryHorizontalAlignment / EntryVerticalAlignment（格子里子控件的对齐）。导出到 UE 时自动展开成一个个子控件。
- ListView：EntryWidgetClass（子控件名）、NumDesignerPreviewEntries、Orientation、EntrySpacing、SelectionMode(None|Single|SingleToggle|Multi)
- TileView：EntryWidgetClass、NumDesignerPreviewEntries、EntryWidth、EntryHeight、Orientation、TileAlignment(EvenlyDistributed|EvenlySize|EvenlyWide|Left|Right|Center|Fill)
- DynamicEntryBox：EntryWidgetClass、NumDesignerPreviewEntries、EntryBoxType(Horizontal|Vertical|Wrap|VerticalWrap|Overlay)、EntrySpacing{"X","Y"}
- ScaleBox：Stretch(None|Fill|ScaleToFit|ScaleToFitX|ScaleToFitY|ScaleToFill|UserSpecified)
- 所有控件：Visibility(Visible|Collapsed|Hidden|HitTestInvisible|SelfHitTestInvisible)、RenderOpacity、RenderTransform{"Translation","Scale","Angle"}`

export function buildDesignPrompt(
  d: Design,
  history: DesignMessage[],
  request: string,
  annotations?: Annotation[],
  project?: { prompts: ProjectPrompt[]; images: { name: string; prompt: string }[] },
  /** 风格库里同类（游戏 / 网页）的风格：风格还没定时可以作为选项 */
  styles: SavedStyle[] = [],
  /** 原画：先出原画阶段（concept）还是照着确认的模板做（template） */
  concept?: ConceptContext,
) {
  const brief = project ? projectPromptBrief(project.prompts) : ''
  // 整体风格定了没有：设计有风格说明，或者项目里打开了画风类的提示词
  const styled = !!d.style.trim() || !!project?.prompts.some((p) => p.enabled && p.category === 'style')
  const imgs = d.images.map((i) => ({
    id: i.id,
    name: i.name,
    size: `${i.width}x${i.height}`,
    transparent: i.transparent,
    ...(i.nineSlice ? { nineSlice: i.nineSlice } : {}),
    prompt: i.prompt,
    generated: i.variants.length > 0,
  }))
  const comps = d.components.map((c) => ({
    Name: c.Name,
    DesignSize: c.DesignSize,
    Root: compactTree(c.Root),
  }))
  const chat = history
    .slice(-12)
    .map((m) => `${m.role === 'user' ? '用户' : m.role === 'agent' ? '你' : '系统'}：${m.text}`)
    .join('\n\n')
  const web = d.kind === 'web'
  return `${
    web
      ? '你是网页 UI 设计助手。用户描述想要的网页界面，你用 design 工具搭出控件树（布局和 Figma 的自动布局、CSS 的 flex 一样）并列出需要生成的图片，用户最后会导出成 HTML / CSS。'
      : '你是游戏 UI 设计助手，在为虚幻引擎 5 的 UMG 设计界面。用户描述想要的界面，你用 design 工具搭出 UMG 控件树并列出需要生成的图片，用户最后会把结果导入 UE 生成 Widget Blueprint。'
  }

## 可用控件${web ? '' : '（UE5 自带）'}
${widgetCatalogText(web ? 'web' : 'game')}

${web ? WEB_NOTES : UMG_NOTES}

## 设计规则
${web ? webRules(d) : gameRules(d)}- 图片的 prompt 用英文写清楚画什么、什么风格、什么颜色，不要包含文字；尺寸写在 width / height（像素，按界面上的显示尺寸）。
- 已经生成好的图片不用再列出来，除非用户要求改它（列出来就会重新生成）。新图片的 id 用简短的英文（例如 btn_normal）。
- 用户只是提问、不需要改设计时，只回答，不用调用修改的工具。

${
  styled
    ? ''
    : `## 整体风格还没定
这个设计还没有确定整体美术风格。如果用户这次的要求和之前的对话里都没有说清楚整体风格（例如「暗黑奇幻」「像素风」「扁平简约」这样的描述，或者附上了参考图），先不要搭界面、不要列图片：
调用 ask_user 问用户想要什么整体风格（需要的话同时问配色、气质等其他问题），然后回复一句为什么先问，给 3~4 个适合这个界面和题材的选项，每个选项写 label（中文，10 个字以内）、desc（一句中文说明画面感觉）、style（选了以后用的英文风格描述，40~80 个词）。
${styles.length ? `风格库里有这些用户存过的风格，合适的直接作为选项（style 照抄它的英文）：\n${styles.map((x) => `- ${x.name}：${x.summary}\n  英文：${x.en}`).join('\n')}\n` : ''}用户已经说清楚风格时不要问，直接做，并用 set_design 的 style 写下整体风格。用户回答了风格问题后，按之前的要求接着做。

`
}## 当前设计
${brief ? `项目提示词（整个项目统一的美术要求，生成每张图时会自动带上英文版，图片的 prompt 里不用重复，但设计要符合）：\n${brief}\n这个界面额外的风格补充：${d.style || '（没有）'}` : `美术风格：${d.style || '（还没定）'}`}${project?.images.length ? `\n项目里其他界面已有的图片（新图片要和它们风格一致，可以复用相同的描述方式）：\n${project.images.map((i) => `- ${i.name}：${i.prompt}`).join('\n')}` : ''}
设计稿尺寸：${d.designSize.X}×${d.designSize.Y}
控件树：
${JSON.stringify(compactTree(d.root))}
子控件：
${comps.length ? JSON.stringify(comps) : '（没有）'}
图片：
${imgs.length ? JSON.stringify(imgs) : '（没有）'}
动画：
${d.animations?.length ? JSON.stringify(animationsBrief(d.animations)) : '（没有）'}
${chat ? `\n## 之前的对话\n${chat}\n` : ''}
## 用户这次的要求
${request}
${annotations?.length ? `\n${annotationText(annotations, d.designSize)}\n` : ''}
${concept ? conceptSection(concept, d) : ''}## 用 design 工具改设计
你有 design 工具（MCP），每一次调用都会马上显示给用户。**一次输出太长会让连接中途断开、这一轮整个失败**，所以按区域分多次小步提交：
- 每次调用最多 ${MAX_TOOL_ITEMS} 条 items、合计最多 ${MAX_TOOL_WIDGETS} 个控件（带的子控件也算）、add_images 最多 ${MAX_TOOL_IMAGES} 张，超过会被退回
- 从零搭界面：先 create_components 建好子控件（每个子控件一次），再 replace_widget 把根控件换成只有几个大区块的骨架，然后用 add_widgets 一块一块往各区块里填，每块一次调用
- 改现有界面：add_widgets / update_widgets / remove_widgets / move_widgets / rename_widgets；duplicate_widgets 复制控件（重复的卡片、按钮）；wrap_widget 给控件外面套一层面板
- 找控件：find_widgets 按名字、类型、文字找；get_tree 看某个子控件的树（in 写子控件名）
- 改错了：undo 撤回这一轮最近几次调用
- 子控件：create_components、resize_components、delete_components；往子控件里加控件时 in 写子控件名
- 图片：add_images 列出要生成的图片（prompt 写正向描述，negative 写反向提示词），再用 update_widgets 设到控件上（"img:<图片 id>"）。同类的小图标（背包物品、技能、货币、状态图标，3 个以上）给它们写同一个 sheet（例如 "items"）：面板让图片模型把它们画在一张图上再自动切开，比一张张生成快得多，每个图标仍然按各自的 width、height 精确输出
- 看图量尺寸：inspect_image 量图的精确像素尺寸、主要颜色和任意位置的颜色；view_image 生成带坐标格的图或放大一块区域，再用读图的能力看这个文件。照着参考图做界面、或要看设计里已有的图时先用它们量准位置、大小和颜色，不要目测
- 看效果：screenshot 截一张当前画布（就是用户左边看到的样子），返回图片文件和每个控件在画布上的位置；搭完一块或改完后截图看一眼，有重叠、跑出画面、比例不对的地方接着改
- set_design：style 写${brief ? '这个界面在项目提示词之外的风格补充（英文，不能和项目提示词冲突）' : '整体美术风格（英文，生成每张图时都会带上）'}，designSize 改设计稿尺寸${styled ? '' : '；ask_user 先问用户（可以一次问几个问题）'}
- 当前的控件树已经在上面，不用先 get_tree；最后调一次 check，有问题接着改，没问题就用几句中文回复你做了什么

### 控件的写法（宽松，少写错）
- {"Type":"TextBlock","Name":"Txt_Title","Text":"背包","Slot":{…}}：Type、Name、Slot、Children、Class 以外的键都是属性，也可以写在 Properties 里
- 画布（CanvasPanel）里的位置用简写：{"anchor":"top-left","x":40,"y":32,"w":320,"h":72}，anchor 取 top-left / top / top-right / left / center / right / bottom-left / bottom / bottom-right，
  锚点和控件自身的对齐点是同一个角，x、y 是离那个点的距离（例如 bottom-right 写 x:-24,y:-24 就是离右下角各 24 像素），w、h 是宽高；铺满写 {"anchor":"stretch","margin":[左,上,右,下]}
- 横排、竖排等的插槽：{"padding":8 或 [左,上,右,下],"fill":1,"h":"center","v":"center"}
- 尺寸按设计稿 ${d.designSize.X}×${d.designSize.Y} 的像素写准；照着参考图做时先量准再换算：参考图的宽高比和设计稿一致时，参考图像素坐标 × (${d.designSize.X} ÷ 参考图宽) 就是设计稿坐标
- 图片控件的显示尺寸和图片自己的宽高比要一致（add_images 的 width、height 就按它在界面上的显示尺寸写），否则会被拉伸变形；check 会提醒
- 改属性：update_widgets 的 properties / slot 只写要改的字段，和原来的合并；换图就是给画刷设 {"Brush":{"ResourceObject":"img:icon_gem"}}

### 动画（add_animations / remove_animations）
${web ? WEB_MOTION : GAME_MOTION}
- 一般用 presets，一句话就能加上；预设满足不了时再写 tracks 关键帧。动画只改不透明度、位移、缩放、旋转，不影响布局。
- 列表、卡片、按钮组一个接一个出现：同一个预设写多个 widgets，stagger 0.05~0.12 秒。
- 动画要克制：入场 0.3~0.6 秒，悬停反馈 0.15~0.2 秒，循环动画只用在真正需要吸引注意的地方（可领取的奖励、加载中、新消息）。
- 可用的预设：
${presetCatalogText()}

## 回复
所有修改都通过 design 工具完成，不要把整棵树写成 JSON 输出、不要写文件、不要运行命令。回复就是给用户看的几句中文说明，不要输出 JSON 或代码块。`
}

/** 每次调用设计工具最多提交的条数、控件数和图片数：一次输出太长，模型服务的连接容易中途断开 */
export const MAX_TOOL_ITEMS = 20
export const MAX_TOOL_WIDGETS = 30
export const MAX_TOOL_IMAGES = 16
export const MAX_TOOL_KEYS = 240

/** 给设计 AI 的原画信息：先出原画（concept）还是照着确认的模板做（template） */
export interface ConceptContext {
  mode: 'concept' | 'template'
  state: ConceptState
  /** 用户这次在原画上的标注 */
  marks: Annotation[]
  /** 用户在输入框选的这一轮出几张 */
  count?: number
}

function conceptSection(c: ConceptContext, d: Design) {
  const size = `${d.designSize.X}×${d.designSize.Y}`
  const fmt = (i: ConceptImage) =>
    `- ${i.id}（第 ${i.round} 轮，${i.width}×${i.height}${i.base ? `，在 ${i.base} 上改的` : ''}）：${i.prompt.slice(0, 400)}${i.negative ? `\n  negative：${i.negative.slice(0, 200)}` : ''}`
  if (c.mode === 'template') {
    const tpl = c.state.images.find((i) => i.id === c.state.approved)!
    return `## 已确认的效果图模板
用户已经确认这张效果图作为最终模板：${tpl.id}（${tpl.width}×${tpl.height}，看图时 source 写 "concept:${tpl.id}"）。它的描述：${tpl.prompt.slice(0, 600)}
照着它搭界面、出切图，界面要和模板一致：
1. 先用 view_image 整体看一遍模板，再用 region 放大各个区域，用 inspect_image 量准位置、尺寸和颜色，换算到设计稿 ${size}。
2. 分区域搭控件树：先搭骨架，再一块一块往里加控件（见下面的数量限制）。模板里的文字写进 TextBlock。
3. 切图资源不是从效果图上截，而是照着模板里的样子重新生成生产级的独立图片：每个底框、按钮、高亮框、图标、装饰单独一张，prompt 用英文写清楚形状、材质、颜色、细节，negative 写反向提示词（例如 text, watermark, background scenery, cropped）。同类的小图标（3 个以上）放进同一个 sheet 合成一张图出，面板会自动切开，不用一张张出，也不用问用户；需要拉伸的框给 nineSlice。生成时面板会把模板图一起交给图片模型参考，风格会和模板一致。
4. 搭完调 screenshot 截一张当前画布，和模板对比（用 view_image 看截图文件和模板的同一块），位置、比例、层次不对的接着改，直到和模板一致；最后调 check。
- 之后用户只要求改某个已有的小图标时，只重新出那一张（add_images 写同一个 id，不写 sheet），不要重出整张图集。

`
  }
  const sel = c.state.images.find((i) => i.id === c.state.selected)
  return `## 现在是「先出原画」阶段
用户打开了「先出原画」：这一轮**不要搭控件树、不要列切图**，先画整屏的效果图（原画）给用户挑，用户确认一张作为模板以后才开始搭界面和切图。
- 调用 generate_concepts：prompt 用英文完整描述整个界面的画面（题材、整体风格（定了美术风格时照它写，不要换成别的风格）、布局分区和每块放什么、主色调、材质和光影、氛围），negative 写反向提示词（不想出现的东西），${c.count ? `这一轮出 ${c.count} 张，是用户在输入框里选的，count 不用写，generate_concepts 只调一次` : `count 是同时出几张候选（用户没说就出 3 张，最多 ${MAX_CONCEPTS} 张）`}${(c.count ?? 3) > 1 ? '；几张之间在布局或配色上要有明显区别，方便挑' : ''}。效果图按设计稿 ${size} 的比例出。
- 用户要在某张的基础上改（标注、提意见）时：base 写那张的 id，prompt 写改好以后的完整描述（不是只写改动），面板会把那张图作为参考一起交给图片模型。
- 想先确认题材或风格可以用 ask_user；要求已经清楚时直接出图。
- 调用后回复一两句：这几张的思路有什么不同；用户可以在左边挑一张、在图上标注再让你改，满意了点「用这张做模板」。
${c.state.images.length ? `\n已经出过的原画：\n${c.state.images.slice(-12).map(fmt).join('\n')}\n用户现在选中的是：${sel ? sel.id : '（没有）'}\n` : ''}${
    c.marks.length
      ? `\n${c.marks
          .map((m) => m.target.slice('concept:'.length))
          .filter((id, i, a) => a.indexOf(id) === i)
          .map((id) => {
            const img = c.state.images.find((i) => i.id === id)
            const marks = c.marks.filter((m) => m.target === conceptTarget(id))
            return img
              ? `用户在原画 ${id} 上标出的修改（位置是图片宽高的百分比，可以直接写进 prompt）：\n${imageRevisionText('', marks, { X: img.width || d.designSize.X, Y: img.height || d.designSize.Y })}`
              : ''
          })
          .filter(Boolean)
          .join('\n\n')}\n`
      : ''
  }
`
}

/** 检查 AI 的结果，补齐默认值；不合格时返回给 CLI 修正的错误 */
export function resolveDesignResult(
  raw: unknown,
  d: Design,
):
  | { error: string }
  | { result: z.infer<typeof AiDesignResult>; root?: Widget; components?: Component[]; animations?: UiAnimation[] } {
  const p = AiDesignResult.safeParse(raw)
  if (!p.success) return { error: z.prettifyError(p.error) }
  const r = p.data
  const imageIds = new Set([...d.images.map((i) => i.id), ...r.images.map((i) => i.id)])
  const components = r.components?.map((c) => ({
    Name: c.Name,
    DesignSize: c.DesignSize ?? { X: 128, Y: 128 },
    Root: normalizeTree(c.Root),
  }))
  let root = r.root ? normalizeTree(r.root) : undefined
  const errors: string[] = []
  // 一步步改：在现有设计（或这次写的完整树）上应用操作，结果再整体检查
  let after = components
  let animations = r.animations
  // ops 给了空数组也要走这里：MCP 的「检查」用它检查当前的设计
  if (r.ops) {
    const applied = applyOps(
      { root: root ?? d.root, components: components ?? d.components, animations: animations ?? d.animations ?? [] },
      r.ops,
    )
    errors.push(...applied.errors)
    root = applied.state.root
    after = applied.state.components
    animations = applied.state.animations
  }
  const compNames = (after ?? d.components).map((c) => c.Name)
  errors.push(
    ...(root ? checkTree(root, compNames, imageIds) : []),
    ...(after ?? []).flatMap((c) => checkTree(c.Root, compNames, imageIds).map((e) => `${c.Name}：${e}`)),
  )
  if (r.root && !r.root?.Type) errors.push('root 必须是一个控件（有 Type）')
  if (r.root && r.ops?.length) errors.push('root 和 ops 只写一个：改现有设计用 ops，整个重做才写完整的 root')
  // normalizeTree 会把不认识的类型换成 Overlay，这里先查原始数据，让 AI 知道写错了
  const unknown = (w: any, out: string[]): string[] => {
    if (w && typeof w === 'object') {
      if (w.Type && !WIDGETS[w.Type as WidgetType]) out.push(`未知的控件类型 ${w.Type}（${w.Name ?? ''}）`)
      // normalizeTree 会丢掉列表控件下的子控件，这里提醒 AI 改用条目子控件
      else if (WIDGETS[w.Type as WidgetType]?.entries && Array.isArray(w.Children) && w.Children.length)
        out.push(
          `${w.Type} 的条目是运行时生成的，不能预先放子控件（${w.Name ?? ''}）：把条目做成子控件，写在 Properties.EntryWidgetClass 里`,
        )
      for (const c of Array.isArray(w.Children) ? w.Children : []) unknown(c, out)
    }
    return out
  }
  errors.push(
    ...unknown(r.root, []),
    ...(r.components ?? []).flatMap((c) => unknown(c.Root, [])),
    ...(r.ops ?? []).flatMap((o: any) => unknown(o?.widget ?? o?.component?.Root, [])),
  )
  // TextBlock 留着默认的 "Text Block"：要写成实际显示的文字或示例
  const placeholder: string[] = []
  for (const tr of [root, ...(after ?? []).map((c) => c.Root)])
    if (tr)
      walk(tr, (w) => {
        const def = w.Type === 'TextBlock' ? 'Text Block' : w.Type === 'Text' ? 'Text' : ''
        if (def && (!String(w.Properties.Text ?? '').trim() || w.Properties.Text === def)) placeholder.push(w.Name)
      })
  if (placeholder.length)
    errors.push(
      `这些文字控件还是默认文字：${placeholder.slice(0, 10).join('、')}。把 Text 写成要显示的内容，运行时才知道的值写成真实格式的示例（如 Lv.99、12,345、00:59）`,
    )
  // 列出来的图都要用在控件上：只列图不引用，图生成完了效果图上也看不到
  const used = usedImages([root ?? d.root, ...(after ?? d.components).map((c) => c.Root)])
  const unused = r.images.filter((i) => !used.has(i.id)).map((i) => i.id)
  if (unused.length)
    errors.push(
      `这些图片没有被任何控件用到：${unused.join('、')}。在对应控件的画刷里写 "ResourceObject":"img:<图片 id>"（Image 的 Brush、Border 的 Background、Button 的 WidgetStyle.Normal；网页是 Picture 的 Src、Frame / WebButton 的 BackgroundImage），用 update_widgets 设上`,
    )
  // 动画引用的控件要在：控件删了、改名了，动画里的轨道要跟着改
  const finalRoot = root ?? d.root
  const finalComps = after ?? d.components
  const names = (w: Widget) => {
    const set = new Set<string>()
    walk(w, (x) => set.add(x.Name))
    return set
  }
  errors.push(
    ...checkAnimations(
      animations ?? d.animations ?? [],
      new Map([['', names(finalRoot)], ...finalComps.map((c) => [c.Name, names(c.Root)] as [string, Set<string>])]),
    ).map((e) => `${e}：用 add_animations 改好或 remove_animations 删掉`),
  )
  if (errors.length) return { error: errors.slice(0, 12).join('\n') }
  return { result: r, root, components: after, animations }
}

export const ANNOTATION_LABEL: Record<AnnotationKind, string> = {
  change: '修改',
  add: '新增',
  remove: '删除',
  keep: '保持不变',
}

/** 标注的范围（设计稿像素）：画笔取外框，图钉和箭头取指向的点 */
export function annotationBox(a: Pick<Annotation, 'shape' | 'points'>) {
  const p = a.points
  if (a.shape === 'rect') return { x: p[0], y: p[1], w: p[2], h: p[3] }
  if (a.shape === 'pin') return { x: p[0], y: p[1], w: 0, h: 0 }
  if (a.shape === 'arrow') return { x: p[2], y: p[3], w: 0, h: 0 }
  const xs = p.filter((_, i) => i % 2 === 0)
  const ys = p.filter((_, i) => i % 2 === 1)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** 发给 AI 的标注说明：编号、意思、位置、范围里的控件和用户写的说明 */
export function annotationText(list: Annotation[], size: { X: number; Y: number }) {
  const shape = { rect: '框选', arrow: '箭头指向', pen: '圈画', pin: '标记点' }
  const lines = list.map((a, i) => {
    const b = annotationBox(a)
    const r = (n: number) => Math.round(n)
    const where = b.w || b.h ? `范围 x=${r(b.x)} y=${r(b.y)} 宽=${r(b.w)} 高=${r(b.h)}` : `位置 x=${r(b.x)} y=${r(b.y)}`
    return [
      `${i + 1}.【${ANNOTATION_LABEL[a.kind]}】${shape[a.shape]}，${a.target ? `在子控件 ${a.target} 里，` : ''}${where}`,
      a.widgets.length ? `   涉及的控件：${a.widgets.join('、')}` : '',
      a.note.trim() ? `   说明：${a.note.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })
  return `## 用户在效果图上的标注
坐标是设计稿像素（左上角为原点，设计稿 ${size.X}×${size.Y}）。「修改」是要改这里，「新增」是在这里加东西，「删除」是去掉这里的内容，「保持不变」是这部分不要动、可以作为参考。按编号逐条处理，回复里简单说明每条怎么改的。
${lines.join('\n')}`
}

/**
 * 生成图片的完整描述：带上整体风格；透明背景时浏览器网页版做不出真透明，
 * 让它画纯绿底，扩展再抠掉（chroma 为 true 时）。
 */
export function imagePrompt(
  img: Pick<DesignImage, 'prompt' | 'width' | 'height' | 'transparent' | 'nineSlice'> & { negative?: string },
  style: string,
  chroma: boolean,
  /** 项目提示词的英文（projectPromptText），整个项目统一 */
  projectStyle = '',
  /** 网页 UI 的图（插图、头像、图标）和游戏 UI 的描述不一样 */
  kind: DesignKind = 'game',
  /** 生成时一起交给图片模型的参考图（确认的原画模板） */
  reference = false,
) {
  const ratio = aspect(img.width, img.height)
  const parts = [
    kind === 'web' ? `Image for a web page: ${img.prompt.trim()}` : `Game UI asset: ${img.prompt.trim()}`,
    kind === 'web' ? WEB_QUALITY : GAME_QUALITY,
    projectStyle.trim(),
    style ? `${projectStyle.trim() ? 'Additional style for this screen' : 'Art style'}: ${style.trim()}` : '',
    reference ? REFERENCE_NOTE : '',
    kind === 'web'
      ? `Aspect ratio ${ratio} (about ${img.width}x${img.height} px). The image fills the whole canvas, no text, no watermark, no browser window or device mockup around it.`
      : `Aspect ratio ${ratio} (about ${img.width}x${img.height} px). One single isolated UI element, centered, filling the canvas, no text, no watermark, no mockup or screen around it.`,
    img.nineSlice
      ? 'It will be stretched as a 9-slice: keep the corners decorated and the edges and center plain and uniform.'
      : '',
    img.transparent
      ? chroma
        ? 'Background: perfectly flat pure green #00FF00 everywhere outside the element (chroma key), no shadows or gradients on the background, do not use green inside the element.'
        : 'Transparent background (alpha), nothing outside the element.'
      : '',
    negativeLine(kind === 'web' ? WEB_NEGATIVE : GAME_NEGATIVE, img.negative),
  ]
  return parts.filter(Boolean).join('\n')
}

/**
 * 生产级出图的正向要求：图片模型默认出的东西偏「插画、海报」，要明确说这是交给引擎用的资源。
 * 反向提示词：网页版的图片模型没有单独的反向参数，写成「不能出现」的一行，效果最稳
 */
const GAME_QUALITY =
  'Production-ready game UI asset, as delivered by a senior game UI artist for direct use in the engine: crisp clean edges, precise readable silhouette, consistent soft top-left lighting, rich but controlled detail that stays readable at the target size, high resolution, sharp focus, clean flat-on front view.'
const WEB_QUALITY =
  'Production-ready image for a shipped website: professional, polished, high resolution, sharp focus, clean composition with breathing room, consistent lighting and color grading.'
const GAME_NEGATIVE =
  'text, letters, numbers, words, watermark, signature, logo, UI mockup, screenshot, full screen layout, extra unrelated elements, cropped, cut off, out of frame, blurry, low resolution, pixelated, jpeg artifacts, noise, grain, chromatic aberration, depth of field, perspective tilt, photo background, messy sketch lines, unfinished, inconsistent lighting, deformed or warped shapes'
const WEB_NEGATIVE =
  'text, letters, watermark, signature, logo, browser window, device frame, screenshot, cropped, blurry, low resolution, pixelated, jpeg artifacts, noise, oversaturated, distorted, deformed, cluttered composition'
const REFERENCE_NOTE =
  'The attached image is the approved concept art of the whole screen: match its art style, materials, colors, lighting and level of detail exactly, but draw only the single element described here, cleanly isolated (not cropped from the screenshot).'
const negativeLine = (...lists: (string | undefined)[]) => {
  const all = lists.flatMap((l) => (l ?? '').split(',')).map((x) => x.trim())
  const uniq = [...new Set(all.filter(Boolean).map((x) => x.toLowerCase()))]
  return uniq.length ? `Negative prompt (none of these may appear): ${uniq.join(', ')}.` : ''
}

/**
 * 原画（整屏效果图）的生成描述：按设计稿的比例画出完整的界面，正面平视、没有设备边框；
 * reference 表示带着上一张图一起交给图片模型，在它的基础上改
 */
export function conceptPrompt(
  c: { prompt: string; negative?: string },
  size: { X: number; Y: number },
  style: string,
  projectStyle = '',
  kind: DesignKind = 'game',
  reference = false,
) {
  const parts = [
    kind === 'web'
      ? `Website UI design concept: a complete, polished page design shown at ${size.X}x${size.Y} (aspect ratio ${aspect(size.X, size.Y)}). ${c.prompt.trim()}`
      : `Game UI concept art: a complete, polished in-game screen mockup at ${size.X}x${size.Y} (aspect ratio ${aspect(size.X, size.Y)}). ${c.prompt.trim()}`,
    'Shown exactly as the final screen looks on the display: flat front-on view filling the whole canvas, no device frame, no monitor, no perspective angle, no hands or people.',
    kind === 'web'
      ? 'Production quality UI design: clear visual hierarchy, consistent component styling, aligned grid, generous whitespace, legible typography hierarchy shown with short placeholder text.'
      : 'Production quality game UI art direction: clear visual hierarchy, every panel, frame, button, icon and decoration in one consistent art style, clean alignment and spacing, readable at a glance, layered depth with subtle shadows and highlights. Labels are short and legible or suggested with simple lines.',
    projectStyle.trim(),
    style ? `${projectStyle.trim() ? 'Additional style for this screen' : 'Art style'}: ${style.trim()}` : '',
    reference
      ? 'The attached image is the previous version of this screen: keep its layout, composition and everything not mentioned, and apply only the described changes.'
      : '',
    negativeLine(
      'watermark, signature, device frame, monitor bezel, photo of a screen, perspective angle, blurry, low resolution, jpeg artifacts, cluttered overlapping elements, misaligned layout, inconsistent styles, distorted icons, gibberish text, long paragraphs of text',
      c.negative,
    ),
  ]
  return parts.filter(Boolean).join('\n')
}

/** 图标表的格数：尽量接近正方形（按图标的宽高比算），最后一行可以不满 */
export function sheetGrid(n: number, cell: { width: number; height: number }) {
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * cell.height) / cell.width))))
  return { cols, rows: Math.ceil(n / cols) }
}

/**
 * 图标表的生成描述：一张图里画 n 个图标，排成整齐的格子，每个图标单独占一格，之后面板按格切开。
 * chroma 时用纯绿底（面板再抠成透明）
 */
export function sheetPrompt(
  imgs: (Pick<DesignImage, 'prompt' | 'width' | 'height' | 'transparent'> & { negative?: string })[],
  style: string,
  chroma: boolean,
  projectStyle = '',
  kind: DesignKind = 'game',
  /** 带着确认的原画模板一起交给图片模型 */
  reference = false,
) {
  const cell = {
    width: Math.max(...imgs.map((i) => i.width)),
    height: Math.max(...imgs.map((i) => i.height)),
  }
  const { cols, rows } = sheetGrid(imgs.length, cell)
  const transparent = imgs.some((i) => i.transparent)
  const parts = [
    `Icon sprite sheet for ${kind === 'web' ? 'a web page' : 'a game UI'}: ${imgs.length} separate icons laid out in a strict grid of ${cols} columns × ${rows} rows, aspect ratio ${aspect(cols * cell.width, rows * cell.height)}, the grid fills the whole canvas.`,
    'Every cell is the same size. Each icon is centered in its own cell, fully inside it with about 12% empty margin on every side; nothing touches or crosses a cell border. No grid lines, frames around cells, numbers, labels or text anywhere.',
    'All icons look like one matching set: identical art style, outline weight, lighting direction, color treatment and level of detail.',
    kind === 'web' ? WEB_QUALITY : GAME_QUALITY,
    projectStyle.trim(),
    style ? `${projectStyle.trim() ? 'Additional style for this screen' : 'Art style'}: ${style.trim()}` : '',
    reference
      ? 'The attached image is the approved concept art of the whole screen: match its art style, materials, colors and lighting exactly, but draw each icon cleanly isolated in its own cell.'
      : '',
    transparent
      ? chroma
        ? 'Background: perfectly flat pure green #00FF00 everywhere outside the icons (chroma key), no shadows, gradients or texture on the background, do not use green inside any icon.'
        : 'Transparent background (alpha), nothing outside the icons.'
      : 'Background: plain flat neutral color, identical in every cell.',
    `Icons in order, row by row starting at the top-left, left to right:\n${imgs.map((i, k) => `${k + 1}. ${i.prompt.trim()}`).join('\n')}`,
    imgs.length < cols * rows ? 'Leave the unused cells at the end empty (background only).' : '',
    negativeLine(
      kind === 'web' ? WEB_NEGATIVE : GAME_NEGATIVE,
      'grid lines, cell borders, icons touching each other, icons crossing cell borders',
      ...imgs.map((i) => i.negative),
    ),
  ]
  return parts.filter(Boolean).join('\n')
}

/**
 * 图片的修改意见：用户写的意见和在大图上画的标记，拼成英文加在生成描述后面。
 * 位置用图片宽高的百分比，生成模型不管出图多大都能对上
 */
export function imageRevisionText(feedback: string, marks: Annotation[], size: { X: number; Y: number }) {
  const verb = { change: 'Change', add: 'Add something', remove: 'Remove', keep: 'Keep unchanged' }
  const pct = (v: number, max: number) => `${Math.round((v / Math.max(1, max)) * 100)}%`
  const lines = marks.map((a, i) => {
    const b = annotationBox(a)
    const where =
      b.w || b.h
        ? `the area x ${pct(b.x, size.X)}–${pct(b.x + b.w, size.X)}, y ${pct(b.y, size.Y)}–${pct(b.y + b.h, size.Y)}`
        : `around x ${pct(b.x, size.X)}, y ${pct(b.y, size.Y)}`
    return `${i + 1}. ${verb[a.kind]} at ${where} (from the top-left corner)${a.note.trim() ? `: ${a.note.trim()}` : ''}`
  })
  if (!feedback.trim() && !lines.length) return ''
  return [
    'Requested changes compared with the previous version (keep everything else as described):',
    feedback.trim(),
    ...lines,
  ]
    .filter(Boolean)
    .join('\n')
}

function aspect(w: number, h: number) {
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a)
  const d = g(w, h) || 1
  const a = w / d
  const b = h / d
  return a > 32 || b > 32 ? `${(w / h).toFixed(2)}:1` : `${a}:${b}`
}

export type { Margin }

// ---- 项目里已有的子控件 ----

/** 项目里一个设计的子控件，给「控件」列表用：带上它们用到的图片（选中的那一版），页面能直接画出来 */
export interface ProjectComponents {
  designId: string
  /** 游戏 UI 和网页 UI 的控件不能混用，列表只列同一种的 */
  kind: DesignKind
  title: string
  components: Component[]
  images: { id: string; file: string; width: number; height: number }[]
}

/** 子控件引用的其他子控件（UserWidget 的 Class、列表和网格的 EntryWidgetClass），连同间接引用的 */
export function componentDeps(name: string, all: Component[]): string[] {
  const out: string[] = []
  const visit = (n: string) => {
    if (out.includes(n)) return
    const c = all.find((x) => x.Name === n)
    if (!c) return
    out.push(n)
    walk(c.Root, (w) => {
      if (w.Type === 'UserWidget' && w.Class) visit(w.Class)
      const entry = w.Properties?.EntryWidgetClass
      if (typeof entry === 'string' && entry) visit(entry)
    })
  }
  visit(name)
  return out
}

/**
 * 把别的设计里的子控件（连同它引用的子控件和图片）加进这个设计。
 * 同名的子控件已经有了就不重复加（引用的子控件按名字共用）；图片 id 冲突时换个 id，引用跟着改。
 * 返回新的子控件和图片列表，copyFiles 是要从来源设计复制过来的图片文件
 */
export function importComponent(
  target: { components: Component[]; images: DesignImage[]; animations?: UiAnimation[] },
  source: { components: Component[]; images: DesignImage[]; animations?: UiAnimation[] },
  name: string,
):
  | { error: string }
  | { components: Component[]; images: DesignImage[]; animations: UiAnimation[]; copyFiles: string[] } {
  if (!source.components.some((c) => c.Name === name)) return { error: t('没有找到子控件 {name}', { name }) }
  if (target.components.some((c) => c.Name === name))
    return { error: t('这个设计里已经有叫 {name} 的子控件了', { name }) }
  const add = componentDeps(name, source.components)
    .filter((n) => !target.components.some((c) => c.Name === n))
    .map((n) => structuredClone(source.components.find((c) => c.Name === n)!))
  const used = usedImages(add.map((c) => c.Root))
  const ids = new Set(target.images.map((i) => i.id))
  const rename = new Map<string, string>()
  const images = [...target.images]
  const copyFiles: string[] = []
  for (const img of source.images) {
    if (!used.has(img.id)) continue
    let id = img.id
    for (let k = 2; ids.has(id); k++) id = `${img.id}_${k}`
    ids.add(id)
    if (id !== img.id) rename.set(img.id, id)
    images.push({ ...structuredClone(img), id, status: 'idle', error: undefined })
    copyFiles.push(...img.variants.map((v) => v.file))
  }
  // 图片换了 id 的，子控件里的 "img:<id>" 引用跟着换
  const fix = (v: any): any =>
    typeof v === 'string' && v.startsWith('img:') && rename.has(v.slice(4))
      ? `img:${rename.get(v.slice(4))}`
      : Array.isArray(v)
        ? v.map(fix)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]))
          : v
  // 子控件自己的动画一起带过来
  const added = new Set(add.map((c) => c.Name))
  const animations = [
    ...(target.animations ?? []),
    ...structuredClone((source.animations ?? []).filter((a) => added.has(a.in))),
  ]
  return { components: [...target.components, ...add.map(fix)], images, animations, copyFiles }
}

// ---- 设计版本 ----

/** 一个版本：控件树、子控件、尺寸、风格和图片清单的快照；auto 是自动存的（AI 改之前、恢复之前） */
export interface DesignVersion {
  id: string
  name: string
  at: string
  auto: boolean
  snapshot: Pick<Design, 'designSize' | 'style' | 'root' | 'components' | 'images'> & { animations?: UiAnimation[] }
}
export type DesignVersionMeta = Omit<DesignVersion, 'snapshot'> & { widgets: number }
