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
    grid: t('数据表格'),
    callTree: t('调用栈树'),
    structure: t('功能结构'),
    capRow: t('能力行'),
    htmlCard: t('HTML 卡片'),
    changesCard: t('改动卡片'),
    versionDiff: t('版本差异'),
    foldBar: t('折叠条'),
    sourceList: t('来源列表'),
    routeBadge: t('路由小标'),
    grantBadge: t('放行小标'),
    genBadge: t('写参数小标'),
    liveText: t('实时输出'),
    styleRef: t('风格参考图'),
    toast: t('提示'),
    scrollbar: t('滚动条'),
    canvas: t('流程图画布'),
    countBadge: t('数字角标'),
    flowNode: t('流程图节点'),
    flowPin: t('流程图引脚'),
    sectionRail: t('分区导航'),
  })[c]

/** 项的显示名：同名的项在不同部件里意思一样，只有少数按部件改说法 */
const propLabel = (c: CompName, prop: string) => {
  if (c === 'chip' && prop === 'ring') return t('描边')
  if (c === 'input' && prop === 'ring') return t('聚焦光圈')
  if (c === 'menu' && prop === 'itemRadius') return t('菜单项圆角')
  if (c === 'menu' && prop === 'search') return t('下拉框搜索框')
  if (c === 'segmented' && prop === 'itemRadius') return t('选中块圆角')
  if (c === 'switch' && prop === 'on') return t('打开时颜色')
  if (c === 'empty' && prop === 'border') return t('边框线型')
  if (c === 'grid') return gridPropLabel(prop) ?? prop
  if (c === 'callTree') return callTreePropLabel(prop) ?? prop
  if (c === 'structure' && prop !== 'radius')
    return (
      { diagramH: t('图的最大高度'), why: t('显示「它选的」理由'), nodes: t('列出节点在代码里的位置') } as Record<
        string,
        string
      >
    )[prop]
  if (c === 'htmlCard' && prop !== 'radius')
    return (
      { preview: t('缩略预览'), previewH: t('预览高度'), active: t('右栏正在显示的描边') } as Record<string, string>
    )[prop]
  if (c === 'changesCard' && prop !== 'radius')
    return ({ scope: t('默认显示'), first: t('先列几个文件'), fold: t('一开始') } as Record<string, string>)[prop]
  if (c === 'versionDiff')
    return (
      {
        navW: t('版本列表默认宽度'),
        msgLines: t('提交说明显示几行'),
        busySec: t('UE 读取超过几秒算忙'),
        historyMax: t('属性来历往回读几版'),
        sameCommit: t('同一次提交改的资源'),
      } as Record<string, string>
    )[prop]
  if (c === 'foldBar' && prop === 'hint') return t('右边写「展开 / 收起」')
  if (c === 'sourceList' && prop === 'autoOpen') return t('只有来源时也自动打开右栏')
  if (c === 'routeBadge' && prop === 'show') return t('在工具卡片上显示实际走的路')
  if (c === 'genBadge' && prop === 'show') return t('在工具卡片上标出写参数用了多久')
  if (c === 'grantBadge')
    return (
      {
        show: t('在工具卡片上标出自动允许'),
        text: t('小标写字（关掉只留图标）'),
        runOpen: t('合并的放行记录一开始展开'),
      } as Record<string, string>
    )[prop]
  if (c === 'liveText')
    return (
      { maxH: t('正在输出时最多多高'), bar: t('左边竖线'), draft: t('「正在写」下面显示写到哪了') } as Record<
        string,
        string
      >
    )[prop]
  if (c === 'styleRef' && prop !== 'radius')
    return ({ thumbW: t('列表里缩略图宽度'), ring: t('选中风格的描边') } as Record<string, string>)[prop]
  if (c === 'toast' && prop !== 'radius' && prop !== 'bg' && prop !== 'border')
    return ({ position: t('位置'), duration: t('停留时长'), bar: t('左侧色条宽度') } as Record<string, string>)[prop]
  if (c === 'canvas')
    return ({ minimap: t('小地图'), minimapW: t('小地图宽度'), selectPad: t('选框外扩') } as Record<string, string>)[
      prop
    ]
  if (c === 'countBadge')
    return ({ size: t('大小'), bg: t('底色'), ring: t('外圈颜色') } as Record<string, string>)[prop]
  if (c === 'flowNode' || c === 'flowPin') return flowPropLabel(c, prop) ?? prop
  if (c === 'sectionRail')
    return (
      {
        width: t('图标轨宽度'),
        count: t('错误写数字（关掉只画圆点）'),
        labels: t('图标下面写名字'),
        bg: t('图标轨底色'),
        panelBg: t('二级面板底色'),
      } as Record<string, string>
    )[prop]
  if (c === 'modal' && prop === 'resizeEdge') return t('拖边缩放时的边线颜色')
  if (c === 'modal' && prop === 'resizeLine') return t('拖边缩放时的边线粗细')
  if (c === 'scrollbar')
    return (
      {
        size: t('轨道宽度'),
        pad: t('滑块两边留白'),
        thumb: t('滑块颜色'),
        hover: t('悬停时颜色'),
        idle: t('平时'),
      } as Record<string, string>
    )[prop]
  if (c === 'capRow' && prop !== 'radius')
    return ({ pad: t('上下留白'), when: t('显示「该用 / 别用」'), name: t('显示原名') } as Record<string, string>)[prop]
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
      track: t('未完成部分底色'),
    } as Record<string, string>
  )[prop]
}

