import { z } from 'zod'

/**
 * Markdown 渲染样式：对话回复、文档预览、总结报告、文件预览共用一套。
 * 每个元素的每个可调项在这里登记一次（默认值、范围、选项），设置页、CSS 变量生成、校验都读这一份。
 * 设置里只存改过的项：以后调默认值，没改过的用户自动跟着变。
 *
 * 默认值要和 web/src/index.css 里 `:root` 的 `--md-*` 一致（web/src/lib/markdown-style.test.ts 会对）。
 * 尺寸都是相对正文字号的倍数（em），所以「外观 → 字号」仍然整体缩放；圆角、线宽是像素。
 */

/** 文字颜色只从主题色里选（换配色、切深浅色都跟着变）；custom 是浅色、深色各一个值 */
export const MD_COLORS = [
  'inherit',
  'fg',
  'muted',
  'subtle',
  'accent',
  'success',
  'warning',
  'danger',
  'code',
  'line',
  'border',
  // Markdown 自己的一组色相（标题分级、列表符号、提示块、Mermaid 共用），深浅色各一套，见 index.css 的 --md-gold…
  'gold',
  'blue',
  'violet',
  'teal',
  'coral',
  'gray',
  'bright',
  'sand',
] as const
export type MdColorRole = (typeof MD_COLORS)[number]

/** 底色同理 */
export const MD_BGS = ['none', 'card', 'field', 'code', 'chip', 'sel', 'accent', 'blue', 'warm', 'head'] as const
export type MdBgRole = (typeof MD_BGS)[number]

const HEX = /^#[0-9a-f]{6}$/i
export const MdCustomColor = z.object({ light: z.string().regex(HEX), dark: z.string().regex(HEX) })
export type MdCustomColor = z.infer<typeof MdCustomColor>

type NumField = { kind: 'num'; def: number; min: number; max: number; step: number; unit: 'em' | 'px' | '' | '%' }
type EnumField = { kind: 'enum'; def: string; options: readonly string[] }
type ColorField = { kind: 'color'; def: MdColorRole }
type BgField = { kind: 'bg'; def: MdBgRole }
type BoolField = { kind: 'bool'; def: boolean }
export type MdField = NumField | EnumField | ColorField | BgField | BoolField

const em = (def: number, min: number, max: number, step = 0.01): NumField => ({
  kind: 'num',
  def,
  min,
  max,
  step,
  unit: 'em',
})
const px = (def: number, min: number, max: number): NumField => ({ kind: 'num', def, min, max, step: 1, unit: 'px' })
const num = (def: number, min: number, max: number, step: number): NumField => ({
  kind: 'num',
  def,
  min,
  max,
  step,
  unit: '',
})
const color = (def: MdColorRole): ColorField => ({ kind: 'color', def })
const bg = (def: MdBgRole): BgField => ({ kind: 'bg', def })
const bool = (def: boolean): BoolField => ({ kind: 'bool', def })
const pick = <T extends string>(def: T, options: readonly T[]): EnumField => ({ kind: 'enum', def, options })

const WEIGHTS = ['450', '500', '600', '700'] as const
/** 标题前的装饰：竖条、菱形、短横、圆点，或标题下一条渐隐的线；颜色跟标题走 */
const DECOS = ['none', 'bar', 'diamond', 'dash', 'dot', 'underline'] as const
type Deco = (typeof DECOS)[number]
const heading = (
  size: number,
  mt: number,
  mb: number,
  c: MdColorRole,
  weight: (typeof WEIGHTS)[number],
  deco: Deco,
) => ({
  size: em(size, 0.8, 2.4),
  weight: pick(weight, WEIGHTS),
  color: color(c),
  deco: pick(deco, DECOS),
  mt: em(mt, 0, 3),
  mb: em(mb, 0, 2),
  rule: bool(false),
  font: pick('sans', ['sans', 'serif'] as const),
})

/**
 * 元素 → 可调项。默认值是 2026-10 定下的那套：六级标题各一个色相 + 装饰（金 / 蓝 / 紫 / 青 / 珊瑚 / 灰），
 * 链接和 @提及用蓝色，行内代码暖橙，代码块带行号，表格圆角外框、隔行底色，分隔线两头渐隐
 */
