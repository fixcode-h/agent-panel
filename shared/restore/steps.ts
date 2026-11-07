import { t } from '../i18n.ts'
import type { Img } from '../raster.ts'
import type { Design, DesignImage } from '../design.ts'
import { walk } from '../umg.ts'
import { extractAssets } from './assets.ts'
import { compileRestore } from './compile.ts'
import { detectElements } from './detect.ts'
import { findGroups } from './grid.ts'
import { applyLabels, buildLabelPrompt, type LabelReply } from './label.ts'
import { drawLabels } from './overlay.ts'
import {
  RESTORE_STEPS,
  emptyRestore,
  markStale,
  pushVersion,
  stepOf,
  type RestoreElement,
  type RestoreSource,
  type RestoreState,
  type RestoreStep,
  type StepCard,
} from './schema.ts'
import type { RestoreThresholds } from './thresholds.ts'
import { verifyRestore } from './verify.ts'

/**
 * 还原六步怎么跑：服务端和演示版共用，读写文件、问模型这些由调用方提供（RestoreCtx）。
 * 每跑一步交一版（pushVersion：决策卡 + 这一步的产物），状态变成「等确认」；用户确认了才进下一步。
 * 决策卡里的数字、要注意的条目都由这里按分数算，不靠模型自己说
 */

export interface RestoreCtx {
  design: Design
  /** 原画（解码好的） */
  art: () => Promise<Img>
  /** 存一张图到设计的图片目录 */
  store: (img: Img) => Promise<{ file: string; width: number; height: number }>
  /** 问模型标注：调用方把标注图存到模型能读的地方，用那个路径拼出提示词；不给就只用算法的结果 */
  label?: (overlay: Img, prompt: (image: string) => string, elements: RestoreElement[]) => Promise<LabelReply>
  thresholds: RestoreThresholds
  now: () => string
  /** 读 PSD 图层存下来的文件（元素的 layer / states 填的文件名）；原画不是 PSD 时用不到 */
  layer?: (file: string) => Promise<Img>
}

/** PSD 导入时读不全的东西：写在原画那一步的卡上 */
const PSD_WARNINGS: Record<string, () => string> = {
  style: () => t('有图层样式（描边、投影、发光）：切图只有图层本身的像素，样式要在引擎里补或者先在 PS 里栅格化'),
  mask: () => t('有图层蒙版：切图没套蒙版，先在 PS 里应用蒙版再导入更准'),
  blend: () => t('有非「正常」的混合模式：叠出来的颜色可能和 PS 里不一样'),
  clip: () => t('有剪贴蒙版：被剪贴的图层按自己的像素切，没有裁到下面那层的形状'),
}

/** 还原用的图片 id 前缀：重新切图时先清掉上一版的 */
const IMG_PREFIX = 'rs_'

export const stepName = (s: RestoreStep) =>
  ({
    source: t('原画'),
    elements: t('拆解'),
    assets: t('切图'),
    build: t('搭建'),
    verify: t('校验'),
    deliver: t('交付'),
  })[s]

const pct = (v: number) => `${Math.round(v * 100)}%`

export function stateOf(d: Design): RestoreState {
  d.restore ??= emptyRestore()
  return d.restore
}

/**
 * 换了原画：从头来，之前的步骤全清掉。
 * PSD 带上图层读出来的元素（layer、states 已经换成存好的文件名）：拆解那一步直接用，不再检测
 */
