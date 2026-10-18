import { createElement, useState, type CSSProperties } from 'react'
import type { Widget } from '@shared/umg'
import { propsAt, webCss } from '@shared/web'
import type { RenderCtx } from './umg-render'

/**
 * 网页 UI 的效果图：按 shared/web.ts 的规则画出来，和导出的 HTML 一致。
 * 子控件（UserWidget）画成它的根控件，选中时选的是引用它的那个 UserWidget
 */
export function WebNode({ w, parent, ctx, wid }: { w: Widget; parent?: Widget; ctx: RenderCtx; wid?: string }) {
  const [hover, setHover] = useState(false)
  const [text, setText] = useState<string>()
  const device = ctx.device ?? 'desktop'
  const play = !!ctx.play
  // 运行模式里鼠标移上去时用悬停样式
  const over = play && hover && !!w.Properties?.Hover
  const p = propsAt(w.Properties, device, over)
  const id = wid ?? (ctx.interactive ? w.id : undefined)
  if (w.Type === 'UserWidget') {
    const comp = ctx.components.get(w.Class ?? '')
    if (!comp || ctx.depth > 6)
      return (
        <div
          data-wid={id}
          style={{
            padding: '12px 16px',
            outline: '1px dashed #94a3b866',
            color: '#94a3b8',
            fontSize: 11,
          }}
        >
          {w.Class || 'UserWidget'}
        </div>
      )
    // 插槽（绝对定位、对齐）用引用它的 UserWidget 的
    return (
      <WebNode
        w={{ ...comp.Root, Slot: w.Slot }}
        parent={parent}
        ctx={{ ...ctx, interactive: false, depth: ctx.depth + 1 }}
        wid={id}
      />
    )
  }
  const style = webCss(w, parent, (img) => ctx.images.get(img)?.url, { device, hover: over }) as CSSProperties
  const common = {
    'data-wid': id,
    'data-type': w.Type,
    style,
    ...(w.Properties?.Hover ? { onPointerEnter: () => setHover(true), onPointerLeave: () => setHover(false) } : {}),
  }
  // 链接画成 <a>，但在设计器里点了不跳转
  const link = p.Href
    ? { href: String(p.Href), onClick: (e: { preventDefault: () => void }) => e.preventDefault() }
    : {}
  switch (w.Type) {
    case 'Frame':
      return createElement(
        p.Href ? 'a' : 'div',
        { ...common, ...link },
        (w.Children ?? []).map((c) => <WebNode key={c.id} w={c} parent={w} ctx={ctx} />),
      )
    case 'Text':
      return createElement(
        p.Href ? 'a' : ['h1', 'h2', 'h3', 'h4', 'p', 'span', 'label'].includes(p.Tag) ? p.Tag : 'p',
        { ...common, ...link },
        String(p.Text ?? ''),
      )
    case 'Picture': {
      const src = typeof p.Src === 'string' && p.Src.startsWith('img:') ? ctx.images.get(p.Src.slice(4))?.url : ''
      if (!src)
        return (
          <div
            {...common}
            style={{
              ...style,
              background: 'repeating-linear-gradient(45deg,#94a3b81f 0 8px,#0000 8px 16px)',
              outline: '1px dashed #9ca3af88',
            }}
          />
        )
      return <img {...common} src={src} alt={p.Alt || w.Name} draggable={false} />
    }
    case 'WebButton':
      return (
        <button
          {...common}
          type="button"
          tabIndex={play ? 0 : -1}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          // 运行模式里鼠标移上去：有悬停样式用悬停样式，没有就稍微变亮，像真的按钮
          style={{ ...style, filter: hover && play && !w.Properties?.Hover ? 'brightness(1.08)' : undefined }}
        >
          {String(p.Text ?? '')}
        </button>
      )
    case 'Input': {
      const props = {
        ...common,
        placeholder: String(p.Placeholder ?? ''),
        value: play ? (text ?? String(p.Value ?? '')) : String(p.Value ?? ''),
        readOnly: !play,
        tabIndex: play ? 0 : -1,
        onChange: (e: { target: { value: string } }) => setText(e.target.value),
      }
      return p.Multiline ? <textarea {...props} /> : <input {...props} type={p.InputType || 'text'} />
    }
    case 'Divider':
      return <div {...common} />
    default:
      return null
  }
}
