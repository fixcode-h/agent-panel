import { z } from 'zod'
import {
  checkTree,
  compactTree,
  newWidget,
  normalizeTree,
  widgetCatalogText,
  WIDGETS,
  type WidgetType,
  type Component,
  type Margin,
  type Widget,
} from './umg.ts'

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

export const DesignMessage = z.object({
  id: z.string(),
  role: z.enum(['user', 'agent', 'system']),
  text: z.string(),
  at: z.string(),
  /** 这条回复新建或重新生成的图片 */
  images: z.array(z.string()).optional(),
  run: z.object({ cli: z.string(), model: z.string(), effort: z.string() }).optional(),
  error: z.boolean().optional(),
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
 * UI 设计自己的项目：和 Agent 的项目分开，互不影响。path 是可选的本机目录，「导出到项目目录」写到这里
 */
export const DesignProject = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type DesignProject = z.infer<typeof DesignProject>
export const DesignProjectInput = z.object({
  name: z.string().trim().min(1).max(100),
  path: z.string().trim().max(1000).default(''),
})

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
})
export type DesignChatInput = z.infer<typeof DesignChatInput>

export const GenerateImageInput = z.object({
  source: ImageSource,
  count: z.number().int().min(1).max(4).default(1),
  /** 换一个描述再生成 */
  prompt: z.string().max(4000).optional(),
})

export interface DesignJob {
  status: 'running' | 'done' | 'failed'
  /** design：AI 在改结构；images：在生成图片 */
  phase: 'design' | 'images'
  text: string
  thinking?: string
  tools?: string[]
  outChars: number
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
- ScaleBox：Stretch(None|Fill|ScaleToFit|ScaleToFitX|ScaleToFitY|ScaleToFill|UserSpecified)
- 所有控件：Visibility(Visible|Collapsed|Hidden|HitTestInvisible|SelfHitTestInvisible)、RenderOpacity、RenderTransform{"Translation","Scale","Angle"}`

export function buildDesignPrompt(d: Design, history: DesignMessage[], request: string) {
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
- 根控件一般是 CanvasPanel，尺寸就是设计稿尺寸 ${d.designSize.X}×${d.designSize.Y}；靠边的元素用对应的锚点，方便适配不同分辨率。
- 控件名用英文 PascalCase，同一棵树里不能重复；只写和默认值不一样的属性。
- 图片的 prompt 用英文写清楚画什么、什么风格、什么颜色，不要包含文字；尺寸写在 width / height（像素，按界面上的显示尺寸）。
- 已经生成好的图片不用再列出来，除非用户要求改它（列出来就会重新生成）。新图片的 id 用简短的英文（例如 btn_normal）。
- 用户只是提问、不需要改设计时，只回答，JSON 里只写 reply。

## 当前设计
美术风格：${d.style || '（还没定）'}
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

## 输出格式
先用一两句中文说明你做了什么，然后输出一个 \`\`\`json 代码块：
{
  "reply": "给用户看的说明（中文）",
  "style": "整体美术风格（英文，生成每张图时都会带上；不改就不写）",
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
      for (const c of Array.isArray(w.Children) ? w.Children : []) unknown(c, out)
    }
    return out
  }
  errors.push(...unknown(r.root, []), ...(r.components ?? []).flatMap((c) => unknown(c.Root, [])))
  if (errors.length) return { error: errors.slice(0, 12).join('\n') }
  return { result: r, root, components }
}

/**
 * 生成图片的完整描述：带上整体风格；透明背景时浏览器网页版做不出真透明，
 * 让它画纯绿底，扩展再抠掉（chroma 为 true 时）。
 */
export function imagePrompt(
  img: Pick<DesignImage, 'prompt' | 'width' | 'height' | 'transparent' | 'nineSlice'>,
  style: string,
  chroma: boolean,
) {
  const ratio = aspect(img.width, img.height)
  const parts = [
    `Game UI asset: ${img.prompt.trim()}`,
    style ? `Art style: ${style.trim()}` : '',
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

function aspect(w: number, h: number) {
  const g = (a: number, b: number): number => (b ? g(b, a % b) : a)
  const d = g(w, h) || 1
  const a = w / d
  const b = h / d
  return a > 32 || b > 32 ? `${(w / h).toFixed(2)}:1` : `${a}:${b}`
}

export type { Margin }
