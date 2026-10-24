import { z } from 'zod'

/**
 * UI 动画：参照 UE5 UMG 的 Widget Animation——一个动画有名字，里面是若干条轨道（某个控件的某个属性），
 * 轨道上是关键帧（时间、值、到下一帧的缓动）。游戏 UI 和网页 UI 共用这一套：
 * - 游戏 UI 导出成 UMG 的动画数据（见 docs/umg-export.md），在 UE 里生成 WidgetAnimation；
 * - 网页 UI 导出成浏览器自带的 Web Animations（element.animate），不依赖任何动画库；
 * - 面板里的预览、运行模式也用 Web Animations，看到的就是导出后的样子。
 *
 * 属性只取 UE 的 RenderOpacity 和 RenderTransform（位移、缩放、旋转）：这几个不影响布局、GPU 合成，
 * 在 UE 和浏览器里表现一致，也是界面动效里最常用的。
 * 常用的效果写成预设（淡入、弹出、呼吸、浮动……），AI 和用户一句话就能加上，不用一帧帧写。
 */

export const ANIM_PROPS = ['RenderOpacity', 'Translation', 'Scale', 'Angle'] as const
export type AnimProp = (typeof ANIM_PROPS)[number]
/** 值是二维的属性（X、Y） */
export const isVecProp = (p: AnimProp) => p === 'Translation' || p === 'Scale'
export const ANIM_PROP_LABEL: Record<AnimProp, string> = {
  RenderOpacity: '不透明度',
  Translation: '位移',
  Scale: '缩放',
  Angle: '旋转',
}
/** 属性的初始值（控件不动时的样子） */
export const propRest = (p: AnimProp): AnimValue =>
  p === 'Scale' ? { X: 1, Y: 1 } : p === 'Translation' ? { X: 0, Y: 0 } : p === 'RenderOpacity' ? 1 : 0

/** 属性面板里能打关键帧的字段（和 UE Details 里的属性名一致）：只有这几项对应动画属性 */
export const ANIM_FIELD: Record<string, AnimProp> = {
  RenderOpacity: 'RenderOpacity',
  'RenderTransform.Translation': 'Translation',
  'RenderTransform.Scale': 'Scale',
  'RenderTransform.Angle': 'Angle',
}
/** 属性面板的字段路径 → 动画属性；不是可动画的属性返回 undefined（不加关键帧按钮） */
export const animPropOfField = (path: string): AnimProp | undefined => ANIM_FIELD[path]

/** 关键帧时间的比较精度：属性面板和播放头的时间精确到 0.01 秒 */
export const KEY_EPS = 0.001
const keyTime = (t: number) => Math.round(Math.max(0, Math.min(120, t)) * 1000) / 1000

/** 控件某个属性在动画里的轨道 */
export function trackOf(anim: Pick<UiAnimation, 'tracks'> | undefined, widget: string, prop: AnimProp) {
  return anim?.tracks.find((t) => t.widget === widget && t.prop === prop)
}

/** 关键帧按钮的状态：没有动画、还没有这条轨道、有轨道但当前时间没有关键帧、当前时间已有关键帧 */
export type AnimKeyState = 'no-anim' | 'no-track' | 'no-key' | 'key'
export function animKeyState(anim: UiAnimation | undefined, widget: string, prop: AnimProp, t: number): AnimKeyState {
  if (!anim) return 'no-anim'
  const tr = trackOf(anim, widget, prop)
  if (!tr) return 'no-track'
  return tr.keys.some((k) => Math.abs(k.t - t) <= KEY_EPS) ? 'key' : 'no-key'
}

/** 属性面板里的值 → 动画值：向量缺一个轴用初始值补，数字不是数就用初始值 */
export function animValueOf(prop: AnimProp, raw: unknown): AnimValue {
  if (!isVecProp(prop)) {
    const n = Number(raw)
    return Number.isFinite(n) ? n : propRest(prop)
  }
  const rest = propRest(prop) as { X: number; Y: number }
  const o = (raw ?? {}) as { X?: unknown; Y?: unknown }
  const x = Number(o.X)
  const y = Number(o.Y)
  return { X: Number.isFinite(x) ? x : rest.X, Y: Number.isFinite(y) ? y : rest.Y }
}

/**
 * 在某个时间给控件的属性打一个关键帧（UE 里点属性左边的菱形按钮）：
 * 还没有轨道就新建，当前时间已有关键帧就更新值（保留原来的缓动），不重复插。
 */
export function setKeyAt(anim: UiAnimation, widget: string, prop: AnimProp, t: number, v: AnimValue): UiAnimation {
  const at = keyTime(t)
  const tr = trackOf(anim, widget, prop)
  if (!tr) return { ...anim, tracks: [...anim.tracks, { widget, prop, keys: [{ t: at, v, ease: 'ease-out' }] }] }
  const old = tr.keys.find((k) => Math.abs(k.t - at) <= KEY_EPS)
  const keys = [
    ...tr.keys.filter((k) => Math.abs(k.t - at) > KEY_EPS),
    { t: at, v, ease: old?.ease ?? ('ease-out' as Ease) },
  ].sort((a, b) => a.t - b.t)
  return { ...anim, tracks: anim.tracks.map((x) => (x === tr ? { ...x, keys } : x)) }
}

