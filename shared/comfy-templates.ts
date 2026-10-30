import { t } from './i18n.ts'
import {
  LOCAL_FILES,
  autoPlaceholders,
  checkWorkflow,
  localFile,
  localWorkflow,
  type ComfyWorkflow,
  type LocalDir,
  type LocalModel,
} from './local-image.ts'

/**
 * ComfyUI 模板商店：官方模板索引来自 Comfy-Org/workflow_templates 的 templates/index.json，
 * 单个模板是 ComfyUI 的界面格式（nodes / links / definitions.subgraphs），不是接口格式。
 * 这里做三件事：分类筛选、从界面格式里读出依赖的模型文件、把界面格式转成能提交给 ComfyUI 的接口格式。
 * 纯逻辑，前后端共用，单测在 shared/comfy-templates.test.ts。
 */

export interface TemplateAsset {
  dir: LocalDir
  file: string
  /** 下载地址；模板说明里没给地址时为空 */
  url: string
  /** 大约多少 GB */
  gb: number
  /** 本地已经下载（服务端按 ComfyUI/models 检查后填） */
  have?: boolean
}

export interface ComfyTemplateMeta {
  /** 内置模板 builtin:<model>，官方模板是官方文件名 */
  name: string
  title: string
  description: string
  /** 官方分类（Image、Product & Ads…）或 builtin */
  category: string
  tags: string[]
  models: string[]
  /** 模板依赖的模型总量（字节），下载地址里的估计值；不知道时为 0 */
  size: number
  date: string
  username: string
  usage: number
  openSource: boolean
  source: 'builtin' | 'comfy'
  /** 模板产出的内容类型；UI 设计只处理图片 */
  output?: 'image' | 'video' | 'audio' | '3d' | 'llm'
  /** 需要先喂一张图才能跑（图生图、编辑类） */
  needsInput?: boolean
  /** 节点图已经在本地（内置或缓存过），离线也能预览 */
  available?: boolean
  /** 依赖的文件都下载好了 */
  ready?: boolean
}

export interface ComfyTemplate extends ComfyTemplateMeta {
  /** 接口格式图；内置模板直接给，官方模板要转换后才有 */
  graph: ComfyWorkflow['graph']
  assets: TemplateAsset[]
}

export interface ComfyTemplateDetail {
  template: ComfyTemplateMeta
  /** 接口格式图（内置模板，或已经转换/缓存过的官方模板） */
  graph?: ComfyWorkflow['graph']
  /** 官方模板的原始界面格式，用来预览和转换 */
  ui?: UiGraph
  assets: TemplateAsset[]
}

/* ------------------------------- 分类与筛选 ------------------------------- */

export const TEMPLATE_CATEGORIES = [
  { id: 'all', title: t('所有模板') },
  { id: 'builtin', title: t('面板内置') },
  { id: 'Image', title: t('图像') },
  { id: 'Image Tools', title: t('图像工具') },
  { id: 'Product & Ads', title: t('产品与广告') },
  { id: 'Character & Fashion', title: t('角色与时尚') },
  { id: 'Brand & Design', title: t('品牌与设计') },
  { id: 'Video', title: t('视频') },
  { id: 'Video Tools', title: t('视频工具') },
  { id: 'Audio', title: t('音频') },
  { id: '3D Model', title: t('3D 模型') },
  { id: 'Vector', title: t('矢量') },
  { id: 'LLM', title: t('大语言模型') },
  { id: 'Node Basics', title: t('节点基础') },
] as const

/** 官方分类的显示名；官方以后加了新分类就原样显示 */
export function templateCategoryTitle(id: string): string {
  return TEMPLATE_CATEGORIES.find((c) => c.id === id)?.title ?? id
}

export const TEMPLATE_SORTS = [
  { id: 'recommended', title: t('推荐') },
  { id: 'newest', title: t('最新') },
  { id: 'smallest', title: t('体积最小') },
] as const
export type TemplateSort = (typeof TEMPLATE_SORTS)[number]['id']

export const TEMPLATE_SOURCES = [
  { id: 'all', title: t('全部来源') },
  { id: 'builtin', title: t('面板内置') },
  { id: 'comfy', title: t('ComfyUI 官方') },
] as const
export type TemplateSource = (typeof TEMPLATE_SOURCES)[number]['id']

export const TEMPLATE_READY = [
  { id: 'all', title: t('全部状态') },
  { id: 'ready', title: t('可以直接跑') },
  { id: 'missing', title: t('缺模型') },
] as const
export type TemplateReady = (typeof TEMPLATE_READY)[number]['id']

