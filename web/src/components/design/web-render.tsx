import { createElement, useState, type CSSProperties } from 'react'
import type { Widget } from '@shared/umg'
import { webCss } from '@shared/web'
import type { RenderCtx } from './umg-render'

/**
 * 网页 UI 的效果图：按 shared/web.ts 的规则画出来，和导出的 HTML 一致。
 * 子控件（UserWidget）画成它的根控件，选中时选的是引用它的那个 UserWidget
 */
export function WebNode({ w, parent, ctx, wid }: { w: Widget; parent?: Widget; ctx: RenderCtx; wid?: string }) {
  const [hover, setHover] = useState(false)
  const [text, setText] = useState<string>()
  if (w.Properties?.Visibility === 'Collapsed') return null
  const p = w.Properties ?? {}
  const id = wid ?? (ctx.interactive ? w.id : undefined)
  if (w.Type === 'UserWidget') {
    const comp = ctx.components.get(w.Class ?? '')
    if (!comp || ctx.depth > 6)
      return (
        <div
          data-wid={id}
          style={{
            padding: '12px 16px',
            outline: '1px dashed #ff00ff88',
            color: '#ff66ff',
            fontSize: 11,
          }}
        >
          {w.Class || 'UserWidget'}
        </div>
      )
    return <WebNode w={comp.Root} parent={parent} ctx={{ ...ctx, interactive: false, depth: ctx.depth + 1 }} wid={id} />
  }
  const style = webCss(w, parent, (img) => ctx.images.get(img)?.url) as CSSProperties
  const play = !!ctx.play
  const common = { 'data-wid': id, 'data-type': w.Type, style }
  switch (w.Type) {
    case 'Frame':
      return (
        <div {...common}>
          {(w.Children ?? []).map((c) => (
            <WebNode key={c.id} w={c} parent={w} ctx={ctx} />
          ))}
        </div>
      )
    case 'Text':
      return createElement(
        ['h1', 'h2', 'h3', 'h4', 'p', 'span', 'label'].includes(p.Tag) ? p.Tag : 'p',
        common,
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
              background: 'repeating-linear-gradient(45deg,#9ca3af22 0 6px,#0000 6px 12px)',
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
          onPointerEnter={() => play && setHover(true)}
          onPointerLeave={() => setHover(false)}
          // 运行模式里鼠标移上去稍微变亮，像真的按钮
          style={{ ...style, filter: hover && play ? 'brightness(1.08)' : undefined }}
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