export const EASES = [
  'linear',
  'constant',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'back-in',
  'back-out',
  'elastic-out',
  'bounce-out',
] as const
export type Ease = (typeof EASES)[number]
export const EASE_LABEL: Record<Ease, string> = {
  linear: '线性',
  constant: '跳变（不过渡）',
  ease: '平滑',
  'ease-in': '缓入（先慢后快）',
  'ease-out': '缓出（先快后慢）',
  'ease-in-out': '缓入缓出',
  'back-in': '回拉后加速',
  'back-out': '冲过头再回弹',
  'elastic-out': '弹簧',
  'bounce-out': '落地弹跳',
}

/**
 * 触发方式：show 打开时（UE 的 Construct，网页载入时）、hover 鼠标移上去播放、移开倒着播回去、
 * click 点击时、scroll 滚动到能看见时（网页）、manual 由程序调用（UE 蓝图里 PlayAnimation，例如关闭面板、获得奖励）
 */
export const ANIM_TRIGGERS = ['show', 'hover', 'click', 'scroll', 'manual'] as const
export type AnimTrigger = (typeof ANIM_TRIGGERS)[number]
export const TRIGGER_LABEL: Record<AnimTrigger, string> = {
  show: '打开时',
  hover: '鼠标悬停',
  click: '点击时',
  scroll: '滚动到可见时',
  manual: '程序调用',
}

const Vec = z.object({ X: z.number(), Y: z.number() })
export const AnimValue = z.union([z.number(), Vec])
export type AnimValue = z.infer<typeof AnimValue>

export const AnimKey = z.object({
  /** 时间（秒） */
  t: z.number().min(0).max(120),
  v: AnimValue,
  /** 从这一帧到下一帧怎么过渡 */
  ease: z.enum(EASES).catch('ease-out').default('ease-out'),
})
export type AnimKey = z.infer<typeof AnimKey>

export const AnimTrack = z.object({
  /** 控件名（同一棵树里） */
  widget: z.string().min(1),
  prop: z.enum(ANIM_PROPS),
  keys: z.array(AnimKey).min(1).max(200),
})
export type AnimTrack = z.infer<typeof AnimTrack>

export const ANIM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const UiAnimation = z.object({
  /** 动画名（英文，UE 里的 WidgetAnimation 名，例如 Anim_Open） */
  name: z.string().regex(ANIM_NAME),
  /** 属于哪棵树：空是主界面，否则是子控件名（UE 里每个 Widget Blueprint 有自己的动画） */
  in: z.string().default(''),
  trigger: z.enum(ANIM_TRIGGERS).catch('show').default('show'),
  /** hover、click 由哪个控件触发；不写就是第一条轨道的控件 */
  source: z.string().default(''),
  /** 播放几遍，0 是一直循环 */
  loop: z.number().int().min(0).max(1000).default(1),
  /** 来回播放（播完倒着播回去，再算一遍） */
  pingPong: z.boolean().default(false),
  /** 开始前等多久（秒） */
  delay: z.number().min(0).max(60).default(0),
  tracks: z.array(AnimTrack).max(200).default([]),
})
export type UiAnimation = z.infer<typeof UiAnimation>

/** 动画的长度（秒）：最后一个关键帧的时间 */
export const animLength = (a: Pick<UiAnimation, 'tracks'>) =>
  Math.max(0, ...a.tracks.flatMap((tr) => tr.keys.map((k) => k.t)))

// ---- 缓动 ----

const PI2 = (2 * Math.PI) / 3
function bounceOut(x: number) {
  const n = 7.5625
  const d = 2.75
  if (x < 1 / d) return n * x * x
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375
  return n * (x -= 2.625 / d) * x + 0.984375
}
/** 三次贝塞尔（和 CSS 的 cubic-bezier 一样） */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const f = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  return (x: number) => {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2
      if (f(x1, x2, m) < x) lo = m
      else hi = m
    }
    return f(y1, y2, (lo + hi) / 2)
  }
}
const BEZIER: Partial<Record<Ease, [number, number, number, number]>> = {
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.32, 0, 0.67, 0],
  'ease-out': [0.33, 1, 0.68, 1],
  'ease-in-out': [0.65, 0, 0.35, 1],
  'back-in': [0.36, 0, 0.66, -0.56],
  'back-out': [0.34, 1.56, 0.64, 1],
}
const FN = new Map<Ease, (x: number) => number>()
/** 缓动函数：0~1 → 0~1（回弹类会超出） */
export function easeFn(e: Ease): (x: number) => number {
  const hit = FN.get(e)
  if (hit) return hit
  const b = BEZIER[e]
  const f =
    e === 'linear'
      ? (x: number) => x
      : e === 'constant'
        ? (x: number) => (x >= 1 ? 1 : 0)
        : e === 'elastic-out'
          ? (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * PI2) + 1)
          : e === 'bounce-out'
            ? bounceOut
            : b
              ? bezier(...b)
              : (x: number) => x
  FN.set(e, f)
  return f
}

/** CSS / Web Animations 的写法：贝塞尔直接写，弹簧和弹跳用 linear() 按曲线取点 */
export function cssEase(e: Ease) {
  if (e === 'linear') return 'linear'
  if (e === 'constant') return 'steps(1, end)'
  const b = BEZIER[e]
  if (b) return `cubic-bezier(${b.join(', ')})`
  const f = easeFn(e)
  const n = 40
  return `linear(${Array.from({ length: n + 1 }, (_, i) => +f(i / n).toFixed(4)).join(', ')})`
}

// ---- 取值 ----

