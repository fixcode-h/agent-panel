import { cssColor, deepMerge, type Component, type Widget } from './umg.ts'
import { animKey, animRuntime, animRuntimeSource, compileAnimations, type UiAnimation } from './anim.ts'

/**
 * 网页 UI：控件 → CSS。效果图（web-render.tsx）和导出的 HTML、React 组件用同一套规则，看到的就是导出的样子。
 * 布局是 flex：Frame 横排或竖排子控件；宽高写 "auto"（按内容）、"fill"（占满父控件剩下的空间）或像素数。
 *
 * 断点：Properties.Tablet（宽度 ≤ 1023）、Properties.Mobile（≤ 767）里写这个宽度下要改的属性，按顺序叠在上面；
 * Properties.Hover 是鼠标移上去时的样式。插槽里 Position 为 absolute 时按 Pin 角 + X、Y 偏移贴在父控件上（角标、浮层）。
 */

export type Css = Record<string, string | number>
export type Device = 'desktop' | 'tablet' | 'mobile'
export const DEVICE_MAX: Record<Exclude<Device, 'desktop'>, number> = { tablet: 1023, mobile: 767 }
/** 预览时的宽度：桌面是设计稿宽度 */
export const DEVICE_WIDTH: Record<Exclude<Device, 'desktop'>, number> = { tablet: 768, mobile: 390 }
/** 这些属性是按宽度 / 悬停叠上去的改动，不是样式本身 */
export const OVERRIDES = ['Tablet', 'Mobile', 'Hover'] as const
/** 断点里属性存在哪个键下 */
export const DEVICE_KEY: Record<Exclude<Device, 'desktop'>, 'Tablet' | 'Mobile'> = {
  tablet: 'Tablet',
  mobile: 'Mobile',
}

const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }
const JUSTIFY: Record<string, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
  evenly: 'space-evenly',
}
export const SHADOW: Record<string, string> = {
  none: 'none',
  sm: '0 1px 2px rgba(0,0,0,0.08)',
  md: '0 4px 12px rgba(0,0,0,0.12)',
  lg: '0 12px 32px rgba(0,0,0,0.18)',
}

const px = (n: unknown) => `${Number(n) || 0}px`
const pad = (m: any) => (m && typeof m === 'object' ? `${px(m.Top)} ${px(m.Right)} ${px(m.Bottom)} ${px(m.Left)}` : '0')
export const imgId = (v: unknown) => (typeof v === 'string' && v.startsWith('img:') ? v.slice(4) : '')

/** 某个宽度下（以及悬停时）实际用的属性：桌面的属性叠上平板、手机的改动 */
export function propsAt(p: Record<string, any> | undefined, device: Device = 'desktop', hover = false) {
  const base: Record<string, any> = { ...(p ?? {}) }
  for (const k of OVERRIDES) delete base[k]
  let out = base
  if (device !== 'desktop' && p?.Tablet) out = deepMerge(out, p.Tablet)
  if (device === 'mobile' && p?.Mobile) out = deepMerge(out, p.Mobile)
  if (hover && p?.Hover) out = deepMerge(out, p.Hover)
  return out
}

/** 绝对定位（插槽里 Position: absolute）：按 Pin 的角贴在父控件上，X、Y 是离那个角的距离 */
const absolute = (slot: any) => slot?.Position === 'absolute'

function position(slot: any, css: Css) {
  if (!absolute(slot)) return
  css.position = 'absolute'
  const pin = String(slot.Pin ?? 'top-left')
  if (pin === 'center') {
    css.left = `calc(50% + ${px(slot.X)})`
    css.top = `calc(50% + ${px(slot.Y)})`
    css.transform = 'translate(-50%, -50%)'
  } else {
    css[pin.startsWith('bottom') ? 'bottom' : 'top'] = px(slot.Y)
    css[pin.endsWith('right') ? 'right' : 'left'] = px(slot.X)
  }
  if (Number(slot.ZIndex)) css.zIndex = Number(slot.ZIndex)
}

