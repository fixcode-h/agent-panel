import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { t } from '../shared/i18n.ts'
import {
  builtinTemplates,
  builtinTemplateMeta,
  localGb,
  templateAssets,
  templatePreview,
  templateToWorkflow,
  type ComfyNodeInfo,
  type ComfyTemplateDetail,
  type ComfyTemplateMeta,
  type TemplateAsset,
  type UiGraph,
} from '../shared/comfy-templates.ts'
import { LOCAL_MODELS, localFile, type ComfyWorkflow } from '../shared/local-image.ts'
import snapshot from './comfy-templates-snapshot.json'
import { DATA_DIR, readJson, writeJsonAtomic } from './store.ts'
import { log } from './log.ts'
import { netFetch } from './net.ts'

/**
 * ComfyUI 模板商店的服务端：内置一份官方模板索引快照（离线可浏览），
 * 联网时可以刷新成最新的完整索引；模板的节点图按需下载并缓存到数据目录，之后离线也能看。
 * 依赖文件的下载复用本机生图那条分片下载通道（由 server/comfy.ts 注入）。
 */

const INDEX_URL = 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/index.json'
const TEMPLATE_URL = 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates'
const cacheDir = () => path.join(DATA_DIR, 'comfy-templates')
const indexFile = () => path.join(cacheDir(), 'index.json')
const uiFile = (name: string) => path.join(cacheDir(), `${name}.json`)

/** 快照里的字段：官方索引里的事实数据，不含节点图 */
type SnapshotItem = Omit<ComfyTemplateMeta, 'source' | 'available' | 'ready'>

const SNAPSHOT = snapshot as unknown as SnapshotItem[]

export interface TemplateCatalog {
  templates: ComfyTemplateMeta[]
  /** 上次在线刷新的时间；没刷新过时为空 */
  updatedAt: string
  /** 用的是在线刷新后的完整索引，还是内置快照 */
  cached: boolean
}

export interface TemplateDetailResult extends ComfyTemplateDetail {
  preview?: ComfyWorkflow['graph']
}

export interface TemplateDeps {
  /** 保存成用户工作流（由 server/comfy.ts 写入 comfy-workflows.json） */
  saveWorkflow: (wf: ComfyWorkflow) => Promise<void>
  /** ComfyUI 运行时的节点定义，用来转换内置表里没有的节点 */
  nodeInfo: () => Promise<Map<string, ComfyNodeInfo> | undefined>
  /** ComfyUI/models 的绝对路径 */
  modelsDir: () => string
  /** 启动依赖下载（复用本机生图的下载任务） */
  download: (files: TemplateAsset[], label: string, skipped: number) => unknown
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** 官方索引里一条模板 → 我们用的精简结构 */
function itemOf(group: { title?: unknown; type?: unknown }, raw: Record<string, unknown>): SnapshotItem | undefined {
  const name = str(raw.name)
  if (!name) return undefined
  const io = raw.io as { inputs?: unknown[] } | undefined
  return {
    name,
    title: str(raw.title, name),
    description: str(raw.description),
    category: str(group.title, str(raw.category, 'Image')),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((x): x is string => typeof x === 'string') : [],
    models: Array.isArray(raw.models) ? raw.models.filter((x): x is string => typeof x === 'string') : [],
    size: num(raw.size),
    date: str(raw.date),
    username: str(raw.username, 'ComfyUI'),
    usage: num(raw.usage),
    openSource: raw.openSource === true,
    output:
      group.type === 'video' || group.type === 'audio' || group.type === '3d' || group.type === 'llm'
        ? group.type
        : 'image',
    needsInput: Array.isArray(io?.inputs) && io.inputs.length > 0,
  }
}

async function cachedIndex(): Promise<{ updatedAt: string; list: SnapshotItem[] } | undefined> {
  const raw = await readJson(indexFile())
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { updatedAt?: unknown; list?: unknown }
  if (!Array.isArray(r.list)) return undefined
  const list = r.list.filter((x): x is SnapshotItem => !!x && typeof x === 'object' && typeof (x as SnapshotItem).name === 'string')
  return { updatedAt: str(r.updatedAt), list }
}

const withHave = (assets: TemplateAsset[], modelsDir: string): TemplateAsset[] =>
  assets.map((a) => ({ ...a, have: existsSync(path.join(modelsDir, a.dir, a.file)) }))

/** 列表：内置模板 + 官方索引（在线刷新过用缓存，否则用内置快照） */
export async function templateCatalog(modelsDir: string): Promise<TemplateCatalog> {
  const builtin = builtinTemplates(LOCAL_MODELS)
  const templates: ComfyTemplateMeta[] = builtin.map((tpl) => {
    const ready = withHave(tpl.assets, modelsDir).every((a) => a.have)
    return { ...builtinTemplateMeta([tpl])[0], ready }
  })
  const cache = await cachedIndex()
  for (const item of cache?.list ?? SNAPSHOT)
    templates.push({ ...item, source: 'comfy', available: existsSync(uiFile(item.name)) })
  return { templates, updatedAt: cache?.updatedAt ?? '', cached: !!cache }
}

/** 在线刷新官方索引：成功才覆盖缓存，失败保留旧的（离线时还能用） */
export async function refreshTemplates(modelsDir: string): Promise<TemplateCatalog> {
  const res = await netFetch(INDEX_URL, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(t('下载模板列表失败（{status}）', { status: String(res.status) }))
  const groups = (await res.json()) as { title?: unknown; type?: unknown; templates?: unknown }[]
  const list: SnapshotItem[] = []
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const raw of Array.isArray(group.templates) ? group.templates : []) {
      if (!raw || typeof raw !== 'object') continue
      const item = itemOf(group, raw as Record<string, unknown>)
      if (item) list.push(item)
    }
  }
  await mkdir(cacheDir(), { recursive: true })
  await writeJsonAtomic(indexFile(), { updatedAt: new Date().toISOString(), list }, true)
  log.info('comfy', `模板索引已更新：${list.length} 个`)
  return templateCatalog(modelsDir)
}