const vec = (v: AnimValue): { X: number; Y: number } => (typeof v === 'number' ? { X: v, Y: v } : v)
const lerp = (a: number, b: number, k: number) => a + (b - a) * k

/** 轨道在某个时间（秒）的值：第一帧之前用第一帧，最后一帧之后用最后一帧 */
export function sampleTrack(tr: Pick<AnimTrack, 'prop' | 'keys'>, t: number): AnimValue {
  const keys = [...tr.keys].sort((a, b) => a.t - b.t)
  if (!keys.length) return propRest(tr.prop)
  if (t <= keys[0].t) return keys[0].v
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (t > b.t) continue
    const k = b.t > a.t ? easeFn(a.ease)((t - a.t) / (b.t - a.t)) : 1
    if (!isVecProp(tr.prop)) return lerp(Number(a.v), Number(b.v), k)
    const va = vec(a.v)
    const vb = vec(b.v)
    return { X: lerp(va.X, vb.X, k), Y: lerp(va.Y, vb.Y, k) }
  }
  return keys.at(-1)!.v
}

/** 一个值在 Web Animations 里的写法：用 CSS 的单独变换属性（translate、scale、rotate），互相不覆盖，也不覆盖控件本身的变换 */
export function cssProp(prop: AnimProp, v: AnimValue): [string, string | number] {
  const r = (n: number) => +n.toFixed(4)
  if (prop === 'RenderOpacity') return ['opacity', r(Number(v))]
  if (prop === 'Angle') return ['rotate', `${r(Number(v))}deg`]
  const p = vec(v)
  return prop === 'Translation' ? ['translate', `${r(p.X)}px ${r(p.Y)}px`] : ['scale', `${r(p.X)} ${r(p.Y)}`]
}

// ---- 预设 ----

/** 预设的参数：distance 是位移类的距离（像素），strength 是缩放、旋转类的幅度（倍数，1 为默认） */
interface PresetOpts {
  duration: number
  distance: number
  strength: number
}
type PresetTrack = { prop: AnimProp; keys: AnimKey[] }
interface Preset {
  label: string
  group: 'enter' | 'exit' | 'emphasis' | 'loop' | 'hover'
  /** 默认时长（秒） */
  duration: number
  /** 适合的触发方式和循环 */
  trigger?: AnimTrigger
  loop?: number
  tracks: (o: PresetOpts) => PresetTrack[]
}
const K = (t: number, v: AnimValue, ease: Ease = 'ease-out'): AnimKey => ({ t, v, ease })
const fade = (d: number, from: number, to: number, ease: Ease = 'ease-out'): PresetTrack => ({
  prop: 'RenderOpacity',
  keys: [K(0, from, ease), K(d, to)],
})
const move = (d: number, from: [number, number], to: [number, number], ease: Ease = 'ease-out'): PresetTrack => ({
  prop: 'Translation',
  keys: [K(0, { X: from[0], Y: from[1] }, ease), K(d, { X: to[0], Y: to[1] })],
})
const scale = (d: number, from: number, to: number, ease: Ease = 'ease-out'): PresetTrack => ({
  prop: 'Scale',
  keys: [K(0, { X: from, Y: from }, ease), K(d, { X: to, Y: to })],
})
/** 在 0 和峰值之间来回（循环、强调类）：keys 是 [时间比例, 值] */
const wave = (prop: AnimProp, d: number, points: [number, AnimValue][], ease: Ease = 'ease-in-out'): PresetTrack => ({
  prop,
  keys: points.map(([f, v]) => K(+(f * d).toFixed(3), v, ease)),
})
const s = (n: number) => ({ X: n, Y: n })