export function setSource(
  d: Design,
  source: RestoreSource,
  at: string,
  psd?: { elements: RestoreElement[]; warnings: string[] },
) {
  const prev = d.restore
  d.restore = { ...emptyRestore(), source, elements: psd?.elements ?? [] }
  // 上一张原画的切图不再有用
  if (prev) d.images = d.images.filter((i) => !i.id.startsWith(IMG_PREFIX))
  pushVersion(
    d.restore,
    'source',
    {
      conclusion: t('原画 {w}×{h}，设计稿 {X}×{Y}', {
        w: source.width,
        h: source.height,
        X: d.designSize.X,
        Y: d.designSize.Y,
      }),
      todo: psd
        ? t('确认这就是要还原的 PSD，下一步按图层列出所有元素')
        : t('确认这就是要还原的那张原画，下一步自动拆出所有元素'),
      warnings: [
        ...(Math.abs(source.width / source.height - d.designSize.X / d.designSize.Y) > 0.02
          ? [t('原画和设计稿的宽高比不一样，横竖会按各自的比例缩放')]
          : []),
        ...(psd?.warnings ?? []).flatMap((w) => (PSD_WARNINGS[w] ? [PSD_WARNINGS[w]()] : [])),
      ],
      diff: '',
      metrics: [
        { label: t('原画'), value: `${source.width}×${source.height}` },
        { label: t('缩放'), value: `${(d.designSize.X / source.width).toFixed(2)}×` },
        ...(psd ? [{ label: t('图层元素'), value: String(psd.elements.length) }] : []),
      ],
      note: '',
    },
    '',
    at,
  )
}

/** 确认这一步：返回接着要跑的下一步（最后一步没有） */
export function confirmStep(d: Design, step: RestoreStep): RestoreStep | undefined {
  const r = stateOf(d)
  const st = stepOf(r, step)
  if (st.status !== 'review') return undefined
  r.steps[step] = { ...st, status: 'done' }
  const next = RESTORE_STEPS[RESTORE_STEPS.indexOf(step) + 1]
  return next && stepOf(r, next).status !== 'done' ? next : undefined
}

/** 用户在图上改了元素（拖框、改类型、删、加）：这一步还是等确认，后面做过的都要更新 */
export function editElements(d: Design, elements: RestoreElement[], groups?: RestoreState['groups']) {
  const r = stateOf(d)
  r.elements = elements
  if (groups) r.groups = groups
  markStale(r, 'elements')
}

export async function runStep(step: RestoreStep, ctx: RestoreCtx, feedback = '') {
  const d = ctx.design
  const r = stateOf(d)
  if (!r.source) throw new Error(t('还没有原画'))
  const prev = stepOf(r, step)
  const before = prev.versions.at(-1)?.card
  let card: StepCard
  switch (step) {
    case 'source':
      return
    case 'elements':
      card = await runElements(ctx, r, feedback)
      break
    case 'assets':
      card = await runAssets(ctx, r)
      break
    case 'build':
      card = runBuild(ctx, r)
      break
    case 'verify':
      card = runVerify(d, ctx.thresholds, r)
      break
    case 'deliver':
      card = {
        conclusion: r.score?.passed
          ? t('还原完成：{n} 个元素，总分 {s}', { n: r.elements.filter((e) => !e.hidden).length, s: r.score.total })
          : t('还原完成（有没过门槛的差异已接受）'),
        todo: t('确认后就可以像平常的设计一样导出 UE 或者继续让 AI 改'),
        warnings: [],
        diff: '',
        metrics: [],
        note: '',
      }
      break
  }
  if (before && step !== 'deliver') card.diff = diffCards(before, card)
  pushVersion(r, step, card, feedback, ctx.now())
}

function diffCards(a: StepCard, b: StepCard) {
  const old = new Map(a.metrics.map((m) => [m.label, m.value]))
  return b.metrics
    .filter((m) => old.has(m.label) && old.get(m.label) !== m.value)
    .map((m) => `${m.label} ${old.get(m.label)} → ${m.value}`)
    .join('，')
}

const overlapsHidden = (e: RestoreElement, hidden: RestoreElement[]) =>
  hidden.some(
    (h) =>
      Math.abs(h.box.x - e.box.x) < 4 &&
      Math.abs(h.box.y - e.box.y) < 4 &&
      Math.abs(h.box.w - e.box.w) < 4 &&
      Math.abs(h.box.h - e.box.h) < 4,
  )