/** 模板文件名只允许字母数字和 . _ -，防止拼出缓存目录外的路径 */
export function safeTemplateName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..')
}

async function findMeta(name: string): Promise<ComfyTemplateMeta | undefined> {
  const cache = await cachedIndex()
  const item = (cache?.list ?? SNAPSHOT).find((x) => x.name === name)
  return item && { ...item, source: 'comfy', available: existsSync(uiFile(name)) }
}

/** 模板的界面格式：先用缓存，没有就下载并缓存 */
async function loadUi(name: string): Promise<UiGraph> {
  if (!safeTemplateName(name)) throw new Error(t('模板名不对：{name}', { name }))
  if (existsSync(uiFile(name))) {
    const raw = await readJson(uiFile(name))
    if (raw && typeof raw === 'object') return raw as UiGraph
  }
  const res = await netFetch(`${TEMPLATE_URL}/${name}.json`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(t('取模板 {name} 失败（{status}）', { name, status: String(res.status) }))
  const ui = (await res.json()) as UiGraph
  await mkdir(cacheDir(), { recursive: true })
  await writeJsonAtomic(uiFile(name), ui, true)
  return ui
}

/** 模板详情：内置的直接给接口格式图，官方模板给界面格式、预览图和依赖 */
export async function templateDetail(name: string, modelsDir: string): Promise<TemplateDetailResult> {
  const builtin = builtinTemplates(LOCAL_MODELS).find((tpl) => tpl.name === name)
  if (builtin) {
    const assets = withHave(builtin.assets, modelsDir)
    return {
      template: { ...builtinTemplateMeta([builtin])[0], ready: assets.every((a) => a.have) },
      graph: builtin.graph,
      assets,
    }
  }
  const meta = await findMeta(name)
  if (!meta) throw new Error(t('找不到模板 {name}', { name }))
  const ui = await loadUi(name)
  const assets = withHave(templateAssets(ui, localGb), modelsDir)
  return {
    template: { ...meta, available: true, ready: assets.every((a) => a.have) },
    ui,
    preview: templatePreview(ui),
    assets,
  }
}

/** 依赖文件和某个本机模型的文件完全一致时，关联到这个模型；用于工作流页的就绪提示 */
function matchModel(assets: string[]): string {
  const set = new Set(assets)
  for (const m of LOCAL_MODELS) {
    const files = m.files.flatMap((id) => {
      const f = localFile(id)
      return f ? [`${f.dir}/${f.file}`] : []
    })
    if (files.length && files.every((f) => set.has(f))) return m.id
  }
  return ''
}

/** 把模板添加成用户工作流（内置模板复制一份，官方模板先转成接口格式） */
export async function addTemplate(name: string, kind: 'game' | 'web', deps: TemplateDeps): Promise<ComfyWorkflow> {
  const builtin = builtinTemplates(LOCAL_MODELS).find((tpl) => tpl.name === name)
  if (builtin) {
    const wf: ComfyWorkflow = {
      id: `wf_${randomUUID().slice(0, 8)}`,
      name: t('{name}（副本）', { name: builtin.title }),
      kind,
      use: 'any',
      description: builtin.description.slice(0, 2000),
      model: builtin.name.startsWith('builtin:') ? builtin.name.slice('builtin:'.length) : '',
      assets: builtin.assets.map((a) => `${a.dir}/${a.file}`),
      extra: '',
      graph: builtin.graph,
      updatedAt: new Date().toISOString(),
    }
    await deps.saveWorkflow(wf)
    return wf
  }

  const detail = await templateDetail(name, deps.modelsDir())
  if (detail.template.output && detail.template.output !== 'image')
    throw new Error(t('这是视频 / 音频模板，UI 设计只处理图片'))
  if (!detail.ui) throw new Error(t('这个模板没有节点图，取不到依赖'))
  const wf = templateToWorkflow(detail.ui, detail.template, {
    kind,
    id: `wf_${randomUUID().slice(0, 8)}`,
    nodeInfo: await deps.nodeInfo(),
  })
  wf.model = matchModel(wf.assets)
  await deps.saveWorkflow(wf)
  return wf
}

/** 只下载 Hugging Face 上的文件；模板说明里别的站点的链接不自动下 */
export function downloadUrl(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && /(^|\.)huggingface\.co$/.test(u.hostname) ? url : undefined
  } catch {
    return undefined
  }
}