/** 名字和 Animate.css 的常用效果对应，网页和游戏都能用 */
export const ANIM_PRESETS: Record<string, Preset> = {
  'fade-in': { label: '淡入', group: 'enter', duration: 0.4, tracks: (o) => [fade(o.duration, 0, 1)] },
  'fade-in-up': {
    label: '上浮淡入',
    group: 'enter',
    duration: 0.5,
    tracks: (o) => [fade(o.duration, 0, 1), move(o.duration, [0, o.distance], [0, 0])],
  },
  'fade-in-down': {
    label: '下落淡入',
    group: 'enter',
    duration: 0.5,
    tracks: (o) => [fade(o.duration, 0, 1), move(o.duration, [0, -o.distance], [0, 0])],
  },
  'fade-in-left': {
    label: '从左淡入',
    group: 'enter',
    duration: 0.5,
    tracks: (o) => [fade(o.duration, 0, 1), move(o.duration, [-o.distance, 0], [0, 0])],
  },
  'fade-in-right': {
    label: '从右淡入',
    group: 'enter',
    duration: 0.5,
    tracks: (o) => [fade(o.duration, 0, 1), move(o.duration, [o.distance, 0], [0, 0])],
  },
  'slide-in-up': {
    label: '从下滑入',
    group: 'enter',
    duration: 0.45,
    tracks: (o) => [move(o.duration, [0, o.distance * 4], [0, 0], 'ease-out')],
  },
  'zoom-in': {
    label: '放大出现',
    group: 'enter',
    duration: 0.35,
    tracks: (o) => [fade(o.duration * 0.6, 0, 1), scale(o.duration, 1 - 0.3 * o.strength, 1)],
  },
  'pop-in': {
    label: '弹出（弹窗）',
    group: 'enter',
    duration: 0.45,
    tracks: (o) => [fade(o.duration * 0.4, 0, 1), scale(o.duration, 1 - 0.4 * o.strength, 1, 'back-out')],
  },
  'bounce-in': {
    label: '弹簧出现',
    group: 'enter',
    duration: 0.8,
    tracks: (o) => [fade(o.duration * 0.25, 0, 1), scale(o.duration, 1 - 0.7 * o.strength, 1, 'elastic-out')],
  },
  'drop-in': {
    label: '掉落弹跳',
    group: 'enter',
    duration: 0.7,
    tracks: (o) => [fade(o.duration * 0.2, 0, 1), move(o.duration, [0, -o.distance * 4], [0, 0], 'bounce-out')],
  },
  'rotate-in': {
    label: '旋转出现',
    group: 'enter',
    duration: 0.5,
    tracks: (o) => [
      fade(o.duration, 0, 1),
      { prop: 'Angle', keys: [K(0, -90 * o.strength, 'back-out'), K(o.duration, 0)] },
      scale(o.duration, 0.6, 1),
    ],
  },
  'fade-out': {
    label: '淡出',
    group: 'exit',
    duration: 0.3,
    trigger: 'manual',
    tracks: (o) => [fade(o.duration, 1, 0, 'ease-in')],
  },
  'fade-out-down': {
    label: '下沉淡出',
    group: 'exit',
    duration: 0.35,
    trigger: 'manual',
    tracks: (o) => [fade(o.duration, 1, 0, 'ease-in'), move(o.duration, [0, 0], [0, o.distance], 'ease-in')],
  },
  'zoom-out': {
    label: '缩小消失',
    group: 'exit',
    duration: 0.3,
    trigger: 'manual',
    tracks: (o) => [fade(o.duration, 1, 0, 'ease-in'), scale(o.duration, 1, 1 - 0.3 * o.strength, 'back-in')],
  },
  pulse: {
    label: '脉冲',
    group: 'emphasis',
    duration: 0.6,
    tracks: (o) => [
      wave('Scale', o.duration, [
        [0, s(1)],
        [0.5, s(1 + 0.08 * o.strength)],
        [1, s(1)],
      ]),
    ],
  },
  shake: {
    label: '抖动（出错）',
    group: 'emphasis',
    duration: 0.5,
    trigger: 'manual',
    tracks: (o) => {
      const d = o.distance / 2
      return [
        wave(
          'Translation',
          o.duration,
          [0, -1, 1, -1, 1, -0.5, 0].map((x, i, a) => [i / (a.length - 1), { X: x * d, Y: 0 }]),
          'ease-in-out',
        ),
      ]
    },
  },
  wobble: {
    label: '摇摆',
    group: 'emphasis',
    duration: 0.8,
    tracks: (o) => [
      wave(
        'Angle',
        o.duration,
        [0, -8, 6, -4, 2, 0].map((x, i, a) => [i / (a.length - 1), x * o.strength]),
      ),
    ],
  },
  flash: {
    label: '闪烁',
    group: 'emphasis',
    duration: 0.8,
    tracks: (o) => [
      wave('RenderOpacity', o.duration, [
        [0, 1],
        [0.25, 0.1],
        [0.5, 1],
        [0.75, 0.1],
        [1, 1],
      ]),
    ],
  },
  'heart-beat': {
    label: '心跳',
    group: 'emphasis',
    duration: 1,
    tracks: (o) => {
      const k = 0.15 * o.strength
      return [
        wave('Scale', o.duration, [
          [0, s(1)],
          [0.14, s(1 + k)],
          [0.28, s(1)],
          [0.42, s(1 + k)],
          [0.7, s(1)],
          [1, s(1)],
        ]),
      ]
    },
  },
  jelly: {
    label: '果冻',
    group: 'emphasis',
    duration: 0.8,
    tracks: (o) => {
      const k = o.strength
      const p = (x: number, y: number) => ({ X: 1 + x * k, Y: 1 + y * k })
      return [
        wave('Scale', o.duration, [
          [0, p(0, 0)],
          [0.3, p(0.25, -0.25)],
          [0.4, p(-0.25, 0.25)],
          [0.5, p(0.15, -0.15)],
          [0.65, p(-0.05, 0.05)],
          [0.75, p(0.05, -0.05)],
          [1, p(0, 0)],
        ]),
      ]
    },
  },
  breathe: {
    label: '呼吸（发光、提示）',
    group: 'loop',
    duration: 2,
    loop: 0,
    tracks: (o) => [
      wave('RenderOpacity', o.duration, [
        [0, 1],
        [0.5, Math.max(0, 1 - 0.6 * o.strength)],
        [1, 1],
      ]),
    ],
  },
  float: {
    label: '上下浮动',
    group: 'loop',
    duration: 2.4,
    loop: 0,
    tracks: (o) => [
      wave('Translation', o.duration, [
        [0, { X: 0, Y: 0 }],
        [0.5, { X: 0, Y: -o.distance / 3 }],
        [1, { X: 0, Y: 0 }],
      ]),
    ],
  },
  'pulse-loop': {
    label: '持续脉冲',
    group: 'loop',
    duration: 1.2,
    loop: 0,
    tracks: (o) => [
      wave('Scale', o.duration, [
        [0, s(1)],
        [0.5, s(1 + 0.06 * o.strength)],
        [1, s(1)],
      ]),
    ],
  },
  spin: {
    label: '旋转（加载）',
    group: 'loop',
    duration: 1.2,
    loop: 0,
    tracks: (o) => [{ prop: 'Angle', keys: [K(0, 0, 'linear'), K(o.duration, 360)] }],
  },
  'hover-lift': {
    label: '悬停上浮',
    group: 'hover',
    duration: 0.18,
    trigger: 'hover',
    tracks: (o) => [move(o.duration, [0, 0], [0, -o.distance / 5]), scale(o.duration, 1, 1 + 0.03 * o.strength)],
  },
  'hover-grow': {
    label: '悬停放大',
    group: 'hover',
    duration: 0.15,
    trigger: 'hover',
    tracks: (o) => [scale(o.duration, 1, 1 + 0.06 * o.strength)],
  },
  'hover-tilt': {
    label: '悬停微倾',
    group: 'hover',
    duration: 0.2,
    trigger: 'hover',
    tracks: (o) => [{ prop: 'Angle', keys: [K(0, 0), K(o.duration, -3 * o.strength)] }, scale(o.duration, 1, 1.04)],
  },
  press: {
    label: '按下回弹',
    group: 'hover',
    duration: 0.25,
    trigger: 'click',
    tracks: (o) => [
      wave(
        'Scale',
        o.duration,
        [
          [0, s(1)],
          [0.35, s(1 - 0.08 * o.strength)],
          [1, s(1)],
        ],
        'ease-out',
      ),
    ],
  },
}
export type PresetName = keyof typeof ANIM_PRESETS
export const PRESET_GROUP_LABEL: Record<Preset['group'], string> = {
  enter: '入场',
  exit: '退场',
  emphasis: '强调',
  loop: '循环',
  hover: '交互反馈',
}

