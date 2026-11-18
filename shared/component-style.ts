import { z } from 'zod'

/**
 * 通用部件的微调：设置 → 组件里每个部件下面能展开调圆角、边框、阴影这些，改一处全站跟着变。
 * 和 Markdown 样式（shared/markdown-style.ts）同一个思路：每个部件的每个可调项在这里登记一次，
 * 设置页、CSS 变量生成、校验都读这一份；设置里只存改过的项，以后调默认值，没改过的用户自动跟着变。
 *
 * 每项落成一个 CSS 变量 --c-<部件>-<项>，部件的 class 直接读它（rounded-(--c-button-radius)）。
 * 默认值要和 web/src/index.css 里 `:root` 的 `--c-*` 一致（shared/component-style.test.ts 会对）。
 * 开关和选项在这里就写好开 / 关、每个选项对应的 CSS 值，生成时不用再分情况。
 */

type PxField = { kind: 'px'; def: number; min: number; max: number }
type BoolField = { kind: 'bool'; def: boolean; on: string; off: string }
type EnumField = { kind: 'enum'; def: string; options: Record<string, string> }
/** 颜色：从主题色里选（换配色、切深浅色都跟着变），或者自定义浅色、深色各一个值 */
type ColorField = { kind: 'color'; def: string; options: Record<string, string> }
export type CompField = PxField | BoolField | EnumField | ColorField

const HEX = /^#[0-9a-f]{6}$/i
export const CompCustomColor = z.object({ light: z.string().regex(HEX), dark: z.string().regex(HEX) })
export type CompCustomColor = z.infer<typeof CompCustomColor>

const px = (def: number, min: number, max: number): PxField => ({ kind: 'px', def, min, max })
const bool = (def: boolean, on: string, off: string): BoolField => ({ kind: 'bool', def, on, off })
const pick = (def: string, options: Record<string, string>): EnumField => ({ kind: 'enum', def, options })
const color = (def: string, options: Record<string, string> = BG): ColorField => ({ kind: 'color', def, options })

/** 底色能选的主题色；部件原来的底色不在里面的（半透明的浅底）单独加一项 default */
export const BG: Record<string, string> = {
  card: 'var(--card)',
  /** 浮层色：弹出菜单、输入框上方弹层的底色，默认和卡片一样，有的配色单独提亮一档（--pop） */
  pop: 'var(--pop)',
  panel: 'var(--panel)',
  bg: 'var(--bg)',
  field: 'var(--field)',
  sel: 'var(--sel)',
  accent: 'var(--accent-soft)',
  none: 'transparent',
}
const tint = (pct: number, base = 'var(--fg)') => `color-mix(in oklab, ${base} ${pct}%, transparent)`

const WEIGHT = { '400': '400', '500': '500', '600': '600' }
/**
 * 表格表头行的颜色：取主题里的几种色相，和页面底色混成不透明的浅底（浓度另调），
 * 表头钉在顶上时下面滚过去的格子不会透出来；换配色、切深浅色都跟着变
 */
const HUE: Record<string, string> = {
  violet: 'var(--peer)',
  teal: 'var(--run)',
  amber: 'var(--warning)',
  blue: 'var(--ctx-messages)',
  green: 'var(--success)',
  red: 'var(--danger)',
  orange: 'var(--accent)',
  gray: 'var(--fg)',
}
const hue = (def: string) => color(def, HUE)
const BORDER = bool(true, '1px', '0px')
/** 调用栈树的几套整体样式（值原样落成变量，也是 html 上 data-ct-report / data-ct-chat 的值） */
const CT_LOOKS = { tree: 'tree', rail: 'rail', cards: 'cards', ide: 'ide' }

/**
 * 部件 → 可调项。圆角上限按部件高度定：胶囊类（标签、状态、进度条）拉到最大就是全圆。
 * 默认值照抄改造前各部件 class 里写死的值，升级后界面不变；只有总结卡按用户要求默认去掉圆角
 */