export const MD_SPEC = {
  body: { size: num(1, 0.85, 1.3, 0.01), gap: em(0.75, 0, 1.5), color: color('fg') },
  h1: heading(1.5, 1.6, 0.7, 'gold', '700', 'underline'),
  h2: heading(1.28, 1.5, 0.6, 'blue', '600', 'bar'),
  h3: heading(1.12, 1.3, 0.5, 'violet', '600', 'diamond'),
  h4: heading(1, 1.1, 0.4, 'teal', '600', 'dash'),
  h5: heading(0.95, 1, 0.35, 'coral', '600', 'none'),
  h6: heading(0.82, 1, 0.3, 'gray', '600', 'none'),
  strong: { weight: pick('600', WEIGHTS), color: color('bright') },
  em: { color: color('sand') },
  del: { color: color('subtle') },
  link: { color: color('blue'), underline: pick('always', ['always', 'hover', 'none'] as const) },
  code: {
    size: em(0.86, 0.7, 1.2),
    color: color('code'),
    bg: bg('warm'),
    border: bool(true),
    radius: px(5, 0, 12),
  },
  pre: {
    size: em(0.86, 0.7, 1.2),
    leading: num(1.7, 1.2, 2.2, 0.05),
    bg: bg('code'),
    radius: px(10, 0, 20),
    border: bool(true),
    bar: bool(true),
    wrap: bool(false),
    lineNumbers: bool(true),
  },
  quote: {
    line: color('blue'),
    lineWidth: px(3, 0, 8),
    color: color('muted'),
    bg: bg('blue'),
    radius: px(8, 0, 16),
    italic: bool(false),
  },
  /** > [!NOTE] 这类提示块：标题和左线按类型着色，tint 是同色浅底 */
  alert: { tint: bool(true), radius: px(8, 0, 16) },
  ul: {
    marker: pick('disc', ['disc', 'circle', 'square', 'dash'] as const),
    markerColor: color('blue'),
    indent: em(1.5, 0.8, 3),
    gap: em(0.28, 0, 1),
  },
  ol: {
    markerColor: color('gold'),
    markerWeight: pick('700', WEIGHTS),
    indent: em(1.5, 0.8, 3),
    gap: em(0.28, 0, 1),
  },
  task: { color: color('teal'), doneFade: bool(true) },
  table: {
    size: em(0.93, 0.75, 1.15),
    border: pick('rows', ['rows', 'grid', 'none'] as const),
    outer: bool(true),
    radius: px(8, 0, 16),
    headerBg: bg('head'),
    headerWeight: pick('600', WEIGHTS),
    zebra: bool(true),
    pad: num(1, 0.5, 2, 0.05),
  },
  hr: {
    style: pick('fade', ['fade', 'solid', 'dashed', 'dotted'] as const),
    width: px(1, 1, 4),
    color: color('border'),
    space: em(1.6, 0.3, 3),
  },
  img: {
    radius: px(8, 0, 24),
    maxWidth: pick('100', ['100', '75', '50'] as const),
    border: bool(true),
    caption: bool(true),
  },
  mention: { color: color('blue'), bg: bg('blue') },
  /** mermaid 图：出场动画、悬停高亮相连的线、画布点阵底、节点渐变底 */
  mermaid: { motion: bool(true), hover: bool(true), grid: bool(true), gradient: bool(true) },
} as const satisfies Record<string, Record<string, MdField>>

export type MdElement = keyof typeof MD_SPEC
export const MD_ELEMENTS = Object.keys(MD_SPEC) as MdElement[]

type FieldValue<F> = F extends NumField
  ? number
  : F extends BoolField
    ? boolean
    : F extends ColorField | BgField
      ? string | MdCustomColor
      : F extends { options: readonly (infer O)[] }
        ? O
        : never

/** 存下来的样式：只有改过的元素和项 */
export type MarkdownStyle = {
  [E in MdElement]?: { [P in keyof (typeof MD_SPEC)[E]]?: FieldValue<(typeof MD_SPEC)[E][P]> }
}
export type MdValue = number | boolean | string | MdCustomColor

/** 一项的校验：出错（手改设置文件、旧版本没有的选项）就当没改过 */
function fieldSchema(f: MdField): z.ZodType<MdValue> {
  switch (f.kind) {
    case 'num':
      return z.number().min(f.min).max(f.max)
    case 'bool':
      return z.boolean()
    case 'enum':
      return z.string().refine((v) => f.options.includes(v))
    case 'color':
      return z.union([z.enum(MD_COLORS), MdCustomColor])
    case 'bg':
      return z.union([z.enum(MD_BGS), MdCustomColor])
  }
}