export interface TemplateQuery {
  category: string
  query: string
  source: TemplateSource
  ready: TemplateReady
  sort: TemplateSort
}

export const emptyTemplateQuery = (): TemplateQuery => ({
  category: 'all',
  query: '',
  source: 'all',
  ready: 'all',
  sort: 'recommended',
})

const byDate = (a: ComfyTemplateMeta, b: ComfyTemplateMeta) => (b.date || '').localeCompare(a.date || '')

/** 搜索、分类、来源、就绪状态过滤，再按推荐 / 最新 / 体积排序 */
export function filterTemplates(list: ComfyTemplateMeta[], q: TemplateQuery): ComfyTemplateMeta[] {
  const words = q.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const out = list.filter((m) => {
    if (q.category !== 'all' && m.category !== q.category) return false
    if (q.source !== 'all' && m.source !== q.source) return false
    if (q.ready === 'ready' && m.ready !== true) return false
    if (q.ready === 'missing' && m.ready !== false) return false
    if (!words.length) return true
    const text = [m.title, m.description, m.name, ...m.tags, ...m.models].join(' ').toLowerCase()
    return words.every((w) => text.includes(w))
  })
  return out.sort((a, b) => {
    if (q.sort === 'newest') return byDate(a, b)
    if (q.sort === 'smallest') return (a.size || Number.MAX_SAFE_INTEGER) - (b.size || Number.MAX_SAFE_INTEGER)
    // 面板内置的排最前（装了就能跑），其余按官方热度
    return Number(a.source !== 'builtin') - Number(b.source !== 'builtin') || b.usage - a.usage || byDate(a, b)
  })
}

/* ------------------------------- 界面格式 ------------------------------- */

export interface UiLink {
  id: number
  origin_id: number
  origin_slot: number
  target_id: number
  target_slot: number
  type?: string
}

export interface UiInput {
  name: string
  type?: string
  link?: number | null
  widget?: { name?: string }
}

export interface UiOutput {
  name?: string
  type?: string
  links?: number[] | null
}

export interface UiNode {
  id: number | string
  type: string
  title?: string
  mode?: number
  inputs?: UiInput[]
  outputs?: UiOutput[]
  widgets_values?: unknown[]
  properties?: Record<string, unknown>
}

export interface UiSubgraph {
  id: string
  inputs?: { name?: string; type?: string; linkIds?: number[]; label?: string }[]
  outputs?: { name?: string; type?: string; linkIds?: number[] }[]
  nodes?: UiNode[]
  links?: unknown
}

export interface UiGraph {
  nodes?: UiNode[]
  links?: unknown
  definitions?: { subgraphs?: UiSubgraph[] }
}

/** links 有数组和对象两种写法（新旧前端版本），统一成对象 */
export function normalizeLinks(raw: unknown): UiLink[] {
  if (!Array.isArray(raw)) return []
  const out: UiLink[] = []
  for (const x of raw) {
    const src = Array.isArray(x)
      ? { id: x[0], origin_id: x[1], origin_slot: x[2], target_id: x[3], target_slot: x[4], type: x[5] }
      : (x as Record<string, unknown> | null)
    if (!src || typeof src !== 'object') continue
    const link: UiLink = {
      id: Number(src.id),
      origin_id: Number(src.origin_id),
      origin_slot: Number(src.origin_slot),
      target_id: Number(src.target_id),
      target_slot: Number(src.target_slot),
      type: typeof src.type === 'string' ? src.type : undefined,
    }
    if (
      Object.values(link)
        .slice(0, 5)
        .every((v) => Number.isFinite(v))
    )
      out.push(link)
  }
  return out
}

const isNote = (n: UiNode) => /^(MarkdownNote|Note)$/i.test(n.type)

export interface FlatNode {
  id: string
  type: string
  title: string
  /** UI 输入名，按顺序；连线的 target_slot 就是这个数组的下标 */
  inputs: string[]
  widgets: unknown[]
}

export interface FlatEdge {
  from: string
  fromSlot: number
  to: string
  toInput: string
  type?: string
}

export interface FlatGraph {
  nodes: Map<string, FlatNode>
  edges: FlatEdge[]
}