export const COMP_SPEC = {
  /** 总结卡（Agent 每轮的「修复 / 未完成…」卡片，web/src/index.css 的 .md-card） */
  summary: {
    radius: px(0, 0, 20),
    bg: color('card'),
    bar: px(3, 0, 8),
    border: BORDER,
    divider: bool(true, '1px', '0px'),
    needs: color('warning', {
      warning: tint(12, 'var(--warning)'),
      accent: 'var(--accent-soft)',
      sel: 'var(--sel)',
      none: 'transparent',
    }),
    kindRadius: px(5, 0, 12),
  },
  card: {
    radius: px(10, 0, 24),
    bg: color('card'),
    shadow: bool(true, 'var(--shadow-card)', 'none'),
    border: bool(false, '1px', '0px'),
  },
  button: { radius: px(7, 0, 18), weight: pick('500', WEIGHT) },
  iconButton: { radius: px(7, 0, 14) },
  statusPill: { radius: px(12, 0, 12), weight: pick('500', WEIGHT) },
  badge: { radius: px(12, 0, 12) },
  kbd: { radius: px(5, 0, 9), bg: color('sel') },
  progress: { height: px(6, 2, 12), radius: px(12, 0, 12), track: color('default', { default: tint(14), ...BG }) },
  input: {
    radius: px(7, 0, 16),
    border: BORDER,
    bg: color('field'),
    ring: bool(true, '6px', '0px'),
  },
  checkbox: { radius: px(5, 0, 9) },
  switch: { on: pick('primary', { primary: 'var(--primary)', accent: 'var(--accent)', success: 'var(--success)' }) },
  segmented: { radius: px(7, 0, 16), itemRadius: px(5, 0, 14) },
  chip: { radius: px(5, 0, 12), ring: bool(true, '1px', '0px') },
  row: { radius: px(7, 0, 16), bg: color('default', { default: tint(3.5), ...BG }) },
  nav: { radius: px(7, 0, 16) },
  /**
   * 下拉菜单：search 是下拉框（ui/input 的 Select）几项起打开时顶上带搜索框，值是项数，0 是不显示；
   * Select 打开时读这个变量决定用哪种列表（web/src/components/ui/select-search.tsx）
   */
  menu: {
    radius: px(10, 0, 20),
    itemRadius: px(7, 0, 14),
    bg: color('pop'),
    border: BORDER,
    search: pick('from10', { always: '1', from6: '6', from10: '10', from20: '20', never: '0' }),
  },
  // 弹窗照 Claude Code 网页版的方案弹窗：圆角 8、深色下比页面亮一档的窗口色（--window）
  /** resizeEdge / resizeLine：拖边缘缩放时点亮那一边边线的颜色和粗细（web/src/components/ui/modal-resize.tsx） */
  modal: {
    radius: px(14, 0, 28),
    bg: color('window', { window: 'var(--window)', ...BG }),
    border: BORDER,
    resizeEdge: color('emphasis', {
      emphasis: 'var(--accent)',
      primary: 'var(--primary)',
      gray: tint(40),
    }),
    resizeLine: px(2, 1, 4),
  },
  sheet: { radius: px(14, 0, 24), bg: color('bg') },
  popover: { radius: px(10, 0, 24), bg: color('pop') },
  /** 数据表格（文件弹窗里的 xlsx / CSV，web/src/components/files/SheetTable.tsx）：表头每种行一个颜色 */
  grid: {
    rowH: px(26, 20, 40),
    font: pick('mono', { mono: 'var(--app-mono)', sans: 'var(--app-sans)' }),
    lines: pick('all', { all: '1px', rows: '0px' }),
    tint: pick('high', { low: '8%', mid: '14%', high: '22%', vivid: '32%' }),
    /** 表头每种行一个颜色，互相不重 */
    modifier: hue('violet'),
    side: hue('teal'),
    type: hue('amber'),
    name: hue('blue'),
    comment: hue('green'),
    other: hue('orange'),
    /** 数据区斑马纹：隔一行的底色浓度 */
    stripe: pick('low', { none: '0%', low: '4.5%', mid: '8%' }),
    nameBold: bool(true, '600', '500'),
    divider: bool(true, '2px', '1px'),
    /** 表格页：改过还没保存的格子（左边一条蓝色竖线 + 淡底，不和琥珀色的类型行、橙色的选中撞色）、不合规的格子 */
    edited: hue('blue'),
    invalid: hue('red'),
    /** 版本差异、跨项目对比：新增的行 / 新值、删掉的行 / 旧值（改过的格子底色用 edited） */
    added: hue('green'),
    removed: hue('red'),
    /** 两行列头里类型标签（类型、枚举、引用…）的字号（rem，跟着界面字号缩放）和圆角 */
    tagSize: pick('md', { sm: '0.625rem', md: '0.65625rem', lg: '0.75rem' }),
    tagRadius: px(3, 0, 8),
    /** 格子里的显示：枚举画成胶囊、布尔画成小勾、空格子画淡淡的「—」（开 '1' 关 '0'，SheetTable 读了决定画什么） */
    pills: bool(true, '1', '0'),
    bools: bool(true, '1', '0'),
    blank: bool(true, '1', '0'),
    /** xlsx 里还原的显示信息：批注角标、超链接的颜色；整行底色在行号左边画的色条宽度（关掉就不画） */
    note: hue('amber'),
    link: hue('blue'),
    rowMark: pick('thin', { off: '0px', thin: '3px', wide: '5px' }),
    /** 表格页：选区右下角的填充柄（拖它向下 / 向右填充）有多大 */
    handle: px(7, 5, 12),
    /** 列宽自适应：两行列头的字段名、类型标签也量进去（不被截断）；自动列宽最多这么宽，太长的格子截断、悬停看全 */
    fitHead: bool(true, '1', '0'),
    colMax: px(320, 160, 640),
  },
  /**
   * 调用栈树（诊断报告的调用栈、回复里的 calltree 代码块，web/src/components/ui/call-tree.css）：
   * 连线粗细、缩进、行距、出错点底色、没走到的一跳多淡、出错点下面带不带代码、位置写不写目录、图例；
   * 整体样式按场合各选一套（诊断报告里 / 对话里）：树线、时间轴、卡片、调试器（用户 2026-11-18 定四套都要，
   * 报告默认调试器、对话默认树线）。样式不是 CSS 值，web/src/lib/markdown-style.ts 落成 html 上的 data-ct-*，
   * 规则在 web/src/components/ui/call-tree-looks.css
   */
  callTree: {
    report: pick('ide', CT_LOOKS),
    chat: pick('tree', CT_LOOKS),
    lines: pick('normal', { normal: '1.5px', fine: '1px', none: '0px' }),
    indent: px(20, 12, 32),
    gap: pick('normal', { tight: '1px', normal: '3px', loose: '6px' }),
    fault: pick('fill', { fill: 'color-mix(in srgb, var(--md-coral) 10%, transparent)', bar: 'transparent' }),
    missed: pick('fade', { fade: '0.62', faint: '0.4', keep: '1' }),
    code: bool(true, 'block', 'none'),
    dir: bool(false, 'inline', 'none'),
    legend: bool(true, 'flex', 'none'),
    edge: hue('violet'),
  },
  /**
   * 诊断报告的功能结构（调用栈 / 时序图 / 类图 / 架构页四个页签，web/src/components/ui/structure-views.css）：
   * 架构页说明卡的圆角、图最高多高（超出在框里滚动）、显不显示「它选的」理由、图下面列不列节点对到的代码位置
   */
  structure: {
    radius: px(10, 0, 20),
    diagramH: px(560, 240, 900),
    why: bool(true, 'inline', 'none'),
    nodes: bool(true, 'flex', 'none'),
  },
  /**
   * 能力行（设置 →「MCP」的工具和动作，web/src/components/ui/capability-row.tsx）：
   * 上下留白、悬停底的圆角、显不显示「该用 / 别用」两行、显不显示工具原名
   */
  capRow: {
    pad: pick('normal', { compact: '6px', normal: '10px', loose: '14px' }),
    radius: px(8, 0, 16),
    when: bool(true, 'grid', 'none'),
    name: bool(true, 'inline', 'none'),
  },
  /**
   * HTML 卡片（回复里的 .html / .svg 和「本轮产出」，web/src/components/ui/html-card.tsx）：
   * 圆角、要不要缩略预览、预览多高、正在右栏显示时描边的颜色
   */
  htmlCard: {
    radius: px(10, 0, 20),
    preview: bool(true, 'block', 'none'),
    previewH: px(168, 96, 320),
    active: hue('orange'),
  },
  /**
   * 改动卡片（对话停下后最后面那张「这一轮 / 整个对话改了 N 个文件」，web/src/components/ui/changes-card.tsx）：
   * 圆角、默认看哪一段、先列几个文件。后两项不是 CSS，ConvChangesCard 读设置里的值；落成变量只为走同一套登记
   */
  changesCard: {
    radius: px(12, 0, 20),
    scope: pick('round', { round: 'round', conv: 'conv' }),
    first: pick('3', { '3': '3', '5': '5', '8': '8', '20': '20' }),
  },
  /**
   * 风格参考图和风格选择（web/src/components/ui/style-thumb.tsx、style-picker.tsx）：
   * 缩略图圆角、列表行里缩略图多宽、选中风格的描边颜色
   */
  styleRef: {
    radius: px(6, 0, 16),
    thumbW: px(56, 40, 120),
    ring: hue('orange'),
  },
  /**
   * 提示（toast，web/src/components/ui/toaster.tsx 和 index.css 的 [data-sonner-toast]）：
   * 浮层色的小卡片，图标按类型着色。位置和停留时长不是 CSS，Toaster 读设置里的值；
   * 这里也落成变量只是为了和别的项走同一套登记、校验，默认值和 index.css 对得上
   */
  toast: {
    position: pick('bottomRight', {
      bottomRight: 'bottom-right',
      topRight: 'top-right',
      bottomCenter: 'bottom-center',
      topCenter: 'top-center',
    }),
    duration: pick('4s', { '3s': '3000', '4s': '4000', '6s': '6000', '8s': '8000' }),
    radius: px(10, 0, 20),
    bg: color('pop', { window: 'var(--window)', ...BG }),
    border: BORDER,
    /** 左侧按类型着色的竖条，0 是不画 */
    bar: px(0, 0, 6),
  },
  empty: {
    radius: px(10, 0, 24),
    bg: color('none'),
    border: pick('dashed', { dashed: 'dashed', solid: 'solid', none: 'none' }),
  },
  /**
   * 滚动条（全站一套，照 Claude Code：细、无箭头、透明轨道、圆头滑块，web/src/index.css 的 ::-webkit-scrollbar）：
   * size 是整条轨道多宽，pad 是滑块两边留的透明边（滑块宽 = size - 2 × pad）。
   * size 上限 12：对话区右边给消息区滚动条留的槽就是 12px（RAIL_GUTTER），再宽会钻到会话栏底下。
   * idle 是平时（鼠标不在滚动区里）滑块的颜色：一直显示就等于 thumb，「进来才显示」就是透明
   */
  scrollbar: {
    size: px(10, 6, 12),
    pad: px(2, 0, 4),
    thumb: color('theme', {
      theme: 'var(--scroll-thumb)',
      faint: tint(14),
      strong: tint(32),
      orange: tint(55, 'var(--accent)'),
    }),
    hover: color('theme', {
      theme: 'var(--scroll-thumb-hover)',
      strong: tint(45),
      orange: 'var(--accent)',
    }),
    idle: pick('always', { always: 'var(--c-scrollbar-thumb)', hover: 'transparent' }),
  },
} as const satisfies Record<string, Record<string, CompField>>

