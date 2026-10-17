import { z } from 'zod'
import {
  checkTree,
  compactTree,
  newWidget,
  normalizeTree,
  usedImages,
  walk,
  widgetCatalogText,
  WIDGETS,
  type WidgetType,
  type Component,
  type Margin,
  type Widget,
} from './umg.ts'
import type { ToolUse } from './schema.ts'
import { t } from './i18n.ts'

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
})
export type DesignDoc = Omit<z.infer<typeof DesignDoc>, 'root' | 'components'> & {
  root: Widget
  components: Component[]
}

export const Design = DesignDoc.extend({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(DESIGN_KINDS).default('game'),
  messages: z.array(DesignMessage).default([]),
  /** AI 改过结构就加一，页面据此换掉本地的树 */
  rev: z.number().int().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Design = DesignDoc & {
  id: string
  projectId: string
  kind: DesignKind
  messages: DesignMessage[]
  rev: number
  createdAt: string
  updatedAt: string
}
/** 侧栏列表用：不带树和对话 */
export type DesignMeta = Pick<Design, 'id' | 'projectId' | 'kind' | 'title' | 'createdAt' | 'updatedAt'> & {
  running?: boolean
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
})
export type PromptAiInput = z.infer<typeof PromptAiInput>

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
  /** 对话用的 CLI、模型和思考强度；不给时用默认 CLI */
  run: z
    .object({ cli: z.string().max(40), model: z.string().max(200).default(''), effort: z.string().max(40).default('') })
    .optional(),
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

export interface DesignJob {
  status: 'running' | 'done' | 'failed'
  /** design：AI 在改结构；images：在生成图片 */
  phase: 'design' | 'images'
  /** 正在说的话（JSON 之前的说明） */
  text: string
  thinking?: string
  /** 这一轮的工具调用，和 Agent 的输出一样显示 */
  tools?: ToolUse[]
  /** 这次对话用的 CLI、模型和思考强度 */
  run?: { cli: string; model: string; effort: string }
  /** 生成图片的进度 */
  images?: ImageJobItem[]
  outChars: number
  /** 正在写的控件树和图片清单（JSON 的最后一段），边写边显示 */
  out?: string
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

export const emptyRoot = (): Widget => newWidget('CanvasPanel', 'RootCanvas')

// ---- AI 对话 ----

const AiImage = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'id 只能用字母、数字、下划线和连字符'),
  name: z.string().min(1),
  prompt: z.string().min(1),
  width: z.number().int().min(4).max(2048),
  height: z.number().int().min(4).max(2048),
  transparent: z.boolean().default(true),
  nineSlice: MarginSchema.optional(),
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
})

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
) {
  const brief = project ? projectPromptBrief(project.prompts) : ''
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
  return `你是游戏 UI 设计助手，在为虚幻引擎 5 的 UMG 设计界面。用户描述想要的界面，你给出 UMG 控件树和需要生成的图片，用户最后会把结果导入 UE 生成 Widget Blueprint。

## 可用控件（UE5 自带）
${widgetCatalogText()}

${UMG_NOTES}

## 设计规则
- 游戏 UI 的视觉全部用图片：面板底框、按钮底图、高亮框、选中框、进度条底和填充、图标、分隔线、装饰都是独立的图片，用 Image 或画刷引用（"img:<图片 id>"），不要指望用纯色块拼出效果。文字用 TextBlock。
- 一张图只画一个元素（例如只画按钮底图，不带文字；高亮框单独一张），这样在 UE 里能分别替换和复用。按钮的 Normal / Hovered / Pressed 可以各一张图，也可以共用一张再用 TintColor 区分。
- 需要拉伸的框和底图（面板、按钮、进度条）给图片设 nineSlice，画刷用 DrawAs: "Box" 并把 Margin 设成同样的比例。
- 重复出现、结构复杂的部分（列表项、背包格子、技能按钮）提取成子控件放进 components，在树里用 {"Type":"UserWidget","Class":"<子控件名>"} 引用。
- 数量要等游戏运行时才知道的内容（背包和商店的格子、任务 / 邮件 / 好友列表、排行榜、Buff 图标）用 TileView、ListView 或 DynamicEntryBox，不要在里面预先摆子控件：条目做成子控件，写在 Properties.EntryWidgetClass，NumDesignerPreviewEntries 是设计器里预览几条。数量固定的等大格子（技能栏、快捷栏）用 UniformGridPanel，同样不放子控件，在属性里写 EntryWidgetClass、NumEntries、NumColumns。数量固定、各不相同的排列（主菜单的几个按钮、属性栏）才用 VerticalBox / HorizontalBox 直接放子控件。
- 根控件一般是 CanvasPanel，尺寸就是设计稿尺寸 ${d.designSize.X}×${d.designSize.Y}；靠边的元素用对应的锚点，方便适配不同分辨率。
- 控件名用英文 PascalCase，同一棵树里不能重复；只写和默认值不一样的属性。
- 图片的 prompt 用英文写清楚画什么、什么风格、什么颜色，不要包含文字；尺寸写在 width / height（像素，按界面上的显示尺寸）。
- 已经生成好的图片不用再列出来，除非用户要求改它（列出来就会重新生成）。新图片的 id 用简短的英文（例如 btn_normal）。
- 用户只是提问、不需要改设计时，只回答，JSON 里只写 reply。

## 当前设计
${brief ? `项目提示词（整个项目统一的美术要求，生成每张图时会自动带上英文版，图片的 prompt 里不用重复，但设计要符合）：\n${brief}\n这个界面额外的风格补充：${d.style || '（没有）'}` : `美术风格：${d.style || '（还没定）'}`}${project?.images.length ? `\n项目里其他界面已有的图片（新图片要和它们风格一致，可以复用相同的描述方式）：\n${project.images.map((i) => `- ${i.name}：${i.prompt}`).join('\n')}` : ''}
设计稿尺寸：${d.designSize.X}×${d.designSize.Y}
控件树：
${JSON.stringify(compactTree(d.root))}
子控件：
${comps.length ? JSON.stringify(comps) : '（没有）'}
图片：
${imgs.length ? JSON.stringify(imgs) : '（没有）'}
${chat ? `\n## 之前的对话\n${chat}\n` : ''}
## 用户这次的要求
${request}
${annotations?.length ? `\n${annotationText(annotations, d.designSize)}\n` : ''}
## 输出格式
先用一两句中文说明你做了什么，然后输出一个 \`\`\`json 代码块：
{
  "reply": "给用户看的说明（中文）",
  "style": "${brief ? '这个界面在项目提示词之外的风格补充（英文，不能和项目提示词冲突；没有就不写）' : '整体美术风格（英文，生成每张图时都会带上；不改就不写）'}",
  "designSize": {"X":1920,"Y":1080}（不改就不写）,
  "root": { 完整的控件树（改了结构就写完整的树；没改就不写） },
  "components": [{"Name":"WBP_ItemSlot","DesignSize":{"X":96,"Y":96},"Root":{…}}]（写了就是完整的子控件列表）,
  "images": [{"id":"btn_normal","name":"Button_Normal","prompt":"…","width":320,"height":96,"transparent":true,"nineSlice":{"Left":0.2,"Top":0.3,"Right":0.2,"Bottom":0.3}}]（这次要新建或重新生成的图片）
}
不要修改文件、不要运行命令，只输出说明和 JSON。`
}

