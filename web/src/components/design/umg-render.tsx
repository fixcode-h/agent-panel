import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { desiredSize, scaleBoxFactor } from '@shared/umg-layout'
import {
  WIDGETS,
  cssColor,
  entryCount,
  fontPx,
  gridCell,
  imageFitStyle,
  isWebType,
  parseColor,
  type Brush,
  type Component,
  type SlotType,
  type Widget,
} from '@shared/umg'
import { WebNode } from './web-render'
import type { Device } from '@shared/web'
import { animKey } from '@shared/anim'
import { dataRows, withRow, type DataRow, type DesignData } from '@shared/design-data'

/**
 * 用 HTML 近似 UMG 的布局，在设计器里预览。视觉都来自图片（画刷），HTML 只负责摆位置：
 * CanvasPanel 用锚点 + 偏移绝对定位，横竖排列用 flex，Overlay 用单格 grid，九宫格用 border-image。
 * 和 UE 里的效果会有细微差别（字体、ScaleBox），结构和数值是一一对应的。
 */

export interface RenderImage {
  url: string
  width: number
  height: number
}

export interface RenderCtx {
  images: Map<string, RenderImage>
  components: Map<string, Component>
  /** 子控件里的控件不能单独选中（点它选中的是引用它的 UserWidget） */
  interactive: boolean
  /** 防止子控件互相引用死循环 */
  depth: number
  /** 运行模式：像游戏里一样能点按钮、勾选、拖滑块、输入文字，只改预览不改设计 */
  play?: boolean
  /** 网页 UI 按哪个宽度画（平板、手机用断点里的属性） */
  device?: Device
  /** 正在画的是哪棵树（主界面是空，子控件里是子控件名）：给控件打上动画用的标记 data-an */
  tree?: string
  /** 画板的运行时假数据（见 design-data.ts），只在预览里生效 */
  data?: DesignData
  /** 当前条目用的是哪一行数据：列表渲染条目时传进来 */
  row?: DataRow
}

const H_JUSTIFY: Record<string, string> = {
  HAlign_Left: 'flex-start',
  HAlign_Center: 'center',
  HAlign_Right: 'flex-end',
  HAlign_Fill: 'stretch',
}
const V_ALIGN: Record<string, string> = {
  VAlign_Top: 'flex-start',
  VAlign_Center: 'center',
  VAlign_Bottom: 'flex-end',
  VAlign_Fill: 'stretch',
}
const pad = (m: any): string =>
  m && typeof m === 'object' ? `${m.Top ?? 0}px ${m.Right ?? 0}px ${m.Bottom ?? 0}px ${m.Left ?? 0}px` : '0'