async function runElements(ctx: RestoreCtx, r: RestoreState, feedback: string): Promise<StepCard> {
  if (r.source?.kind === 'psd') return psdElements(r)
  const art = await ctx.art()
  const det = detectElements(art)
  // 用户自己画、改过的框留着；删掉的那块重新检测出来也不要
  const kept = r.elements.filter((e) => e.source === 'user' || e.source === 'psd')
  const hidden = r.elements.filter((e) => e.hidden)
  let elements = [
    ...det.elements.filter((e) => !overlapsHidden(e, hidden) && !overlapsHidden(e, kept)),
    ...kept,
    ...hidden,
  ]
  let groups = det.groups
  const warnings: string[] = []
  let note = ''
  if (det.uncovered.length)
    warnings.push(t('有 {n} 块地方没有框到元素，图上用红色标出来了', { n: det.uncovered.length }))
  if (ctx.label) {
    try {
      const list = elements
      const reply = await ctx.label(
        drawLabels(art, list),
        (image) => buildLabelPrompt({ image, width: art.width, height: art.height, elements: list, groups, feedback }),
        list,
      )
      ;({ elements, groups } = applyLabels(elements, groups, reply))
      note = reply.note
      for (const m of reply.missing) warnings.push(t('模型说漏了：{text}', { text: m }))
    } catch (e) {
      // 标注失败不吞掉：结果先按算法的给，失败原因写在卡上
      warnings.push(t('模型标注失败，先用算法的类型和名字：{error}', { error: (e as Error).message }))
    }
  }
  r.elements = elements
  r.groups = groups
  const live = elements.filter((e) => !e.hidden)
  const low = live.filter((e) => e.confidence < 0.6).length
  if (low) warnings.push(t('{n} 个元素把握不大（黄框），看一眼对不对', { n: low }))
  const texts = live.filter((e) => e.kind === 'text')
  const empty = texts.filter((e) => !e.text?.content.trim()).length
  if (empty) warnings.push(t('{n} 段文字还没有内容，点开填上', { n: empty }))
  return {
    conclusion: t('拆出 {n} 个元素，{g} 组重复的', { n: live.length - 1, g: groups.length }),
    todo: t('在图上拖框改位置、改类型，多的删掉、漏的框出来；没问题就确认，下一步从原画抠切图'),
    warnings: warnings.slice(0, 6),
    diff: '',
    metrics: [
      { label: t('元素'), value: String(live.length - 1) },
      { label: t('覆盖率'), value: pct(det.coverage), ok: det.coverage >= 0.9 },
      { label: t('重复组'), value: groups.map((g) => `${g.rows}×${g.cols}`).join('、') || '0' },
      { label: t('文字'), value: `${texts.length - empty}/${texts.length}`, ok: !empty },
    ],
    note,
  }
}

/** PSD：元素就是图层，位置、名字照图层，不检测也不问模型；重复的格子照样排成组 */
function psdElements(r: RestoreState): StepCard {
  // 重新排组：先清掉上一次的分组（findGroups 跳过已经有组的）
  r.elements = r.elements.map((e) => ({ ...e, repeat: undefined }))
  const live = r.elements.filter((e) => !e.hidden)
  r.groups = findGroups(live, 'p')
  const texts = live.filter((e) => e.kind === 'text')
  const empty = texts.filter((e) => !e.text?.content.trim()).length
  return {
    conclusion: t('从 PSD 图层读出 {n} 个元素，{g} 组重复的', { n: live.length - 1, g: r.groups.length }),
    todo: t('位置和名字都照图层来；类型不对的点开改，没问题就确认，下一步直接用图层的像素当切图'),
    warnings: empty ? [t('{n} 段文字还没有内容，点开填上', { n: empty })] : [],
    diff: '',
    metrics: [
      { label: t('元素'), value: String(live.length - 1) },
      { label: t('来自图层'), value: String(live.filter((e) => e.source === 'psd').length - 1) },
      { label: t('重复组'), value: r.groups.map((g) => `${g.rows}×${g.cols}`).join('、') || '0' },
      { label: t('文字'), value: `${texts.length - empty}/${texts.length}`, ok: !empty },
    ],
    note: '',
  }
}

