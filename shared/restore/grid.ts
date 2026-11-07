import type { RepeatGroup, RestoreElement } from './schema.ts'

/**
 * 重复组：大小一样（差几像素以内）、按固定间距排成行列的容器（背包格子、技能栏、商店条目、一排按钮）。
 * 同组的搭建时抽成一个子控件，格子数和间距直接用这里算出来的，不靠模型数。
 * 原画（尤其 AI 画的）格子常有几像素的出入：组里统一成平均大小、按等间距排，决策卡里说明
 */
export function findGroups(list: RestoreElement[], prefix = 'e'): RepeatGroup[] {
  const cand = list.filter(
    (e) => !e.hidden && !e.repeat && (e.kind === 'slot' || e.kind === 'panel' || e.kind === 'button'),
  )
  const used = new Set<string>()
  const groups: RepeatGroup[] = []
  for (const a of cand) {
    if (used.has(a.id)) continue
    const tol = Math.max(3, Math.min(a.box.w, a.box.h) * 0.05)
    const same = cand.filter(
      (b) => !used.has(b.id) && Math.abs(b.box.w - a.box.w) <= tol && Math.abs(b.box.h - a.box.h) <= tol,
    )
    if (same.length < 3) continue
    const xs = levels(
      same.map((e) => e.box.x),
      tol,
    )
    const ys = levels(
      same.map((e) => e.box.y),
      tol,
    )
    const sx = step(xs, tol)
    const sy = step(ys, tol)
    // 多列要等间距，多行也要等间距；一行或一列时只看那一个方向
    if ((xs.length > 1 && sx === undefined) || (ys.length > 1 && sy === undefined)) continue
    // 格子里的元素要大致填满行列（允许缺几格：没画边框的空格子检测不到）
    if (same.length < xs.length * ys.length * 0.6) continue
    const w = avg(same.map((e) => e.box.w))
    const h = avg(same.map((e) => e.box.h))
    const id = `${prefix}g${groups.length + 1}`
    const square = w / h > 0.7 && w / h < 1.4
    groups.push({
      id,
      name: '',
      rows: ys.length,
      cols: xs.length,
      cell: { w: Math.round(w), h: Math.round(h) },
      gap: { x: sx === undefined ? 0 : Math.round(sx - w), y: sy === undefined ? 0 : Math.round(sy - h) },
      origin: { x: Math.round(xs[0]), y: Math.round(ys[0]) },
    })
    for (const e of same) {
      used.add(e.id)
      e.repeat = id
      if (square) e.kind = 'slot'
    }
  }
  return groups
}

const avg = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length

/** 把一组坐标按容差聚成几档（每档取平均），从小到大 */
export function levels(v: number[], tol: number) {
  const out: { sum: number; n: number }[] = []
  for (const x of [...v].sort((a, b) => a - b)) {
    const last = out.at(-1)
    if (last && Math.abs(x - last.sum / last.n) <= tol) {
      last.sum += x
      last.n++
    } else out.push({ sum: x, n: 1 })
  }
  return out.map((l) => l.sum / l.n)
}

/** 几档之间的间距一样（容差内）就返回平均间距，否则 undefined */
function step(v: number[], tol: number) {
  if (v.length < 2) return undefined
  const d = v.slice(1).map((x, i) => x - v[i])
  const m = avg(d)
  return d.every((x) => Math.abs(x - m) <= tol) ? m : undefined
}