/** 把颜色乘在一起（画刷的 TintColor × 控件的 ColorAndOpacity） */
function mulColor(a: string, b?: string) {
  if (!b) return a
  const x = parseColor(a)
  const y = parseColor(b)
  const c = x.map((v, i) => v * y[i])
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${+c[3].toFixed(3)})`
}
const isWhite = (hex: string) =>
  parseColor(hex)
    .slice(0, 3)
    .every((v) => v > 0.995)

/**
 * 画刷画成控件里的一层（position:absolute、在内容下面），不直接写在控件元素上：
 * - 画刷的透明度只作用在这一层：半透明的面板背景不会把里面的文字也一起变淡（以前写成控件的 opacity）
 * - 着色是「图片 × 颜色」：九宫格先用 border-image 画纹理，再叠一层颜色做 multiply，
 *   用同样的切片做遮罩只留图片形状（以前九宫格完全不吃着色，按钮在画布上正常、进 UE 几乎是黑的）
 * - 非白色着色的 alpha 作为这一层的不透明度（以前 multiply 混合后整张变成不透明）
 * 控件元素要加 isolation:isolate（见 el），这一层的 z-index:-1 才不会跑到父控件背景下面
 */
export function BrushLayer({
  b,
  ctx,
  tint,
  style,
}: {
  b: Brush | undefined
  ctx: RenderCtx
  tint?: string
  /** 层自己的位置大小，不写就是铺满控件 */
  style?: CSSProperties
}) {
  if (!b || b.DrawAs === 'NoDrawType') return null
  const color = mulColor(b.TintColor ?? '#FFFFFFFF', tint)
  const id =
    typeof b.ResourceObject === 'string' && b.ResourceObject.startsWith('img:') ? b.ResourceObject.slice(4) : ''
  const img = id ? ctx.images.get(id) : undefined
  const alpha = parseColor(b.TintColor ?? '#FFFFFFFF')[3] * (tint ? parseColor(tint)[3] : 1)
  const base: CSSProperties = {
    position: 'absolute',
    inset: 0,
    zIndex: -1,
    pointerEvents: 'none',
    ...style,
  }
  if (!img) {
    if (id)
      return (
        <span
          aria-hidden
          style={{
            ...base,
            // 图片还没生成：柔和的灰蓝斜纹，不抢眼（以前是品红色，一整片很晃眼）
            background: 'repeating-linear-gradient(45deg,#94a3b81f 0 8px,#0000 8px 16px)',
            outline: '1px dashed #94a3b855',
          }}
        />
      )
    if (b.DrawAs === 'Border') return <span aria-hidden style={{ ...base, boxShadow: `inset 0 0 0 1px ${color}` }} />
    const r = b.OutlineSettings?.CornerRadii
    return (
      <span
        aria-hidden
        style={{
          ...base,
          background: color,
          ...(b.DrawAs === 'RoundedBox' && r ? { borderRadius: `${r.X}px ${r.Y}px ${r.Z}px ${r.W}px` } : {}),
        }}
      />
    )
  }
  const url = `url("${img.url}")`
  const white = isWhite(b.TintColor ?? '#FFFFFFFF') && (!tint || isWhite(tint))
  // 着色只乘 RGB；alpha 交给整层的不透明度
  const tc = parseColor(b.TintColor ?? '#FFFFFFFF')
  const tt = tint ? parseColor(tint) : [1, 1, 1, 1]
  const ch = (i: number) => Math.round(tc[i] * tt[i] * 255)
  const rgb = `rgb(${ch(0)},${ch(1)},${ch(2)})`
  const m = b.Margin ?? { Left: 0, Top: 0, Right: 0, Bottom: 0 }
  const box = (b.DrawAs === 'Box' || b.DrawAs === 'Border') && (m.Left || m.Top || m.Right || m.Bottom)
  const group: CSSProperties = { ...base, isolation: 'isolate', opacity: alpha < 1 ? alpha : undefined }
  if (box) {
    // UE 的九宫格：Margin 是图片尺寸的比例，画出来的边宽 = Margin × ImageSize
    const sz = b.ImageSize ?? { X: img.width, Y: img.height }
    const slice = `${m.Top * img.height} ${m.Right * img.width} ${m.Bottom * img.height} ${m.Left * img.width}`
    const widths = `${m.Top * sz.Y}px ${m.Right * sz.X}px ${m.Bottom * sz.Y}px ${m.Left * sz.X}px`
    const fill = b.DrawAs === 'Box'
    return (
      <span aria-hidden style={group}>
        <span
          style={{
            position: 'absolute',
            inset: 0,
            borderStyle: 'solid',
            borderImageSource: url,
            borderImageSlice: `${slice}${fill ? ' fill' : ''}`,
            borderImageWidth: widths,
            borderImageRepeat: 'stretch',
            borderWidth: 0,
          }}
        />
        {!white && (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              background: rgb,
              mixBlendMode: 'multiply',
              // 和纹理同样的切片做遮罩：颜色只落在图片形状里
              WebkitMaskBoxImage: `${url} ${slice} / ${widths} stretch`,
            }}
          />
        )}
      </span>
    )
  }
  const tile = b.Tiling && b.Tiling !== 'NoTile'
  const fit = tile
    ? { size: `${b.ImageSize?.X ?? img.width}px ${b.ImageSize?.Y ?? img.height}px`, position: '0 0' }
    : imageFitStyle(b.ImageFit, img)
  const repeat = { Horizontal: 'repeat-x', Vertical: 'repeat-y', Both: 'repeat' }[b.Tiling as string] ?? 'no-repeat'
  if (white)
    return (
      <span
        aria-hidden
        style={{
          ...group,
          backgroundImage: url,
          backgroundSize: fit.size,
          backgroundPosition: fit.position,
          backgroundRepeat: repeat,
        }}
      />
    )
  // 着色：图片 × 颜色，再用图片本身做遮罩保住透明部分
  return (
    <span
      aria-hidden
      style={{
        ...group,
        backgroundImage: url,
        backgroundColor: rgb,
        backgroundBlendMode: 'multiply',
        backgroundSize: fit.size,
        backgroundPosition: fit.position,
        backgroundRepeat: repeat,
        maskImage: url,
        maskSize: fit.size,
        maskPosition: fit.position,
        maskRepeat: repeat,
        WebkitMaskImage: url,
        WebkitMaskSize: fit.size,
        WebkitMaskPosition: fit.position,
      }}
    />
  )
}

/** 插槽 → 外层容器的样式；fillX / fillY 表示控件本身要撑满 */
function slotStyle(
  slotType: SlotType | undefined,
  slot: any,
  parent?: Widget,
): { style: CSSProperties; fillX: boolean; fillY: boolean } {
  if (!slotType || !slot) return { style: { display: 'flex', width: '100%', height: '100%' }, fillX: true, fillY: true }
  if (slotType === 'CanvasPanelSlot') {
    const L = slot.LayoutData ?? {}
    const o = L.Offsets ?? {}
    const a = L.Anchors ?? { Minimum: { X: 0, Y: 0 }, Maximum: { X: 0, Y: 0 } }
    const al = L.Alignment ?? { X: 0, Y: 0 }
    const st: CSSProperties = { position: 'absolute', display: 'flex', zIndex: slot.ZOrder || undefined }
    const sx = a.Minimum.X !== a.Maximum.X
    const sy = a.Minimum.Y !== a.Maximum.Y
    st.left = `calc(${a.Minimum.X * 100}% + ${o.Left ?? 0}px)`
    st.top = `calc(${a.Minimum.Y * 100}% + ${o.Top ?? 0}px)`
    if (sx) st.right = `calc(${(1 - a.Maximum.X) * 100}% + ${o.Right ?? 0}px)`
    else if (!slot.bAutoSize) st.width = `${o.Right ?? 0}px`
    if (sy) st.bottom = `calc(${(1 - a.Maximum.Y) * 100}% + ${o.Bottom ?? 0}px)`
    else if (!slot.bAutoSize) st.height = `${o.Bottom ?? 0}px`
    const tx = sx ? 0 : -(al.X ?? 0) * 100
    const ty = sy ? 0 : -(al.Y ?? 0) * 100
    if (tx || ty) st.transform = `translate(${tx}%, ${ty}%)`
    return { style: st, fillX: true, fillY: true }
  }
  const h = slot.HorizontalAlignment ?? 'HAlign_Fill'
  const v = slot.VerticalAlignment ?? 'VAlign_Fill'
  const st: CSSProperties = {
    display: 'flex',
    padding: pad(slot.Padding),
    justifyContent: H_JUSTIFY[h] === 'stretch' ? 'flex-start' : H_JUSTIFY[h],
    alignItems: V_ALIGN[v] === 'stretch' ? 'stretch' : V_ALIGN[v],
    minWidth: 0,
    minHeight: 0,
  }
  if (slotType === 'HorizontalBoxSlot' || slotType === 'VerticalBoxSlot') {
    const fill = slot.Size?.SizeRule === 'Fill'
    st.flex = fill ? `${slot.Size?.Value ?? 1} 1 0` : '0 0 auto'
    // 在排列方向上撑满（Fill）由 flex 决定；另一个方向看对齐
    if (slotType === 'HorizontalBoxSlot') {
      st.alignSelf = 'stretch'
      return { style: st, fillX: h === 'HAlign_Fill', fillY: v === 'VAlign_Fill' }
    }
    st.alignSelf = 'stretch'
    return { style: st, fillX: h === 'HAlign_Fill', fillY: v === 'VAlign_Fill' }
  }
  if (slotType === 'UniformGridSlot') {
    st.gridRow = `${(slot.Row ?? 0) + 1}`
    st.gridColumn = `${(slot.Column ?? 0) + 1}`
    st.padding = pad(parent?.Properties.SlotPadding)
  } else if (slotType === 'OverlaySlot') {
    st.gridArea = '1 / 1'
  } else if (slotType === 'WrapBoxSlot') {
    st.flex = slot.bFillEmptySpace ? '1 0 auto' : '0 0 auto'
  } else if (slotType === 'ScrollBoxSlot') {
    st.flex = '0 0 auto'
  } else {
    // 只有一个子控件的容器（Border、Button、SizeBox……）：子控件占满容器
    st.flex = '1 1 auto'
  }
  return { style: st, fillX: h === 'HAlign_Fill', fillY: v === 'VAlign_Fill' }
}

/** 所有控件都有的：可见性、透明度、变换 */
function commonStyle(p: Record<string, any>): CSSProperties {
  const st: CSSProperties = {}
  if (p.Visibility === 'Hidden') st.visibility = 'hidden'
  if (p.RenderOpacity !== undefined && p.RenderOpacity !== 1) st.opacity = p.RenderOpacity
  // 平移、旋转、缩放写成 CSS 单独的 translate / rotate / scale 属性（顺序和原来的 transform 一样：平移 → 旋转 → 缩放），
  // 斜切留在 transform 里。动画（anim.ts 的 cssProp）写的也是这几个属性：播放时**替换**静态值，和 UE 的 WidgetAnimation
  // 一样是绝对值（以前静态值写在 transform 里，动画再叠加上去，例如静态 Y=-20 的 fade-in-up 最后停在 -20）
  const tr = p.RenderTransform
  if (tr) {
    if (tr.Translation?.X || tr.Translation?.Y) st.translate = `${tr.Translation.X ?? 0}px ${tr.Translation.Y ?? 0}px`
    if (tr.Angle) st.rotate = `${tr.Angle}deg`
    if ((tr.Scale?.X ?? 1) !== 1 || (tr.Scale?.Y ?? 1) !== 1) st.scale = `${tr.Scale?.X ?? 1} ${tr.Scale?.Y ?? 1}`
    if (tr.Shear?.X || tr.Shear?.Y) st.transform = `skew(${tr.Shear.X ?? 0}deg, ${tr.Shear.Y ?? 0}deg)`
  }
  // 支点只要写了就生效：动画（例如血条从左边伸出来的 ScaleX）也绕它转，以前没有静态变换时支点被忽略
  const pv = p.RenderTransformPivot
  if (pv && (pv.X !== 0.5 || pv.Y !== 0.5)) st.transformOrigin = `${(pv.X ?? 0.5) * 100}% ${(pv.Y ?? 0.5) * 100}%`
  return st
}

/**
 * 有自身尺寸的控件（Image 的 ImageSize、进度条、滑条）在 Fill 对齐时：
 * UE 里槽位按控件的期望尺寸分配，Fill 只是撑满槽位；CSS 里不写宽高就没有内容尺寸，
 * 放在 Automatic 的横竖排、WrapBox、ScrollBox 或自动大小的画布插槽里会被压成 0（画布上看不见）。
 * 塞一个看不见的占位块给出期望尺寸：外层按内容排版时用它，撑满 / 固定尺寸时照样拉伸或收缩。
 * shared/umg-layout.ts 按同样的规则算位置
 */
function Sizer({ x, y, on }: { x: number; y: number; on: boolean }) {
  if (!on) return null
  return (
    <span
      aria-hidden
      data-sizer
      style={{ display: 'block', width: x, height: y, visibility: 'hidden', pointerEvents: 'none' }}
    />
  )
}

/**
 * ScaleBox 的内容：子控件按自己的期望尺寸画在中间，再整体缩放（ScaleToFit 等，倍数见 scaleBoxFactor）。
 * 以前只是一个 flex 盒子，子控件被拉伸铺满、不按比例缩放，和 UE 不一样。
 * ScaleBox 自己的大小要等画出来才知道：useLayoutEffect 里量一次（在绘制之前，截图拿到的也是缩放好的），尺寸变了再量。
 * 看不见的占位块给出期望尺寸，按内容排版时 ScaleBox 不会被压成 0；shared/umg-layout.ts 按同样的规则算位置
 */
function ScaleBoxBody({ w, ctx }: { w: Widget; ctx: RenderCtx }) {
  const box = useRef<HTMLSpanElement>(null)
  const [size, setSize] = useState<{ w: number; h: number }>()
  const c = (w.Children ?? []).find((x) => x.Properties?.Visibility !== 'Collapsed')
  const comps = [...ctx.components.values()]
  const want = c ? desiredSize(c, { components: comps, data: ctx.data, parent: w }) : { w: 0, h: 0 }
  const self = desiredSize(w, { components: comps, data: ctx.data })
  useLayoutEffect(() => {
    const el = box.current?.parentElement
    if (!el) return
    const measure = () =>
      setSize((s) =>
        s && s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight },
      )
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [sx, sy] = size ? scaleBoxFactor(w, size, want) : [1, 1]
  return (
    <>
      <span
        ref={box}
        aria-hidden
        data-sizer
        style={{ display: 'block', width: self.w, height: self.h, visibility: 'hidden', pointerEvents: 'none' }}
      />
      {c && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: want.w,
            height: want.h,
            display: 'flex',
            transform: `translate(-50%, -50%) scale(${sx}, ${sy})`,
          }}
        >
          <UmgNode w={c} slotType="ScaleBoxSlot" parent={w} ctx={ctx} />
        </div>
      )}
    </>
  )
}

/** 一个控件连同它的插槽外壳 */
export function UmgNode({
  w,
  slotType,
  parent,
  ctx,
}: {
  w: Widget
  slotType?: SlotType
  parent?: Widget
  ctx: RenderCtx
}) {
  // 套用当前数据行：状态覆盖和字段绑定只在渲染时生效，不改设计树
  const ww = withRow(w, ctx.row)
  // 网页 UI 的控件（以及放在 Frame 里的子控件引用）按网页的规则画
  if (isWebType(ww.Type) || slotType === 'FlexSlot') return <WebNode w={ww} parent={parent} ctx={ctx} />
  if (ww.Properties?.Visibility === 'Collapsed') return null
  const s = slotStyle(slotType, w.Slot, parent)
  // 只有固定尺寸（没开 Size To Content）的 CanvasPanel 控件才裁剪文字：
  // 由内容撑开的文字宽高就是内容本身，裁掉会削掉字形下缘和描边
  const clip = slotType === 'CanvasPanelSlot' && !w.Slot?.bAutoSize
  return (
    <div style={s.style} data-slot={ctx.interactive ? w.id : undefined}>
      <UmgBody w={ww} ctx={ctx} fillX={s.fillX} fillY={s.fillY} clip={clip} />
    </div>
  )
}

function Children({ w, ctx }: { w: Widget; ctx: RenderCtx }) {
  const slot = WIDGETS[w.Type]?.slot
  return (
    <>
      {(w.Children ?? []).map((c) => (
        <UmgNode key={c.id} w={c} slotType={slot} parent={w} ctx={ctx} />
      ))}
    </>
  )
}

function UmgBody({
  w,
  ctx,
  fillX,
  fillY,
  clip,
}: {
  w: Widget
  ctx: RenderCtx
  fillX: boolean
  fillY: boolean
  /** 控件在固定尺寸的 CanvasPanelSlot 里：文字超出范围时裁掉 */
  clip?: boolean
}) {
  const p = w.Properties ?? {}
  const [hover, setHover] = useState(false)
  const [press, setPress] = useState(false)
  // 运行模式里临时改的状态（勾选、滑块的值、输入的文字），退出运行模式就丢掉
  const [live, setLive] = useState<{ checked?: boolean; value?: number; text?: string }>({})
  const play = !!ctx.play
  useEffect(() => {
    if (!play) {
      setLive({})
      setHover(false)
      setPress(false)
    }
  }, [play])
  const base: CSSProperties = {
    position: 'relative',
    boxSizing: 'border-box',
    flex: fillX ? '1 1 auto' : '0 0 auto',
    alignSelf: fillY ? 'stretch' : undefined,
    minWidth: 0,
    minHeight: 0,
    // 画刷画在 z-index:-1 的一层里（BrushLayer）：每个控件自己是一个层叠上下文，那一层才不会跑到父控件背景下面
    isolation: 'isolate',
    ...commonStyle(p),
  }
  const id = ctx.interactive ? w.id : undefined
  const el = (style: CSSProperties, children?: ReactNode, extra?: Record<string, unknown>) => (
    <div
      data-wid={id}
      data-type={w.Type}
      data-an={animKey(ctx.tree ?? '', w.Name)}
      style={{ ...base, ...style }}
      {...extra}
    >
      {children}
    </div>
  )
  switch (w.Type) {
    case 'CanvasPanel':
      return el({ width: fillX ? undefined : 0, height: fillY ? undefined : 0 }, <Children w={w} ctx={ctx} />)
    case 'Overlay':
      return el({ display: 'grid', gridTemplate: '100% / 100%' }, <Children w={w} ctx={ctx} />)
    case 'HorizontalBox':
      return el({ display: 'flex', flexDirection: 'row' }, <Children w={w} ctx={ctx} />)
    case 'VerticalBox':
      return el({ display: 'flex', flexDirection: 'column' }, <Children w={w} ctx={ctx} />)
    case 'UniformGridPanel': {
      const kids = w.Children ?? []
      // 格子在属性里设：同一个子控件按格子数、列数排开，每格四周留 SlotPadding，和 UE 的 UniformGridPanel 一样等大
      const comp = ctx.components.get(String(p.EntryWidgetClass ?? ''))
      // 绑定了数据集合：格子数和每格内容都按假数据来（集合是空的就是 0 个格子）
      const dataList = dataRows(ctx.data, w)
      if (!kids.length) {
        const n = dataList ? dataList.length : entryCount(w)
        if (!comp || ctx.depth > 6 || (!dataList && !n))
          return el(
            {
              width: fillX ? undefined : 200,
              height: fillY ? undefined : 120,
              outline: '1px dashed #60a5fa99',
              display: 'grid',
              placeItems: 'center',
              fontSize: 11,
              color: '#60a5fa',
            },
            `${w.Type}${p.EntryWidgetClass ? ` · ${p.EntryWidgetClass}` : ''}${dataList ? ` · ${n} 行数据` : ''}`,
          )
        // 集合有绑定但没有行：空网格，占住原来的位置
        if (dataList && !n) return el({ width: fillX ? undefined : 200, height: fillY ? undefined : 120 })
        const cols = Math.min(n, Math.max(1, Number(p.NumColumns) || 1))
        const sp = p.SlotPadding ?? {}
        const cellW = Math.max(Number(p.MinDesiredSlotWidth) || 0, comp.DesignSize.X + (sp.Left ?? 0) + (sp.Right ?? 0))
        const cellH = Math.max(
          Number(p.MinDesiredSlotHeight) || 0,
          comp.DesignSize.Y + (sp.Top ?? 0) + (sp.Bottom ?? 0),
        )
        const fx = (p.EntryHorizontalAlignment ?? 'HAlign_Fill') === 'HAlign_Fill'
        const fy = (p.EntryVerticalAlignment ?? 'VAlign_Fill') === 'VAlign_Fill'
        const sub = { ...ctx, interactive: false, depth: ctx.depth + 1, tree: comp.Name }
        return el(
          {
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, minmax(${cellW}px, 1fr))`,
            gridTemplateRows: `repeat(${Math.ceil(n / cols)}, minmax(${cellH}px, 1fr))`,
          },
          Array.from({ length: n }, (_, i) => {
            const cell = gridCell(w, i)
            return (
              <div
                key={i}
                style={{
                  gridRow: cell.Row + 1,
                  gridColumn: cell.Column + 1,
                  display: 'flex',
                  minWidth: 0,
                  minHeight: 0,
                  padding: pad(sp),
                  justifyContent: H_JUSTIFY[p.EntryHorizontalAlignment] ?? 'stretch',
                  alignItems: V_ALIGN[p.EntryVerticalAlignment] ?? 'stretch',
                }}
              >
                <div
                  data-ac={comp.Name}
                  style={{
                    display: 'flex',
                    width: fx ? '100%' : comp.DesignSize.X,
                    height: fy ? '100%' : comp.DesignSize.Y,
                  }}
                >
                  <UmgNode w={comp.Root} ctx={dataList ? { ...sub, row: dataList[i] } : sub} />
                </div>
              </div>
            )
          }),
        )
      }
      // 以前存下的、格子各不相同的网格：照旧显示里面的子控件
      const cols = Math.max(1, ...kids.map((k) => (k.Slot?.Column ?? 0) + 1))
      const rows = Math.max(1, ...kids.map((k) => (k.Slot?.Row ?? 0) + 1))
      return el(
        {
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, minmax(${p.MinDesiredSlotWidth || 0}px, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(${p.MinDesiredSlotHeight || 0}px, 1fr))`,
        },
        <Children w={w} ctx={ctx} />,
      )
    }
    case 'WrapBox':
      return el(
        {
          display: 'flex',
          flexWrap: 'wrap',
          flexDirection: p.Orientation === 'Orient_Vertical' ? 'column' : 'row',
          gap: `${p.InnerSlotPadding?.Y ?? 0}px ${p.InnerSlotPadding?.X ?? 0}px`,
          alignContent: 'flex-start',
        },
        <Children w={w} ctx={ctx} />,
      )
    case 'ScrollBox':
      return el(
        {
          display: 'flex',
          flexDirection: p.Orientation === 'Orient_Horizontal' ? 'row' : 'column',
          overflow: 'auto',
          scrollbarWidth: p.ScrollBarVisibility === 'Collapsed' || p.ScrollBarVisibility === 'Hidden' ? 'none' : 'thin',
        },
        <Children w={w} ctx={ctx} />,
      )
    case 'SizeBox':
      return el(
        {
          display: 'flex',
          width: p.WidthOverride > 0 ? p.WidthOverride : undefined,
          height: p.HeightOverride > 0 ? p.HeightOverride : undefined,
          flex: p.WidthOverride > 0 ? '0 0 auto' : base.flex,
          alignSelf: p.HeightOverride > 0 ? undefined : base.alignSelf,
          minWidth: p.MinDesiredWidth || undefined,
          minHeight: p.MinDesiredHeight || undefined,
          maxWidth: p.MaxDesiredWidth || undefined,
          maxHeight: p.MaxDesiredHeight || undefined,
        },
        <Children w={w} ctx={ctx} />,
      )
    case 'ScaleBox':
    case 'WidgetSwitcher': {
      if (w.Type === 'WidgetSwitcher') {
        const i = Math.min(p.ActiveWidgetIndex ?? 0, (w.Children?.length ?? 1) - 1)
        const c = w.Children?.[i]
        return el({ display: 'flex' }, c && <UmgNode w={c} slotType="WidgetSwitcherSlot" parent={w} ctx={ctx} />)
      }
      return el({ display: 'flex' }, <ScaleBoxBody w={w} ctx={ctx} />)
    }
    case 'Border':
      return el(
        { display: 'flex' },
        <>
          <BrushLayer b={p.Background} ctx={ctx} tint={p.BrushColor} />
          <Children w={w} ctx={ctx} />
        </>,
      )
    case 'Button': {
      const ws = p.WidgetStyle ?? {}
      const state =
        p.bIsEnabled === false ? 'Disabled' : play && press ? 'Pressed' : play && hover ? 'Hovered' : 'Normal'
      return el(
        {
          display: 'flex',
          padding: pad(state === 'Pressed' ? ws.PressedPadding : ws.NormalPadding),
          cursor: play && p.bIsEnabled !== false ? 'pointer' : undefined,
        },
        <>
          <BrushLayer b={ws[state]} ctx={ctx} tint={p.BackgroundColor} />
          <Children w={w} ctx={ctx} />
        </>,
        {
          onPointerEnter: () => setHover(true),
          onPointerLeave: () => {
            setHover(false)
            setPress(false)
          },
          onPointerDown: () => setPress(true),
          onPointerUp: () => setPress(false),
        },
      )
    }
    case 'CheckBox': {
      const ws = p.WidgetStyle ?? {}
      const on = play && live.checked !== undefined ? live.checked : p.CheckedState === 'Checked'
      const b: Brush = on ? ws.CheckedImage : ws.UncheckedImage
      return el(
        { display: 'flex', alignItems: 'center', gap: 6, cursor: play ? 'pointer' : undefined },
        <>
          <span
            style={{
              position: 'relative',
              isolation: 'isolate',
              width: b?.ImageSize?.X ?? 24,
              height: b?.ImageSize?.Y ?? 24,
              flex: 'none',
            }}
          >
            <BrushLayer b={b} ctx={ctx} />
          </span>
          <Children w={w} ctx={ctx} />
        </>,
        play && p.bIsEnabled !== false ? { onClick: () => setLive((l) => ({ ...l, checked: !on })) } : undefined,
      )
    }
    case 'Spacer':
      return el({ width: p.Size?.X ?? 0, height: p.Size?.Y ?? 0, flex: base.flex === '1 1 auto' ? base.flex : 'none' })
    case 'Image': {
      const b: Brush = p.Brush
      const x = b?.ImageSize?.X ?? 32
      const y = b?.ImageSize?.Y ?? 32
      return el(
        {
          width: fillX ? undefined : x,
          height: fillY ? undefined : y,
        },
        <>
          <BrushLayer b={b} ctx={ctx} tint={p.ColorAndOpacity} />
          <Sizer x={x} y={y} on={fillX || fillY} />
        </>,
      )
    }
    case 'TextBlock': {
      const f = p.Font ?? {}
      const ol = f.OutlineSettings?.OutlineSize ?? 0
      const sh = p.ShadowColorAndOpacity && parseColor(p.ShadowColorAndOpacity)[3] > 0
      return el(
        {
          color: cssColor(p.ColorAndOpacity),
          fontSize: fontPx(f.Size ?? 24),
          fontWeight: /bold|black|heavy/i.test(f.TypefaceFontName ?? '')
            ? 700
            : /light|thin/i.test(f.TypefaceFontName ?? '')
              ? 300
              : 400,
          fontStyle: /italic/i.test(f.TypefaceFontName ?? '') ? 'italic' : undefined,
          letterSpacing: f.LetterSpacing ? `${f.LetterSpacing / 1000}em` : undefined,
          textAlign: ({ Left: 'left', Center: 'center', Right: 'right' } as const)[p.Justification as 'Left'] ?? 'left',
          whiteSpace: p.AutoWrapText ? 'pre-wrap' : 'pre',
          // 自动换行、不横向撑满的文字按插槽宽度收窄再折行（UE 里按槽位宽度换行）；以前 0 0 auto 永远一行、溢出去
          flex: p.AutoWrapText && !fillX ? '0 1 auto' : base.flex,
          // 固定尺寸时裁掉超出控件范围的文字，不再压到父控件的背景装饰上；长串（没有空格）也按控件宽度断行
          overflow: clip ? 'hidden' : undefined,
          overflowWrap: p.AutoWrapText ? 'anywhere' : undefined,
          lineHeight: 1.2,
          fontFamily: '"Roboto", "Noto Sans SC", system-ui, sans-serif',
          WebkitTextStroke: ol ? `${ol}px ${cssColor(f.OutlineSettings.OutlineColor)}` : undefined,
          paintOrder: ol ? 'stroke fill' : undefined,
          textShadow: sh
            ? `${p.ShadowOffset?.X ?? 1}px ${p.ShadowOffset?.Y ?? 1}px 0 ${cssColor(p.ShadowColorAndOpacity)}`
            : undefined,
        },
        String(p.Text ?? ''),
      )
    }
    case 'ProgressBar': {
      const ws = p.WidgetStyle ?? {}
      const pct = Math.max(0, Math.min(1, Number(p.Percent ?? 0)))
      // 填充条的位置大小（BrushLayer 默认铺满，先清掉 inset 再按方向摆）
      const fill: CSSProperties = { inset: 'auto', zIndex: 0 }
      const dir = p.BarFillType ?? 'LeftToRight'
      if (dir === 'RightToLeft') Object.assign(fill, { top: 0, bottom: 0, right: 0, width: `${pct * 100}%` })
      else if (dir === 'TopToBottom') Object.assign(fill, { left: 0, right: 0, top: 0, height: `${pct * 100}%` })
      else if (dir === 'BottomToTop') Object.assign(fill, { left: 0, right: 0, bottom: 0, height: `${pct * 100}%` })
      else if (dir === 'FillFromCenter')
        Object.assign(fill, { top: 0, bottom: 0, left: `${(1 - pct) * 50}%`, width: `${pct * 100}%` })
      else Object.assign(fill, { top: 0, bottom: 0, left: 0, width: `${pct * 100}%` })
      const bg: Brush | undefined = ws.BackgroundImage
      const bx = bg?.ImageSize?.X ?? 200
      const by = bg?.ImageSize?.Y ?? 16
      return el(
        {
          width: fillX ? undefined : bx,
          height: fillY ? undefined : by,
        },
        <>
          <BrushLayer b={bg} ctx={ctx} />
          <Sizer x={bx} y={by} on={fillX || fillY} />
          <BrushLayer b={ws.FillImage} ctx={ctx} tint={p.FillColorAndOpacity} style={fill} />
        </>,
      )
    }
    case 'Slider': {
      const ws = p.WidgetStyle ?? {}
      const min = Number(p.MinValue ?? 0)
      const range = Number(p.MaxValue ?? 1) - min || 1
      const v = play && live.value !== undefined ? live.value : (Number(p.Value ?? 0) - min) / range
      const th: Brush | undefined = ws.NormalThumbImage
      const vert = p.Orientation === 'Orient_Vertical'
      // 运行模式里按住拖动改值（0~1 的比例）
      const slide = (e: React.PointerEvent<HTMLElement>) => {
        const r = e.currentTarget.getBoundingClientRect()
        const k = vert ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width
        setLive((l) => ({ ...l, value: Math.max(0, Math.min(1, k)) }))
      }
      const sx = vert ? (th?.ImageSize?.X ?? 16) : 160
      const sy = vert ? 160 : (th?.ImageSize?.Y ?? 16)
      return el(
        {
          width: fillX ? undefined : sx,
          height: fillY ? undefined : sy,
          cursor: play ? 'pointer' : undefined,
          touchAction: play ? 'none' : undefined,
        },
        <>
          <Sizer x={sx} y={sy} on={fillX || fillY} />
          <BrushLayer
            b={ws.NormalBarImage}
            ctx={ctx}
            tint={p.SliderBarColor}
            style={{
              inset: 'auto',
              zIndex: 0,
              ...(vert
                ? {
                    left: '50%',
                    top: 0,
                    bottom: 0,
                    width: ws.NormalBarImage?.ImageSize?.X ?? 4,
                    transform: 'translateX(-50%)',
                  }
                : {
                    top: '50%',
                    left: 0,
                    right: 0,
                    height: ws.NormalBarImage?.ImageSize?.Y ?? 4,
                    transform: 'translateY(-50%)',
                  }),
            }}
          />
          <BrushLayer
            b={th}
            ctx={ctx}
            tint={p.SliderHandleColor}
            style={{
              inset: 'auto',
              zIndex: 0,
              width: th?.ImageSize?.X ?? 16,
              height: th?.ImageSize?.Y ?? 16,
              ...(vert
                ? { left: '50%', top: `${(1 - v) * 100}%`, transform: 'translate(-50%,-50%)' }
                : { top: '50%', left: `${v * 100}%`, transform: 'translate(-50%,-50%)' }),
            }}
          />
        </>,
        play
          ? {
              onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                slide(e)
              },
              onPointerMove: (e: React.PointerEvent<HTMLElement>) => e.buttons === 1 && slide(e),
            }
          : undefined,
      )
    }
    case 'EditableTextBox': {
      const f = p.Font ?? {}
      if (play)
        return el(
          {
            display: 'flex',
            alignItems: 'center',
            padding: '4px 8px',
            minWidth: fillX ? 0 : 160,
          },
          <>
            <BrushLayer b={p.WidgetStyle?.BackgroundImageNormal} ctx={ctx} />
            <input
              value={live.text ?? String(p.Text ?? '')}
              placeholder={String(p.HintText ?? '')}
              onChange={(e) => setLive((l) => ({ ...l, text: e.target.value }))}
              style={{
                all: 'unset',
                width: '100%',
                color: cssColor(p.ForegroundColor),
                fontSize: fontPx(f.Size ?? 18),
              }}
            />
          </>,
        )
      return el(
        {
          display: 'flex',
          alignItems: 'center',
          padding: '4px 8px',
          minWidth: fillX ? 0 : 160,
          color: p.Text ? cssColor(p.ForegroundColor) : cssColor('#FFFFFF80'),
          fontSize: fontPx(f.Size ?? 18),
        },
        <>
          <BrushLayer b={p.WidgetStyle?.BackgroundImageNormal} ctx={ctx} />
          {String(p.Text || p.HintText || '')}
        </>,
      )
    }
    case 'ListView':
    case 'TileView':
    case 'DynamicEntryBox': {
      // 条目是运行时生成的：有数据集合时按数据行渲染，否则和 UE 设计器一样预览几条
      const comp = ctx.components.get(String(p.EntryWidgetClass ?? ''))
      const rows = dataRows(ctx.data, w)
      const n = rows ? rows.length : Math.max(0, Math.min(50, Number(p.NumDesignerPreviewEntries) || 0))
      if (!comp || ctx.depth > 6 || (!rows && !n))
        return el(
          {
            width: fillX ? undefined : 200,
            height: fillY ? undefined : 120,
            outline: '1px dashed #60a5fa99',
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            color: '#60a5fa',
          },
          `${w.Type}${p.EntryWidgetClass ? ` · ${p.EntryWidgetClass}` : ''}${rows ? ` · ${n} 行数据` : ''}`,
        )
      const tile = w.Type === 'TileView'
      const vertical =
        w.Type === 'DynamicEntryBox' ? /Vertical/.test(p.EntryBoxType) : p.Orientation !== 'Orient_Horizontal'
      const wrap = tile || /Wrap/.test(p.EntryBoxType ?? '')
      const gap =
        w.Type === 'ListView'
          ? `${p.EntrySpacing ?? 0}px`
          : w.Type === 'DynamicEntryBox'
            ? `${p.EntrySpacing?.Y ?? 0}px ${p.EntrySpacing?.X ?? 0}px`
            : '0'
      const sub = { ...ctx, interactive: false, depth: ctx.depth + 1, tree: comp.Name }
      return el(
        {
          display: p.EntryBoxType === 'Overlay' ? 'grid' : 'flex',
          gridTemplate: p.EntryBoxType === 'Overlay' ? '100% / 100%' : undefined,
          // TileView 竖着滚动时格子横着排满再换行
          flexDirection: tile ? (vertical ? 'row' : 'column') : vertical ? 'column' : 'row',
          flexWrap: wrap ? 'wrap' : 'nowrap',
          alignContent: 'flex-start',
          justifyContent: tile && p.TileAlignment === 'EvenlyDistributed' ? 'space-evenly' : undefined,
          gap,
          // 运行模式里列表能滚动
          overflow: w.Type === 'DynamicEntryBox' ? 'visible' : play ? 'auto' : 'hidden',
        },
        Array.from({ length: n }, (_, i) => {
          // ListView 的条目在交叉方向上撑满列表；列表本身按内容排版时（自动大小的插槽、Automatic 的横竖排）
          // 写 100% 会被压成 0，改成拉伸 + 看不见的占位块给出条目的设计尺寸（和 UserWidget 撑满时同一个办法）
          const stretchW = !tile && vertical && w.Type === 'ListView'
          const stretchH = !tile && !vertical && w.Type === 'ListView'
          const node = <UmgNode w={comp.Root} ctx={rows ? { ...sub, row: rows[i] } : sub} />
          return (
            <div
              key={i}
              data-ac={comp.Name}
              style={{
                display: stretchW || stretchH ? 'grid' : 'flex',
                gridTemplate: stretchW || stretchH ? 'minmax(0, 1fr) / minmax(0, 1fr)' : undefined,
                flex: '0 0 auto',
                alignSelf: stretchW || stretchH ? 'stretch' : undefined,
                width: tile ? p.EntryWidth : stretchW ? undefined : comp.DesignSize.X,
                height: tile ? p.EntryHeight : stretchH ? undefined : comp.DesignSize.Y,
                gridArea: p.EntryBoxType === 'Overlay' ? '1 / 1' : undefined,
              }}
            >
              {stretchW || stretchH ? (
                <>
                  <span
                    aria-hidden
                    data-sizer
                    style={{
                      gridArea: '1 / 1',
                      width: comp.DesignSize.X,
                      height: comp.DesignSize.Y,
                      visibility: 'hidden',
                      pointerEvents: 'none',
                    }}
                  />
                  <div style={{ gridArea: '1 / 1', display: 'flex', minWidth: 0, minHeight: 0 }}>{node}</div>
                </>
              ) : (
                node
              )}
            </div>
          )
        }),
      )
    }
    case 'UserWidget': {
      const comp = ctx.components.get(w.Class ?? '')
      if (!comp || ctx.depth > 6)
        return el(
          {
            width: fillX ? undefined : 96,
            height: fillY ? undefined : 48,
            outline: '1px dashed #94a3b866',
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            color: '#94a3b8',
          },
          w.Class || 'UserWidget',
        )
      // 子控件按自己的设计尺寸显示（放在 CanvasPanel 里时由插槽决定大小）。
      // 撑满时用单格网格：占位块给出设计尺寸（按内容排版时不会被压成 0），子控件的根铺满这一格
      const fill = fillX || fillY
      const inner = (
        <UmgNode w={comp.Root} ctx={{ ...ctx, interactive: false, depth: ctx.depth + 1, tree: comp.Name }} />
      )
      return el(
        fill
          ? {
              display: 'grid',
              gridTemplate: 'minmax(0, 1fr) / minmax(0, 1fr)',
              width: fillX ? undefined : comp.DesignSize.X,
              height: fillY ? undefined : comp.DesignSize.Y,
            }
          : { display: 'flex', width: comp.DesignSize.X, height: comp.DesignSize.Y },
        fill ? (
          <>
            <span
              aria-hidden
              data-sizer
              style={{
                gridArea: '1 / 1',
                width: comp.DesignSize.X,
                height: comp.DesignSize.Y,
                visibility: 'hidden',
                pointerEvents: 'none',
              }}
            />
            <div style={{ gridArea: '1 / 1', display: 'flex', minWidth: 0, minHeight: 0 }}>{inner}</div>
          </>
        ) : (
          inner
        ),
        { 'data-ac': comp.Name },
      )
    }
    default:
      return el({})
  }
}
