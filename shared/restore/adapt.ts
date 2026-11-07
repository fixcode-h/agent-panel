import { layoutTree } from '../umg-layout.ts'
import type { DesignData } from '../design-data.ts'
import type { Component, Widget } from '../umg.ts'

/**
 * 多分辨率检查（交付那一步）：高度不变，把宽度换成别的比例重新排一遍，
 * 看挂在根上的控件有没有跑出画面、有没有原来不重叠现在叠上的。锚点推断得对，这些都不该出现
 */
export interface AdaptIssue {
  ratio: string
  widget: string
  kind: 'out' | 'overlap'
  other?: string
}

export const RATIOS: { label: string; w: number; h: number }[] = [
  { label: '21:9', w: 21, h: 9 },
  { label: '16:10', w: 16, h: 10 },
  { label: '4:3', w: 4, h: 3 },
]

export function checkAdapt(o: {
  root: Widget
  components: Component[]
  data?: DesignData
  size: { X: number; Y: number }
}): { ratio: string; issues: AdaptIssue[] }[] {
  const top = new Set((o.root.Children ?? []).filter((c) => !/_Bg$/.test(c.Name)).map((c) => c.Name))
  const rectsAt = (X: number, Y: number) =>
    (layoutTree(o.root, { size: { X, Y }, components: o.components, data: o.data }) ?? []).filter((r) =>
      top.has(r.name),
    )
  const hit = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1
  const base = rectsAt(o.size.X, o.size.Y)
  const before = new Set<string>()
  for (const a of base) for (const b of base) if (a !== b && hit(a, b)) before.add(`${a.name}|${b.name}`)
  return RATIOS.map((r) => {
    const Y = o.size.Y
    const X = Math.round((Y * r.w) / r.h)
    const list = rectsAt(X, Y)
    const issues: AdaptIssue[] = []
    for (const a of list) {
      if (a.x < -1 || a.y < -1 || a.x + a.w > X + 1 || a.y + a.h > Y + 1)
        issues.push({ ratio: r.label, widget: a.name, kind: 'out' })
    }
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        if (hit(a, b) && !before.has(`${a.name}|${b.name}`))
          issues.push({ ratio: r.label, widget: a.name, kind: 'overlap', other: b.name })
      }
    return { ratio: r.label, issues }
  })
}