interface Expanded extends FlatGraph {
  /** subgraph 的输入端口（下标）落到展开后的哪个节点输入 */
  ins: { to: string; toInput: string }[]
  /** subgraph 的输出端口（下标）来自展开后的哪个节点输出 */
  outs: { from: string; fromSlot: number }[]
}

const nodeName = (n: UiNode) => {
  const named = n.properties?.['Node name for S&R']
  return n.title ?? (typeof named === 'string' ? named : '')
}

/**
 * 展开界面格式：子图实例换成里面的节点（id 加前缀），内外连线按子图的输入输出端口接上；
 * MarkdownNote / Note 这类说明节点去掉。找不到的子图实例按普通节点处理。
 */
function expandGraph(ui: UiGraph | UiSubgraph, prefix: string, defs: Map<string, UiSubgraph>): Expanded {
  const nodes = new Map<string, FlatNode>()
  const edges: FlatEdge[] = []
  const ins: { to: string; toInput: string }[] = []
  const outs: { from: string; fromSlot: number }[] = []
  const links = normalizeLinks(ui.links)
  const byId = new Map(links.map((l) => [l.id, l]))
  const idOf = (raw: number | string) => `${prefix}${raw}`

  for (const n of ui.nodes ?? []) {
    if (isNote(n)) continue
    if (defs.has(n.type)) continue
    nodes.set(idOf(n.id), {
      id: idOf(n.id),
      type: n.type,
      title: nodeName(n),
      inputs: (n.inputs ?? []).map((x) => x.name),
      widgets: Array.isArray(n.widgets_values) ? n.widgets_values : [],
    })
  }

  const connect = (from: string, fromSlot: number, to: string, toSlot: number, type?: string) => {
    const target = nodes.get(to)
    const input = target?.inputs[toSlot]
    if (target && input) edges.push({ from, fromSlot, to, toInput: input, type })
  }

  for (const l of links) {
    if (l.origin_id < 0 || l.target_id < 0) continue
    connect(idOf(l.origin_id), l.origin_slot, idOf(l.target_id), l.target_slot, l.type)
  }

  for (const n of ui.nodes ?? []) {
    const def = defs.get(n.type)
    if (!def) continue
    const inst = idOf(n.id)
    const sub = expandGraph(def, `${inst}/`, defs)
    for (const [id, node] of sub.nodes) nodes.set(id, node)
    edges.push(...sub.edges)

    const ports = def.inputs ?? (n.inputs ?? []).map((x) => ({ name: x.name }))
    ports.forEach((port, slot) => {
      const inner = sub.ins[slot]
      if (!inner) return
      const uiInput = (n.inputs ?? []).find((x) => x.name === port.name) ?? (n.inputs ?? [])[slot]
      const link = uiInput?.link != null ? byId.get(uiInput.link) : undefined
      if (link && link.origin_id >= 0)
        edges.push({
          from: idOf(link.origin_id),
          fromSlot: link.origin_slot,
          to: inner.to,
          toInput: inner.toInput,
          type: link.type,
        })
    })

    const outputs = def.outputs ?? (n.outputs ?? []).map((x, i) => ({ name: x.name, linkIds: [], i }))
    outputs.forEach((_port, slot) => {
      const inner = sub.outs[slot]
      if (!inner) return
      for (const linkId of (n.outputs ?? [])[slot]?.links ?? []) {
        const link = byId.get(linkId)
        if (!link || link.target_id < 0) continue
        connect(inner.from, inner.fromSlot, idOf(link.target_id), link.target_slot, link.type)
      }
    })
  }

  for (const l of links) {
    if (l.origin_id === -10) {
      const to = idOf(l.target_id)
      const input = nodes.get(to)?.inputs[l.target_slot]
      if (input) ins[l.origin_slot] = { to, toInput: input }
    } else if (l.target_id === -20) {
      const from = idOf(l.origin_id)
      if (nodes.has(from)) outs[l.target_slot] = { from, fromSlot: l.origin_slot }
    }
  }

  return { nodes, edges, ins, outs }
}

export function expandUiGraph(ui: UiGraph): FlatGraph {
  const defs = new Map((ui.definitions?.subgraphs ?? []).map((s) => [s.id, s]))
  const { nodes, edges } = expandGraph(ui, '', defs)
  return { nodes, edges }
}

/* ------------------------------- 节点输入名 ------------------------------- */

/**
 * 节点上有哪些控件值（widgets_values 按这个顺序放）。null 表示 ComfyUI 界面上的附加控件
 * （例如 seed 后面的 control_after_generate），提交给接口时要跳过。
 * 覆盖本项目和常用官方模板里的节点；认不出来时再按 ComfyUI 的 /object_info 推导。
 */
