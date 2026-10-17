import { cssColor, type Component, type Widget } from './umg.ts'

/**
 * 网页 UI：控件 → CSS。效果图（web-render.tsx）和导出的 HTML（webExport）用同一套规则，看到的就是导出的样子。
 * 布局是 flex：Frame 横排或竖排子控件；宽高写 "auto"（按内容）、"fill"（占满父控件剩下的空间）或像素数。
 */

export type Css = Record<string, string | number>

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
const imgId = (v: unknown) => (typeof v === 'string' && v.startsWith('img:') ? v.slice(4) : '')

/** 宽高：在父控件的排列方向上 fill 是占满剩下的空间，另一个方向是拉伸到和父控件一样 */
function sizing(w: Widget, parent: Widget | undefined, css: Css) {
  const p = w.Properties ?? {}
  const dir = parent?.Properties?.Direction === 'row' ? 'row' : 'column'
  for (const axis of ['Width', 'Height'] as const) {
    const v = p[axis]
    const prop = axis === 'Width' ? 'width' : 'height'
    if (typeof v === 'number') {
      css[prop] = px(v)
      css.flexShrink = 0
    } else if (v === 'fill') {
      if (!parent) css[prop] = '100%'
      else if ((axis === 'Width') === (dir === 'row')) {
        css.flex = '1 1 0'
        css[axis === 'Width' ? 'minWidth' : 'minHeight'] = 0
      } else css.alignSelf = 'stretch'
    }
  }
  const self = w.Slot?.AlignSelf
  if (self && self !== 'auto' && ALIGN[self]) css.alignSelf = ALIGN[self]
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

/** 一个控件的样式（React 的写法：驼峰属性名） */
export function webCss(w: Widget, parent: Widget | undefined, img: (id: string) => string | undefined): Css {
  const p = w.Properties ?? {}
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
      })
      background(p, css, img)
      border(p, css)
      if (p.Shadow && p.Shadow !== 'none') css.boxShadow = SHADOW[p.Shadow] ?? SHADOW.md
      if (p.Overflow && p.Overflow !== 'visible') css.overflow = p.Overflow
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
      })
      background(p, css, img)
      border(p, css)
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
  sizing(w, parent, css)
  return css
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const cssText = (css: Css) =>
  Object.entries(css)
    .map(([k, v]) => `${kebab(k)}: ${v};`)
    .join(' ')
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * 导出成一个 HTML 页面：每个控件一个 class（名字就是控件名，子控件里的加上子控件名前缀），样式写在 <style> 里，
 * 子控件（UserWidget）在用到的地方展开；图片用 images/ 下的文件
 */
export function webExport(d: {
  title: string
  designSize: { X: number; Y: number }
  root: Widget
  components: Component[]
  /** 图片 id → 导出的文件路径 */
  file: (id: string) => string | undefined
}) {
  const rules = new Map<string, string>()
  const comps = new Map(d.components.map((c) => [c.Name, c]))
  const cls = (prefix: string, w: Widget) => `${prefix ? `${prefix}__` : ''}${w.Name}`.replace(/[^A-Za-z0-9_-]/g, '_')
  const node = (w: Widget, parent: Widget | undefined, prefix: string, depth: number, indent: string): string => {
    if (w.Properties?.Visibility === 'Collapsed') return ''
    if (w.Type === 'UserWidget') {
      const c = comps.get(w.Class ?? '')
      return c && depth < 8 ? node(c.Root, parent, c.Name, depth + 1, indent) : ''
    }
    const name = cls(prefix, w)
    if (!rules.has(name)) rules.set(name, cssText(webCss(w, parent, d.file)))
    const p = w.Properties ?? {}
    const kids = (w.Children ?? [])
      .map((c) => node(c, w, prefix, depth, indent + '  '))
      .filter(Boolean)
      .join('\n')
    switch (w.Type) {
      case 'Frame':
        return `${indent}<div class="${name}">${kids ? `\n${kids}\n${indent}` : ''}</div>`
      case 'Text': {
        const tag = ['h1', 'h2', 'h3', 'h4', 'p', 'span', 'label'].includes(p.Tag) ? p.Tag : 'p'
        return `${indent}<${tag} class="${name}">${esc(p.Text)}</${tag}>`
      }
      case 'Picture': {
        const src = imgId(p.Src) ? d.file(imgId(p.Src)) : undefined
        return `${indent}<img class="${name}" src="${esc(src ?? '')}" alt="${esc(p.Alt || w.Name)}">`
      }
      case 'WebButton':
        return `${indent}<button class="${name}" type="button">${esc(p.Text)}</button>`
      case 'Input':
        return p.Multiline
          ? `${indent}<textarea class="${name}" placeholder="${esc(p.Placeholder)}">${esc(p.Value)}</textarea>`
          : `${indent}<input class="${name}" type="${esc(p.InputType || 'text')}" placeholder="${esc(p.Placeholder)}" value="${esc(p.Value)}">`
      case 'Divider':
        return `${indent}<div class="${name}" role="separator"></div>`
      default:
        return ''
    }
  }
  const body = node(d.root, undefined, '', 0, '  ')
  const css = [...rules].map(([k, v]) => `.${k} { ${v} }`).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title)}</title>
<style>
html, body { margin: 0; height: 100%; }
body { font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
${css}
</style>
</head>
<body>
${body}
</body>
</html>
`
}
