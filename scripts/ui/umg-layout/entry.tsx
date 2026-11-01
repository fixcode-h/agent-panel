/**
 * 界面检查用：把 shared/umg-layout.fixtures.ts 的样例树交给画布组件 UmgNode 画出来，
 * 量出每个控件本体的外框（和 CanvasCapture 量截图位置表的方法一样），交给分片和算出来的位置比对。
 * 由 scripts/ui/11-umg-layout.mjs 用 esbuild 现场打包，不进正式包也不进演示版。
 */
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { UmgNode } from '@/components/design/umg-render'
import { layoutFixtures } from '@shared/umg-layout.fixtures'
import { layoutTree } from '@shared/umg-layout'
import { webLayoutFixtures } from '@shared/web-layout.fixtures'
import { webLayoutTree } from '@shared/web-layout'
import { walk, type Widget } from '@shared/umg'

const host = document.getElementById('root')!
const root = createRoot(host)

;(window as any).__measure = (index: number) => {
  const f = layoutFixtures()[index]
  flushSync(() =>
    root.render(
      <div id="box" style={{ width: f.size.X, height: f.size.Y, position: 'relative', overflow: 'hidden' }}>
        <UmgNode
          w={f.root}
          ctx={{
            images: new Map(),
            components: new Map((f.components ?? []).map((c) => [c.Name, c])),
            interactive: true,
            depth: 0,
            play: false,
          }}
        />
      </div>,
    ),
  )
  const el = document.getElementById('box')!
  const byId = new Map<string, Widget>()
  walk(f.root, (x) => byId.set(x.id, x))
  const base = el.getBoundingClientRect()
  const dom = [...el.querySelectorAll<HTMLElement>('[data-wid]')].flatMap((n) => {
    const x = byId.get(n.dataset.wid ?? '')
    if (!x) return []
    const r = n.getBoundingClientRect()
    return [{ name: x.Name, x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }]
  })
  const calc = layoutTree(f.root, { size: f.size, components: f.components ?? [] }) ?? []
  return { name: f.name, dom, calc }
}
;(window as any).__count = layoutFixtures().length

// 网页设计：画布组件按 WebNode 画（根控件是 Frame），和 web-layout.ts 算出来的比
;(window as any).__measureWeb = (index: number) => {
  const f = webLayoutFixtures()[index]
  flushSync(() =>
    root.render(
      <div id="box" style={{ width: f.size.X, height: f.size.Y, position: 'relative', overflow: 'hidden' }}>
        <UmgNode
          w={f.root}
          ctx={{
            images: new Map(),
            components: new Map(),
            interactive: true,
            depth: 0,
            play: false,
            device: 'desktop',
          }}
        />
      </div>,
    ),
  )
  const el = document.getElementById('box')!
  const byId = new Map<string, Widget>()
  walk(f.root, (x) => byId.set(x.id, x))
  const base = el.getBoundingClientRect()
  const dom = [...el.querySelectorAll<HTMLElement>('[data-wid]')].flatMap((n) => {
    const x = byId.get(n.dataset.wid ?? '')
    if (!x) return []
    const r = n.getBoundingClientRect()
    return [{ name: x.Name, x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }]
  })
  const calc = webLayoutTree(f.root, { size: f.size, components: [] })
  return { name: f.name, dom, calc }
}
;(window as any).__countWeb = webLayoutFixtures().length