const KNOWN_WIDGETS: Record<string, (string | null)[]> = {
  UNETLoader: ['unet_name', 'weight_dtype'],
  CLIPLoader: ['clip_name', 'type', 'device'],
  DualCLIPLoader: ['clip_name1', 'clip_name2', 'type', 'device'],
  VAELoader: ['vae_name'],
  CheckpointLoaderSimple: ['ckpt_name'],
  CheckpointLoader: ['ckpt_name', 'config_name'],
  LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
  LoraLoaderModelOnly: ['lora_name', 'strength_model'],
  ControlNetLoader: ['control_net_name'],
  CLIPVisionLoader: ['clip_name'],
  UpscaleModelLoader: ['model_name'],
  CLIPTextEncode: ['text'],
  CLIPTextEncodeSDXL: ['width', 'height', 'crop_w', 'crop_h', 'target_width', 'target_height', 'text_g', 'text_l'],
  KSampler: ['seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  KSamplerAdvanced: [
    'add_noise',
    'noise_seed',
    null,
    'steps',
    'cfg',
    'sampler_name',
    'scheduler',
    'start_at_step',
    'end_at_step',
    'return_with_leftover_noise',
  ],
  RandomNoise: ['noise_seed', null],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  EmptySD3LatentImage: ['width', 'height', 'batch_size'],
  EmptyFlux2LatentImage: ['width', 'height', 'batch_size'],
  ModelSamplingAuraFlow: ['shift'],
  CFGGuider: ['cfg'],
  KSamplerSelect: ['sampler_name'],
  Flux2Scheduler: ['steps', 'width', 'height'],
  FluxGuidance: ['guidance'],
  BasicScheduler: ['scheduler', 'steps', 'denoise'],
  SaveImage: ['filename_prefix'],
  PreviewImage: [],
  VAEDecode: [],
  VAEDecodeTiled: ['tile_size', 'overlap', 'temporal_size', 'temporal_overlap'],
  ConditioningZeroOut: [],
  SamplerCustomAdvanced: [],
  ImageScale: ['upscale_method', 'width', 'height', 'crop'],
  ImageScaleBy: ['upscale_method', 'scale_by'],
  ImageInvert: [],
}

/** 没有控件、但确实是 ComfyUI 节点的类型；用来区分「未知节点」和「只是没有参数」 */
const KNOWN_EMPTY = new Set(
  Object.entries(KNOWN_WIDGETS)
    .filter(([, v]) => !v.length)
    .map(([k]) => k),
)

export interface ComfyNodeInfo {
  input?: {
    required?: Record<string, unknown>
    optional?: Record<string, unknown>
  }
}

const WIDGET_TYPE = /^(INT|FLOAT|STRING|BOOLEAN|COMBO)$/

/** 一个节点的控件值顺序：先查内置表，再按 ComfyUI 的 /object_info 推导 */
export function widgetNames(type: string, nodeInfo?: Map<string, ComfyNodeInfo>): (string | null)[] {
  const known = KNOWN_WIDGETS[type]
  if (known) return known
  const info = nodeInfo?.get(type)
  const spec = { ...(info?.input?.required ?? {}), ...(info?.input?.optional ?? {}) }
  const out: (string | null)[] = []
  for (const [name, def] of Object.entries(spec)) {
    const kind = Array.isArray(def) ? def[0] : def
    // 连线型（MODEL / CLIP / IMAGE…）不是控件；数组是下拉选项，其余基本类型是控件
    if (typeof kind === 'string' && !WIDGET_TYPE.test(kind) && kind !== 'COMBO') continue
    out.push(name)
    // ComfyUI 在 seed 后面会多出一个「生成后怎么处理」的控件
    if (/^(noise_)?seed$/i.test(name)) out.push(null)
  }
  return out
}

/* ------------------------------- 预览与依赖 ------------------------------- */

