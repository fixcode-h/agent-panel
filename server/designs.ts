import { Hono, type Context } from 'hono'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { extractJson } from '../shared/assist.ts'
import { openDesignSession } from './design-mcp.ts'
import { mcpConfig } from '../shared/cli-spec.ts'

import { getCli } from '../shared/clis.ts'
import {
  Design,
  addToParts,
  type ReplyPart,
  DesignChatInput,
  DesignProject,
  DesignProjectInput,
  SavedStyle,
  SavedStyleInput,
  AiStyle,
  buildStyleExtractPrompt,
  DesignDoc,
  DesignImage,
  GenerateImageInput,
  NewDesignInput,
  AiPrompts,
  PromptAiInput,
  buildPromptAiPrompt,
  buildDesignPrompt,
  emptyRoot,
  imagePrompt,
  sheetGrid,
  sheetPrompt,
  importComponent,
  type DesignVersion,
  type DesignVersionMeta,
  type ProjectComponents,
  projectPromptText,
  AiDesignResult,
  resolveDesignResult,
  type DesignJob,
  type DesignMeta,
  type ImageJobItem,
  type ImageSource,
} from '../shared/design.ts'
import type { Project } from '../shared/schema.ts'
import { agentRun, cliSettings, defaultCli } from '../shared/settings.ts'
import { exportDesign, migrateGrids, normalizeTree, uniqueName, usedImages, walk } from '../shared/umg.ts'
import { webExport, webReactExport } from '../shared/web.ts'
import { t } from '../shared/i18n.ts'
import { askSession, askingScopes, setAskUser } from './asks.ts'
import { browserGenerate, browserParallel, browserStatus } from './bridge.ts'
import { invokeCli, type CliControl } from './exec/invoke.ts'
import { failureHints } from './exec/runner.ts'
import { normalizeGenerated, sliceSheet } from './image.ts'
import { BUILTIN_STYLES, isBuiltinStyle } from '../shared/styles.ts'
import { childEnv } from './exec/process.ts'
import { log } from './log.ts'
import { getSettings } from './settings.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from './store.ts'
import { UPLOADS_DIR, clipTranscript, saveTextUpload } from './uploads.ts'
import { expandSlash } from './slash.ts'
import { withAttachments } from '../shared/task.ts'
import { imageSize, zip } from './zip.ts'

/**
 * UI 设计：每个设计一个 JSON（designs/<id>.json），生成和上传的图片放在 designs/<id>/images/。
 * 和任务分开存放，侧栏也分开列。
 */
const DIR = path.join(DATA_DIR, 'designs')
const fileOf = (id: string) => path.join(DIR, `${id}.json`)
const imagesDir = (id: string) => path.join(DIR, id, 'images')
/** 版本单独存一个文件：设计文件页面每秒都要取，不能带着所有历史版本 */
const versionsFile = (id: string) => path.join(DIR, id, 'versions.json')
/** 自动存的版本最多留这么多，手动存的最多 50 个 */
const MAX_AUTO_VERSIONS = 20
const MAX_VERSIONS = 50
// 下划线开头，和设计文件（<id>.json）区分开
const PROJECTS_FILE = path.join(DIR, '_projects.json')
/** 风格库：设置里管理，所有 UI 项目共用 */
const STYLES_FILE = path.join(DIR, '_styles.json')

type Lister<T> = { get(id: string): Promise<T | null>; list(): Promise<T[]> }
const isImageFile = (x: { mime: string; name: string }) =>
  /^image\//.test(x.mime) || /\.(png|jpe?g|gif|webp)$/i.test(x.name)

/** 存进消息的分段：工具都已结束，去掉空的段 */
function finalParts(parts: ReplyPart[]): ReplyPart[] | undefined {
  const list = parts
    .map((p) => ({ ...p, tools: p.tools.map((x) => ({ ...x, running: false })) }))
    .filter((p) => p.text || p.thinking?.trim() || p.tools.length)
  return list.length ? list : undefined
}

type Job = DesignJob & {
  abort: AbortController
  /** 生成图片时：把一张图排进这一轮的队列（点了「重试」或「再生成」）；不在生成图片时没有 */
  enqueue?: (img: DesignImage, revision?: string) => void
  /** 审批和提问放在哪个会话下（design:<设计 id>），页面按它取回来显示 */
  scope: string
  /** AI 正在改设计时控制 CLI：把用户新说的话补充给这一轮 */
  control?: CliControl
  /** 这一轮列出的图标表：图片 id → sheet，生成图片时同一个 sheet 的图标一起生成 */
  sheets?: Map<string, string>
}

const now = () => new Date().toISOString()
const meta = (d: Design): DesignMeta => ({
  id: d.id,
  projectId: d.projectId,
  kind: d.kind,
  title: d.title,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
})