/** 宽高：在父控件的排列方向上 fill 是占满剩下的空间，另一个方向是拉伸到和父控件一样；绝对定位时 fill 是父控件的 100% */
function sizing(p: Record<string, any>, w: Widget, parentProps: Record<string, any> | undefined, css: Css) {
  const dir = parentProps?.Direction === 'row' ? 'row' : 'column'
  const free = !parentProps || absolute(w.Slot)
  for (const axis of ['Width', 'Height'] as const) {
    const v = p[axis]
    const prop = axis === 'Width' ? 'width' : 'height'
    if (typeof v === 'number') {
      css[prop] = px(v)
      css.flexShrink = 0
    } else if (v === 'fill') {
      if (free) css[prop] = '100%'
      else if ((axis === 'Width') === (dir === 'row')) {
        css.flex = '1 1 0'
        css[axis === 'Width' ? 'minWidth' : 'minHeight'] = 0
      } else css.alignSelf = 'stretch'
    }
  }
  const self = w.Slot?.AlignSelf
  if (!free && self && self !== 'auto' && ALIGN[self]) css.alignSelf = ALIGN[self]
}

const border = (p: Record<string, any>, css: Css) => {
  if (Number(p.BorderWidth) > 0) css.border = `${px(p.BorderWidth)} solid ${cssColor(p.BorderColor)}`
  if (Number(p.Radius) > 0) css.borderRadius = px(p.Radius)
}

const background = (p: Record<string, any>, css: Css, img: (id: string) => string | undefined) => {
  const c = cssColor(p.Background ?? '#00000000')
  if (!/,0\)$/.test(c)) css.backgroundColor = c
  const url = imgId(p.BackgroundImage) && img(imgId(p.BackgroundImage))
  if (url) {
    css.backgroundImage = `url("${url}")`
    css.backgroundSize = 'cover'
    css.backgroundPosition = 'center'
  }
}

/** 一个控件在某个宽度下（悬停时）的样式（React 的写法：驼峰属性名） */
export function webCss(
  w: Widget,
  parent: Widget | undefined,
  img: (id: string) => string | undefined,
  o: { device?: Device; hover?: boolean } = {},
): Css {
  const p = propsAt(w.Properties, o.device, o.hover)
  const pp = parent ? propsAt(parent.Properties, o.device) : undefined
  const css: Css = { boxSizing: 'border-box' }
  if (p.Visibility === 'Hidden') css.visibility = 'hidden'
  if (p.RenderOpacity !== undefined && p.RenderOpacity !== 1) css.opacity = p.RenderOpacity
  switch (w.Type) {
    case 'Frame':
      Object.assign(css, {
        display: 'flex',
        position: 'relative',
        flexDirection: p.Direction === 'row' ? 'row' : 'column',
        gap: px(p.Gap),
        padding: pad(p.Padding),
        alignItems: ALIGN[p.AlignItems] ?? 'stretch',
        justifyContent: JUSTIFY[p.JustifyContent] ?? 'flex-start',
        flexWrap: p.Wrap ? 'wrap' : 'nowrap',
        // 做成链接时去掉下划线和链接色
        ...(p.Href ? { textDecoration: 'none', color: 'inherit' } : {}),
      })
      background(p, css, img)
      border(p, css)
      if (p.Shadow && p.Shadow !== 'none') css.boxShadow = SHADOW[p.Shadow] ?? SHADOW.md
      if (p.Overflow === 'scroll-x') Object.assign(css, { overflowX: 'auto', overflowY: 'hidden' })
      else if (p.Overflow === 'scroll-y') Object.assign(css, { overflowY: 'auto', overflowX: 'hidden' })
      else if (p.Overflow && p.Overflow !== 'visible') css.overflow = p.Overflow
      break
    case 'Text':
      Object.assign(css, {
        margin: 0,
        fontSize: px(p.FontSize ?? 16),
        fontWeight: p.FontWeight ?? 400,
        color: cssColor(p.Color ?? '#111827FF'),
        textAlign: p.TextAlign ?? 'left',
        lineHeight: p.LineHeight ?? 1.5,
        whiteSpace: 'pre-wrap',
        ...(p.Href ? { textDecoration: p.Underline ? 'underline' : 'none' } : {}),
      })
      if (p.LetterSpacing) css.letterSpacing = px(p.LetterSpacing)
      break
    case 'Picture':
      Object.assign(css, { display: 'block', objectFit: p.Fit ?? 'cover' })
      if (Number(p.Radius) > 0) css.borderRadius = px(p.Radius)
      break
    case 'WebButton':
      Object.assign(css, {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: pad(p.Padding),
        fontSize: px(p.FontSize ?? 14),
        fontWeight: p.FontWeight ?? 500,
        color: cssColor(p.Color ?? '#FFFFFFFF'),
        cursor: 'pointer',
        fontFamily: 'inherit',
        border: 0,
        textDecoration: 'none',
      })
      background(p, css, img)
      border(p, css)
      if (p.Shadow && p.Shadow !== 'none') css.boxShadow = SHADOW[p.Shadow] ?? SHADOW.md
      break
    case 'Input':
      Object.assign(css, {
        padding: pad(p.Padding),
        fontSize: px(p.FontSize ?? 14),
        color: cssColor(p.Color ?? '#111827FF'),
        fontFamily: 'inherit',
        outline: 'none',
        resize: 'none',
      })
      background(p, css, img)
      border(p, css)
      break
    case 'Divider':
      Object.assign(css, {
        flexShrink: 0,
        alignSelf: 'stretch',
        background: cssColor(p.Color ?? '#E5E7EBFF'),
        [p.Vertical ? 'width' : 'height']: px(p.Thickness ?? 1),
      })
      break
  }
  // 有悬停样式的控件变化时带一点过渡
  if (w.Properties?.Hover) css.transition = 'all 0.15s ease'
  sizing(p, w, pp, css)
  position(w.Slot, css)
  // 这个宽度下隐藏（例如手机上不显示侧栏）
  if (p.Visibility === 'Collapsed') css.display = 'none'
  return css
}