/** 给 AI 的预设清单：一行一组 */
export function presetCatalogText() {
  return (Object.keys(PRESET_GROUP_LABEL) as Preset['group'][])
    .map(
      (g) =>
        `${PRESET_GROUP_LABEL[g]}：${Object.entries(ANIM_PRESETS)
          .filter(([, p]) => p.group === g)
          .map(([k, p]) => `${k}（${p.label}）`)
          .join('、')}`,
    )
    .join('\n')
}

export interface PresetUse {
  preset: string
  /** 用在哪些控件上：多个时按 stagger 依次错开（列表、卡片一个接一个出现） */
  widgets: string[]
  /** 从第几秒开始 */
  at?: number
  duration?: number
  stagger?: number
  distance?: number
  strength?: number
}

/** 把预设展开成轨道：每个控件一组，按 stagger 错开；同一个控件同一个属性只留一条 */
export function presetTracks(use: PresetUse): { tracks: AnimTrack[]; error?: string } {
  const p = ANIM_PRESETS[use.preset]
  if (!p) return { tracks: [], error: `没有预设 ${use.preset}，可用的：${Object.keys(ANIM_PRESETS).join('、')}` }
  const o: PresetOpts = {
    duration: Math.max(0.05, Math.min(30, Number(use.duration) || p.duration)),
    distance: Number.isFinite(Number(use.distance)) && use.distance !== undefined ? Number(use.distance) : 40,
    strength: Number(use.strength) > 0 ? Number(use.strength) : 1,
  }
  const at = Math.max(0, Number(use.at) || 0)
  const stagger = Math.max(0, Number(use.stagger) || 0)
  const tracks: AnimTrack[] = []
  use.widgets.forEach((widget, i) => {
    const off = +(at + i * stagger).toFixed(3)
    for (const tr of p.tracks(o)) {
      // 错开时前面补一帧，开始前保持第一帧的样子（例如还没轮到的卡片先是透明的）
      const keys = tr.keys.map((k) => ({ ...k, t: +(k.t + off).toFixed(3) }))
      if (off > 0) keys.unshift({ ...tr.keys[0], t: 0, ease: 'constant' })
      tracks.push({ widget, prop: tr.prop, keys })
    }
  })
  return { tracks }
}
export const presetDefaults = (name: string) => {
  const p = ANIM_PRESETS[name]
  return p ? { trigger: p.trigger ?? 'show', loop: p.loop ?? 1 } : { trigger: 'show' as const, loop: 1 }
}

// ---- AI 写的动画：宽松地认 ----

const PROP_ALIAS: Record<string, AnimProp> = {
  renderopacity: 'RenderOpacity',
  opacity: 'RenderOpacity',
  alpha: 'RenderOpacity',
  translation: 'Translation',
  translate: 'Translation',
  position: 'Translation',
  offset: 'Translation',
  move: 'Translation',
  scale: 'Scale',
  angle: 'Angle',
  rotate: 'Angle',
  rotation: 'Angle',
}
const num = (v: unknown) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
function looseValue(prop: AnimProp, v: any): AnimValue | undefined {
  if (!isVecProp(prop)) return num(Array.isArray(v) ? v[0] : (v?.X ?? v?.x ?? v))
  if (typeof v === 'number' || typeof v === 'string') {
    const n = num(v)
    // 缩放写一个数是等比；位移写一个数当作竖直方向（最常见的上浮、下落）
    return n === undefined ? undefined : prop === 'Scale' ? { X: n, Y: n } : { X: 0, Y: n }
  }
  const x = num(Array.isArray(v) ? v[0] : (v?.X ?? v?.x))
  const y = num(Array.isArray(v) ? v[1] : (v?.Y ?? v?.y))
  if (x === undefined && y === undefined) return undefined
  const rest = propRest(prop) as { X: number; Y: number }
  return { X: x ?? rest.X, Y: y ?? rest.Y }
}

