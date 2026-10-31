import { createContext, useContext, useState } from 'react'
import { RotateCcw, SlidersHorizontal } from 'lucide-react'
import {
  COMP_SPEC,
  compCssValue,
  compField,
  compValue,
  setCompValue,
  type CompCustomColor,
  type CompName,
  type CompValue,
  type ComponentStyle,
} from '@shared/component-style'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Select } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'

type Ctx = { style: ComponentStyle; set: (c: CompName, prop: string, v: CompValue | undefined) => void }
const TuneCtx = createContext<Ctx | null>(null)
export const TuneProvider = TuneCtx.Provider

/** 部件的显示名：静态写出来，文案检查才认得 */
export const compLabel = (c: CompName) =>
  ({
    summary: t('总结卡'),
    card: t('卡片'),
    button: t('按钮'),
    iconButton: t('图标按钮'),
    statusPill: t('状态标签'),
    badge: t('小标签'),
    kbd: t('快捷键'),
    progress: t('进度条'),
    input: t('输入框'),
    checkbox: t('勾选框'),
    switch: t('开关'),
    segmented: t('分段切换'),
    chip: t('引用标签'),
    row: t('过程行'),
    nav: t('侧栏行'),
    menu: t('下拉菜单'),
    modal: t('弹窗'),
    sheet: t('侧边抽屉'),
    popover: t('输入框弹层'),
    empty: t('空状态'),
  })[c]

/** 项的显示名：同名的项在不同部件里意思一样，只有少数按部件改说法 */
const propLabel = (c: CompName, prop: string) => {
  if (c === 'chip' && prop === 'ring') return t('描边')
  if (c === 'input' && prop === 'ring') return t('聚焦光圈')
  if (c === 'menu' && prop === 'itemRadius') return t('菜单项圆角')
  if (c === 'segmented' && prop === 'itemRadius') return t('选中块圆角')
  if (c === 'switch' && prop === 'on') return t('打开时颜色')
  if (c === 'empty' && prop === 'border') return t('边框线型')
  return (
    {
      radius: t('圆角'),
      bg: t('底色'),
      border: t('边框'),
      shadow: t('阴影'),
      weight: t('字重'),
      height: t('高度'),
      bar: t('左侧色条宽度'),
      divider: t('标题下分隔线'),
      needs: t('「要你处理」底色'),
      kindRadius: t('类型标签圆角'),
    } as Record<string, string>
  )[prop]
}

const optionLabel = (v: string) =>
  ({
    card: t('卡片色'),
    pop: t('浮层色'),
    panel: t('面板色'),
    bg: t('页面底色'),
    field: t('输入框色'),
    sel: t('选中底色'),
    accent: t('强调浅底'),
    none: t('无'),
    default: t('默认浅底'),
    warning: t('警告色'),
    primary: t('主色'),
    success: t('成功色'),
    dashed: t('虚线'),
    solid: t('实线'),
    '400': t('常规'),
    '500': t('中等'),
    '600': t('半粗'),
    custom: t('自定义'),
  })[v] ?? v