/** 界面格式 → 预览用的接口格式图；认不出的控件按顺序叫 value 1、value 2，只用来画节点图 */
export function templatePreview(ui: UiGraph): ComfyWorkflow['graph'] {
  const flat = expandUiGraph(ui)
  const graph: ComfyWorkflow['graph'] = {}
  for (const n of flat.nodes.values()) {
    const names = widgetNames(n.type)
    const inputs: Record<string, unknown> = {}
    n.widgets.forEach((v, i) => {
      const name = names[i]
      if (name) inputs[name] = v
      else if (v !== null && v !== undefined && typeof v !== 'object') inputs[`value ${i + 1}`] = v
    })
    const node: ComfyWorkflow['graph'][string] = { class_type: n.type, inputs }
    if (n.title) (node as { _meta?: { title?: string } })._meta = { title: n.title }
    graph[n.id] = node
  }
  for (const e of flat.edges) {
    const target = graph[e.to]
    if (target) target.inputs[e.toInput] = [e.from, e.fromSlot]
  }
  return graph
}

/** 各类加载节点从哪个控件取文件名、放到 ComfyUI/models 的哪个目录 */
const LOADERS: Record<string, { input: string; dir: LocalDir }[]> = {
  CheckpointLoaderSimple: [{ input: 'ckpt_name', dir: 'checkpoints' }],
  CheckpointLoader: [{ input: 'ckpt_name', dir: 'checkpoints' }],
  UNETLoader: [{ input: 'unet_name', dir: 'diffusion_models' }],
  CLIPLoader: [{ input: 'clip_name', dir: 'text_encoders' }],
  DualCLIPLoader: [
    { input: 'clip_name1', dir: 'text_encoders' },
    { input: 'clip_name2', dir: 'text_encoders' },
  ],
  VAELoader: [{ input: 'vae_name', dir: 'vae' }],
  LoraLoader: [{ input: 'lora_name', dir: 'loras' }],
  LoraLoaderModelOnly: [{ input: 'lora_name', dir: 'loras' }],
  ControlNetLoader: [{ input: 'control_net_name', dir: 'controlnet' }],
  CLIPVisionLoader: [{ input: 'clip_name', dir: 'clip_vision' }],
  UpscaleModelLoader: [{ input: 'model_name', dir: 'upscale_models' }],
}

function noteTexts(ui: UiGraph | UiSubgraph): string[] {
  const out: string[] = []
  for (const n of ui.nodes ?? []) {
    if (!isNote(n)) continue
    for (const v of n.widgets_values ?? []) if (typeof v === 'string') out.push(v)
  }
  for (const s of (ui as UiGraph).definitions?.subgraphs ?? []) out.push(...noteTexts(s))
  return out
}

const sizeToGb = (n: number, unit: string) =>
  unit.toUpperCase() === 'GB' ? n : unit.toUpperCase() === 'MB' ? n / 1024 : n / 1024 ** 2

/** 模板说明（MarkdownNote）里给出的模型下载地址：文件名 → 地址和大小 */
export function noteUrls(ui: UiGraph): Map<string, { url: string; gb: number }> {
  const out = new Map<string, { url: string; gb: number }>()
  for (const text of noteTexts(ui)) {
    for (const line of text.split(/\r?\n/)) {
      for (const m of line.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)) {
        const url = m[1]
        let file = ''
        try {
          file = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
        } catch {
          continue
        }
        if (!file || out.has(file)) continue
        const size = /([\d.]+)\s*(GB|MB|KB)/i.exec(line.slice(m.index ?? 0))
        out.set(file, { url, gb: size ? sizeToGb(Number(size[1]), size[2]) : 0 })
      }
    }
  }
  return out
}

/**
 * 模板依赖的模型文件：从加载节点读文件名，目录按节点类型定；
 * 下载地址和大小优先用模板说明里的，没写时用已知文件的大小。
 */
export function templateAssets(ui: UiGraph, knownGb?: (file: string) => number | undefined): TemplateAsset[] {
  const flat = expandUiGraph(ui)
  const urls = noteUrls(ui)
  const out = new Map<string, TemplateAsset>()
  for (const n of flat.nodes.values()) {
    const fields = LOADERS[n.type]
    if (!fields) continue
    const names = widgetNames(n.type)
    for (const field of fields) {
      const i = names.indexOf(field.input)
      const file = i >= 0 ? n.widgets[i] : undefined
      if (typeof file !== 'string') continue
      const name = file.trim()
      if (!name || name === 'None' || /[\\/]/.test(name) || name.includes('..')) continue
      const key = `${field.dir}/${name}`
      if (out.has(key)) continue
      const found = urls.get(name)
      out.set(key, {
        dir: field.dir,
        file: name,
        url: found?.url ?? '',
        gb: knownGb?.(name) ?? found?.gb ?? 0,
      })
    }
  }
  return [...out.values()]
}