export function canDownload(asset: TemplateAsset): boolean {
  return !!asset.url && !!downloadUrl(asset.url) && safeTemplateName(asset.file) && !asset.file.includes('..')
}

export interface DownloadResult {
  job: unknown
  files: TemplateAsset[]
  skipped: number
}

/** 下载模板缺的模型文件；返回启动的下载任务和跳过的文件数 */
export async function downloadTemplate(name: string, deps: TemplateDeps): Promise<DownloadResult> {
  const detail = await templateDetail(name, deps.modelsDir())
  const missing = detail.assets.filter((a) => !a.have)
  if (!missing.length) throw new Error(t('模板依赖的模型都在本地了'))
  const files = missing.filter(canDownload)
  if (!files.length) throw new Error(t('模板里的模型没有可下载的地址，需要自己放到 ComfyUI/models'))
  const skipped = missing.length - files.length
  const job = deps.download(files, detail.template.title, skipped)
  return { job, files, skipped }
}

/** /local-image/templates 下的接口 */
export function templateApi(deps: TemplateDeps) {
  const routes = new Hono()
  const wrap = (fn: () => Promise<unknown>) => async (c: import('hono').Context) => {
    try {
      return c.json((await fn()) ?? { ok: true })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }
  routes.get('/', wrap(() => templateCatalog(deps.modelsDir())))
  routes.post('/refresh', wrap(() => refreshTemplates(deps.modelsDir())))
  routes.get('/:name', (c) => wrap(() => templateDetail(c.req.param('name'), deps.modelsDir()))(c))
  routes.post('/:name/add', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { kind?: string }
    return wrap(() => addTemplate(c.req.param('name'), body.kind === 'web' ? 'web' : 'game', deps))(c)
  })
  routes.post('/:name/download', (c) => wrap(() => downloadTemplate(c.req.param('name'), deps))(c))
  return routes
}
