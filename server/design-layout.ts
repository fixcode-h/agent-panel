import type { OpsState } from '../shared/design-ops.ts'
import { layoutChanges, layoutTree, rectLine, type LayoutRect } from '../shared/umg-layout.ts'
import { webLayoutTree } from '../shared/web-layout.ts'
import type { Session } from './design-mcp.ts'

/**
 * 设计工具里和「控件在画布上的位置」有关的部分：改完自动回读、get_layout、截图失败时的位置表。
 * 位置按画布同一套排版规则算，不用开页面截图：游戏 UI 用 shared/umg-layout.ts，网页设计用 shared/web-layout.ts（桌面宽度）。
 */

/** 一棵树（主界面或子控件）算出来的位置；没有这个子控件时是 undefined */
export function sessionLayout(s: Session, target = ''): LayoutRect[] | undefined {
  const comp = target ? s.state.components.find((c) => c.Name === target) : undefined
  if (target && !comp) return undefined
  if (s.design.kind === 'web')
    return webLayoutTree(comp ? comp.Root : s.state.root, {
      size: comp ? comp.DesignSize : (s.designSize ?? s.design.designSize),
      components: s.state.components,
      // 没写宽高的图片按图片的尺寸撑开：这一轮新列的图也算上
      images: [...s.design.images, ...s.images],
    })
  return layoutTree(comp ? comp.Root : s.state.root, {
    size: comp ? comp.DesignSize : (s.designSize ?? s.design.designSize),
    components: s.state.components,
    data: s.data ?? s.design.data,
  })
}

/** 改完以后哪些控件的位置、大小变了：直接附在工具结果里，AI 不用为了回读再截图 */
export function layoutNote(s: Session, before: OpsState, ops: unknown[]) {
  const trees = ['', ...new Set(ops.map((o: any) => (typeof o?.in === 'string' ? o.in : '')).filter(Boolean))]
  const out: string[] = []
  for (const tree of trees) {
    const after = sessionLayout(s, tree)
    if (!after) continue
    const prev = sessionLayout({ ...s, state: before }, tree)
    const changed = layoutChanges(prev, after)
    if (!changed.length) continue
    const size = tree
      ? s.state.components.find((c) => c.Name === tree)?.DesignSize
      : (s.designSize ?? s.design.designSize)
    const outside = changed.filter(
      (r) => size && r.w > 0 && r.h > 0 && (r.x < -2 || r.y < -2 || r.x + r.w > size.X + 2 || r.y + r.h > size.Y + 2),
    )
    out.push(
      `${tree ? `子控件 ${tree} 里` : ''}位置或大小变了的控件（x,y 宽×高，设计稿像素${changed.length > 20 ? '，只列前 20 个' : ''}；≈ 是按字宽估的）：`,
      ...changed.slice(0, 20).map(rectLine),
      ...(outside.length ? [`跑出画面：${outside.map((r) => r.name).join('、')}`] : []),
    )
  }
  return out.join('\n')
}

/** get_layout：整棵树（或其中几个控件）的位置；返回 [文字, 是否出错] */
export function layoutReport(s: Session, target: string, names: unknown): [string, boolean] {
  if (target && !s.state.components.some((c) => c.Name === target)) return [`没有子控件 ${target}`, true]
  const rects = sessionLayout(s, target) ?? []
  const want = Array.isArray(names) ? new Set(names.map(String)) : undefined
  const list = want ? rects.filter((r) => want.has(r.name)) : rects
  const missing = want ? [...want].filter((n) => !rects.some((r) => r.name === n)) : []
  return [
    [
      `控件位置（x,y 宽×高，设计稿像素${list.length > 120 ? '，只列前 120 个' : ''}；≈ 是按字宽估的）：`,
      ...list.slice(0, 120).map(rectLine),
      missing.length ? `没找到（不在这棵树里，或者是 Collapsed）：${missing.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    false,
  ]
}