async function runAssets(ctx: RestoreCtx, r: RestoreState): Promise<StepCard> {
  const d = ctx.design
  const art = await ctx.art()
  // PSD 图层的像素直接当切图
  const given = new Map<string, Img>()
  if (ctx.layer) for (const e of r.elements) if (e.layer && !e.hidden) given.set(e.id, await ctx.layer(e.layer))
  const x = extractAssets(art, r.elements, given)
  const k = { x: d.designSize.X / art.width, y: d.designSize.Y / art.height }
  const byElement = new Map(r.elements.map((e) => [e.id, e]))
  const images: DesignImage[] = []
  const imageOf = new Map<string, string>()
  const names = new Set(d.images.filter((i) => !i.id.startsWith(IMG_PREFIX)).map((i) => i.name))
  for (const s of x.slices) {
    if (s.same) continue
    const e = byElement.get(s.element)!
    const stored = await ctx.store(s.img)
    let name = (e.kind === 'background' ? 'Bg_Plate' : e.name || e.id).replace(/[^\w]/g, '_')
    for (let i = 2; names.has(name); i++) name = `${e.name || e.id}_${i}`
    names.add(name)
    const id = `${IMG_PREFIX}${e.id}`
    imageOf.set(e.id, id)
    images.push({
      id,
      name,
      prompt: '',
      negative: '',
      width: Math.max(1, Math.round(e.box.w * k.x)),
      height: Math.max(1, Math.round(e.box.h * k.y)),
      transparent: s.transparent,
      ...(s.nineSlice ? { nineSlice: s.nineSlice } : {}),
      variants: [{ ...stored, source: 'crop', score: x.sims[e.id] ?? 1, at: ctx.now() }],
      selected: 0,
      status: 'idle',
      ref: { x: e.box.x * k.x, y: e.box.y * k.y, w: e.box.w * k.x, h: e.box.h * k.y },
    })
  }
  // PSD 按钮的其他状态：各存一张，搭建时按钮的悬停、按下、禁用用它们
  if (ctx.layer)
    for (const e of r.elements) {
      if (e.hidden || !e.states) continue
      for (const [s, file] of Object.entries(e.states)) {
        if (!file) continue
        const img = await ctx.layer(file)
        const stored = await ctx.store(img)
        const base = images.find((i) => i.id === `${IMG_PREFIX}${e.id}`)
        images.push({
          ...(base ?? {
            prompt: '',
            negative: '',
            width: Math.max(1, Math.round(e.box.w * k.x)),
            height: Math.max(1, Math.round(e.box.h * k.y)),
            selected: 0,
            status: 'idle' as const,
          }),
          id: `${IMG_PREFIX}${e.id}_${s}`,
          name: `${base?.name ?? e.name ?? e.id}_${s[0].toUpperCase()}${s.slice(1)}`,
          transparent: true,
          variants: [{ ...stored, source: 'crop', score: 1, at: ctx.now() }],
        })
      }
    }
  for (const s of x.slices) if (s.same) imageOf.set(s.element, imageOf.get(s.same)!)
  d.images = [...d.images.filter((i) => !i.id.startsWith(IMG_PREFIX)), ...images]
  r.elements = r.elements.map((e) => ({ ...e, image: imageOf.get(e.id), sim: x.sims[e.id] }))
  const bg = r.elements.find((e) => e.kind === 'background')
  r.plate = bg ? imageOf.get(bg.id) : undefined
  const sims = Object.values(x.sims)
  const avg = sims.length ? sims.reduce((s, v) => s + v, 0) / sims.length : 1
  const low = r.elements.filter((e) => !e.hidden && e.sim !== undefined && e.sim < ctx.thresholds.assetSim)
  const shared = x.slices.filter((s) => s.same).length
  return {
    conclusion: t('抠出 {n} 张切图，{s} 个元素共用同一张', { n: images.length, s: shared }),
    todo: t('看一眼切图和干净背景；有不像的可以在图片里精修。确认后搭控件树'),
    warnings: low
      .slice(0, 5)
      .map((e) => t('{name} 拼回去和原画只有 {s} 像', { name: e.name || e.id, s: (e.sim ?? 0).toFixed(2) })),
    diff: '',
    metrics: [
      { label: t('切图'), value: String(images.length) },
      { label: t('共用'), value: String(shared) },
      { label: t('平均相似度'), value: avg.toFixed(3), ok: avg >= ctx.thresholds.assetSim },
      { label: t('九宫格'), value: String(x.slices.filter((s) => s.nineSlice).length) },
    ],
    note: '',
  }
}

