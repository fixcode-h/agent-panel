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
const BORDER = bool(true, '1px', '0px')

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
    kindRadius: px(6, 0, 12),
  },
  card: {
    radius: px(12, 0, 24),
    bg: color('card'),
    shadow: bool(true, 'var(--shadow-card)', 'none'),
    border: bool(false, '1px', '0px'),
  },
  button: { radius: px(8, 0, 18), weight: pick('500', WEIGHT) },
  iconButton: { radius: px(6, 0, 14) },
  statusPill: { radius: px(12, 0, 12), weight: pick('500', WEIGHT) },
  badge: { radius: px(12, 0, 12) },
  kbd: { radius: px(4, 0, 9), bg: color('sel') },
  progress: { height: px(6, 2, 12), radius: px(12, 0, 12), track: color('default', { default: tint(14), ...BG }) },
  input: {
    radius: px(8, 0, 16),
    border: BORDER,
    bg: color('field'),
    ring: bool(true, '6px', '0px'),
  },
  checkbox: { radius: px(4, 0, 9) },
  switch: { on: pick('primary', { primary: 'var(--primary)', accent: 'var(--accent)', success: 'var(--success)' }) },
  segmented: { radius: px(8, 0, 16), itemRadius: px(6, 0, 14) },
  chip: { radius: px(6, 0, 12), ring: bool(true, '1px', '0px') },
  row: { radius: px(8, 0, 16), bg: color('default', { default: tint(3.5), ...BG }) },
  nav: { radius: px(8, 0, 16) },
  menu: { radius: px(10, 0, 20), itemRadius: px(6, 0, 14), bg: color('pop'), border: BORDER },
  // 弹窗照 Claude Code 网页版的方案弹窗：圆角 8、深色下比页面亮一档的窗口色（--window）
  modal: { radius: px(8, 0, 28), bg: color('window', { window: 'var(--window)', ...BG }), border: BORDER },
  sheet: { radius: px(12, 0, 24), bg: color('bg') },
  popover: { radius: px(12, 0, 24), bg: color('pop') },
  empty: {
    radius: px(12, 0, 24),
    bg: color('none'),
    border: pick('dashed', { dashed: 'dashed', solid: 'solid', none: 'none' }),
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