/** AI 写的一个动画（可以写 tracks，也可以用 presets 展开），整理成标准格式；有错时返回错误 */
export function looseAnimation(raw: any): { animation: UiAnimation } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: '动画要写成对象' }
  const name = String(raw.name ?? raw.Name ?? '')
  if (!ANIM_NAME.test(name)) return { error: `动画名要用英文、数字和下划线（例如 Anim_Open）：${name || '（空）'}` }
  const tracks: AnimTrack[] = []
  const errors: string[] = []
  const add = (tr: AnimTrack) => {
    const i = tracks.findIndex((x) => x.widget === tr.widget && x.prop === tr.prop)
    if (i >= 0) tracks[i] = tr
    else tracks.push(tr)
  }
  for (const [i, t] of (Array.isArray(raw.tracks) ? raw.tracks : []).entries()) {
    const prop = PROP_ALIAS[String(t?.prop ?? t?.property ?? '').toLowerCase()]
    const widget = String(t?.widget ?? t?.target ?? '')
    if (!prop) {
      errors.push(`tracks[${i}] 的 prop 要是 ${ANIM_PROPS.join(' / ')} 之一`)
      continue
    }
    if (!widget) {
      errors.push(`tracks[${i}] 要写 widget（控件名）`)
      continue
    }
    const keys: AnimKey[] = []
    for (const k of Array.isArray(t?.keys) ? t.keys : []) {
      const time = num(k?.t ?? k?.time)
      const v = looseValue(prop, k?.v ?? k?.value)
      if (time === undefined || v === undefined) {
        errors.push(`tracks[${i}]（${widget} 的 ${prop}）的关键帧要写 t（秒）和 v`)
        break
      }
      const ease = (EASES as readonly string[]).includes(k?.ease) ? (k.ease as Ease) : 'ease-out'
      keys.push({ t: Math.max(0, Math.min(120, time)), v, ease })
    }
    if (!keys.length) {
      if (!errors.length) errors.push(`tracks[${i}]（${widget}）没有关键帧`)
      continue
    }
    add({ widget, prop, keys: keys.sort((a, b) => a.t - b.t) })
  }
  const presets = Array.isArray(raw.presets) ? raw.presets : raw.preset ? [raw] : []
  let trigger: AnimTrigger | undefined
  let loop: number | undefined
  for (const p of presets) {
    const widgets = (Array.isArray(p?.widgets) ? p.widgets : p?.widget ? [p.widget] : []).map(String)
    if (!widgets.length) {
      errors.push(`预设 ${p?.preset ?? ''} 要写 widgets（用在哪些控件上）`)
      continue
    }
    const r = presetTracks({ ...p, preset: String(p?.preset ?? ''), widgets })
    if (r.error) errors.push(r.error)
    r.tracks.forEach(add)
    const def = presetDefaults(String(p?.preset ?? ''))
    trigger ??= def.trigger
    loop ??= def.loop
  }
  if (errors.length) return { error: errors.join('；') }
  if (!tracks.length) return { error: `动画 ${name} 没有轨道：写 tracks 或 presets` }
  const p = UiAnimation.safeParse({
    name,
    in: String(raw.in ?? ''),
    trigger: raw.trigger ?? trigger ?? 'show',
    source: String(raw.source ?? ''),
    loop: Math.max(0, Math.round(num(raw.loop) ?? loop ?? 1)),
    pingPong: !!raw.pingPong,
    delay: Math.max(0, num(raw.delay) ?? 0),
    tracks,
  })
  if (!p.success) return { error: z.prettifyError(p.error) }
  return { animation: p.data }
}

/** 检查动画引用的控件都在：trees 是每棵树（'' 是主界面）里的控件名 */
export function checkAnimations(list: UiAnimation[], trees: Map<string, Set<string>>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const a of list) {
    const where = a.in ? `子控件 ${a.in} 的动画 ${a.name}` : `动画 ${a.name}`
    const key = `${a.in}/${a.name}`
    if (seen.has(key)) out.push(`${where} 重名了`)
    seen.add(key)
    const names = trees.get(a.in)
    if (!names) {
      out.push(`${where} 所在的子控件 ${a.in} 不存在`)
      continue
    }
    const missing = [...new Set(a.tracks.map((t) => t.widget).filter((w) => !names.has(w)))]
    if (missing.length) out.push(`${where} 的轨道用了不存在的控件：${missing.join('、')}`)
    if (a.source && !names.has(a.source)) out.push(`${where} 的触发控件 ${a.source} 不存在`)
  }
  return out
}

/** 控件改名：动画里的引用跟着改 */
export function renameInAnimations(list: UiAnimation[], tree: string, from: string, to: string) {
  if (from === to) return list
  let changed = false
  const next = list.map((a) => {
    if (a.in !== tree || !(a.source === from || a.tracks.some((t) => t.widget === from))) return a
    changed = true
    return {
      ...a,
      source: a.source === from ? to : a.source,
      tracks: a.tracks.map((t) => (t.widget === from ? { ...t, widget: to } : t)),
    }
  })
  return changed ? next : list
}

/** 给 AI 看的动画概况：一行一个，写清楚轨道 */
export function animationsBrief(list: UiAnimation[]) {
  return list.map((a) => ({
    name: a.name,
    ...(a.in ? { in: a.in } : {}),
    trigger: a.trigger,
    ...(a.source ? { source: a.source } : {}),
    ...(a.loop !== 1 ? { loop: a.loop } : {}),
    ...(a.pingPong ? { pingPong: true } : {}),
    ...(a.delay ? { delay: a.delay } : {}),
    length: animLength(a),
    tracks: a.tracks.map(
      (t) => `${t.widget}.${t.prop}：${t.keys.map((k) => `${k.t}s=${JSON.stringify(k.v)}`).join(' → ')}`,
    ),
  }))
}