/** 只留下 b 里和 a 不一样的（断点、悬停只写改了的样式） */
export function cssDiff(a: Css, b: Css): Css {
  const out: Css = {}
  for (const [k, v] of Object.entries(b)) if (a[k] !== v) out[k] = v
  // a 有、b 没有的（例如手机上不再固定宽度）要写回默认值
  for (const k of Object.keys(a)) if (!(k in b)) out[k] = 'initial'
  return out
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const cssText = (css: Css) =>
  Object.entries(css)
    .map(([k, v]) => `${kebab(k)}: ${v};`)
    .join(' ')
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const TEXT_TAGS = ['h1', 'h2', 'h3', 'h4', 'p', 'span', 'label']
const textTag = (p: Record<string, any>) => (TEXT_TAGS.includes(p.Tag) ? p.Tag : 'p')

/** 导出用：遍历控件树（子控件在用到的地方展开），每个控件给出 class 名、各个宽度下和悬停时的样式 */
interface Node {
  w: Widget
  p: Record<string, any>
  cls: string
  styles: { base: Css; tablet: Css; mobile: Css; hover?: Css }
  kids: Node[]
  /** 子控件（UserWidget）展开出来的，记下子控件名 */
  component?: string
  /** 动画用的标记（data-an）：主界面的控件名，子控件里的是「子控件名/控件名」；子控件的根还带引用它的控件名 */
  an: string
}

function buildNodes(d: { root: Widget; components: Component[]; file: (id: string) => string | undefined }) {
  const comps = new Map(d.components.map((c) => [c.Name, c]))
  const cls = (prefix: string, w: Widget) => `${prefix ? `${prefix}__` : ''}${w.Name}`.replace(/[^A-Za-z0-9_-]/g, '_')
  const walk = (w: Widget, parent: Widget | undefined, prefix: string, depth: number): Node | undefined => {
    if (w.Type === 'UserWidget') {
      const c = comps.get(w.Class ?? '')
      if (!c || depth >= 8) return undefined
      // 子控件的根控件在这里的样子：插槽和可见性用引用它的 UserWidget 的
      const n = walk({ ...c.Root, Slot: w.Slot ?? c.Root.Slot }, parent, c.Name, depth + 1)
      return n && { ...n, component: c.Name, an: `${animKey(prefix, w.Name)} ${n.an}` }
    }
    const style = (o: { device?: Device; hover?: boolean }) => webCss(w, parent, d.file, o)
    const base = style({})
    const tablet = style({ device: 'tablet' })
    const mobile = style({ device: 'mobile' })
    return {
      w,
      p: propsAt(w.Properties),
      cls: cls(prefix, w),
      styles: {
        base,
        tablet: cssDiff(base, tablet),
        mobile: cssDiff(tablet, mobile),
        hover: w.Properties?.Hover ? cssDiff(base, style({ hover: true })) : undefined,
      },
      kids: (w.Children ?? []).map((c) => walk(c, w, prefix, depth)).filter(Boolean) as Node[],
      an: animKey(prefix, w.Name),
    }
  }
  return walk(d.root, undefined, '', 0)
}

/**
 * 导出成一个 HTML 页面：每个控件一个 class（名字就是控件名，子控件里的加上子控件名前缀），样式写在 <style> 里，
 * 平板、手机的改动写成媒体查询，悬停写成 :hover；子控件在用到的地方展开；图片用 images/ 下的文件
 */
export function webExport(d: {
  title: string
  designSize: { X: number; Y: number }
  root: Widget
  components: Component[]
  /** 图片 id → 导出的文件路径 */
  file: (id: string) => string | undefined
  animations?: UiAnimation[]
}) {
  const runs = compileAnimations(d.animations ?? [])
  // 有动画时给控件打上标记，播放代码按标记找控件
  const mark = (n: Node) =>
    runs.length ? ` data-an="${esc(n.an)}"${n.component ? ` data-ac="${esc(n.component)}"` : ''}` : ''
  const base = new Map<string, Css>()
  const hover = new Map<string, Css>()
  const tablet = new Map<string, Css>()
  const mobile = new Map<string, Css>()
  const html = (n: Node, indent: string): string => {
    if (!base.has(n.cls)) {
      base.set(n.cls, n.styles.base)
      if (n.styles.hover && Object.keys(n.styles.hover).length) hover.set(n.cls, n.styles.hover)
      if (Object.keys(n.styles.tablet).length) tablet.set(n.cls, n.styles.tablet)
      if (Object.keys(n.styles.mobile).length) mobile.set(n.cls, n.styles.mobile)
    }
    const { w, p } = n
    const kids = n.kids.map((c) => html(c, indent + '  ')).join('\n')
    const href = p.Href ? ` href="${esc(p.Href)}"` : ''
    switch (w.Type) {
      case 'Frame': {
        const tag = p.Href ? 'a' : 'div'
        return `${indent}<${tag} class="${n.cls}"${mark(n)}${href}>${kids ? `\n${kids}\n${indent}` : ''}</${tag}>`
      }
      case 'Text': {
        const tag = p.Href ? 'a' : textTag(p)
        return `${indent}<${tag} class="${n.cls}"${mark(n)}${href}>${esc(p.Text)}</${tag}>`
      }
      case 'Picture': {
        const img = `<img class="${n.cls}"${mark(n)} src="${esc((imgId(p.Src) && d.file(imgId(p.Src))) || '')}" alt="${esc(p.Alt || w.Name)}">`
        return p.Href ? `${indent}<a${href}>${img}</a>` : `${indent}${img}`
      }
      case 'WebButton':
        return p.Href
          ? `${indent}<a class="${n.cls}"${mark(n)}${href}>${esc(p.Text)}</a>`
          : `${indent}<button class="${n.cls}"${mark(n)} type="button">${esc(p.Text)}</button>`
      case 'Input':
        return p.Multiline
          ? `${indent}<textarea class="${n.cls}"${mark(n)} placeholder="${esc(p.Placeholder)}">${esc(p.Value)}</textarea>`
          : `${indent}<input class="${n.cls}"${mark(n)} type="${esc(p.InputType || 'text')}" placeholder="${esc(p.Placeholder)}" value="${esc(p.Value)}">`
      case 'Divider':
        return `${indent}<div class="${n.cls}"${mark(n)} role="separator"></div>`
      default:
        return ''
    }
  }
  const root = buildNodes(d)
  const body = root ? html(root, '  ') : ''
  const rules = (m: Map<string, Css>, suffix = '', indent = '') =>
    [...m].map(([k, v]) => `${indent}.${k}${suffix} { ${cssText(v)} }`).join('\n')
  const media = (m: Map<string, Css>, max: number) =>
    m.size ? `@media (max-width: ${max}px) {\n${rules(m, '', '  ')}\n}` : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title)}</title>