function runBuild(ctx: RestoreCtx, r: RestoreState): StepCard {
  const d = ctx.design
  const images: Record<string, string | undefined> = {}
  const nine: Record<string, DesignImage['nineSlice']> = {}
  for (const e of r.elements) {
    images[e.id] = e.image
    for (const s of Object.keys(e.states ?? {}))
      if (d.images.some((i) => i.id === `${IMG_PREFIX}${e.id}_${s}`))
        images[`${e.id}:${s}`] = `${IMG_PREFIX}${e.id}_${s}`
  }
  for (const i of d.images) if (i.nineSlice) nine[i.id] = i.nineSlice
  const c = compileRestore({ restore: r, designSize: d.designSize, images, nineSlice: nine })
  d.root = c.root
  d.rev++
  r.elements = r.elements.map((e) => ({ ...e, widget: c.names[e.id] }))
  let n = 0
  walk(c.root, () => n++)
  return {
    conclusion: t('搭出 {n} 个控件，位置全部按元素框摆好并锁住', { n }),
    todo: t('在画布上看看层级和名字；确认后逐个校验和原画差多少'),
    warnings: [],
    diff: '',
    metrics: [
      { label: t('控件'), value: String(n) },
      { label: t('元素'), value: String(Object.keys(c.names).length) },
    ],
    note: '',
  }
}

function runVerify(d: Design, th: RestoreThresholds, r: RestoreState): StepCard {
  const names: Record<string, string> = {}
  for (const e of r.elements) if (e.widget) names[e.id] = e.widget
  const accepted = new Set((r.score?.items ?? []).filter((i) => i.accepted).map((i) => i.element))
  const s = verifyRestore({
    restore: r,
    root: d.root,
    components: d.components,
    designSize: d.designSize,
    names,
    sims: Object.fromEntries(r.elements.map((e) => [e.id, e.sim])),
    thresholds: th,
    accepted,
  })
  r.score = s
  const bad = s.items.filter((i) => !i.ok)
  const byId = new Map(r.elements.map((e) => [e.id, e]))
  const why = (w: string) =>
    w
      .split(',')
      .map(
        (x) =>
          ({ missing: t('控件不见了'), position: t('位置不对'), asset: t('切图不像'), text: t('文字没内容') })[x] ?? x,
      )
      .join('、')
  return {
    conclusion: s.passed
      ? t('校验通过，总分 {s}', { s: s.total })
      : t('还有 {n} 处差异，总分 {s}', { n: bad.length, s: s.total }),
    todo: s.passed ? t('确认后交付') : t('点差异看是哪里不对：改元素重新跑，或者接受这处差异'),
    warnings: bad.slice(0, 6).map((i) => `${byId.get(i.element)?.name || i.element}：${why(i.why)}`),
    diff: '',
    metrics: [
      { label: t('总分'), value: String(s.total), ok: s.passed },
      { label: t('位置对上'), value: `${s.posOk}/${s.posTotal}`, ok: s.posOk / Math.max(1, s.posTotal) >= th.posRatio },
      { label: t('切图'), value: s.assetSim.toFixed(3), ok: s.assetSim >= th.assetSim },
      { label: t('文字'), value: `${s.textOk}/${s.textTotal}`, ok: s.textOk === s.textTotal },
    ],
    note: '',
  }
}

/** 接受一处差异（或取消）：重新算分，不用重新跑校验 */
export function acceptDiff(d: Design, element: string, on: boolean, th: RestoreThresholds) {
  const r = stateOf(d)
  if (!r.score) return
  r.score.items = r.score.items.map((i) => (i.element === element ? { ...i, accepted: on || undefined } : i))
  const card = runVerify(d, th, r)
  const st = stepOf(r, 'verify')
  const last = st.versions.at(-1)
  if (last) last.card = { ...card, diff: last.card.diff }
}