export type CompName = keyof typeof COMP_SPEC
export const COMP_NAMES = Object.keys(COMP_SPEC) as CompName[]
export type CompValue = number | boolean | string | CompCustomColor

/** 存下来的微调：只有改过的部件和项 */
export type ComponentStyle = Partial<Record<CompName, Record<string, CompValue>>>

export const compField = (c: CompName, prop: string) => (COMP_SPEC[c] as Record<string, CompField>)[prop]

function valid(f: CompField, v: unknown): v is CompValue {
  if (f.kind === 'px') return typeof v === 'number' && v >= f.min && v <= f.max
  if (f.kind === 'bool') return typeof v === 'boolean'
  if (f.kind === 'color' && CompCustomColor.safeParse(v).success) return true
  return typeof v === 'string' && v in f.options
}

/** 逐项校验后只留合法、且和默认值不同的项；坏值（手改设置文件、旧版本没有的选项）当没改过 */
export function cleanComponentStyle(raw: unknown): ComponentStyle {
  const out: ComponentStyle = {}
  if (!raw || typeof raw !== 'object') return out
  for (const c of COMP_NAMES) {
    const given = (raw as Record<string, unknown>)[c]
    if (!given || typeof given !== 'object') continue
    for (const [prop, f] of Object.entries(COMP_SPEC[c] as Record<string, CompField>)) {
      const v = (given as Record<string, unknown>)[prop]
      if (!valid(f, v) || v === f.def) continue
      ;(out[c] ??= {})[prop] = typeof v === 'object' ? CompCustomColor.parse(v) : v
    }
  }
  return out
}

