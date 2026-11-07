import { layoutTree } from '../umg-layout.ts'
import type { Component, Widget } from '../umg.ts'
import { artScale, type ElementCheck, type RestoreScore, type RestoreState } from './schema.ts'
import type { RestoreThresholds } from './thresholds.ts'

/**
 * 校验：把控件树按 UMG 的排版规则算一遍位置（layoutTree，不用开页面），和元素表逐个比。
 * 偏差按设计稿像素算，超过门槛的列出来；切图相似度由切图那一步量好传进来。
 * 文字只看有没有内容（字体没法从图里量准，字号差一点不算错）。
 * 总分：位置五成、切图三成五、文字一成五；位置和切图都过门槛才算过关
 */
export function verifyRestore(o: {
  restore: RestoreState
  root: Widget
  components?: Component[]
  designSize: { X: number; Y: number }
  /** 元素 id → 控件名（编译时给的） */
  names: Record<string, string>
  /** 元素 id → 切图和原画那一块的相似度 */
  sims?: Record<string, number | undefined>
  thresholds: RestoreThresholds
  /** 用户点过「接受差异」的元素 */
  accepted?: Set<string>
}): RestoreScore {
  const { restore, thresholds: th } = o
  const k = artScale(restore, o.designSize)
  const rects = new Map(
    (layoutTree(o.root, { size: o.designSize, components: o.components ?? [] }) ?? []).map((r) => [r.name, r]),
  )
  const items: ElementCheck[] = []
  let posOk = 0
  let posTotal = 0
  let textOk = 0
  let textTotal = 0
  const sims: number[] = []
  for (const e of restore.elements) {
    if (e.hidden || e.kind === 'background') continue
    const widget = o.names[e.id] ?? ''
    const r = rects.get(widget)
    posTotal++
    const want = { x: e.box.x * k.x, y: e.box.y * k.y, w: e.box.w * k.x, h: e.box.h * k.y }
    const d = r
      ? { dx: r.x - want.x, dy: r.y - want.y, dw: r.w - want.w, dh: r.h - want.h }
      : { dx: 0, dy: 0, dw: 0, dh: 0 }
    const worst = Math.max(Math.abs(d.dx), Math.abs(d.dy), Math.abs(d.dw), Math.abs(d.dh))
    const sim = o.sims?.[e.id]
    if (sim !== undefined) sims.push(sim)
    const why: string[] = []
    if (!r) why.push('missing')
    else if (worst > th.posPx + 0.5) why.push('position')
    if (sim !== undefined && sim < th.assetSim) why.push('asset')
    if (e.kind === 'text') {
      textTotal++
      if (e.text?.content.trim()) textOk++
      else why.push('text')
    }
    const accepted = o.accepted?.has(e.id)
    const posGood = !!r && worst <= th.posPx + 0.5
    if (posGood || accepted) posOk++
    const round = (v: number) => Math.round(v * 10) / 10
    items.push({
      element: e.id,
      widget,
      dx: round(d.dx),
      dy: round(d.dy),
      dw: round(d.dw),
      dh: round(d.dh),
      ...(sim !== undefined ? { sim: Math.round(sim * 1000) / 1000 } : {}),
      ok: !why.length || !!accepted,
      ...(accepted ? { accepted: true } : {}),
      why: why.join(','),
    })
  }
  const posRatio = posTotal ? posOk / posTotal : 1
  const assetSim = sims.length ? sims.reduce((s, v) => s + v, 0) / sims.length : 1
  const textRatio = textTotal ? textOk / textTotal : 1
  const total = Math.round((0.5 * posRatio + 0.35 * assetSim + 0.15 * textRatio) * 1000) / 10
  return {
    total,
    posOk,
    posTotal,
    assetSim: Math.round(assetSim * 1000) / 1000,
    textOk,
    textTotal,
    passed: posRatio >= th.posRatio && assetSim >= th.assetSim,
    items,
    fixed: 0,
  }
}
