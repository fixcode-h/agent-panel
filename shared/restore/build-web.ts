import { t } from '../i18n.ts'
import type { Design } from '../design.ts'
import { walk } from '../umg.ts'
import { compileWeb } from './compile-web.ts'
import { clusterColors, clusterSizes } from './css.ts'
import type { RestoreState, StepCard } from './schema.ts'
import type { RestoreThresholds } from './thresholds.ts'
import { verifyRestore } from './verify.ts'

/** 网页排版要知道图片的原始尺寸（没写宽高的图片按它算） */
export const webImages = (d: Design) => d.images.map((i) => ({ id: i.id, width: i.width, height: i.height }))

/**
 * 网页还原的搭建：flex 推断 → 按元素框核对位置 → 跑位的容器改成绝对定位再编（最多三轮）。
 * 卡上报横排、竖排、绝对定位各几个容器，CSS 画的底框几个，聚出来的颜色和字号几档（设计变量）
 */
export function buildWeb(d: Design, r: RestoreState, th: RestoreThresholds): StepCard {
  const images: Record<string, string | undefined> = {}
  const has = new Set(d.images.map((i) => i.id))
  for (const e of r.elements) {
    images[e.id] = e.image
    if (has.has(`rs_${e.id}_hover`)) images[`${e.id}:hover`] = `rs_${e.id}_hover`
  }
  const absolute = new Set<string>()
  const compile = () => compileWeb({ restore: r, designSize: d.designSize, images, absolute })
  let c = compile()
  const parentOf = (id: string) => {
    // 跑位的元素：它所在的那个容器改成绝对定位
    for (const [key, kind] of Object.entries(c.layouts)) {
      if (kind === 'absolute') continue
      const box = key === 'root' ? undefined : r.elements.find((e) => e.id === key)
      const e = r.elements.find((x) => x.id === id)
      if (!e) continue
      if (!box) continue
      if (e.box.x >= box.box.x && e.box.y >= box.box.y && e.box.x + e.box.w <= box.box.x + box.box.w + 1) return key
    }
    return 'root'
  }
  let fixed = 0
  for (let round = 0; round < 3; round++) {
    const s = verifyRestore({
      restore: r,
      root: c.root,
      designSize: d.designSize,
      names: c.names,
      thresholds: th,
      web: { images: webImages(d) },
    })
    const off = s.items.filter((i) => /position|missing/.test(i.why))
    const keys = new Set(off.map((i) => parentOf(i.element)).filter((k) => c.layouts[k] && c.layouts[k] !== 'absolute'))
    if (!keys.size) break
    for (const k of keys) absolute.add(k)
    fixed += keys.size
    c = compile()
  }
  d.root = c.root
  // 网页还原不抽子控件：上一次游戏还原留下的子控件、数据集清掉
  d.components = d.components.filter((x) => !x.Root.id.startsWith('rs-'))
  if (d.data) d.data = { ...d.data, sets: d.data.sets.filter((x) => !x.id.startsWith('rs_')) }
  d.rev++
  r.elements = r.elements.map((e) => ({ ...e, widget: c.names[e.id], grid: undefined }))
  let n = 0
  walk(c.root, () => n++)
  const kinds = Object.values(c.layouts)
  const live = r.elements.filter((e) => !e.hidden)
  const css = live.filter((e) => e.css).length
  const colors = clusterColors([
    ...live.flatMap((e) => (e.text?.color ? [e.text.color] : [])),
    ...live.flatMap((e) => (e.css ? [e.css.bg] : [])),
  ])
  const sizes = clusterSizes(live.flatMap((e) => (e.kind === 'text' && e.text ? [Math.round(e.text.px / 0.85)] : [])))
  const warnings: string[] = []
  if (fixed) warnings.push(t('自动修正：{n} 个容器按 flex 排会跑位，改成了绝对定位', { n: fixed }))
  const abs = kinds.filter((x) => x === 'absolute').length
  if (abs) warnings.push(t('{n} 个容器推断不出横排或竖排，用了绝对定位', { n: abs }))
  return {
    conclusion: t('搭出 {n} 个控件：{f} 个容器用 flex 排，{a} 个绝对定位', {
      n,
      f: kinds.length - abs,
      a: abs,
    }),
    todo: t('在画布上看看层级和名字；确认后逐个校验和原画差多少'),
    warnings,
    diff: '',
    metrics: [
      { label: t('控件'), value: String(n) },
      { label: t('flex 容器'), value: `${kinds.length - abs}/${kinds.length}`, ok: abs === 0 },
      { label: t('CSS 画的底框'), value: String(css) },
      { label: t('设计变量'), value: t('颜色 {c} 档，字号 {s} 档', { c: colors.length, s: sizes.length }) },
    ],
    note: colors.length
      ? `${t('颜色')}：${colors
          .slice(0, 6)
          .map((x) => x.color.slice(0, 7))
          .join(' ')}；${t('字号')}：${sizes.map((x) => `${x.size}px`).join(' ')}`
      : '',
  }
}