/** 已知模型文件的大小（GB）：模板说明里没写大小时用 */
const FILE_GB = new Map(LOCAL_FILES.map((f) => [f.file, f.gb]))
export const localGb = (file: string): number | undefined => FILE_GB.get(file)

/* ------------------------------- 转成接口格式 ------------------------------- */

export interface TemplateConvertOptions {
  /** 加到哪个分类（游戏 / 网页），用于 UI 设计里的自动挑选 */
  kind: 'game' | 'web'
  /** ComfyUI 在运行时的节点定义；有它就能转换内置表里没有的节点 */
  nodeInfo?: Map<string, ComfyNodeInfo>
  /** 保存成新工作流时的 id */
  id: string
}

/**
 * 界面格式 → 接口格式：展开子图、把控件值按输入名填上、连线换成 [节点 id, 输出序号]，
 * 再自动换成占位符。遇到不认识的节点直接报错（附上节点类型），不生成跑不了的工作流。
 */
export function templateToWorkflow(ui: UiGraph, meta: ComfyTemplateMeta, o: TemplateConvertOptions): ComfyWorkflow {
  const flat = expandUiGraph(ui)
  const graph: ComfyWorkflow['graph'] = {}
  const unknown = new Set<string>()

  for (const n of flat.nodes.values()) {
    const names = widgetNames(n.type, o.nodeInfo)
    if (!names.length && !KNOWN_EMPTY.has(n.type) && !o.nodeInfo?.has(n.type)) unknown.add(n.type)
    const inputs: Record<string, unknown> = {}
    n.widgets.forEach((v, i) => {
      const name = names[i]
      if (name) inputs[name] = v
    })
    graph[n.id] = { class_type: n.type, inputs }
  }
  if (unknown.size)
    throw new Error(
      t('模板用了面板不认识的节点：{list}。请先启动 ComfyUI 再添加，它会按实际安装的节点来转换', {
        list: [...unknown].join('、'),
      }),
    )

  for (const e of flat.edges) {
    const target = graph[e.to]
    if (target) target.inputs[e.toInput] = [e.from, e.fromSlot]
  }
  if (!Object.values(graph).some((n) => n.class_type === 'SaveImage' || n.class_type === 'PreviewImage'))
    throw new Error(t('模板里没有 SaveImage 节点，拿不到生成的图片'))

  const filled = autoPlaceholders(graph)
  const problems = checkWorkflow(filled)
  if (problems.length) throw new Error(problems.join('；'))

  return {
    id: o.id,
    name: meta.title.slice(0, 80),
    kind: o.kind,
    use: 'any',
    description: meta.description.slice(0, 2000),
    model: '',
    assets: templateAssets(ui, localGb).map((a) => `${a.dir}/${a.file}`),
    extra: '',
    graph: filled,
    updatedAt: '',
  }
}

/* ------------------------------- 内置模板 ------------------------------- */

const PROMPT = {
  prompt: '{{prompt}}',
  negative: '{{negative}}',
  width: '{{width}}',
  height: '{{height}}',
  count: '{{count}}',
  seed: '{{seed}}',
}

function builtinTemplate(model: LocalModel): ComfyTemplate {
  const assets: TemplateAsset[] = model.files.flatMap((id) => {
    const f = localFile(id)
    return f ? [{ dir: f.dir, file: f.file, url: f.url, gb: f.gb }] : []
  })
  return {
    name: `builtin:${model.id}`,
    title: `${model.name} · ${t('文本生图')}`,
    description: model.use,
    category: 'builtin',
    tags: ['Text to Image'],
    models: [model.name],
    size: Math.round(assets.reduce((n, a) => n + a.gb, 0) * 1024 ** 3),
    date: '',
    username: t('面板内置'),
    usage: 0,
    openSource: true,
    source: 'builtin',
    output: 'image',
    available: true,
    graph: localWorkflow(model, PROMPT),
    assets,
  }
}

/**
 * 面板内置模板：每个本机模型一条，装好依赖就能直接跑，离线可用。
 * 处理类模型（去背景）不是文生图，没有模板；它在工作流和链里用
 */
export function builtinTemplates(models: LocalModel[]): ComfyTemplate[] {
  return models.filter((m) => m.family !== 'birefnet').map(builtinTemplate)
}

export const builtinTemplateMeta = (list: ComfyTemplate[]): ComfyTemplateMeta[] =>
  list.map(({ graph: _graph, assets: _assets, ...meta }) => meta)