// ---- 播放（面板预览、运行模式和导出的网页共用） ----

/** 编译好的动画：关键帧换成 Web Animations 的写法，时间用毫秒 */
export interface AnimRun {
  name: string
  in: string
  trigger: AnimTrigger
  source: string
  /** 0 是一直循环 */
  loop: number
  pingPong: boolean
  delay: number
  duration: number
  tracks: { key: string; keyframes: Keyframe[] }[]
}

/** 控件在页面上的标记（data-an）：主界面的控件是控件名，子控件里的是「子控件名/控件名」 */
export const animKey = (tree: string, widget: string) => (tree ? `${tree}/${widget}` : widget)

export function compileAnimations(list: UiAnimation[]): AnimRun[] {
  return list
    .filter((a) => a.tracks.length)
    .map((a) => {
      const len = Math.max(animLength(a), 0.001)
      return {
        name: a.name,
        in: a.in,
        trigger: a.trigger,
        source: animKey(a.in, a.source || a.tracks[0].widget),
        loop: a.loop,
        pingPong: a.pingPong,
        delay: Math.round(a.delay * 1000),
        duration: Math.round(len * 1000),
        tracks: a.tracks.map((tr) => {
          const keys = [...tr.keys].sort((x, y) => x.t - y.t)
          // 第一帧之前、最后一帧之后保持不动：补上 0 和结尾的帧
          if (keys[0].t > 0) keys.unshift({ ...keys[0], t: 0, ease: 'linear' })
          if (keys.at(-1)!.t < len) keys.push({ ...keys.at(-1)!, t: len })
          return {
            key: animKey(a.in, tr.widget),
            keyframes: keys.map((k) => {
              const [p, v] = cssProp(tr.prop, k.v)
              return { offset: Math.min(1, +(k.t / len).toFixed(5)), [p]: v, easing: cssEase(k.ease) }
            }),
          }
        }),
      }
    })
}

export interface AnimController {
  /** 播放一个动画；scope 是哪个子控件实例（不写就是全部），reverse 倒着播 */
  play: (name: string, o?: { scope?: Element; reverse?: boolean; tree?: string }) => void
  /** 停在某个时间（毫秒），时间轴拖动时用 */
  seek: (name: string, ms: number, tree?: string) => void
  /** 停下并回到原样 */
  stop: () => void
  dispose: () => void
}

/**
 * 在一块页面上播放动画（不依赖任何库，只用浏览器自带的 Web Animations）。
 * 导出的网页会把这个函数原样写进页面（animRuntimeSource），所以函数里不能用外面的变量和导入。
 * root 是画面的根元素；rootTree 是根上画的是哪棵树（主界面是空，编辑子控件时是子控件名）；
 * triggers 为 true 时按触发方式自动播放：打开时、滚动到可见时、悬停、点击。
 */