/** 设置里的 schema：缺省是空对象（全部默认） */
export const ComponentStyle = z
  .unknown()
  .optional()
  .transform((v) => cleanComponentStyle(v))

/** 一项当前的值：改过的用改过的，没改过的用默认值 */
export const compValue = (s: ComponentStyle, c: CompName, prop: string): CompValue =>
  s[c]?.[prop] ?? compField(c, prop).def

/** 改一项：等于默认值时删掉，部件下没有改过的项时整个部件也删掉 */
export function setCompValue(s: ComponentStyle, c: CompName, prop: string, v: CompValue | undefined): ComponentStyle {
  const next = { ...s[c] }
  if (v === undefined || v === compField(c, prop).def) delete next[prop]
  else next[prop] = v
  const out = { ...s }
  if (Object.keys(next).length) out[c] = next
  else delete out[c]
  return out
}

/** CSS 变量名：--c-button-radius、--c-summary-bar */
export const compVarName = (c: CompName, prop: string) => `--c-${c}-${prop}`

/** 一项换成 CSS 值；自定义颜色按当前是深色还是浅色取 */
export function compCssValue(f: CompField, v: CompValue, dark = false): string {
  if (typeof v === 'object') return dark ? v.dark : v.light
  if (f.kind === 'px') return `${v}px`
  if (f.kind === 'bool') return v ? f.on : f.off
  return f.options[v as string] ?? f.options[f.def]
}

/** 改过的项生成一段 :root 覆盖，自定义颜色的深色值再写一份 :root.dark；没改过就是空串 */
export function componentCss(s: ComponentStyle): string {
  const light: string[] = []
  const dark: string[] = []
  for (const c of COMP_NAMES)
    for (const [prop, v] of Object.entries(s[c] ?? {})) {
      const f = compField(c, prop)
      if (!f) continue
      light.push(`${compVarName(c, prop)}:${compCssValue(f, v)}`)
      if (typeof v === 'object') dark.push(`${compVarName(c, prop)}:${compCssValue(f, v, true)}`)
    }
  return (light.length ? `:root{${light.join(';')}}` : '') + (dark.length ? `:root.dark{${dark.join(';')}}` : '')
}

/** 默认值对应的变量，测试拿来和 index.css 对照 */
export function componentDefaultVars(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of COMP_NAMES)
    for (const [prop, f] of Object.entries(COMP_SPEC[c] as Record<string, CompField>))
      out[compVarName(c, prop)] = compCssValue(f, f.def)
  return out
}