/** 逐项校验后只留合法、且和默认值不同的项；整组都没改就不留这个元素 */
export function cleanMarkdownStyle(raw: unknown): MarkdownStyle {
  const out: Record<string, Record<string, MdValue>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const el of MD_ELEMENTS) {
    const given = (raw as Record<string, unknown>)[el]
    if (!given || typeof given !== 'object') continue
    const spec = MD_SPEC[el] as Record<string, MdField>
    for (const [prop, f] of Object.entries(spec)) {
      const r = fieldSchema(f).safeParse((given as Record<string, unknown>)[prop])
      if (!r.success || sameValue(r.data, f.def)) continue
      ;(out[el] ??= {})[prop] = r.data
    }
  }
  return out as MarkdownStyle
}

/** 设置里的 schema：不认识的、越界的项丢掉，缺省是空对象（全部默认） */
export const MarkdownStyle = z
  .unknown()
  .optional()
  .transform((v) => cleanMarkdownStyle(v))

export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export const mdField = (el: MdElement, prop: string) => (MD_SPEC[el] as Record<string, MdField>)[prop]

/** 一项当前的值：改过的用改过的，没改过的用默认值 */
export function mdValue(style: MarkdownStyle, el: MdElement, prop: string): MdValue {
  const v = (style[el] as Record<string, MdValue> | undefined)?.[prop]
  return v ?? mdField(el, prop).def
}

/** 改一项：等于默认值时删掉，元素下没有改过的项时整个元素也删掉 */
export function setMdValue(style: MarkdownStyle, el: MdElement, prop: string, v: MdValue | undefined): MarkdownStyle {
  const next = { ...(style[el] as Record<string, MdValue> | undefined) }
  if (v === undefined || sameValue(v, mdField(el, prop).def)) delete next[prop]
  else next[prop] = v
  const out = { ...style } as Record<string, Record<string, MdValue>>
  if (Object.keys(next).length) out[el] = next
  else delete out[el]
  return out as MarkdownStyle
}

const COLOR_VAR: Record<MdColorRole, string> = {
  inherit: 'currentColor',
  fg: 'var(--fg)',
  muted: 'var(--muted)',
  subtle: 'var(--subtle)',
  accent: 'var(--accent-text)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  code: 'var(--code-chip-fg)',
  line: 'var(--line)',
  border: 'var(--line-strong)',
  gold: 'var(--md-gold)',
  blue: 'var(--md-blue)',
  violet: 'var(--md-violet)',
  teal: 'var(--md-teal)',
  coral: 'var(--md-coral)',
  gray: 'var(--md-gray)',
  bright: 'var(--md-bright)',
  sand: 'var(--md-sand)',
}
const BG_VAR: Record<MdBgRole, string> = {
  none: 'transparent',
  card: 'var(--card)',
  field: 'var(--field)',
  code: 'var(--code-bg)',
  chip: 'var(--code-chip)',
  sel: 'var(--sel)',
  accent: 'var(--accent-soft)',
  blue: 'color-mix(in srgb, var(--md-blue) 11%, transparent)',
  warm: 'color-mix(in srgb, var(--code-chip-fg) 9%, transparent)',
  head: 'color-mix(in srgb, var(--fg) 4%, transparent)',
}
/** 开关在 CSS 里没法当条件用，直接换成开 / 关时的取值 */
const BOOL_CSS: Record<string, [on: string, off: string]> = {
  rule: ['1px', '0px'],
  border: ['1px', '0px'],
  bar: ['flex', 'none'],
  wrap: ['pre-wrap', 'pre'],
  italic: ['italic', 'normal'],
  doneFade: ['0.55', '1'],
  zebra: ['color-mix(in srgb, var(--fg) 2.5%, transparent)', 'transparent'],
  lineNumbers: ['inline-block', 'none'],
  outer: ['1px', '0px'],
  caption: ['block', 'none'],
  tint: ['7%', '0%'],
  grid: ['radial-gradient(var(--md-dot) 1px, transparent 1px)', 'none'],
}
/** 标题装饰落成 ::before 的显示、宽高、旋转、圆角，和渐隐底线的高度 */
const DECO_CSS: Record<Deco, { display: string; w: string; h: string; rot: string; r: string; ul: string }> = {
  none: { display: 'none', w: '0', h: '0', rot: '0deg', r: '0', ul: '0px' },
  bar: { display: 'inline-block', w: '3px', h: '0.9em', rot: '0deg', r: '3px', ul: '0px' },
  diamond: { display: 'inline-block', w: '0.42em', h: '0.42em', rot: '45deg', r: '1px', ul: '0px' },
  dash: { display: 'inline-block', w: '0.7em', h: '2px', rot: '0deg', r: '2px', ul: '0px' },
  dot: { display: 'inline-block', w: '0.45em', h: '0.45em', rot: '0deg', r: '50%', ul: '0px' },
  underline: { display: 'none', w: '0', h: '0', rot: '0deg', r: '0', ul: '2px' },
}
const UL_MARKER: Record<string, string> = { disc: 'disc', circle: 'circle', square: 'square', dash: "'– '" }