export function animRuntime(
  root: Element,
  runs: AnimRun[],
  o: { rootTree?: string; triggers?: boolean } = {},
): AnimController {
  const rootTree = o.rootTree || ''
  const live = new Map<string, Animation[]>()
  const cleanups: (() => void)[] = []
  const all = (el: Element, sel: string) => [...(el.matches(sel) ? [el] : []), ...el.querySelectorAll(sel)]
  const css = (s: string) => s.replace(/["\\]/g, '\\$&')
  const scopesOf = (r: AnimRun) => (r.in === rootTree ? [root] : all(root, `[data-ac~="${css(r.in)}"]`))
  // 子控件里的控件只在自己那个实例里找；主界面的不进子控件里找（名字可能重复）
  const targets = (scope: Element, key: string) => all(scope, `[data-an~="${css(key)}"]`)
  const ids = new WeakMap<Element, number>()
  let nextId = 1
  const idOf = (el: Element) => {
    let n = ids.get(el)
    if (!n) ids.set(el, (n = nextId++))
    return n
  }
  const make = (r: AnimRun, scope: Element, paused: boolean) => {
    const id = `${r.in}/${r.name}@${idOf(scope)}`
    for (const a of live.get(id) ?? []) a.cancel()
    const list: Animation[] = []
    for (const tr of r.tracks)
      for (const el of targets(scope, tr.key)) {
        const opts: KeyframeAnimationOptions = {
          duration: r.duration,
          delay: r.delay,
          iterations: r.loop === 0 ? Infinity : r.loop,
          direction: r.pingPong ? 'alternate' : 'normal',
          fill: 'both',
          easing: 'linear',
        }
        let a: Animation
        try {
          a = (el as HTMLElement).animate(tr.keyframes, opts)
        } catch {
          // 老浏览器不认 linear() 缓动：换成普通的缓出
          a = (el as HTMLElement).animate(
            tr.keyframes.map((k) => ({ ...k, easing: String(k.easing).startsWith('linear(') ? 'ease-out' : k.easing })),
            opts,
          )
        }
        if (paused) a.pause()
        list.push(a)
      }
    live.set(id, list)
    return list
  }
  const find = (name: string, tree?: string) =>
    runs.find((r) => r.name === name && (tree === undefined || r.in === tree))
  const ctl: AnimController = {
    play(name, p = {}) {
      const r = find(name, p.tree)
      if (!r) return
      for (const scope of p.scope ? [p.scope] : scopesOf(r)) {
        const id = `${r.in}/${r.name}@${idOf(scope)}`
        const cur = live.get(id)
        // 悬停移开时倒着播回去：接着当前的位置倒放，不跳
        if (cur?.length && (p.reverse || cur[0].playbackRate < 0)) {
          for (const a of cur) {
            if (p.reverse ? a.playbackRate > 0 : a.playbackRate < 0) a.reverse()
            else a.play()
          }
          continue
        }
        if (!p.reverse) make(r, scope, false)
      }
    },
    seek(name, ms, tree) {
      const r = find(name, tree)
      if (!r) return
      for (const scope of scopesOf(r)) {
        const id = `${r.in}/${r.name}@${idOf(scope)}`
        const list =
          live.get(id)?.length && live.get(id)![0].playState === 'paused' ? live.get(id)! : make(r, scope, true)
        for (const a of list) a.currentTime = ms + r.delay
      }
    },
    stop() {
      for (const l of live.values()) for (const a of l) a.cancel()
      live.clear()
    },
    dispose() {
      ctl.stop()
      for (const f of cleanups) f()
      cleanups.length = 0
    },
  }
  if (!o.triggers) return ctl
  for (const r of runs) {
    for (const scope of scopesOf(r)) {
      if (r.trigger === 'show') ctl.play(r.name, { scope, tree: r.in })
      else if (r.trigger === 'scroll') {
        // 先停在第一帧（例如还是透明的），滚动到能看见时再播
        const list = make(r, scope, true)
        const first = targets(scope, r.tracks[0]?.key ?? '')[0]
        if (!first || typeof IntersectionObserver === 'undefined') {
          for (const a of list) a.play()
          continue
        }
        const io = new IntersectionObserver(
          (es) => {
            if (!es.some((e) => e.isIntersecting)) return
            io.disconnect()
            for (const a of list) a.play()
          },
          { threshold: 0.15 },
        )
        io.observe(first)
        cleanups.push(() => io.disconnect())
      } else if (r.trigger === 'hover' || r.trigger === 'click') {
        for (const el of targets(scope, r.source)) {
          const on = (ev: string, fn: () => void) => {
            el.addEventListener(ev, fn)
            cleanups.push(() => el.removeEventListener(ev, fn))
          }
          if (r.trigger === 'hover') {
            on('pointerenter', () => ctl.play(r.name, { scope, tree: r.in }))
            on('pointerleave', () => ctl.play(r.name, { scope, tree: r.in, reverse: true }))
          } else on('click', () => ctl.play(r.name, { scope, tree: r.in }))
        }
      }
    }
  }
  return ctl
}

/** 导出的网页里用的播放代码：上面的函数原样写进去，页面载入后按触发方式播放；window.uiAnim.play('名字') 手动播放 */
export function animRuntimeSource(runs: AnimRun[]) {
  if (!runs.length) return ''
  return `(function () {
  var animRuntime = ${animRuntime.toString()};
  var runs = ${JSON.stringify(runs)};
  var start = function () { window.uiAnim = animRuntime(document.body, runs, { triggers: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`
}

// ---- 导出到 UE ----

/** UE 的关键帧插值：线性、跳变照搬，其他缓动按 30 帧取点（线性），保证和预览一样 */
export function ueTracks(a: UiAnimation) {
  const fps = 30
  return a.tracks.map((tr) => {
    const keys = [...tr.keys].sort((x, y) => x.t - y.t)
    const out: { Time: number; Value: AnimValue; Interp: 'Linear' | 'Constant' | 'Cubic' }[] = []
    keys.forEach((k, i) => {
      const next = keys[i + 1]
      const interp = k.ease === 'constant' ? 'Constant' : 'Linear'
      out.push({ Time: +k.t.toFixed(4), Value: k.v, Interp: interp })
      if (!next || k.ease === 'linear' || k.ease === 'constant') return
      const n = Math.max(1, Math.round((next.t - k.t) * fps))
      for (let j = 1; j < n; j++) {
        const t = k.t + ((next.t - k.t) * j) / n
        out.push({ Time: +t.toFixed(4), Value: sampleTrack({ prop: tr.prop, keys }, t), Interp: 'Linear' })
      }
    })
    const ue = tr.prop === 'RenderOpacity' ? 'RenderOpacity' : `RenderTransform.${tr.prop}`
    return {
      Widget: tr.widget,
      Property: ue,
      /** 原始的关键帧和缓动：导入工具想自己设切线时用 */
      Source: keys.map((k) => ({ Time: k.t, Value: k.v, Ease: k.ease })),
      Keys: out,
    }
  })
}

const TRIGGER_UE: Record<AnimTrigger, string> = {
  show: 'Construct',
  hover: 'Hover',
  click: 'Click',
  scroll: 'Construct',
  manual: 'Manual',
}
export function exportAnimations(list: UiAnimation[]) {
  return list.map((a) => ({
    Name: a.name,
    Length: +animLength(a).toFixed(4),
    Trigger: TRIGGER_UE[a.trigger],
    ...(a.trigger === 'hover' || a.trigger === 'click' ? { Source: a.source || a.tracks[0]?.widget || '' } : {}),
    NumLoops: a.loop,
    PlayMode: a.pingPong ? 'PingPong' : 'Forward',
    Delay: a.delay,
    Tracks: ueTracks(a),
  }))
}