<style>
html, body { margin: 0; height: 100%; }
body { font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
${[rules(base), rules(hover, ':hover'), media(tablet, DEVICE_MAX.tablet), media(mobile, DEVICE_MAX.mobile)].filter(Boolean).join('\n')}
</style>
</head>
<body>
${body}
${runs.length ? `<script>\n${animRuntimeSource(runs)}\n</script>\n` : ''}</body>
</html>
`
}

/** 常见的写法换成 Tailwind 自带的类，读起来更像手写的；其余用任意属性写法 [gap:12px] */
const TW: Record<string, string> = {
  'display:flex': 'flex',
  'display:inline-flex': 'inline-flex',
  'display:block': 'block',
  'display:none': 'hidden',
  'flex-direction:row': 'flex-row',
  'flex-direction:column': 'flex-col',
  'flex-wrap:wrap': 'flex-wrap',
  'position:relative': 'relative',
  'position:absolute': 'absolute',
  'align-items:center': 'items-center',
  'align-items:flex-start': 'items-start',
  'align-items:flex-end': 'items-end',
  'justify-content:center': 'justify-center',
  'justify-content:space-between': 'justify-between',
  'justify-content:flex-end': 'justify-end',
  'object-fit:cover': 'object-cover',
  'object-fit:contain': 'object-contain',
  'flex-shrink:0': 'shrink-0',
  'width:100%': 'w-full',
  'height:100%': 'h-full',
  'cursor:pointer': 'cursor-pointer',
  'text-decoration:none': 'no-underline',
  'white-space:pre-wrap': 'whitespace-pre-wrap',
  'margin:0': 'm-0',
}
/** Tailwind 预置样式里已经是这样、不用再写的（只在基础样式里省掉，断点和悬停里照写） */
const TW_DEFAULT = new Set([
  'box-sizing:border-box',
  'flex-wrap:nowrap',
  'align-items:stretch',
  'justify-content:flex-start',
  'padding:0px 0px 0px 0px',
  'gap:0px',
])

/** CSS → Tailwind 类：值里的空格换成下划线；背景图在 React 里用 import 进来的地址，写在 style 里 */
const tw = (css: Css, variant = '') =>
  Object.entries(css)
    .filter(([k]) => k !== 'backgroundImage')
    .map(([k, v]) => `${kebab(k)}:${v}`)
    .filter((d) => variant || !TW_DEFAULT.has(d))
    .map((d) => `${variant}${TW[d] ?? `[${d.replace(/_/g, '\\_').replace(/\s+/g, '_')}]`}`)
    .join(' ')

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((x) => x[0].toUpperCase() + x.slice(1))
    .join('') || 'Page'

/**
 * 导出成 React + Tailwind 组件（.tsx）：每个子控件一个组件，页面是默认导出；
 * 样式写成 Tailwind 的任意属性类，平板、手机用 max-lg: / max-md:，悬停用 hover:；图片从 ./images/ 引入
 */
export function webReactExport(d: {
  title: string
  root: Widget
  components: Component[]
  /** 图片 id → images/ 下的文件名（不含目录） */
  file: (id: string) => string | undefined
  animations?: UiAnimation[]
}) {
  const runs = compileAnimations(d.animations ?? [])
  const imports = new Map<string, string>()
  const imgVar = (id: string) => {
    const f = d.file(id)
    if (!f) return undefined
    if (!imports.has(f)) imports.set(f, `img${pascal(f.replace(/\.[^.]+$/, ''))}`)
    return imports.get(f)!
  }
  // 先用占位的地址算样式，背景图在 style 里换成变量
  const nodes = buildNodes({ ...d, file: (id) => (d.file(id) ? `__img:${id}` : undefined) })
  const used = new Map<string, Node>()
  const str = (v: unknown) => JSON.stringify(String(v ?? ''))
  const jsx = (n: Node, indent: string, inComponent?: string): string => {
    // 子控件展开的地方换成组件
    if (n.component && n.component !== inComponent) {
      if (!used.has(n.component)) used.set(n.component, n)
      return `${indent}<${pascal(n.component)} />`
    }
    const { w, p } = n
    const className = [
      tw(n.styles.base),
      tw(n.styles.tablet, 'max-lg:'),
      tw(n.styles.mobile, 'max-md:'),
      n.styles.hover ? tw(n.styles.hover, 'hover:') : '',
    ]
      .filter(Boolean)
      .join(' ')
    const bg = imgId(p.BackgroundImage) && imgVar(imgId(p.BackgroundImage))
    const marks = runs.length ? ` data-an=${str(n.an)}${n.component ? ` data-ac=${str(n.component)}` : ''}` : ''
    const attrs = `className=${str(className)}${marks}${bg ? ` style={{ backgroundImage: \`url(\${${bg}})\` }}` : ''}${p.Href ? ` href=${str(p.Href)}` : ''}`
    const kids = n.kids.map((c) => jsx(c, indent + '  ', inComponent)).join('\n')
    switch (w.Type) {
      case 'Frame': {
        const tag = p.Href ? 'a' : 'div'
        return kids ? `${indent}<${tag} ${attrs}>\n${kids}\n${indent}</${tag}>` : `${indent}<${tag} ${attrs} />`
      }
      case 'Text': {
        const tag = p.Href ? 'a' : textTag(p)
        return `${indent}<${tag} ${attrs}>{${str(p.Text)}}</${tag}>`
      }
      case 'Picture': {
        const src = imgId(p.Src) && imgVar(imgId(p.Src))
        const img = `<img ${attrs.replace(/ href=.*$/, '')} src={${src || '""'}} alt=${str(p.Alt || w.Name)} />`
        return p.Href ? `${indent}<a href=${str(p.Href)}>${img}</a>` : `${indent}${img}`
      }
      case 'WebButton':
        return p.Href
          ? `${indent}<a ${attrs}>{${str(p.Text)}}</a>`
          : `${indent}<button type="button" ${attrs}>{${str(p.Text)}}</button>`
      case 'Input':
        return p.Multiline
          ? `${indent}<textarea ${attrs} placeholder=${str(p.Placeholder)} defaultValue=${str(p.Value)} />`
          : `${indent}<input ${attrs} type=${str(p.InputType || 'text')} placeholder=${str(p.Placeholder)} defaultValue=${str(p.Value)} />`
      case 'Divider':
        return `${indent}<div ${attrs} role="separator" />`
      default:
        return ''
    }
  }
  const page = nodes ? jsx(nodes, '    ') : '    null'
  // 子控件可能还引用别的子控件：一直展开到没有新的
  const parts: string[] = []
  for (let i = 0; i < used.size; i++) {
    const [name, n] = [...used][i]
    parts.push(`export function ${pascal(name)}() {\n  return (\n${jsx(n, '    ', name)}\n  )\n}`)
  }
  const head = [
    ...(runs.length ? ["import { useEffect } from 'react'", "import { animRuntime } from './ui-anim'"] : []),
    ...[...imports].map(([f, v]) => `import ${v} from './images/${f}'`),
  ].join('\n')
  // 动画：页面挂上以后按触发方式播放（打开时、滚动到可见、悬停、点击）
  const effect = runs.length
    ? `  useEffect(() => {
    const ctl = animRuntime(document.body, ANIMATIONS, { triggers: true })
    return () => ctl.dispose()
  }, [])
`
    : ''
  return `// ${d.title}：由 Agent 面板的 UI 设计导出（React + Tailwind CSS）
${head}${head ? '\n' : ''}${runs.length ? `\nconst ANIMATIONS = ${JSON.stringify(runs)}\n` : ''}
${parts.join('\n\n')}${parts.length ? '\n\n' : ''}export default function ${pascal(d.title)}() {
${effect}  return (
${page}
  )
}
`
}

/** React 导出里的动画播放代码（ui-anim.ts）：和导出的 HTML 用的是同一个函数，只用浏览器自带的 Web Animations */
export function reactAnimFile() {
  return `// @ts-nocheck
// 由 Agent 面板导出：播放 UI 设计里的动画（浏览器自带的 Web Animations，不依赖动画库）
export const animRuntime = ${animRuntime.toString()}
`
}
