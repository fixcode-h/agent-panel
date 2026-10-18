import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Clapperboard, Diamond, Pause, Play, Plus, Sparkles, Trash2, X } from 'lucide-react'
import {
  ANIM_PRESETS,
  ANIM_PROPS,
  ANIM_TRIGGERS,
  EASES,
  animLength,
  isVecProp,
  presetDefaults,
  presetTracks,
  propRest,
  sampleTrack,
  type AnimKey,
  type AnimProp,
  type AnimTrack,
  type AnimTrigger,
  type AnimValue,
  type Ease,
  type UiAnimation,
} from '@shared/anim'
import { allNames, type Widget } from '@shared/umg'
import { cn } from '@/lib/utils'
import { Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { NumInput } from './fields'
import { t } from '@shared/i18n'

/** 时间轴发给画布的指令：停在某个时间（毫秒），或者从头播放 */
export interface AnimCommand {
  name: string
  tree: string
  ms: number
  play?: boolean
  nonce: number
}

/** 文案静态写出来，文案检查才认得 */
const propLabel = (p: AnimProp) =>
  ({ RenderOpacity: t('不透明度'), Translation: t('位移'), Scale: t('缩放'), Angle: t('旋转') })[p]
const triggerLabel = (x: AnimTrigger) =>
  ({
    show: t('打开时'),
    hover: t('鼠标悬停'),
    click: t('点击时'),
    scroll: t('滚动到可见时'),
    manual: t('程序调用'),
  })[x]
const easeLabel = (e: Ease) =>
  ({
    linear: t('线性'),
    constant: t('跳变（不过渡）'),
    ease: t('平滑'),
    'ease-in': t('缓入（先慢后快）'),
    'ease-out': t('缓出（先快后慢）'),
    'ease-in-out': t('缓入缓出'),
    'back-in': t('回拉后加速'),
    'back-out': t('冲过头再回弹'),
    'elastic-out': t('弹簧'),
    'bounce-out': t('落地弹跳'),
  })[e]
const groupLabel = (g: string) =>
  ({ enter: t('入场'), exit: t('退场'), emphasis: t('强调'), loop: t('循环'), hover: t('交互反馈') })[g] ?? g
const presetLabel = (k: string) =>
  ({
    'fade-in': t('淡入'),
    'fade-in-up': t('上浮淡入'),
    'fade-in-down': t('下落淡入'),
    'fade-in-left': t('从左淡入'),
    'fade-in-right': t('从右淡入'),
    'slide-in-up': t('从下滑入'),
    'zoom-in': t('放大出现'),
    'pop-in': t('弹出（弹窗）'),
    'bounce-in': t('弹簧出现'),
    'drop-in': t('掉落弹跳'),
    'rotate-in': t('旋转出现'),
    'fade-out': t('淡出'),
    'fade-out-down': t('下沉淡出'),
    'zoom-out': t('缩小消失'),
    pulse: t('脉冲'),
    shake: t('抖动（出错）'),
    wobble: t('摇摆'),
    flash: t('闪烁'),
    'heart-beat': t('心跳'),
    jelly: t('果冻'),
    breathe: t('呼吸（发光、提示）'),
    float: t('上下浮动'),
    'pulse-loop': t('持续脉冲'),
    spin: t('旋转（加载）'),
    'hover-lift': t('悬停上浮'),
    'hover-grow': t('悬停放大'),
    'hover-tilt': t('悬停微倾'),
    press: t('按下回弹'),
  })[k] ?? k

const fmt = (v: AnimValue) => (typeof v === 'number' ? String(+v.toFixed(2)) : `${+v.X.toFixed(2)}, ${+v.Y.toFixed(2)}`)
const round = (n: number) => Math.round(n * 100) / 100

/**
 * 动画面板：参照 UE 的 Animations + Timeline。上面一行选动画、设触发方式和循环，左边是轨道（控件 · 属性），
 * 右边是时间轴：拖播放头预览某一刻，点关键帧改值和缓动，拖动关键帧改时间，双击空白处加关键帧。
 * 常用效果从「预设」一键加到选中的控件上（多选时依次错开）。
 */
export function AnimationPanel({
  animations,
  tree,
  root,
  selectedNames,
  onChange,
  onCommand,
  onSelectWidget,
  onClose,
  web,
}: {
  animations: UiAnimation[]
  /** 正在编辑的树：主界面是空，子控件是子控件名 */
  tree: string
  root: Widget
  /** 画布上选中的控件名（多选时按点选的顺序） */
  selectedNames: string[]
  onChange: (list: UiAnimation[], key: string) => void
  onCommand: (c: AnimCommand | null) => void
  onSelectWidget: (name: string) => void
  onClose: () => void
  web: boolean
}) {
  const mine = animations.filter((a) => a.in === tree)
  const [cur, setCur] = useState(mine[0]?.name ?? '')
  const anim = mine.find((a) => a.name === cur) ?? mine[0]
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [sel, setSel] = useState<{ track: number; key: number } | null>(null)
  const names = useMemo(() => allNames(root), [root])
  const nonce = useRef(0)
  const len = anim ? animLength(anim) : 0
  // 时间轴的范围：比动画长一点，至少 1 秒
  const span = Math.max(1, Math.ceil((len + 0.25) * 4) / 4)

  useEffect(() => {
    if (anim && anim.name !== cur) setCur(anim.name)
  }, [anim, cur])
  // 关掉面板、换动画时画布回到原样
  useEffect(() => () => onCommand(null), [onCommand])

  const seek = (s: number) => {
    const v = Math.max(0, Math.min(span, round(s)))
    setTime(v)
    setPlaying(false)
    if (anim) onCommand({ name: anim.name, tree, ms: v * 1000, nonce: ++nonce.current })
  }
  // 改了动画（关键帧、轨道）后，画布停在当前时间重新显示
  const sig = anim ? JSON.stringify(anim) : ''
  useEffect(() => {
    if (!anim) return onCommand(null)
    if (!playing) onCommand({ name: anim.name, tree, ms: time * 1000, nonce: ++nonce.current })
    // 只在动画内容、树变化时重新定位；time 由 seek 自己发
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, tree])

  // 播放：画布按真实的时间播放（含缓动、循环），这里只让播放头跟着走
  useEffect(() => {
    if (!playing || !anim) return
    const start = performance.now()
    let raf = 0
    const tick = () => {
      const s = (performance.now() - start) / 1000 - anim.delay
      const total = (anim.loop === 0 ? Infinity : anim.loop) * len
      if (s >= total) {
        setTime(round(len))
        setPlaying(false)
        return
      }
      const k = len > 0 ? Math.max(0, s) % len : 0
      const back = anim.pingPong && Math.floor(Math.max(0, s) / Math.max(len, 0.001)) % 2 === 1
      setTime(round(back ? len - k : k))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, anim, len])

  const update = (fn: (a: UiAnimation) => UiAnimation, key = '') => {
    if (!anim) return
    const next = fn(anim)
    onChange(
      animations.map((a) => (a === anim ? next : a)),
      key ? `anim:${anim.name}:${key}` : '',
    )
  }
  const setTrack = (i: number, tr: AnimTrack | null, key = '') =>
    update(
      (a) => ({
        ...a,
        tracks: tr ? a.tracks.map((x, k) => (k === i ? tr : x)) : a.tracks.filter((_, k) => k !== i),
      }),
      key,
    )

  const create = (name?: string, base?: Partial<UiAnimation>) => {
    const taken = new Set(mine.map((a) => a.name))
    let n = name ?? 'Anim_New'
    for (let k = 2; taken.has(n); k++) n = `${name ?? 'Anim_New'}_${k}`
    const a: UiAnimation = {
      name: n,
      in: tree,
      trigger: 'show',
      source: '',
      loop: 1,
      pingPong: false,
      delay: 0,
      tracks: [],
      ...base,
    }
    onChange([...animations, a], '')
    setCur(n)
    setSel(null)
    setTime(0)
    return a
  }

  /** 预设：有当前动画时加进去（从播放头开始），没有时新建一个 */
  const applyPreset = (preset: string) => {
    const widgets = selectedNames.filter((n) => names.has(n))
    if (!widgets.length) return toast.error(t('先在画布或控件树上选中要加动画的控件（按住 Shift 可以多选）'))
    const r = presetTracks({
      preset,
      widgets,
      at: anim?.tracks.length ? time : 0,
      stagger: widgets.length > 1 ? 0.08 : 0,
    })
    if (r.error) return toast.error(r.error)
    const def = presetDefaults(preset)
    const merge = (list: AnimTrack[]) => [
      ...list.filter((x) => !r.tracks.some((y) => y.widget === x.widget && y.prop === x.prop)),
      ...r.tracks,
    ]
    if (!anim) {
      const name = `Anim_${preset.replace(/(^|-)(\w)/g, (_, _a, c: string) => c.toUpperCase())}`
      create(name, { trigger: def.trigger, loop: def.loop, tracks: r.tracks })
      return
    }
    update(
      (a) => ({
        ...a,
        tracks: merge(a.tracks),
        // 空动画套预设时，触发方式和循环用预设适合的
        ...(a.tracks.length ? {} : { trigger: def.trigger, loop: def.loop }),
      }),
      '',
    )
  }

  const addTrack = (prop: AnimProp) => {
    const widget = selectedNames.at(-1)
    if (!widget || !names.has(widget)) return toast.error(t('先选中一个控件'))
    if (!anim) {
      create(undefined, { tracks: [{ widget, prop, keys: [{ t: 0, v: propRest(prop), ease: 'ease-out' }] }] })
      return
    }
    if (anim.tracks.some((x) => x.widget === widget && x.prop === prop))
      return toast.error(t('{name} 已经有这条轨道了', { name: widget }))
    update((a) => ({
      ...a,
      tracks: [...a.tracks, { widget, prop, keys: [{ t: time, v: propRest(prop), ease: 'ease-out' }] }],
    }))
  }

  /** 在播放头的位置加一帧：值取这一刻的值（之后再改） */
  const addKey = (i: number, at = time) => {
    const tr = anim?.tracks[i]
    if (!tr) return
    const v = sampleTrack(tr, at)
    const keys = [...tr.keys.filter((k) => Math.abs(k.t - at) > 0.001), { t: round(at), v, ease: 'ease-out' as Ease }]
    keys.sort((a, b) => a.t - b.t)
    setTrack(i, { ...tr, keys })
    setSel({ track: i, key: keys.findIndex((k) => Math.abs(k.t - at) < 0.006) })
  }

  const setKey = (i: number, j: number, patch: Partial<AnimKey>, key = '') => {
    const tr = anim?.tracks[i]
    if (!tr) return
    const keys = tr.keys.map((k, n) => (n === j ? { ...k, ...patch } : k))
    // 改时间后按时间重新排，选中的跟着走
    const moved = keys[j]
    keys.sort((a, b) => a.t - b.t)
    setTrack(i, { ...tr, keys }, key)
    setSel({ track: i, key: keys.indexOf(moved) })
  }

  const lane = useRef<HTMLDivElement>(null)
  const timeAt = (clientX: number) => {
    const r = lane.current?.getBoundingClientRect()
    return r ? ((clientX - r.left) / r.width) * span : 0
  }
  const dragHead = (e: React.PointerEvent) => {
    e.preventDefault()
    seek(timeAt(e.clientX))
    const move = (ev: PointerEvent) => seek(timeAt(ev.clientX))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const dragKey = (e: React.PointerEvent, i: number, j: number) => {
    e.stopPropagation()
    e.preventDefault()
    setSel({ track: i, key: j })
    const tr = anim!.tracks[i]
    const k0 = tr.keys[j]
    const x0 = e.clientX
    const id = `drag:${i}:${j}:${Date.now()}`
    let cur = j
    const move = (ev: PointerEvent) => {
      const dt = timeAt(ev.clientX) - timeAt(x0)
      // 按住 Shift 对齐到 0.1 秒
      let tt = Math.max(0, k0.t + dt)
      tt = ev.shiftKey ? Math.round(tt * 10) / 10 : round(tt)
      const keys = tr.keys.map((k, n) => (n === j ? { ...k, t: tt } : k))
      const moved = keys[j]
      keys.sort((a, b) => a.t - b.t)
      cur = keys.indexOf(moved)
      setTrack(i, { ...tr, keys }, id)
      setSel({ track: i, key: cur })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const selTrack = sel && anim ? anim.tracks[sel.track] : undefined
  const selKey = selTrack ? selTrack.keys[sel!.key] : undefined
  const ticks = Array.from({ length: Math.round(span * 10) + 1 }, (_, i) => i / 10)
  const presetGroups = ['enter', 'exit', 'emphasis', 'loop', 'hover'] as const
  const triggers = ANIM_TRIGGERS.filter((x) => web || x !== 'scroll' || anim?.trigger === 'scroll')
  const icon =
    'grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-md text-subtle hover:bg-sel hover:text-fg'

  return (
    <section aria-label={t('动画')} className="flex h-[260px] shrink-0 flex-col border-t bg-card text-[12px]">
      <div className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b px-2">
        <Clapperboard className="ml-1 h-4 w-4 shrink-0 text-subtle" />
        {mine.length > 0 && anim ? (
          <Select
            aria-label={t('动画')}
            value={anim.name}
            onChange={(e) => {
              setCur(e.target.value)
              setSel(null)
              seek(0)
            }}
            options={mine.map((a) => ({ value: a.name, label: a.name }))}
            className="h-7 w-[150px] shrink-0 rounded-md px-2 text-[12px]"
          />
        ) : (
          <span className="shrink-0 text-subtle">{t('还没有动画')}</span>
        )}
        <button aria-label={t('新建动画')} title={t('新建动画')} className={icon} onClick={() => create()}>
          <Plus className="h-4 w-4" />
        </button>
        <Menu>
          <MenuTrigger asChild>
            <button className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-subtle hover:bg-sel hover:text-fg">
              <Sparkles className="h-3.5 w-3.5" />
              {t('预设')}
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <div className="max-h-[360px] overflow-y-auto">
              {presetGroups.map((g, gi) => (
                <div key={g}>
                  {gi > 0 && <MenuSeparator />}
                  <div className="px-2.5 pt-1.5 pb-1 text-[11px] text-subtle">{groupLabel(g)}</div>
                  {Object.entries(ANIM_PRESETS)
                    .filter(([, p]) => p.group === g)
                    .map(([k]) => (
                      <MenuItem key={k} onSelect={() => applyPreset(k)}>
                        {presetLabel(k)}
                      </MenuItem>
                    ))}
                </div>
              ))}
            </div>
          </MenuContent>
        </Menu>
        {anim && (
          <>
            <span className="mx-1 h-4 w-px shrink-0 bg-line" />
            <input
              aria-label={t('动画名')}
              defaultValue={anim.name}
              key={anim.name}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v === anim.name) return
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) || mine.some((a) => a.name === v)) {
                  e.target.value = anim.name
                  return toast.error(t('动画名要用英文、数字和下划线，并且不能重名'))
                }
                update((a) => ({ ...a, name: v }))
                setCur(v)
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              className="h-7 w-[120px] shrink-0 rounded-md border border-line bg-field px-1.5 font-mono text-[11.5px] outline-none focus:border-accent"
            />
            <Select
              aria-label={t('触发方式')}
              value={anim.trigger}
              onChange={(e) => update((a) => ({ ...a, trigger: e.target.value as AnimTrigger }))}
              options={triggers.map((x) => ({ value: x, label: triggerLabel(x) }))}
              className="h-7 w-[118px] shrink-0 rounded-md px-2 text-[12px]"
            />
            {(anim.trigger === 'hover' || anim.trigger === 'click') && (
              <Select
                aria-label={t('触发控件')}
                value={anim.source}
                placeholder={anim.tracks[0]?.widget ?? t('触发控件')}
                onChange={(e) => update((a) => ({ ...a, source: e.target.value }))}
                options={[
                  { value: '', label: t('第一条轨道的控件') },
                  ...[...names].map((n) => ({ value: n, label: n })),
                ]}
                className="h-7 w-[130px] shrink-0 rounded-md px-2 text-[12px]"
              />
            )}
            <span className="shrink-0 text-subtle" title={t('播放几遍，0 是一直循环')}>
              {t('循环')}
            </span>
            <div className="w-12 shrink-0">
              <NumInput
                label={t('循环')}
                value={anim.loop}
                min={0}
                max={1000}
                onChange={(v) => update((a) => ({ ...a, loop: Math.round(v) }))}
              />
            </div>
            <span className="shrink-0 text-subtle">{t('延迟')}</span>
            <div className="w-14 shrink-0">
              <NumInput
                label={t('延迟')}
                value={anim.delay}
                step={0.1}
                min={0}
                max={60}
                onChange={(v) => update((a) => ({ ...a, delay: v }))}
              />
            </div>
            <label className="flex shrink-0 items-center gap-1.5 text-subtle" title={t('播完倒着播回去')}>
              {t('来回')}
              <Switch checked={anim.pingPong} onCheckedChange={(v) => update((a) => ({ ...a, pingPong: v }))} />
            </label>
            <button
              aria-label={t('删除动画')}
              title={t('删除动画')}
              className={icon}
              onClick={() => {
                onChange(
                  animations.filter((a) => a !== anim),
                  '',
                )
                setSel(null)
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        <span className="flex-1" />
        {anim && (
          <>
            <button
              aria-label={playing ? t('停止') : t('播放')}
              title={playing ? t('停止') : t('播放')}
              disabled={!anim.tracks.length}
              onClick={() => {
                if (playing) return seek(time)
                setTime(0)
                setPlaying(true)
                onCommand({ name: anim.name, tree, ms: 0, play: true, nonce: ++nonce.current })
              }}
              className={cn(icon, 'text-fg disabled:cursor-default disabled:opacity-40')}
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </button>
            <span className="w-14 shrink-0 text-right font-mono text-[11.5px] text-subtle tabular-nums">
              {time.toFixed(2)}s
            </span>
          </>
        )}
        <button aria-label={t('关闭动画面板')} title={t('关闭动画面板')} className={icon} onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </div>

      {!anim ? (
        <div className="grid flex-1 place-items-center px-6 text-center text-[12.5px] leading-relaxed text-subtle">
          <div className="max-w-[460px]">
            <p className="mb-1 text-[13px] font-medium text-fg">
              {web ? t('给网页加上动效') : t('给界面加动画（UE 的 Widget Animation）')}
            </p>
            {t(
              '选中控件后点「预设」一键加上淡入、弹出、悬停反馈等效果；也可以新建动画自己加轨道和关键帧。也可以直接让 AI 加，例如「弹窗打开时弹出，奖励一个接一个出现」。',
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 轨道列表 */}
          <div className="flex w-[200px] shrink-0 flex-col border-r">
            <div className="flex h-7 shrink-0 items-center border-b px-2 text-[11px] text-subtle">{t('轨道')}</div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {anim.tracks.map((tr, i) => (
                <div
                  key={`${tr.widget}.${tr.prop}`}
                  className={cn(
                    'group flex h-7 items-center gap-1 border-b border-line/60 px-2',
                    sel?.track === i && 'bg-sel/60',
                  )}
                >
                  <button
                    onClick={() => onSelectWidget(tr.widget)}
                    title={t('在画布上选中 {name}', { name: tr.widget })}
                    className={cn(
                      'min-w-0 flex-1 cursor-pointer truncate text-left',
                      !names.has(tr.widget) && 'text-red-400 line-through',
                    )}
                  >
                    {tr.widget}
                    <span className="text-subtle"> · {propLabel(tr.prop)}</span>
                  </button>
                  <button
                    aria-label={t('在播放头加关键帧')}
                    title={t('在播放头加关键帧')}
                    onClick={() => addKey(i)}
                    className="grid h-5 w-5 cursor-pointer place-items-center rounded text-subtle opacity-0 group-hover:opacity-100 hover:text-fg"
                  >
                    <Diamond className="h-3 w-3" />
                  </button>
                  <button
                    aria-label={t('删除轨道')}
                    title={t('删除轨道')}
                    onClick={() => {
                      setTrack(i, null)
                      setSel(null)
                    }}
                    className="grid h-5 w-5 cursor-pointer place-items-center rounded text-subtle opacity-0 group-hover:opacity-100 hover:text-red-400"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              <Menu>
                <MenuTrigger asChild>
                  <button className="flex h-7 w-full cursor-pointer items-center gap-1 px-2 text-subtle hover:text-fg">
                    <Plus className="h-3.5 w-3.5" />
                    {selectedNames.at(-1) && names.has(selectedNames.at(-1)!)
                      ? t('给 {name} 加轨道', { name: selectedNames.at(-1)! })
                      : t('选中控件后加轨道')}
                  </button>
                </MenuTrigger>
                <MenuContent align="start">
                  {ANIM_PROPS.map((p) => (
                    <MenuItem key={p} onSelect={() => addTrack(p)}>
                      {propLabel(p)}
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            </div>
          </div>

          {/* 时间轴 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1 overflow-y-auto px-3">
              <div ref={lane} className="relative">
                <div className="relative h-7 cursor-ew-resize border-b select-none" onPointerDown={dragHead}>
                  {ticks.map((x) => {
                    const major = Math.abs(x * 2 - Math.round(x * 2)) < 0.001
                    return (
                      <div
                        key={x}
                        className={cn('absolute bottom-0 w-px', major ? 'h-2.5 bg-line-strong' : 'h-1.5 bg-line')}
                        style={{ left: `${(x / span) * 100}%` }}
                      >
                        {major && (
                          <span className="absolute -top-3.5 left-1 font-mono text-[10px] text-subtle tabular-nums">
                            {x.toFixed(1)}
                          </span>
                        )}
                      </div>
                    )
                  })}
                  {/* 动画结束的位置 */}
                  <div
                    className="absolute top-0 bottom-0 bg-accent/10"
                    style={{ left: `${(len / span) * 100}%`, right: 0 }}
                  />
                </div>
                {anim.tracks.map((tr, i) => (
                  <div
                    key={`${tr.widget}.${tr.prop}`}
                    className="relative h-7 border-b border-line/60"
                    onPointerDown={(e) => e.target === e.currentTarget && seek(timeAt(e.clientX))}
                    onDoubleClick={(e) => e.target === e.currentTarget && addKey(i, timeAt(e.clientX))}
                  >
                    {tr.keys.length > 1 && (
                      <div
                        className="pointer-events-none absolute top-1/2 h-px -translate-y-1/2 bg-accent/40"
                        style={{
                          left: `${(tr.keys[0].t / span) * 100}%`,
                          width: `${((tr.keys.at(-1)!.t - tr.keys[0].t) / span) * 100}%`,
                        }}
                      />
                    )}
                    {tr.keys.map((k, j) => {
                      const on = sel?.track === i && sel.key === j
                      return (
                        <button
                          key={j}
                          aria-label={t('关键帧 {t} 秒', { t: k.t })}
                          title={`${k.t}s · ${fmt(k.v)} · ${easeLabel(k.ease)}`}
                          onPointerDown={(e) => dragKey(e, i, j)}
                          onClick={(e) => e.stopPropagation()}
                          className={cn(
                            'absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-grab rounded-[2px] border',
                            on ? 'border-white bg-accent' : 'border-accent bg-card hover:bg-accent/60',
                          )}
                          style={{ left: `${(k.t / span) * 100}%` }}
                        />
                      )
                    })}
                  </div>
                ))}
                {/* 播放头 */}
                <div
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-[#ff4fd8]"
                  style={{ left: `${(time / span) * 100}%` }}
                >
                  <div className="absolute -top-0.5 -left-[4px] h-2 w-[9px] rounded-sm bg-[#ff4fd8]" />
                </div>
              </div>
              {!anim.tracks.length && (
                <p className="py-4 text-center text-[12px] text-subtle">
                  {t('选中控件，用左边的「加轨道」或上面的「预设」开始')}
                </p>
              )}
            </div>
            {/* 选中的关键帧 */}
            <div className="flex h-10 shrink-0 items-center gap-2 border-t px-3">
              {selTrack && selKey ? (
                <>
                  <span className="shrink-0 truncate text-subtle">
                    {selTrack.widget} · {propLabel(selTrack.prop)}
                  </span>
                  <span className="shrink-0 text-subtle">{t('时间')}</span>
                  <div className="w-16 shrink-0">
                    <NumInput
                      label={t('时间')}
                      value={selKey.t}
                      step={0.05}
                      min={0}
                      max={120}
                      onChange={(v) => setKey(sel!.track, sel!.key, { t: round(v) })}
                    />
                  </div>
                  <span className="shrink-0 text-subtle">{t('值')}</span>
                  {isVecProp(selTrack.prop) ? (
                    <div className="flex w-36 shrink-0 gap-1">
                      {(['X', 'Y'] as const).map((ax) => {
                        const v = selKey.v as { X: number; Y: number }
                        return (
                          <NumInput
                            key={ax}
                            prefix={ax}
                            value={v[ax]}
                            step={selTrack.prop === 'Scale' ? 0.05 : 1}
                            onChange={(n) => setKey(sel!.track, sel!.key, { v: { ...v, [ax]: n } })}
                          />
                        )
                      })}
                    </div>
                  ) : (
                    <div className="w-16 shrink-0">
                      <NumInput
                        label={t('值')}
                        value={Number(selKey.v)}
                        step={selTrack.prop === 'RenderOpacity' ? 0.05 : 1}
                        min={selTrack.prop === 'RenderOpacity' ? 0 : undefined}
                        max={selTrack.prop === 'RenderOpacity' ? 1 : undefined}
                        onChange={(n) => setKey(sel!.track, sel!.key, { v: n })}
                      />
                    </div>
                  )}
                  <span className="shrink-0 text-subtle" title={t('从这一帧到下一帧怎么过渡')}>
                    {t('缓动')}
                  </span>
                  <Select
                    aria-label={t('缓动')}
                    value={selKey.ease}
                    onChange={(e) => setKey(sel!.track, sel!.key, { ease: e.target.value as Ease })}
                    options={EASES.map((x) => ({ value: x, label: easeLabel(x) }))}
                    className="h-7 w-[140px] shrink-0 rounded-md px-2 text-[12px]"
                  />
                  <button
                    aria-label={t('删除关键帧')}
                    title={t('删除关键帧')}
                    className={icon}
                    onClick={() => {
                      const keys = selTrack.keys.filter((_, j) => j !== sel!.key)
                      setTrack(sel!.track, keys.length ? { ...selTrack, keys } : null)
                      setSel(null)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : (
                <span className="text-subtle">
                  {t('点关键帧修改；拖动关键帧改时间（按住 Shift 对齐到 0.1 秒）；双击轨道空白处加关键帧')}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