/** 一项的控件：圆角、高度给滑块，开关给开关，选项给分段，颜色给下拉（自定义时浅色、深色各一个取色器） */
function Field({ c, prop }: { c: CompName; prop: string }) {
  const { style, set } = useContext(TuneCtx)!
  const f = compField(c, prop)
  const v = compValue(style, c, prop)
  const label = propLabel(c, prop)
  const changed = style[c]?.[prop] !== undefined
  let control: React.ReactNode
  if (f.kind === 'px') {
    control = (
      <div className="flex flex-1 items-center gap-3">
        <input
          type="range"
          min={f.min}
          max={f.max}
          step={1}
          value={v as number}
          aria-label={label}
          onChange={(e) => set(c, prop, Number(e.target.value))}
          className="min-w-0 flex-1 cursor-pointer accent-[var(--color-accent)]"
        />
        <span className="w-12 text-right font-mono text-[0.8125rem] text-muted tabular-nums">{v as number}px</span>
      </div>
    )
  } else if (f.kind === 'bool') {
    control = (
      <div className="flex flex-1 justify-end">
        <Switch aria-label={label} checked={v as boolean} onCheckedChange={(on) => set(c, prop, on)} />
      </div>
    )
  } else if (f.kind === 'enum') {
    control = (
      <div className="flex flex-1 justify-end">
        <Segmented
          size="sm"
          label={label}
          value={v as string}
          onChange={(o) => set(c, prop, o)}
          options={Object.keys(f.options).map((o) => ({ id: o, label: optionLabel(o) }))}
        />
      </div>
    )
  } else {
    const custom = typeof v === 'object' ? (v as CompCustomColor) : null
    const dark = document.documentElement.classList.contains('dark')
    control = (
      <div className="flex flex-1 items-center justify-end gap-2">
        {custom ? (
          <>
            <input
              type="color"
              aria-label={t('浅色')}
              title={t('浅色')}
              value={custom.light}
              onChange={(e) => set(c, prop, { ...custom, light: e.target.value })}
              className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
            />
            <input
              type="color"
              aria-label={t('深色')}
              title={t('深色')}
              value={custom.dark}
              onChange={(e) => set(c, prop, { ...custom, dark: e.target.value })}
              className="h-7 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </>
        ) : (
          <span
            className="h-4 w-4 shrink-0 rounded-full ring-1 ring-line-strong"
            style={{ background: compCssValue(f, v, dark) }}
          />
        )}
        <Select
          size="sm"
          aria-label={label}
          value={custom ? 'custom' : (v as string)}
          onChange={(e) => {
            const next = e.target.value
            // 自定义从一对中性的浅灰、深灰起步，再用取色器改
            set(c, prop, next === 'custom' ? { light: '#f4f3ee', dark: '#30302e' } : next)
          }}
          options={[...Object.keys(f.options), 'custom'].map((o) => ({ value: o, label: optionLabel(o) }))}
        />
      </div>
    )
  }
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-32 shrink-0 text-[0.8125rem] text-muted">{label}</span>
      {control}
      {changed ? (
        <IconButton size="sm" icon={RotateCcw} label={t('恢复默认')} onClick={() => set(c, prop, undefined)} />
      ) : (
        <span className="w-7 shrink-0" />
      )}
    </div>
  )
}

/**
 * 部件展示格右上角的「微调」：点开在展示下面列出这个部件能调的项，改了立刻作用到整个面板。
 * 一格展示好几个部件时（开关、勾选框、分段）按部件分小标题
 */
export function TuneToggle({ comps }: { comps: CompName[] }) {
  const { style, set } = useContext(TuneCtx)!
  const [open, setOpen] = useState(false)
  const changed = comps.some((c) => style[c])
  return (
    <div className="flex flex-col">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn('self-start', changed && 'text-accent-text')}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        {changed ? t('微调 · 已改') : t('微调')}
      </Button>
      {open && (
        <div className="mt-2 flex w-full flex-col gap-3 rounded-lg bg-panel px-4 py-3 ring-1 ring-line">
          {comps.map((c) => (
            <div key={c} className="flex flex-col" aria-label={compLabel(c)}>
              <div className="flex items-center pb-1">
                <span className="flex-1 text-[0.75rem] font-semibold text-subtle">{compLabel(c)}</span>
                {style[c] && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      for (const prop of Object.keys(style[c] ?? {})) set(c, prop, undefined)
                    }}
                  >
                    {t('恢复本组')}
                  </Button>
                )}
              </div>
              {Object.keys(COMP_SPEC[c]).map((prop) => (
                <Field key={prop} c={c} prop={prop} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 设置页传进来的值和改法包成 set：连续改（恢复本组）时以最新的为准 */
export function useTune(style: ComponentStyle, update: (s: ComponentStyle) => void): Ctx {
  let latest = style
  return {
    style,
    set: (c, prop, v) => {
      latest = setCompValue(latest, c, prop, v)
      update(latest)
    },
  }
}