/** CSS 变量名：--md-h2-size、--md-table-headerBg */
export const mdVarName = (el: MdElement, prop: string) => `--md-${el}-${prop}`

/** 一项换成 CSS 值；custom 颜色按当前是深色还是浅色取 */
export function mdCssValue(f: MdField, v: MdValue, dark: boolean, el?: MdElement, prop = ''): string {
  if (typeof v === 'object') return dark ? v.dark : v.light
  switch (f.kind) {
    case 'num':
      // 尺寸存的是倍数，CSS 里和 --md-base（正文字号）相乘；像素、纯数字原样给
      return f.unit === 'px' ? `${v}px` : String(v)
    case 'bool': {
      const pair = BOOL_CSS[prop]
      return pair ? pair[v ? 0 : 1] : v ? '1' : '0'
    }
    case 'color':
      return COLOR_VAR[v as MdColorRole] ?? 'inherit'
    case 'bg':
      return BG_VAR[v as MdBgRole] ?? 'transparent'
    case 'enum':
      if (el === 'ul') return UL_MARKER[v as string] ?? 'disc'
      if (el === 'img') return `${v}%`
      if (el === 'h1' || el === 'h2' || el === 'h3' || el === 'h4' || el === 'h5' || el === 'h6') {
        if (v === 'serif') return 'var(--font-serif)'
        if (v === 'sans') return 'var(--font-sans)'
      }
      return String(v)
  }
}

/**
 * 改过的项生成一段 CSS：浅色写在 :root，自定义颜色的深色值再写一份 :root.dark。
 * 开关类的项（表格边框、链接下划线这些）样式表里按 data 属性选不了，就转成能直接用的值。
 */
export function markdownCss(style: MarkdownStyle): string {
  const light: string[] = []
  const dark: string[] = []
  for (const el of MD_ELEMENTS) {
    const given = style[el] as Record<string, MdValue> | undefined
    if (!given) continue
    for (const [prop, v] of Object.entries(given)) {
      const f = mdField(el, prop)
      if (!f) continue
      for (const [k, val] of derived(el, prop, f, v, false)) light.push(`${k}:${val}`)
      if (typeof v === 'object') for (const [k, val] of derived(el, prop, f, v, true)) dark.push(`${k}:${val}`)
    }
  }
  return (light.length ? `:root{${light.join(';')}}` : '') + (dark.length ? `:root.dark{${dark.join(';')}}` : '')
}

/** 一项对应的变量（有的项一项要落成几个变量，比如表格边框决定横线和竖线） */
function derived(el: MdElement, prop: string, f: MdField, v: MdValue, dark: boolean): [string, string][] {
  const name = mdVarName(el, prop)
  if (el === 'table' && prop === 'border') {
    const row = v === 'none' ? '0px' : '1px'
    const col = v === 'grid' ? '1px' : '0px'
    return [
      [`${name}-row`, row],
      [`${name}-col`, col],
    ]
  }
  if (prop === 'deco') {
    const d = DECO_CSS[v as Deco] ?? DECO_CSS.none
    return Object.entries(d).map(([k, val]) => [`${name}-${k}`, val])
  }
  if (el === 'hr' && prop === 'style') {
    // 渐隐线是一段渐变底（两头透明），其余线型还是 border-top
    const fade = v === 'fade'
    return [
      [name, fade ? 'none' : String(v)],
      [
        `${name}-fade`,
        fade
          ? 'linear-gradient(90deg, transparent, var(--md-hr-color) 20%, var(--md-hr-color) 80%, transparent)'
          : 'none',
      ],
    ]
  }
  if (el === 'link' && prop === 'underline') {
    return [
      [`${name}-rest`, v === 'always' ? 'underline' : 'none'],
      [`${name}-hover`, v === 'none' ? 'none' : 'underline'],
    ]
  }
  return [[name, mdCssValue(f, v, dark, el, prop)]]
}

/** 默认值对应的变量，测试拿来和 index.css 对照 */
export function markdownDefaultVars(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const el of MD_ELEMENTS)
    for (const [prop, f] of Object.entries(MD_SPEC[el] as Record<string, MdField>))
      for (const [k, v] of derived(el, prop, f, f.def, false)) out[k] = v
  return out
}