/** 数据表格的项：表头每种行一个颜色 */
/** 流程图节点、引脚的项 */
const flowPropLabel = (c: 'flowNode' | 'flowPin', prop: string): string | undefined =>
  c === 'flowPin'
    ? ({ size: t('圆点大小'), ring: t('和卡片隔开的外圈'), tone: t('出口的圆点按出口上色') } as Record<string, string>)[
        prop
      ]
    : (
        {
          radius: t('圆角'),
          bar: t('左侧色条宽度'),
          tile: t('图标外的小方块'),
          divider: t('标题下分隔线'),
          detail: t('显示内容区（细节、条件）'),
          rowH: t('出口行高'),
        } as Record<string, string>
      )[prop]

const gridPropLabel = (prop: string): string | undefined =>
  ({
    rowH: t('行高'),
    font: t('字体'),
    lines: t('竖线'),
    tint: t('表头底色浓度'),
    modifier: t('修饰行'),
    side: t('导出端行'),
    type: t('类型行'),
    name: t('字段名行'),
    comment: t('注释行'),
    other: t('其他表头行'),
    nameBold: t('字段名加粗'),
    divider: t('表头下粗线'),
    edited: t('改过未保存的格子'),
    invalid: t('不合规的格子'),
    added: t('新增的行和新值'),
    removed: t('删掉的行和旧值'),
    stripe: t('隔行底色'),
    tagSize: t('类型标签字号'),
    tagRadius: t('类型标签圆角'),
    pills: t('枚举值画成胶囊'),
    bools: t('布尔值画成小勾'),
    blank: t('空格子画「—」'),
    note: t('批注角标'),
    link: t('超链接'),
    rowMark: t('整行底色标记'),
    handle: t('填充柄大小'),
    fitHead: t('列宽量上列头'),
    colMax: t('自动列宽上限'),
  })[prop]

/** 调用栈树的项 */
const callTreePropLabel = (prop: string): string | undefined =>
  ({
    report: t('诊断报告里的样式'),
    chat: t('对话里的样式'),
    lines: t('连线'),
    indent: t('缩进'),
    gap: t('行距'),
    fault: t('出错点'),
    missed: t('没走到的一跳'),
    code: t('出错点下面带代码'),
    dir: t('位置写出目录'),
    legend: t('显示图例'),
    edge: t('异步、事件边界'),
  })[prop]

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
    emphasis: t('强调色'),
    success: t('成功色'),
    danger: t('危险色'),
    run: t('运行色'),
    dashed: t('虚线'),
    solid: t('实线'),
    '400': t('常规'),
    '500': t('中等'),
    '600': t('半粗'),
    custom: t('自定义'),
    always: t('总是显示'),
    from6: t('6 项起'),
    from10: t('10 项起'),
    from20: t('20 项起'),
    never: t('不显示'),
    mono: t('等宽'),
    sans: t('界面字体'),
    all: t('画'),
    rows: t('不画'),
    low: t('淡'),
    mid: t('中'),
    high: t('浓'),
    vivid: t('鲜艳'),
    violet: t('紫'),
    teal: t('青'),
    amber: t('琥珀'),
    blue: t('蓝'),
    green: t('绿'),
    red: t('红'),
    orange: t('橙'),
    gray: t('灰'),
    sm: t('小'),
    md: t('中'),
    lg: t('大'),
    off: t('不画'),
    thin: t('细条'),
    wide: t('粗条'),
    normal: t('标准'),
    tight: t('紧凑'),
    compact: t('紧凑'),
    loose: t('宽松'),
    tree: t('树线'),
    rail: t('时间轴'),
    cards: t('卡片'),
    ide: t('调试器'),
    fill: t('竖条 + 底色'),
    bar: t('只有竖条'),
    fade: t('变淡'),
    faint: t('很淡'),
    keep: t('不变淡'),
    fine: t('细线'),
    window: t('窗口色'),
    bottomRight: t('右下角'),
    topRight: t('右上角'),
    bottomCenter: t('底部居中'),
    topCenter: t('顶部居中'),
    '3s': t('3 秒'),
    '4s': t('4 秒'),
    '6s': t('6 秒'),
    '8s': t('8 秒'),
    theme: t('跟随配色'),
    strong: t('深一些'),
    hover: t('鼠标进来才显示'),
    round: t('这一轮'),
    conv: t('整个对话'),
    closed: t('折成一行'),
    open: t('展开'),
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
        <span className="w-12 text-right font-mono text-body text-muted tabular-nums">{v as number}px</span>
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
              className="h-7 w-7 cursor-pointer rounded-sm border-0 bg-transparent p-0"
            />
            <input
              type="color"
              aria-label={t('深色')}
              title={t('深色')}
              value={custom.dark}
              onChange={(e) => set(c, prop, { ...custom, dark: e.target.value })}
              className="h-7 w-7 cursor-pointer rounded-sm border-0 bg-transparent p-0"
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
      <span className="w-32 shrink-0 text-body text-muted">{label}</span>
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
              {/* 固定高度的标题行，「恢复本组」不需要时隐藏但不改变行高 */}
              <div className="flex h-9 items-center pb-1">
                <span className="flex-1 text-footnote font-semibold text-subtle">{compLabel(c)}</span>
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