export function designsApi(deps: { projects: Lister<Project> }) {
  const cache = new Map<string, Design>()
  let loaded = false
  const writing = new Map<string, Promise<void>>()
  const jobs = new Map<string, Job>()
  const bad = (c: Context, error: string, status: 400 | 404 | 409 = 400) => c.json({ error }, status)

  async function loadAll() {
    if (loaded) return
    await mkdir(DIR, { recursive: true })
    for (const f of await readdir(DIR)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue
      const raw = await readJson(path.join(DIR, f))
      const p = Design.safeParse(raw)
      if (p.success) {
        const d = p.data as Design
        cache.set(d.id, {
          ...d,
          root: migrateGrids(d.root),
          components: d.components.map((c) => ({ ...c, Root: migrateGrids(c.Root) })),
        })
      } else log.warn('designs', `设计文件格式不对，跳过：${f}`)
    }
    loaded = true
  }
  // ---- UI 设计的项目 ----
  let projects: DesignProject[] | null = null
  async function loadProjects() {
    if (projects) return projects
    await loadAll()
    const raw = await readJson(PROJECTS_FILE)
    if (Array.isArray(raw)) projects = raw.flatMap((x) => DesignProject.safeParse(x).data ?? [])
    else {
      // 第一版的设计挂在 Agent 的项目下：按原来的项目建同名的设计项目，id 不变，设计不用改
      projects = []
      for (const pid of new Set([...cache.values()].map((d) => d.projectId))) {
        const old = await deps.projects.get(pid)
        const at = now()
        projects.push({
          id: pid,
          name: old?.name ?? t('未分类'),
          path: old?.path ?? '',
          prompts: [],
          createdAt: at,
          updatedAt: at,
        })
      }
      await saveProjects()
    }
    return projects
  }
  const saveProjects = () => writeJsonAtomic(PROJECTS_FILE, projects ?? [], true)

  let styles: SavedStyle[] | undefined
  async function loadStyles() {
    if (styles) return styles
    const raw = await readJson(STYLES_FILE)
    styles = Array.isArray(raw) ? raw.flatMap((x) => SavedStyle.safeParse(x).data ?? []) : []
    return styles
  }
  const saveStyles = () => writeJsonAtomic(STYLES_FILE, styles ?? [], true)
  async function removeDesign(d: Design) {
    jobs.get(d.id)?.abort.abort()
    jobs.delete(d.id)
    cache.delete(d.id)
    await writing.get(d.id)?.catch(() => {})
    await rm(fileOf(d.id), { force: true })
    await rm(path.join(DIR, d.id), { recursive: true, force: true })
  }

  async function get(id: string) {
    await loadAll()
    return cache.get(id)
  }
  /** 同一个设计的写入串行；每次写最新的内容 */
  function save(d: Design, touch = true) {
    if (touch) d.updatedAt = now()
    cache.set(d.id, d)
    const prev = writing.get(d.id) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(() => writeJsonAtomic(fileOf(d.id), cache.get(d.id), true))
    writing.set(d.id, next)
    return next
  }

  async function storeImage(d: Design, buf: Buffer) {
    const info = imageSize(buf)
    if (!info) throw new Error(t('不是能识别的图片（支持 PNG、JPEG、WebP、GIF）'))
    const file = `${randomUUID().slice(0, 12)}.${info.ext}`
    await mkdir(imagesDir(d.id), { recursive: true })
    await writeFile(path.join(imagesDir(d.id), file), buf)
    return { file, width: info.width, height: info.height }
  }

  // ---- 生成图片 ----

  const withRevision = (prompt: string, revision: string) =>
    revision.trim() ? `${prompt}\n\n${revision.trim()}` : prompt

  /** 项目提示词的英文：这个项目里每张图都带上 */
  async function projectStyle(d: Design) {
    const p = (await loadProjects()).find((x) => x.id === d.projectId)
    return projectPromptText(p?.prompts ?? [])
  }

  /**
   * 收图：每取回一版就存下来、马上换到设计里（页面轮询时就能看到）。第一版到了就选中它，之后的几版作为备选。
   * 存之前精确变成设计里要的宽高（模型出图的尺寸和比例不由我们定），透明的图抠掉绿底、裁掉空白
   */
  function variantSink(d: Design, img: DesignImage, source: ImageSource, item: ImageJobItem) {
    const cur = () => cache.get(d.id)!.images.find((i) => i.id === img.id)
    const set = (patch: Partial<DesignImage>) => {
      const dd = cache.get(d.id)!
      dd.images = dd.images.map((i) => (i.id === img.id ? { ...i, ...patch } : i))
      void save(dd)
    }
    let first = -1
    let chain = Promise.resolve()
    const kind = source.kind === 'browser' ? ('browser' as const) : ('cli' as const)
    const add = (buf: Buffer, exact = false) => {
      chain = chain
        .then(async () => {
          const want = cur() ?? img
          const s = await storeImage(cache.get(d.id)!, exact ? buf : normalizeGenerated(buf, want))
          const variants = [...(cur()?.variants ?? []), { ...s, source: kind, at: now() }]
          if (first < 0) first = variants.length - 1
          set({ variants, selected: first })
          item.got++
        })
        .catch((e) => log.warn('designs', '保存生成的图片失败', { error: (e as Error).message }))
    }
    return { set, add, done: () => chain }
  }

  /** 生成一张图 */
  async function generateOne(
    d: Design,
    img: DesignImage,
    source: ImageSource,
    count: number,
    style: string,
    job: Job,
    item: ImageJobItem,
    /** 这一次的修改意见，加在描述后面 */
    revision = '',
  ) {
    const sink = variantSink(d, img, source, item)
    sink.set({ status: 'generating', error: undefined })
    item.status = 'generating'
    try {
      const rest =
        source.kind === 'browser'
          ? await browserGenerate(
              {
                tabId: source.tabId,
                prompt: withRevision(
                  imagePrompt(img, cache.get(d.id)!.style, img.transparent, style, d.kind),
                  revision,
                ),
                count,
                chroma: img.transparent,
                concurrency: (await getSettings()).imageGen.concurrency,
                onProgress: (text) => (item.text = text),
                onImage: (b) => sink.add(b),
              },
              job.abort.signal,
            )
          : await cliGenerate(
              // 透明的图让模型画纯绿底，面板自己抠：比模型自己出透明图可靠
              withRevision(imagePrompt(img, cache.get(d.id)!.style, img.transparent, style, d.kind), revision),
              count,
              job,
              (b) => sink.add(b),
            )
      for (const b of rest) sink.add(b)
      await sink.done()
      if (!item.got) throw new Error(t('没有取到图片'))
      sink.set({ status: 'idle' })
      item.status = 'done'
      item.text = undefined
    } catch (e) {
      await sink.done()
      const msg = (e as Error).message
      // 已经取回的几版留着能用，只是没生成全
      sink.set(item.got ? { status: 'idle' } : { status: 'failed', error: msg })
      item.status = 'failed'
      item.text = msg
      throw e
    }
  }

  /**
   * 同类的小图标一次生成：让模型把它们画在一张图上（排成格子），面板按格切开、各自精确裁成要的尺寸。
   * 一次出图就是十几个图标，比一个个生成快得多；没切出来的图标（模型漏画了）单独再生成
   */
  async function generateSheet(
    d: Design,
    imgs: DesignImage[],
    items: ImageJobItem[],
    source: ImageSource,
    count: number,
    style: string,
    job: Job,
    revision: string,
  ) {
    const sinks = imgs.map((img, i) => variantSink(d, img, source, items[i]))
    const { cols, rows } = sheetGrid(imgs.length, {
      width: Math.max(...imgs.map((i) => i.width)),
      height: Math.max(...imgs.map((i) => i.height)),
    })
    const chroma = imgs.some((i) => i.transparent)
    const prompt = withRevision(sheetPrompt(imgs, cache.get(d.id)!.style, chroma, style, d.kind), revision)
    imgs.forEach((img, i) => {
      sinks[i].set({ status: 'generating', error: undefined })
      items[i].status = 'generating'
      items[i].text = t('和另外 {n} 个图标一起生成', { n: imgs.length - 1 })
    })
    const missed = new Set(imgs.map((_, i) => i))
    const onSheet = (buf: Buffer) => {
      const parts = sliceSheet(buf, cols, rows, imgs)
      parts.forEach((part, i) => {
        if (!part) return
        missed.delete(i)
        sinks[i].add(part, true)
      })
    }
    try {
      const rest =
        source.kind === 'browser'
          ? await browserGenerate(
              {
                tabId: source.tabId,
                prompt,
                count,
                chroma,
                concurrency: (await getSettings()).imageGen.concurrency,
                onProgress: (text) => items.forEach((it) => (it.text = text)),
                onImage: onSheet,
              },
              job.abort.signal,
            )
          : await cliGenerate(prompt, count, job, onSheet)
      for (const b of rest) onSheet(b)
    } catch (e) {
      // 整张图都没出来：全部改成一张张生成，下面统一处理
      if (job.abort.signal.aborted) throw e
      log.warn('designs', '图标表生成失败，改成一张张生成', { error: (e as Error).message })
    }
    await Promise.all(sinks.map((x) => x.done()))
    const failed: string[] = []
    // 没切出来的单独生成（整张图失败时就是全部）
    for (const i of missed) {
      if (job.abort.signal.aborted) break
      items[i].text = undefined
      items[i].got = 0
      try {
        await generateOne(cache.get(d.id)!, imgs[i], source, count, style, job, items[i], revision)
      } catch (e) {
        failed.push(`${imgs[i].name}：${(e as Error).message}`)
      }
    }
    for (let i = 0; i < imgs.length; i++) {
      if (missed.has(i)) continue
      sinks[i].set({ status: 'idle' })
      items[i].status = 'done'
      items[i].text = undefined
    }
    if (failed.length) throw new Error(failed.join('\n'))
  }

  /** 用设置里的图片 CLI（Codex 的 image_gen）生成：每生成一张就交给 onImage */
  async function cliGenerate(prompt: string, count: number, job: Job, onImage: (b: Buffer) => void): Promise<Buffer[]> {
    const settings = await getSettings()
    const cliId = settings.imageGen.cli || 'codex'
    const def = getCli(cliId)
    if (!def?.images)
      throw new Error(t('{cli} 不能生成图片，请在设置的「默认 CLI」里换成 Codex', { cli: def?.name ?? cliId }))
    const cs = cliSettings(settings, cliId)
    if (!cs.enabled) throw new Error(t('{cli} 在设置里被停用了', { cli: def.name }))
    const run = agentRun(
      { cli: cliId, model: settings.imageGen.model || '@high', effort: settings.imageGen.effort },
      settings,
    )
    const cwd = path.join(tmpdir(), 'agent-panel-images')
    await mkdir(cwd, { recursive: true })
    let got = 0
    // 图片文件可能还没写完，读到了再交出去；最后等所有读取结束
    const reads: Promise<void>[] = []
    const errors: string[] = []
    let result: { ok: boolean; error?: string } | undefined
    const asks = askSession(job.scope)
    const r = await invokeCli({
      askUser: asks.askUser,
      onAsk: asks.onAsk,
      cliId,
      command: cs.command,
      build: {
        model: run.model,
        effort: run.effort,
        // 审批按设置里的权限：CLI 要确认时弹出卡片等用户
        permission: cs.permission,
        extraArgs: cs.extraArgs,
      },
      cwd,
      env: childEnv(cs.env),
      input: `请用内置的 image_gen 工具生成 ${count} 张图片（每张单独调用一次 image_gen，内容一样、细节可以不同）。不要写代码、不要运行命令、不要另存文件，生成完直接结束，不用解释。

图片要求：
${prompt}`,
      signal: job.abort.signal,
      // 不限时长，用户随时可以停止
      timeoutMs: 0,
      onEvent: (ev) => {
        if (ev.type === 'image') {
          if (ev.failed) errors.push(ev.failed)
          else if (ev.path || ev.data) {
            const b64 = ev.data ? Buffer.from(ev.data, 'base64') : null
            const read = ev.path ? readFile(ev.path).catch(() => b64) : Promise.resolve(b64)
            reads.push(
              read.then((b) => {
                if (!b?.length) return
                got++
                onImage(b)
              }),
            )
          }
        } else if (ev.type === 'error') errors.push(ev.message)
        else if (ev.type === 'result') result = ev
        else if (ev.type === 'text_delta' || ev.type === 'text') job.outChars += ev.text.length
      },
    }).finally(asks.done)
    await Promise.all(reads)
    if (r.killed === 'stopped') throw new Error(t('已停止'))
    if (r.spawnError) throw new Error(t('{error}。请确认已安装 {cli}', { error: r.spawnError, cli: def.name }))
    if (!got)
      throw new Error(
        [
          t('{cli} 没有生成图片', { cli: def.name }),
          result?.error,
          ...errors,
          r.stderr.trim().split('\n').slice(-3).join('\n'),
        ]
          .filter(Boolean)
          .join('：'),
      )
    return []
  }
  async function generateImages(
    d: Design,
    ids: string[],
    source: ImageSource,
    count: number,
    job: Job,
    /** 图片 id → 这一次的修改意见 */
    revisions: Record<string, string> = {},
  ) {
    job.phase = 'images'
    // 进入生成图片阶段：对话的说明已经成了一条消息，不再显示
    job.preview = undefined
    job.text = ''
    job.parts = undefined
    const list = ids.map((id) => d.images.find((i) => i.id === id)).filter(Boolean) as DesignImage[]
    const items: ImageJobItem[] = list.map((i) => ({ id: i.id, name: i.name, status: 'waiting', got: 0, want: count }))
    job.images = items
    const style = await projectStyle(d)
    // 每张图单独一个会话（CLI 进程或浏览器里的新对话），同时跑的个数在设置里调；旧版扩展只能一张张来
    const settings = await getSettings()
    const width = source.kind === 'browser' && !browserParallel() ? 1 : settings.imageGen.concurrency
    // 失败的图：图片 id → 原因；点了重试、重新生成成功的从这里去掉
    const failed = new Map<string, string>()
    // 同一个 sheet（至少 2 个、透明度一样）的图标一起生成，其余一张张来
    type Task = { imgs: DesignImage[]; items: ImageJobItem[]; revision: string }
    const queue: Task[] = []
    const groups = new Map<string, number[]>()
    list.forEach((img, k) => {
      const sheet = job.sheets?.get(img.id)
      if (sheet) groups.set(`${sheet}:${img.transparent}`, [...(groups.get(`${sheet}:${img.transparent}`) ?? []), k])
    })
    const grouped = new Set<number>()
    for (const ks of groups.values())
      if (ks.length >= 2) {
        ks.forEach((k) => grouped.add(k))
        queue.push({
          imgs: ks.map((k) => list[k]),
          items: ks.map((k) => items[k]),
          revision: revisions[list[ks[0]].id] ?? '',
        })
      }
    list.forEach((img, k) => {
      if (!grouped.has(k)) queue.push({ imgs: [img], items: [items[k]], revision: revisions[img.id] ?? '' })
    })
    let next = 0
    const worker = async () => {
      while (next < queue.length && !job.abort.signal.aborted) {
        const task = queue[next++]
        try {
          if (task.imgs.length > 1)
            await generateSheet(cache.get(d.id)!, task.imgs, task.items, source, count, style, job, task.revision)
          else
            await generateOne(cache.get(d.id)!, task.imgs[0], source, count, style, job, task.items[0], task.revision)
          for (const img of task.imgs) failed.delete(img.id)
        } catch (e) {
          // 图标表里失败的图标各自带着原因（一行一个）
          const msg = (e as Error).message
          if (task.imgs.length > 1) for (const line of msg.split('\n')) failed.set(line, line)
          else failed.set(task.imgs[0].id, `${task.imgs[0].name}：${msg}`)
        }
      }
    }
    const workers = new Set<Promise<void>>()
    const spawn = () => {
      const p: Promise<void> = worker().finally(() => workers.delete(p))
      workers.add(p)
    }
    for (let i = 0; i < Math.min(width, queue.length); i++) spawn()
    // 重试、再生成：排到队尾，有空着的位置就马上开始。已经在排队或正在生成的不重复排
    job.enqueue = (img, revision = '') => {
      let item = items.find((x) => x.id === img.id)
      if (item?.status === 'waiting' || item?.status === 'generating') return
      if (item) Object.assign(item, { status: 'waiting', got: 0, text: undefined })
      else items.push((item = { id: img.id, name: img.name, status: 'waiting', got: 0, want: count }))
      queue.push({ imgs: [img], items: [item], revision })
      if (workers.size < width) spawn()
    }
    while (workers.size) await Promise.all([...workers])
    job.enqueue = undefined
    // 没轮到的（停止了）恢复成未生成
    const dd = cache.get(d.id)!
    dd.images = dd.images.map((i) => (ids.includes(i.id) && i.status === 'pending' ? { ...i, status: 'idle' } : i))
    await save(dd)
    return [...failed.values()]
  }

  // ---- AI 对话 ----

  /** 对话用的 CLI：页面选的（装好且没停用时），否则默认 CLI 的高档模型 */
  function chatRun(settings: Awaited<ReturnType<typeof getSettings>>, pick?: DesignChatInput['run']) {
    if (pick?.cli && getCli(pick.cli) && cliSettings(settings, pick.cli).enabled) {
      const run = agentRun({ cli: pick.cli, model: pick.model, effort: pick.effort }, settings)
      return { cli: pick.cli, model: run.model, effort: run.effort }
    }
    const cli = defaultCli(settings)
    const run = agentRun({ cli, model: '@high' }, settings)
    return { cli, model: run.model, effort: run.effort }
  }

  /** 项目提示词和项目里其他设计已有的图片，给设计 AI 参考，保持整个项目风格一致 */
  async function projectContext(d: Design) {
    const p = (await loadProjects()).find((x) => x.id === d.projectId)
    const images = [...cache.values()]
      .filter((x) => x.projectId === d.projectId && x.id !== d.id)
      .flatMap((x) =>
        x.images.filter((i) => i.variants.length && i.prompt).map((i) => ({ name: i.name, prompt: i.prompt })),
      )
      .slice(0, 30)
    return { prompts: p?.prompts ?? [], images }
  }

  async function chat(d: Design, input: z.infer<typeof DesignChatInput>, job: Job) {
    const settings = await getSettings()
    const run = chatRun(settings, input.run)
    const cliId = run.cli
    const def = getCli(cliId)!
    const cs = cliSettings(settings, cliId)
    job.run = run
    setAskUser(job.scope, input.askUser)
    // 每一轮一个单独的工作目录：放设计工具的配置和附件，结束后删掉
    const cwd = path.join(tmpdir(), 'agent-panel-design', randomUUID())
    await mkdir(cwd, { recursive: true })
    // 附件复制进工作目录：有的 CLI 读不了工作目录以外的文件（以前 Command Code 说找不到参考图就是这样）
    const attachments = await Promise.all(
      input.attachments.map(async (a, i) => {
        const to = path.join(cwd, 'attachments', `${i + 1}-${path.basename(a.path)}`)
        await mkdir(path.dirname(to), { recursive: true })
        return (await cp(a.path, to).then(
          () => true,
          () => false,
        ))
          ? { ...a, path: to }
          : a
      }),
    )
    // 附件图片的精确尺寸写进要求里：AI 按它量、换算，不用目测
    const facts = (
      await Promise.all(
        attachments.map(async (a, i) => {
          const info = isImageFile(a) ? imageSize(await readFile(a.path).catch(() => Buffer.alloc(0))) : null
          return info
            ? `附件 ${i + 1}「${a.name}」：${info.width}×${info.height} 像素（inspect_image、view_image 里写 attachment:${i + 1}）`
            : ''
        }),
      )
    ).filter(Boolean)
    const history = d.messages.slice(0, -1)
    const project = await projectContext(d)
    let extra = ''
    // AI 只通过设计工具（MCP）改设计，回复就是普通文字；CLI 的定义里写了怎么把工具交给它
    if (!def.mcp) throw new Error(t('{cli} 用不了设计工具，请换一个 CLI', { cli: def.name }))
    const mcp = openDesignSession(cache.get(d.id)!, (s) => (job.preview = { ...s.state, applied: s.applied }), {
      dir: cwd,
      attachments: attachments.map((a) => ({ name: a.name, path: a.path })),
      imagePath: (id) => {
        const im = cache.get(d.id)?.images.find((i) => i.id === id)
        const v = im?.variants[im.selected] ?? im?.variants.at(-1)
        return v ? path.join(imagesDir(d.id), v.file) : undefined
      },
    })
    const tools = mcpConfig(def.mcp, 'design', mcp.url)
    // 要配置文件的 CLI（Command Code、Gemini CLI）读工作目录里的配置
    for (const f of tools.files) {
      const to = path.join(cwd, f.path)
      await mkdir(path.dirname(to), { recursive: true })
      await writeFile(to, JSON.stringify(f.content, null, 2))
    }
    const sess = mcp.session
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        job.attempt = attempt
        job.text = ''
        job.parts = undefined
        job.outChars = 0
        job.preview = sess.applied ? { ...sess.state, applied: sess.applied } : undefined
        // 工具调用的 id → 在分段里的位置（第几段、第几个），结果回来时更新那一条
        const toolAt = new Map<string, [number, number]>()
        let parts: ReplyPart[] = []
        let text = ''
        const errors: string[] = []
        let result: { ok: boolean; error?: string } | undefined
        const asks = askSession(job.scope)
        const r = await invokeCli({
          askUser: asks.askUser,
          onAsk: asks.onAsk,
          onControl: (c) => (job.control = c),
          cliId,
          command: cs.command,
          build: {
            model: run.model,
            effort: run.effort,
            permission: cs.permission,
            extraArgs: [...cs.extraArgs, ...tools.args],
            // 附件在面板的数据目录里，不在工作目录下；Claude Code 读工作目录外的文件要先放行
            addDirs: attachments.some((a) => !a.path.startsWith(cwd)) ? [UPLOADS_DIR] : undefined,
          },
          cwd,
          env: childEnv(cs.env),
          input:
            buildDesignPrompt(
              cache.get(d.id)!,
              history,
              withAttachments(await expandSlash(input.text, cliId, '', false), attachments) +
                (facts.length ? `\n\n${facts.join('\n')}` : ''),
              input.annotations,
              project,
              // 风格还没定时 AI 把同类的风格作为选项：自己存的在前，再加内置的
              [...(await loadStyles()), ...BUILTIN_STYLES].filter((x) => x.kind === d.kind),
            ) + extra,
          signal: job.abort.signal,
          // 不限时长：复杂的界面让 Agent 慢慢做完，用户随时可以停止
          timeoutMs: 0,
          // 附上的截图、参考图直接给模型看（路径也写在提示词里，需要时它还能自己读）
          images: attachments.filter(isImageFile).map((x) => x.path),
          onEvent: (ev) => {
            if (ev.type === 'text_delta') {
              text += ev.text
              parts = addToParts(parts, { type: 'text', text: ev.text, delta: true })
            } else if (ev.type === 'text') {
              text = text ? `${text.trimEnd()}\n\n${ev.text}` : ev.text
              parts = addToParts(parts, { type: 'text', text: ev.text })
            } else if (ev.type === 'thinking')
              parts = addToParts(parts, { type: 'thinking', text: ev.text, delta: ev.delta })
            else if (ev.type === 'tool') {
              parts = addToParts(parts, { type: 'tool', tool: { ...ev.tool, running: !!ev.id } })
              if (ev.id) toolAt.set(ev.id, [parts.length - 1, parts.at(-1)!.tools.length - 1])
            } else if (ev.type === 'tool_delta' || ev.type === 'tool_result') {
              const at = toolAt.get(ev.id)
              const cur = at && parts[at[0]]?.tools[at[1]]
              if (at && cur)
                parts = addToParts(parts, {
                  type: 'tool_update',
                  at,
                  patch:
                    ev.type === 'tool_delta'
                      ? { output: ((cur.output ?? '') + ev.text).slice(-4000) }
                      : { output: ev.output.slice(-4000), failed: ev.failed, running: false },
                })
            } else if (ev.type === 'error') errors.push(ev.message)
            else if (ev.type === 'result') result = ev
            job.text = text.trim()
            job.parts = parts
            job.outChars = text.length
          },
        }).finally(() => {
          asks.done()
          job.control = undefined
        })
        if (r.killed === 'stopped') throw new Error(t('已停止'))
        if (r.spawnError)
          throw new Error(
            t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写路径。', {
              error: r.spawnError,
              cli: def.name,
              hint: def.installHint,
            }),
          )
        if (result ? !result.ok : r.code !== 0) {
          const detail =
            [result?.error, ...errors, r.stderr.trim().split('\n').slice(-4).join('\n')].filter(Boolean).join('\n') ||
            t('没有更多信息')
          // 启动就因为工具的参数报错：多半是 CLI 版本太旧
          if (!sess.applied && /mcp|mcp_servers|mcp-config|allowedTools/i.test(detail))
            throw new Error(t('{cli} 连不上设计工具，请升级到最新版：{detail}', { cli: def.name, detail }))
          throw new Error(
            [t('{cli} 执行失败：{detail}', { cli: def.name, detail }), ...failureHints(detail, def)].join('\n\n'),
          )
        }
        // 回复就是普通文字；改动都在工具里做好了
        const touched = sess.applied > 0 || sess.images.length > 0
        const raw = {
          reply: text.trim(),
          style: sess.style,
          designSize: sess.designSize,
          questions: sess.questions,
          images: sess.images,
          // 什么都没改（只是回答问题）时不带 ops：设计原样不动，也不算一次修改
          ops: touched ? [] : undefined,
        }
        let res = resolveDesignResult(raw, {
          ...cache.get(d.id)!,
          root: sess.state.root,
          components: sess.state.components,
        })
        let problems = ''
        if ('error' in res) {
          // 检查没通过：让它接着用工具改一次（改过的都保留）
          if (attempt === 1) {
            extra = `\n\n## 你上一次的回复\n${text}\n\n用工具改完的设计还有问题：${res.error}\n请用 design 工具接着改（改过的已经保留），改好后再回复说明。`
            continue
          }
          // 两次都没通过：改好的部分不丢，照样存下，把问题告诉用户
          problems = res.error
          const ok = AiDesignResult.safeParse({ ...raw, ops: undefined })
          if (!ok.success) throw new Error(z.prettifyError(ok.error))
          res = { result: ok.data, root: sess.state.root, components: sess.state.components }
        }
        const cur = cache.get(d.id)!
        const r2 = res.result
        const changed = !!(res.root || res.components || r2.designSize || r2.style !== undefined || r2.images.length)
        if (res.root) cur.root = res.root
        if (res.components) cur.components = res.components
        if (r2.designSize) cur.designSize = r2.designSize
        if (r2.style !== undefined) cur.style = r2.style
        const ids: string[] = []
        job.sheets = new Map(r2.images.flatMap((im) => (im.sheet ? [[im.id, im.sheet] as [string, string]] : [])))
        for (const im of r2.images) {
          ids.push(im.id)
          const old = cur.images.find((i) => i.id === im.id)
          const fields = {
            name: im.name,
            prompt: im.prompt,
            width: im.width,
            height: im.height,
            transparent: im.transparent,
            nineSlice: im.nineSlice,
            status: input.source.kind === 'none' ? ('idle' as const) : ('pending' as const),
            error: undefined,
          }
          if (old) cur.images = cur.images.map((i) => (i.id === im.id ? { ...i, ...fields } : i))
          else cur.images.push(DesignImage.parse({ id: im.id, ...fields }))
        }
        if (changed) cur.rev++
        cur.messages.push({
          id: randomUUID(),
          role: 'agent',
          text: r2.reply || t('改好了。'),
          at: now(),
          images: ids.length ? ids : undefined,
          run,
          // 过程按顺序存下：思考、工具调用和说明，和 Agent 的对话一样显示
          parts: finalParts(parts),
          ...(r2.questions?.length ? { questions: r2.questions } : {}),
        })
        if (problems)
          cur.messages.push({
            id: randomUUID(),
            role: 'system',
            text: `${t('检查还有这些问题：')}\n${problems}`,
            at: now(),
            error: true,
          })
        await save(cur)
        // 存下来了，页面改用正式的设计
        job.preview = undefined
        return ids
      }
    } finally {
      mcp.close()
      // 这一轮的工作目录（附件副本、工具的配置）用完就删
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
    return []
  }

  async function readVersions(id: string): Promise<DesignVersion[]> {
    const raw = await readJson(versionsFile(id))
    return Array.isArray(raw) ? (raw as DesignVersion[]) : []
  }
  async function writeVersions(id: string, list: DesignVersion[]) {
    await mkdir(path.dirname(versionsFile(id)), { recursive: true })
    await writeJsonAtomic(versionsFile(id), list)
  }
  const versionMeta = ({ snapshot, ...rest }: DesignVersion): DesignVersionMeta => {
    let widgets = 0
    for (const r of [snapshot.root, ...snapshot.components.map((c) => c.Root)]) walk(r, () => widgets++)
    return { ...rest, widgets }
  }
  /** 存一个版本（最新的在最前面）；自动存的超过上限时删掉最老的自动版本 */
  async function addVersion(d: Design, name: string, auto: boolean) {
    const v: DesignVersion = {
      id: randomUUID(),
      name,
      at: now(),
      auto,
      snapshot: structuredClone({
        designSize: d.designSize,
        style: d.style,
        root: d.root,
        components: d.components,
        images: d.images,
      }),
    }
    let list = [v, ...(await readVersions(d.id))]
    const autos = list.filter((x) => x.auto)
    if (autos.length > MAX_AUTO_VERSIONS) {
      const drop = new Set(autos.slice(MAX_AUTO_VERSIONS).map((x) => x.id))
      list = list.filter((x) => !drop.has(x.id))
    }
    await writeVersions(d.id, list.slice(0, MAX_VERSIONS + MAX_AUTO_VERSIONS))
    return v
  }

  /** 用默认 CLI 生成或翻译项目提示词；格式不对时让它改一次 */
  /** 用默认 CLI 跑一次、要一个 JSON 回来（项目提示词、风格提取）；格式不对时让它改一次 */
  async function askJson<T>(prompt: string, schema: z.ZodType<T>, scope: string, signal: AbortSignal): Promise<T> {
    const settings = await getSettings()
    const run = chatRun(settings)
    const def = getCli(run.cli)!
    const cs = cliSettings(settings, run.cli)
    if (!cs.enabled) throw new Error(t('{cli} 在设置里被停用了', { cli: def.name }))
    const cwd = path.join(tmpdir(), 'agent-panel-design')
    await mkdir(cwd, { recursive: true })
    let extra = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      let text = ''
      const errors: string[] = []
      let result: { ok: boolean; error?: string } | undefined
      const asks = askSession(scope)
      const r = await invokeCli({
        askUser: asks.askUser,
        onAsk: asks.onAsk,
        cliId: run.cli,
        command: cs.command,
        build: {
          model: run.model,
          effort: run.effort,
          permission: cs.permission,
          extraArgs: cs.extraArgs,
        },
        cwd,
        env: childEnv(cs.env),
        input: prompt + extra,
        signal,
        timeoutMs: 5 * 60_000,
        onEvent: (ev) => {
          if (ev.type === 'text_delta') text += ev.text
          else if (ev.type === 'text') text = text ? `${text.trimEnd()}\n\n${ev.text}` : ev.text
          else if (ev.type === 'error') errors.push(ev.message)
          else if (ev.type === 'result') result = ev
        },
      }).finally(asks.done)
      if (r.killed === 'stopped') throw new Error(t('已停止'))
      if (r.killed === 'timeout') throw new Error(t('超过 5 分钟没有完成，已停止'))
      if (r.spawnError) throw new Error(t('{error}。请确认已安装 {cli}', { error: r.spawnError, cli: def.name }))
      if (result ? !result.ok : r.code !== 0)
        throw new Error(
          t('{cli} 执行失败：{detail}', {
            cli: def.name,
            detail: [result?.error, ...errors, r.stderr.trim().split('\n').slice(-4).join('\n')]
              .filter(Boolean)
              .join('\n'),
          }),
        )
      const ex = extractJson(text)
      const parsed = ex.error ? undefined : schema.safeParse(ex.json)
      if (parsed?.success) return parsed.data
      const why = ex.error ?? (parsed ? z.prettifyError(parsed.error) : '')
      if (attempt === 2) throw new Error(t('{cli} 两次都没有按格式输出：{error}', { cli: def.name, error: why }))
      extra = `\n\n## 你上一次的输出\n${text}\n\n上面的 JSON 不符合要求：${why}\n请重新输出。`
    }
    throw new Error(t('没有拿到结果'))
  }

  /** 用默认 CLI 生成或翻译项目提示词 */
  const promptAi = (input: PromptAiInput, signal: AbortSignal) =>
    askJson(buildPromptAiPrompt(input), AiPrompts, `prompts:${input.scope || randomUUID()}`, signal)

  /** 让 CLI 从设计里总结整体风格，给用户确认后存进风格库 */
  async function extractStyle(d: Design, scope: string, signal: AbortSignal) {
    const project = await projectContext(d)
    return askJson(buildStyleExtractPrompt(d, d.messages, project), AiStyle, `style:${scope || randomUUID()}`, signal)
  }

  function startJob(d: Design, fn: (job: Job) => Promise<void>) {
    const job: Job = {
      status: 'running',
      phase: 'design',
      text: '',
      outChars: 0,
      attempt: 1,
      startedAt: Date.now(),
      abort: new AbortController(),
      scope: `design:${d.id}`,
    }
    jobs.set(d.id, job)
    fn(job)
      .then(() => {
        job.status = 'done'
      })
      .catch(async (e) => {
        job.status = 'failed'
        job.preview = undefined
        job.error = (e as Error).message
        log.warn('designs', '设计任务失败', { id: d.id, error: job.error })
        const cur = cache.get(d.id)
        if (cur) {
          // 错误一定要在对话里显示出来
          cur.messages.push({ id: randomUUID(), role: 'system', text: job.error, at: now(), error: true })
          cur.images = cur.images.map((i) =>
            i.status === 'pending' || i.status === 'generating' ? { ...i, status: 'idle' } : i,
          )
          await save(cur)
        }
      })
    return job
  }

  const view = (j?: Job): DesignJob | null => {
    if (!j) return null
    const { abort, enqueue, scope, control, sheets, ...rest } = j
    return rest
  }

  const routes = new Hono()
    .get('/projects', async (c) => c.json(await loadProjects()))
    .post('/projects', async (c) => {
      const p = DesignProjectInput.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const list = await loadProjects()
      const at = now()
      const item: DesignProject = { id: randomUUID(), ...p.data, createdAt: at, updatedAt: at }
      list.push(item)
      await saveProjects()
      return c.json(item, 201)
    })
    // 只改传了的字段：改名时不会把提示词清掉
    // 项目里所有设计已经做好的子控件（「控件」列表），带上它们用到的图片
    .get('/projects/:pid/components', async (c) => {
      await loadAll()
      const pid = c.req.param('pid')
      const out: ProjectComponents[] = [...cache.values()]
        .filter((d) => d.projectId === pid && d.components.length)
        .map((d) => ({
          designId: d.id,
          kind: d.kind,
          title: d.title,
          components: d.components,
          images: d.images.flatMap((i) => {
            const v = i.variants[i.selected] ?? i.variants.at(-1)
            return v ? [{ id: i.id, file: v.file, width: v.width, height: v.height }] : []
          }),
        }))
      return c.json(out)
    })
    .put('/projects/:pid', async (c) => {
      const body = await c.req.json().catch(() => ({}))
      const p = DesignProjectInput.partial().safeParse(body)
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const item = (await loadProjects()).find((x) => x.id === c.req.param('pid'))
      if (!item) return bad(c, t('项目不存在'), 404)
      // 默认值会补上没传的字段，只取请求里有的
      const patch = Object.fromEntries(Object.entries(p.data).filter(([k]) => k in (body as object)))
      Object.assign(item, patch, { updatedAt: now() })
      await saveProjects()
      return c.json(item)
    })
    // 删除项目时连同它的设计一起删
    .delete('/projects/:pid', async (c) => {
      const list = await loadProjects()
      const pid = c.req.param('pid')
      if (!list.some((x) => x.id === pid)) return bad(c, t('项目不存在'), 404)
      for (const d of [...cache.values()]) if (d.projectId === pid) await removeDesign(d)
      projects = list.filter((x) => x.id !== pid)
      await saveProjects()
      return c.body(null, 204)
    })
    .get('/', async (c) => {
      await loadAll()
      const pid = c.req.query('projectId')
      const asking = askingScopes()
      const list = [...cache.values()]
        .filter((d) => !pid || d.projectId === pid)
        .map((d) => ({
          ...meta(d),
          running: jobs.get(d.id)?.status === 'running',
          asking: asking.has(`design:${d.id}`),
        }))
      return c.json(list)
    })
    .post('/', async (c) => {
      const p = NewDesignInput.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      if (!(await loadProjects()).some((x) => x.id === p.data.projectId)) return bad(c, t('项目不存在'), 404)
      await loadAll()
      const at = now()
      const d: Design = {
        id: randomUUID(),
        projectId: p.data.projectId,
        kind: p.data.kind,
        title: p.data.title,
        designSize: p.data.designSize,
        style: '',
        root: emptyRoot(p.data.kind),
        components: [],
        images: [],
        annotations: [],
        messages: [],
        rev: 0,
        createdAt: at,
        updatedAt: at,
      }
      await save(d, false)
      return c.json(d, 201)
    })
    .get('/browser', (c) => c.json(browserStatus()))
    // 风格库：设置里增删改，设计里存进来、套用
    // 自己存的在前，内置的（程序自带、只读）在后
    .get('/styles', async (c) => c.json([...(await loadStyles()), ...BUILTIN_STYLES]))
    .post('/styles', async (c) => {
      const p = SavedStyleInput.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const at = now()
      const item: SavedStyle = { id: randomUUID(), ...p.data, createdAt: at, updatedAt: at }
      ;(await loadStyles()).unshift(item)
      await saveStyles()
      return c.json(item, 201)
    })
    // 只改传了的字段
    .put('/styles/:sid', async (c) => {
      const body = await c.req.json().catch(() => ({}))
      if (isBuiltinStyle(c.req.param('sid'))) return bad(c, t('内置风格不能修改，复制成自己的再改'))
      const p = SavedStyleInput.partial().safeParse(body)
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const list = await loadStyles()
      const i = list.findIndex((x) => x.id === c.req.param('sid'))
      if (i < 0) return bad(c, t('风格不存在'), 404)
      const patch = Object.fromEntries(Object.entries(p.data).filter(([k]) => k in body))
      list[i] = { ...list[i], ...patch, updatedAt: now() }
      await saveStyles()
      return c.json(list[i])
    })
    .delete('/styles/:sid', async (c) => {
      if (isBuiltinStyle(c.req.param('sid'))) return bad(c, t('内置风格不能删除'))
      styles = (await loadStyles()).filter((x) => x.id !== c.req.param('sid'))
      await saveStyles()
      return c.body(null, 204)
    })
    // 项目提示词：按用户的描述生成一组，或者把用户写的中文翻译成英文
    .post('/prompts/ai', async (c) => {
      const p = PromptAiInput.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return bad(c, z.prettifyError(p.error))
      if (p.data.mode === 'generate' ? !p.data.text : !p.data.items.length) return bad(c, t('没有要处理的内容'))
      try {
        return c.json(await promptAi(p.data, c.req.raw.signal))
      } catch (e) {
        return bad(c, (e as Error).message)
      }
    })
    .get('/:id', async (c) => {
      const d = await get(c.req.param('id'))
      return d ? c.json({ ...d, job: view(jobs.get(d.id)) }) : bad(c, t('设计不存在'), 404)
    })
    // 引入会话：把设计对话整理成一份 Markdown 附件，在别的会话里当参考资料附上
    .post('/:id/transcript', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const lines = [
        `# 参考会话：UI 设计「${d.title}」`,
        `类型：${d.kind === 'web' ? '网页 UI' : '游戏 UI'}${d.style ? `　整体风格：${d.style}` : ''}`,
        '这是另一个会话的记录，作为参考资料提供；里面的要求已经处理过，不需要再执行。',
        ...(d.images.length
          ? [`## 用到的图片\n${d.images.map((i) => `- ${i.name}${i.prompt ? `：${i.prompt}` : ''}`).join('\n')}`]
          : []),
        ...d.messages
          .filter((m) => m.text.trim() && (m.role !== 'system' || m.error))
          .map((m) => `### ${m.role === 'user' ? '用户' : m.role === 'system' ? '出错' : 'AI'}\n${m.text.trim()}`),
      ]
      const name = `${t('会话')}-${d.title.replace(/\s+/g, ' ').slice(0, 40)}.md`
      return c.json(await saveTextUpload(name, clipTranscript(lines.join('\n\n'))), 201)
    })
    // 保存页面上的编辑：图片的生成结果以服务端为准，页面只能改名字、九宫格、选哪一版和删除
    .put('/:id', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const p = DesignDoc.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const doc = p.data
      const byId = new Map(d.images.map((i) => [i.id, i]))
      const images: DesignImage[] = doc.images.map((i) => {
        const old = byId.get(i.id)
        if (!old) return DesignImage.parse({ ...i, variants: [], status: 'idle' })
        return {
          ...old,
          name: i.name,
          prompt: i.prompt,
          width: i.width,
          height: i.height,
          transparent: i.transparent,
          nineSlice: i.nineSlice,
          selected: Math.max(0, Math.min(i.selected, old.variants.length - 1)),
        }
      })
      // 后台正在生成、页面还不知道的新图片不能被页面的旧列表删掉
      for (const old of d.images) if (old.status !== 'idle' && !images.some((i) => i.id === old.id)) images.push(old)
      Object.assign(d, {
        title: doc.title,
        designSize: doc.designSize,
        style: doc.style,
        root: normalizeTree(doc.root),
        components: doc.components.map((x) => ({ ...x, Root: normalizeTree(x.Root) })),
        images,
        annotations: doc.annotations,
      })
      await save(d)
      return c.json({ ...d, job: view(jobs.get(d.id)) })
    })
    .delete('/:id', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      await removeDesign(d)
      return c.body(null, 204)
    })
    .get('/:id/files/:file', async (c) => {
      const file = c.req.param('file')
      if (!/^[\w-]+\.(png|jpg|webp|gif)$/.test(file)) return bad(c, t('文件名不对'))
      const buf = await readFile(path.join(imagesDir(c.req.param('id')), file)).catch(() => null)
      if (!buf) return bad(c, t('图片不存在'), 404)
      const ext = file.split('.').pop()!
      const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext]!
      return c.body(buf, 200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable' })
    })
    // 上传图片：新建一张，或者给已有的图片加一版
    .post('/:id/images', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const body = (await c.req.json().catch(() => ({}))) as { data?: string; name?: string; imageId?: string }
      const buf = Buffer.from(String(body.data ?? '').replace(/^data:[^,]*,/, ''), 'base64')
      if (!buf.length) return bad(c, t('没有图片数据'))
      if (buf.length > 20 * 1024 * 1024) return bad(c, t('图片太大（最多 20 MB）'))
      try {
        const s = await storeImage(d, buf)
        const v = { ...s, source: 'upload' as const, at: now() }
        const old = body.imageId ? d.images.find((i) => i.id === body.imageId) : undefined
        if (old) {
          old.variants.push(v)
          old.selected = old.variants.length - 1
        } else {
          const names = new Set(d.images.map((i) => i.name))
          const name = uniqueName(String(body.name || 'Image').replace(/\.\w+$/, ''), names)
          d.images.push(
            DesignImage.parse({
              id: `img_${randomUUID().slice(0, 8)}`,
              name,
              width: s.width,
              height: s.height,
              transparent: true,
              variants: [v],
            }),
          )
        }
        await save(d)
        return c.json({ ...d, job: view(jobs.get(d.id)) })
      } catch (e) {
        return bad(c, (e as Error).message)
      }
    })
    // 一次生成好几张（「生成全部未生成的」）：正在生成别的图时排进这一轮的队列
    .post('/:id/images/generate', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const running = jobs.get(d.id)?.status === 'running' ? jobs.get(d.id) : undefined
      if (running && !running.enqueue) return bad(c, t('正在处理上一个请求，等它完成或先停止'), 409)
      const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown }
      const p = GenerateImageInput.safeParse(body)
      if (!p.success) return bad(c, z.prettifyError(p.error))
      if (p.data.source.kind === 'none') return bad(c, t('请选择生成图片的方式'))
      const want = new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])
      const list = d.images.filter((i) => want.has(i.id) && i.prompt.trim() && i.status !== 'generating')
      if (!list.length) return bad(c, t('没有要生成的图片'))
      for (const i of list) {
        i.status = 'pending'
        i.error = undefined
      }
      await save(d)
      if (running?.enqueue) for (const i of list) running.enqueue(i)
      else
        startJob(d, async (job) => {
          const failed = await generateImages(
            d,
            list.map((i) => i.id),
            p.data.source,
            p.data.count,
            job,
          )
          if (failed.length)
            throw new Error(t('有 {n} 张图片没有生成出来：\n{list}', { n: failed.length, list: failed.join('\n') }))
        })
      return c.json({ ...d, job: view(jobs.get(d.id)) })
    })
    .post('/:id/images/:imageId/generate', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const running = jobs.get(d.id)?.status === 'running' ? jobs.get(d.id) : undefined
      // 正在生成别的图时排进这一轮的队列；AI 还在改设计时不行
      if (running && !running.enqueue) return bad(c, t('正在处理上一个请求，等它完成或先停止'), 409)
      const img = d.images.find((i) => i.id === c.req.param('imageId'))
      if (!img) return bad(c, t('图片不存在'), 404)
      const p = GenerateImageInput.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      if (p.data.source.kind === 'none') return bad(c, t('请选择生成图片的方式'))
      if (p.data.prompt !== undefined) img.prompt = p.data.prompt
      if (!img.prompt.trim()) return bad(c, t('先写一下这张图要画什么'))
      if (running?.enqueue) {
        img.status = 'pending'
        img.error = undefined
        await save(d)
        running.enqueue(img, p.data.revision)
        return c.json({ ...d, job: view(running) })
      }
      img.status = 'pending'
      await save(d)
      startJob(d, async (job) => {
        const failed = await generateImages(d, [img.id], p.data.source, p.data.count, job, {
          [img.id]: p.data.revision ?? '',
        })
        if (failed.length) throw new Error(failed.join('\n'))
      })
      return c.json({ ...d, job: view(jobs.get(d.id)) })
    })
    // 把项目里别的设计的子控件（连同它引用的子控件和图片）加进这个设计
    .post('/:id/components/import', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const { from, name } = (await c.req.json().catch(() => ({}))) as { from?: string; name?: string }
      const src = from ? cache.get(from) : undefined
      if (!src || src.projectId !== d.projectId) return bad(c, t('设计不存在'), 404)
      if (src.kind !== d.kind) return bad(c, t('游戏 UI 和网页 UI 的控件不能混用'))
      const r = importComponent(d, src, String(name ?? ''))
      if ('error' in r) return bad(c, r.error, 409)
      await mkdir(imagesDir(d.id), { recursive: true })
      for (const f of r.copyFiles)
        await cp(path.join(imagesDir(src.id), f), path.join(imagesDir(d.id), f)).catch(() => {})
      d.components = r.components
      d.images = r.images
      // 结构变了：页面用服务端的子控件替换本地的
      d.rev++
      await save(d)
      return c.json({ ...d, job: view(jobs.get(d.id)) })
    })
    // 重试一张失败的图：正在生成这一轮时排回队列，否则单独生成这一张
    .post('/:id/images/:imageId/retry', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const img = d.images.find((i) => i.id === c.req.param('imageId'))
      if (!img) return bad(c, t('图片不存在'), 404)
      const p = GenerateImageInput.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const running = jobs.get(d.id)
      if (running?.status === 'running') {
        if (!running.enqueue) return bad(c, t('正在处理上一个请求，等它完成或先停止'), 409)
        img.status = 'pending'
        img.error = undefined
        await save(d)
        running.enqueue(img)
        return c.json({ ...d, job: view(running) })
      }
      if (p.data.source.kind === 'none') return bad(c, t('请选择生成图片的方式'))
      if (!img.prompt.trim()) return bad(c, t('先写一下这张图要画什么'))
      img.status = 'pending'
      await save(d)
      startJob(d, async (job) => {
        const failed = await generateImages(d, [img.id], p.data.source, p.data.count, job)
        if (failed.length) throw new Error(failed.join('\n'))
      })
      return c.json({ ...d, job: view(jobs.get(d.id)) })
    })
    // ---- 版本 ----
    .get('/:id/versions', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      return c.json((await readVersions(d.id)).map(versionMeta))
    })
    .get('/:id/versions/:vid', async (c) => {
      const v = (await readVersions(c.req.param('id'))).find((x) => x.id === c.req.param('vid'))
      return v ? c.json(v) : bad(c, t('版本不存在'), 404)
    })
    .post('/:id/versions', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const { name } = (await c.req.json().catch(() => ({}))) as { name?: string }
      const v = await addVersion(
        d,
        String(name ?? '')
          .trim()
          .slice(0, 80) || t('未命名版本'),
        false,
      )
      return c.json(versionMeta(v))
    })
    // 恢复到某个版本：先把现在的样子自动存一个版本，免得恢复错了回不去
    .post('/:id/versions/:vid/restore', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      if (jobs.get(d.id)?.status === 'running') return bad(c, t('正在处理上一个请求，等它完成或先停止'), 409)
      const v = (await readVersions(d.id)).find((x) => x.id === c.req.param('vid'))
      if (!v) return bad(c, t('版本不存在'), 404)
      await addVersion(d, t('恢复「{name}」之前', { name: v.name }), true)
      d.root = v.snapshot.root
      d.components = v.snapshot.components
      d.designSize = v.snapshot.designSize
      d.style = v.snapshot.style
      // 版本里有、现在已经删掉的图片加回来（文件还在时）
      for (const img of v.snapshot.images)
        if (!d.images.some((i) => i.id === img.id)) d.images.push({ ...img, status: 'idle', error: undefined })
      d.rev++
      await save(d)
      return c.json({ ...d, job: view(jobs.get(d.id)) })
    })
    .delete('/:id/versions/:vid', async (c) => {
      const id = c.req.param('id')
      const list = await readVersions(id)
      await writeVersions(
        id,
        list.filter((x) => x.id !== c.req.param('vid')),
      )
      return c.body(null, 204)
    })
    .post('/:id/chat', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      if (jobs.get(d.id)?.status === 'running') return bad(c, t('正在处理上一个请求，等它完成或先停止'), 409)
      const p = DesignChatInput.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const settings = await getSettings()
      const cli = chatRun(settings, p.data.run).cli
      if (!cliSettings(settings, cli).enabled) return bad(c, t('{cli} 在设置里被停用了', { cli: getCli(cli)!.name }))
      // 在风格提问里选了整体风格：先定下来，这一轮按它做
      if (p.data.style) d.style = p.data.style
      d.messages.push({
        id: randomUUID(),
        role: 'user',
        text: p.data.text,
        at: now(),
        ...(p.data.annotations.length ? { annotations: p.data.annotations } : {}),
        ...(p.data.attachments.length ? { attachments: p.data.attachments } : {}),
      })
      await save(d)
      // AI 改之前自动存一个版本，改坏了可以回去
      await addVersion(d, t('AI 修改前：{text}', { text: p.data.text.slice(0, 24) }), true)
      startJob(d, async (job) => {
        const ids = await chat(d, p.data, job)
        if (!ids.length || p.data.source.kind === 'none') return
        const failed = await generateImages(d, ids, p.data.source, p.data.count, job)
        if (failed.length)
          throw new Error(t('有 {n} 张图片没有生成出来：\n{list}', { n: failed.length, list: failed.join('\n') }))
      })
      return c.json({ ...d, job: view(jobs.get(d.id)) })
    })
    // AI 正在改设计时用户又说了话：补充给正在进行的这一轮；CLI 不支持插话或这一轮已经结束时告诉页面改成排队
    .post('/:id/steer', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const { text = '' } = (await c.req.json().catch(() => ({}))) as { text?: string }
      const v = String(text).trim().slice(0, 20000)
      if (!v) return bad(c, t('内容不能为空'))
      const job = jobs.get(d.id)
      const ok = job?.status === 'running' && job.phase === 'design' && !!job.control && (await job.control.steer(v))
      if (!ok) return c.json({ steered: false })
      d.messages.push({ id: randomUUID(), role: 'user', text: v, at: now() })
      await save(d)
      return c.json({ steered: true })
    })
    // 让 CLI 总结这个设计的整体风格；页面上确认、改名后再存进风格库
    .post('/:id/extract-style', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const { scope = '' } = (await c.req.json().catch(() => ({}))) as { scope?: string }
      try {
        return c.json(await extractStyle(d, String(scope).slice(0, 80), c.req.raw.signal))
      } catch (e) {
        return bad(c, (e as Error).message)
      }
    })
    // 创建副本：复制控件树、子控件和图片，对话不带；可以放到别的 UI 项目
    .post('/:id/copy', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const { projectId = d.projectId, title } = (await c.req.json().catch(() => ({}))) as {
        projectId?: string
        title?: string
      }
      if (!(await loadProjects()).some((x) => x.id === projectId)) return bad(c, t('项目不存在'), 404)
      const at = now()
      const copy: Design = {
        ...structuredClone(d),
        id: randomUUID(),
        projectId,
        title: String(title || t('{name} 副本', { name: d.title })).slice(0, 100),
        images: d.images.map((i) => ({ ...i, status: 'idle' as const, error: undefined })),
        messages: [],
        annotations: [],
        rev: 0,
        createdAt: at,
        updatedAt: at,
      }
      await cp(imagesDir(d.id), imagesDir(copy.id), { recursive: true }).catch(() => {})
      await save(copy, false)
      return c.json(copy, 201)
    })
    // 移到别的 UI 项目
    .post('/:id/move', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const { projectId } = (await c.req.json().catch(() => ({}))) as { projectId?: string }
      if (!(await loadProjects()).some((x) => x.id === projectId)) return bad(c, t('项目不存在'), 404)
      d.projectId = projectId!
      await save(d)
      return c.json(meta(d))
    })
    .get('/:id/job', async (c) => c.json(view(jobs.get(c.req.param('id')))))
    .post('/:id/stop', async (c) => {
      const j = jobs.get(c.req.param('id'))
      j?.abort.abort()
      return c.json(view(j))
    })
    .get('/:id/export', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const format = c.req.query('format')
      const pack =
        format === 'react' && d.kind === 'web' ? await reactExport(d) : await buildExport(d, format === 'json')
      return c.body(new Uint8Array(pack.data), 200, {
        'Content-Type': pack.type,
        'Content-Disposition': `attachment; filename="${pack.name}"; filename*=UTF-8''${encodeURIComponent(pack.name)}`,
      })
    })
    // 直接导出到项目目录：<项目>/UI/<设计名>/，导入工具可以直接读
    .post('/:id/export-to-project', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      const p = (await loadProjects()).find((x) => x.id === d.projectId)
      if (!p?.path) return bad(c, t('这个项目还没有选择目录'))
      const files = await exportFiles(d)
      const dir = path.join(p.path, 'UI', files.name)
      for (const f of files.files) {
        await mkdir(path.dirname(path.join(dir, f.name)), { recursive: true })
        await writeFile(path.join(dir, f.name), f.data)
      }
      return c.json({ dir })
    })

  /**
   * 网页 UI 导出：index.html + images/ 下的图片；inline 时只出一个 HTML，图片按 data URL 内嵌，
   * 双击就能用浏览器打开
   */
  async function exportWebFiles(d: Design, inline: boolean) {
    const used = usedImages([d.root, ...d.components.map((c) => c.Root)])
    const names = new Set<string>()
    const files: { name: string; data: Buffer }[] = []
    const src = new Map<string, string>()
    for (const i of d.images) {
      const v = i.variants[i.selected] ?? i.variants.at(-1)
      if (!v || !used.has(i.id)) continue
      const buf = await readFile(path.join(imagesDir(d.id), v.file)).catch(() => null)
      if (!buf) continue
      const ext = v.file.split('.').pop()!
      if (inline) {
        src.set(i.id, `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`)
        continue
      }
      const base = uniqueName(i.name.replace(/[^A-Za-z0-9_-]/g, '_') || i.id, names)
      names.add(base)
      src.set(i.id, `images/${base}.${ext}`)
      files.push({ name: `images/${base}.${ext}`, data: buf })
    }
    const html = webExport({
      title: d.title,
      designSize: d.designSize,
      root: d.root,
      components: d.components,
      file: (id) => src.get(id),
    })
    const ascii = (d.title.match(/[A-Za-z0-9]+/g) ?? []).join('-').toLowerCase()
    return { name: ascii || 'page', files: [{ name: 'index.html', data: Buffer.from(html) }, ...files], src }
  }

  /** 导出的文件：<名字>.umg.json + Textures/T_xxx.png（网页 UI 是 index.html + images/） */
  async function exportFiles(d: Design) {
    if (d.kind === 'web') {
      const f = await exportWebFiles(d, false)
      return { name: f.name, files: f.files, json: undefined }
    }
    const images = []
    const datas = new Map<string, Buffer>()
    for (const i of d.images) {
      const v = i.variants[i.selected] ?? i.variants.at(-1)
      if (!v) continue
      const buf = await readFile(path.join(imagesDir(d.id), v.file)).catch(() => null)
      if (!buf) continue
      datas.set(i.id, buf)
      images.push({
        id: i.id,
        name: i.name,
        ext: v.file.split('.').pop()!,
        width: v.width || i.width,
        height: v.height || i.height,
        nineSlice: i.nineSlice,
      })
    }
    const { json, files: tex } = exportDesign({
      title: d.title,
      designSize: d.designSize,
      root: d.root,
      components: d.components,
      images,
    })
    const files = [
      { name: `${json.Name}.umg.json`, data: Buffer.from(JSON.stringify(json, null, 2)) },
      ...tex.map((x) => ({ name: x.file, data: datas.get(x.id)! })),
    ]
    return { name: json.Name, json, files }
  }

  /** 网页 UI 导出成 React + Tailwind：<页面>.tsx + images/ */
  async function reactExport(d: Design) {
    const f = await exportWebFiles(d, false)
    const tsx = webReactExport({
      title: d.title,
      root: d.root,
      components: d.components,
      file: (id) => f.src.get(id)?.replace(/^images\//, ''),
    })
    const name = f.name.replace(/(^|-)(\w)/g, (_, _a, c: string) => c.toUpperCase()) || 'Page'
    return {
      name: `${f.name}-react.zip`,
      type: 'application/zip',
      data: zip([{ name: `${name}.tsx`, data: Buffer.from(tsx) }, ...f.files.filter((x) => x.name !== 'index.html')]),
    }
  }

  async function buildExport(d: Design, single: boolean) {
    if (d.kind === 'web') {
      const f = await exportWebFiles(d, single)
      if (single) return { name: `${f.name}.html`, type: 'text/html; charset=utf-8', data: f.files[0].data }
      return { name: `${f.name}.zip`, type: 'application/zip', data: zip(f.files) }
    }
    const f = await exportFiles(d)
    if (single && f.json) {
      // 单个 JSON：图片按 base64 内嵌在 Textures[].Data 里
      const data = {
        ...f.json,
        Textures: f.json.Textures.map((tx: { File: string }) => ({
          ...tx,
          Data: f.files.find((x) => x.name === tx.File)?.data.toString('base64') ?? '',
        })),
      }
      return { name: `${f.name}.umg.json`, type: 'application/json', data: Buffer.from(JSON.stringify(data, null, 2)) }
    }
    return { name: `${f.name}.zip`, type: 'application/zip', data: zip(f.files) }
  }

  return {
    routes,
    running: () => [...jobs.values()].filter((j) => j.status === 'running').length,
  }
}