/** 检查 AI 的结果，补齐默认值；不合格时返回给 CLI 修正的错误 */
export function resolveDesignResult(
  raw: unknown,
  d: Design,
): { error: string } | { result: z.infer<typeof AiDesignResult>; root?: Widget; components?: Component[] } {
  const p = AiDesignResult.safeParse(raw)
  if (!p.success) return { error: z.prettifyError(p.error) }
  const r = p.data
  const imageIds = new Set([...d.images.map((i) => i.id), ...r.images.map((i) => i.id)])
  const components = r.components?.map((c) => ({
    Name: c.Name,
    DesignSize: c.DesignSize ?? { X: 128, Y: 128 },
    Root: normalizeTree(c.Root),
  }))
  const compNames = (components ?? d.components).map((c) => c.Name)
  const root = r.root ? normalizeTree(r.root) : undefined
  const errors = [
    ...(root ? checkTree(root, compNames, imageIds) : []),
    ...(components ?? []).flatMap((c) => checkTree(c.Root, compNames, imageIds).map((e) => `${c.Name}：${e}`)),
  ]
  if (root && !r.root?.Type) errors.push('root 必须是一个控件（有 Type）')
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
  errors.push(...unknown(r.root, []), ...(r.components ?? []).flatMap((c) => unknown(c.Root, [])))
  // 列出来的图都要用在控件上：只列图不引用，图生成完了效果图上也看不到
  const used = usedImages([root ?? d.root, ...(components ?? d.components).map((c) => c.Root)])
  const unused = r.images.filter((i) => !used.has(i.id)).map((i) => i.id)
  if (unused.length)
    errors.push(
      `这些图片没有被任何控件用到：${unused.join('、')}。在对应控件的画刷里写 "ResourceObject":"img:<图片 id>"（Image 的 Brush、Border 的 Background、Button 的 WidgetStyle.Normal 等），并写出完整的 root / components`,
    )
  if (errors.length) return { error: errors.slice(0, 12).join('\n') }
  return { result: r, root, components }
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
  img: Pick<DesignImage, 'prompt' | 'width' | 'height' | 'transparent' | 'nineSlice'>,
  style: string,
  chroma: boolean,
  /** 项目提示词的英文（projectPromptText），整个项目统一 */
  projectStyle = '',
) {
  const ratio = aspect(img.width, img.height)
  const parts = [
    `Game UI asset: ${img.prompt.trim()}`,
    projectStyle.trim(),
    style ? `${projectStyle.trim() ? 'Additional style for this screen' : 'Art style'}: ${style.trim()}` : '',
    `Aspect ratio ${ratio} (about ${img.width}x${img.height} px). One single isolated UI element, centered, filling the canvas, no text, no watermark, no mockup or screen around it.`,
    img.nineSlice
      ? 'It will be stretched as a 9-slice: keep the corners decorated and the edges and center plain and uniform.'
      : '',
    img.transparent
      ? chroma
        ? 'Background: perfectly flat pure green #00FF00 everywhere outside the element (chroma key), no shadows or gradients on the background, do not use green inside the element.'
        : 'Transparent background (alpha), nothing outside the element.'
      : '',
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
  target: { components: Component[]; images: DesignImage[] },
  source: { components: Component[]; images: DesignImage[] },
  name: string,
): { error: string } | { components: Component[]; images: DesignImage[]; copyFiles: string[] } {
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
  return { components: [...target.components, ...add.map(fix)], images, copyFiles }
}
