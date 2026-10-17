import { Hono, type Context } from 'hono'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { extractJson } from '../shared/assist.ts'
import { getCli } from '../shared/clis.ts'
import {
  Design,
  DesignChatInput,
  DesignProject,
  DesignProjectInput,
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
  importComponent,
  type ProjectComponents,
  projectPromptText,
  resolveDesignResult,
  type DesignJob,
  type DesignMeta,
  type ImageJobItem,
  type ImageSource,
} from '../shared/design.ts'
import type { Project } from '../shared/schema.ts'
import { agentRun, cliSettings, defaultCli } from '../shared/settings.ts'
import { exportDesign, migrateGrids, normalizeTree, uniqueName } from '../shared/umg.ts'
import { t } from '../shared/i18n.ts'
import { READ_ONLY, safeArgs } from './assist.ts'
import { browserGenerate, browserParallel, browserStatus } from './bridge.ts'
import { invokeCli } from './exec/invoke.ts'
import { childEnv } from './exec/process.ts'
import { log } from './log.ts'
import { getSettings } from './settings.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from './store.ts'
import { UPLOADS_DIR } from './uploads.ts'
import { withAttachments } from '../shared/task.ts'
import { imageSize, zip } from './zip.ts'

/**
 * UI 设计：每个设计一个 JSON（designs/<id>.json），生成和上传的图片放在 designs/<id>/images/。
 * 和任务分开存放，侧栏也分开列。
 */
const DIR = path.join(DATA_DIR, 'designs')
const fileOf = (id: string) => path.join(DIR, `${id}.json`)
const imagesDir = (id: string) => path.join(DIR, id, 'images')
// 下划线开头，和设计文件（<id>.json）区分开
const PROJECTS_FILE = path.join(DIR, '_projects.json')
const TIMEOUT = 10 * 60_000

type Lister<T> = { get(id: string): Promise<T | null>; list(): Promise<T[]> }
type Job = DesignJob & {
  abort: AbortController
  /** 生成图片时：把一张图排进这一轮的队列（点了「重试」或「再生成」）；不在生成图片时没有 */
  enqueue?: (img: DesignImage, revision?: string) => void
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
   * 生成一张图：每取回一版就存下来、马上换到设计里（页面轮询时就能看到），不等这张图的几版全部生成完。
   * 第一版到了就选中它，之后的几版作为备选
   */
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
    const cur = () => cache.get(d.id)!.images.find((i) => i.id === img.id)
    const set = (patch: Partial<DesignImage>) => {
      const dd = cache.get(d.id)!
      dd.images = dd.images.map((i) => (i.id === img.id ? { ...i, ...patch } : i))
      void save(dd)
    }
    set({ status: 'generating', error: undefined })
    item.status = 'generating'
    let first = -1
    let chain = Promise.resolve()
    const kind = source.kind === 'browser' ? ('browser' as const) : ('cli' as const)
    const add = (buf: Buffer) => {
      chain = chain
        .then(async () => {
          const s = await storeImage(cache.get(d.id)!, buf)
          const variants = [...(cur()?.variants ?? []), { ...s, source: kind, at: now() }]
          if (first < 0) first = variants.length - 1
          set({ variants, selected: first })
          item.got++
        })
        .catch((e) => log.warn('designs', '保存生成的图片失败', { error: (e as Error).message }))
    }
    try {
      const rest =
        source.kind === 'browser'
          ? await browserGenerate(
              {
                tabId: source.tabId,
                prompt: withRevision(imagePrompt(img, cache.get(d.id)!.style, img.transparent, style), revision),
                count,
                chroma: img.transparent,
                concurrency: (await getSettings()).imageGen.concurrency,
                onProgress: (text) => (item.text = text),
                onImage: add,
              },
              job.abort.signal,
            )
          : await cliGenerate(
              withRevision(imagePrompt(img, cache.get(d.id)!.style, false, style), revision),
              count,
              job,
              add,
            )
      for (const b of rest) add(b)
      await chain
      if (!item.got) throw new Error(t('没有取到图片'))
      set({ status: 'idle' })
      item.status = 'done'
      item.text = undefined
    } catch (e) {
      await chain
      const msg = (e as Error).message
      // 已经取回的几版留着能用，只是没生成全
      set(item.got ? { status: 'idle' } : { status: 'failed', error: msg })
      item.status = 'failed'
      item.text = msg
      throw e
    }
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
    const r = await invokeCli({
      cliId,
      command: cs.command,
      build: {
        model: run.model,
        effort: run.effort,
        permission: READ_ONLY[cliId] ?? cs.permission,
        extraArgs: safeArgs(cs.extraArgs),
      },
      cwd,
      env: childEnv(cs.env),
      input: `请用内置的 image_gen 工具生成 ${count} 张图片（每张单独调用一次 image_gen，内容一样、细节可以不同）。不要写代码、不要运行命令、不要另存文件，生成完直接结束，不用解释。

图片要求：
${prompt}`,
      signal: job.abort.signal,
      timeoutMs: TIMEOUT,
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
    })
    await Promise.all(reads)
    if (r.killed === 'stopped') throw new Error(t('已停止'))
    if (r.killed === 'timeout') throw new Error(t('超过 10 分钟没有生成完，已停止'))
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
    job.text = ''
    job.thinking = undefined
    job.tools = undefined
    job.out = undefined
    const list = ids.map((id) => d.images.find((i) => i.id === id)).filter(Boolean) as DesignImage[]
    const items: ImageJobItem[] = list.map((i) => ({ id: i.id, name: i.name, status: 'waiting', got: 0, want: count }))
    job.images = items
    const style = await projectStyle(d)
    // 每张图单独一个会话（CLI 进程或浏览器里的新对话），同时跑的个数在设置里调；旧版扩展只能一张张来
    const settings = await getSettings()
    const width = source.kind === 'browser' && !browserParallel() ? 1 : settings.imageGen.concurrency
    // 失败的图：图片 id → 原因；点了重试、重新生成成功的从这里去掉
    const failed = new Map<string, string>()
    const queue = list.map((img, k) => ({ img, item: items[k], revision: revisions[img.id] ?? '' }))
    let next = 0
    const worker = async () => {
      while (next < queue.length && !job.abort.signal.aborted) {
        const { img, item, revision } = queue[next++]
        try {
          await generateOne(cache.get(d.id)!, img, source, count, style, job, item, revision)
          failed.delete(img.id)
        } catch (e) {
          failed.set(img.id, `${img.name}：${(e as Error).message}`)
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
      queue.push({ img, item, revision })
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
    const cwd = path.join(tmpdir(), 'agent-panel-design')
    await mkdir(cwd, { recursive: true })
    const history = d.messages.slice(0, -1)
    const project = await projectContext(d)
    let extra = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      job.attempt = attempt
      job.text = ''
      job.thinking = undefined
      job.tools = undefined
      job.outChars = 0
      job.out = undefined
      // 工具调用的 id → 在 job.tools 里的位置，结果回来时更新那一条
      const toolAt = new Map<string, number>()
      let text = ''
      const errors: string[] = []
      let result: { ok: boolean; error?: string } | undefined
      const r = await invokeCli({
        cliId,
        command: cs.command,
        build: {
          model: run.model,
          effort: run.effort,
          permission: READ_ONLY[cliId] ?? cs.permission,
          extraArgs: safeArgs(cs.extraArgs),
          // 附件在面板的数据目录里，不在工作目录下；Claude Code 读工作目录外的文件要先放行
          addDirs: input.attachments.length ? [UPLOADS_DIR] : undefined,
        },
        cwd,
        env: childEnv(cs.env),
        input:
          buildDesignPrompt(
            cache.get(d.id)!,
            history,
            withAttachments(input.text, input.attachments),
            input.annotations,
            project,
          ) + extra,
        signal: job.abort.signal,
        timeoutMs: TIMEOUT,
        onEvent: (ev) => {
          if (ev.type === 'text_delta') text += ev.text
          else if (ev.type === 'text') text = text ? `${text.trimEnd()}\n\n${ev.text}` : ev.text
          else if (ev.type === 'thinking')
            job.thinking = (ev.delta ? (job.thinking ?? '') + ev.text : ev.text).slice(-1500)
          else if (ev.type === 'tool') {
            const tools = [...(job.tools ?? []), { ...ev.tool, running: !!ev.id }]
            if (ev.id) toolAt.set(ev.id, tools.length - 1)
            job.tools = tools
          } else if (ev.type === 'tool_delta' || ev.type === 'tool_result') {
            const i = toolAt.get(ev.id)
            if (i !== undefined && job.tools?.[i]) {
              const cur = job.tools[i]
              job.tools = job.tools.map((x, k) =>
                k !== i
                  ? x
                  : ev.type === 'tool_delta'
                    ? { ...x, output: ((cur.output ?? '') + ev.text).slice(-4000) }
                    : { ...x, output: ev.output.slice(-4000), failed: ev.failed, running: false },
              )
            }
          } else if (ev.type === 'error') errors.push(ev.message)
          else if (ev.type === 'result') result = ev
          job.text = text.split('```')[0].trim()
          job.outChars = text.length
          // JSON 部分边写边给界面看；只留最后一段，免得每次推送都很大
          const fence = text.indexOf('```')
          if (fence >= 0)
            job.out = text
              .slice(fence)
              .replace(/^```\w*\n?/, '')
              .slice(-3000)
        },
      })
      if (r.killed === 'stopped') throw new Error(t('已停止'))
      if (r.killed === 'timeout') throw new Error(t('超过 10 分钟没有完成，已停止'))
      if (r.spawnError)
        throw new Error(
          t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写路径。', {
            error: r.spawnError,
            cli: def.name,
            hint: def.installHint,
          }),
        )
      if (result ? !result.ok : r.code !== 0)
        throw new Error(
          t('{cli} 执行失败：{detail}', {
            cli: def.name,
            detail:
              [result?.error, ...errors, r.stderr.trim().split('\n').slice(-4).join('\n')].filter(Boolean).join('\n') ||
              t('没有更多信息'),
          }),
        )
      const ex = extractJson(text)
      const res = ex.error ? { error: ex.error } : resolveDesignResult(ex.json, cache.get(d.id)!)
      if ('result' in res) {
        const cur = cache.get(d.id)!
        const r2 = res.result
        const changed = !!(res.root || res.components || r2.designSize || r2.style !== undefined || r2.images.length)
        if (res.root) cur.root = res.root
        if (res.components) cur.components = res.components
        if (r2.designSize) cur.designSize = r2.designSize
        if (r2.style !== undefined) cur.style = r2.style
        const ids: string[] = []
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
          text: r2.reply || ex.rest || t('改好了。'),
          at: now(),
          images: ids.length ? ids : undefined,
          run,
        })
        await save(cur)
        return ids
      }
      if (attempt === 2) throw new Error(t('{cli} 两次都没有按格式输出：{error}', { cli: def.name, error: res.error }))
      extra = `\n\n## 你上一次的输出\n${text}\n\n上面的 JSON 不符合要求：${res.error}\n请修正后重新输出完整的说明和 JSON。`
    }
    return []
  }

  /** 用默认 CLI 生成或翻译项目提示词；格式不对时让它改一次 */
  async function promptAi(input: PromptAiInput, signal: AbortSignal) {
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
      const r = await invokeCli({
        cliId: run.cli,
        command: cs.command,
        build: {
          model: run.model,
          effort: run.effort,
          permission: READ_ONLY[run.cli] ?? cs.permission,
          extraArgs: safeArgs(cs.extraArgs),
        },
        cwd,
        env: childEnv(cs.env),
        input: buildPromptAiPrompt(input) + extra,
        signal,
        timeoutMs: 5 * 60_000,
        onEvent: (ev) => {
          if (ev.type === 'text_delta') text += ev.text
          else if (ev.type === 'text') text = text ? `${text.trimEnd()}\n\n${ev.text}` : ev.text
          else if (ev.type === 'error') errors.push(ev.message)
          else if (ev.type === 'result') result = ev
        },
      })
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
      const parsed = ex.error ? undefined : AiPrompts.safeParse(ex.json)
      if (parsed?.success) return parsed.data
      const why = ex.error ?? (parsed ? z.prettifyError(parsed.error) : '')
      if (attempt === 2) throw new Error(t('{cli} 两次都没有按格式输出：{error}', { cli: def.name, error: why }))
      extra = `\n\n## 你上一次的输出\n${text}\n\n上面的 JSON 不符合要求：${why}\n请重新输出。`
    }
    return { prompts: [] }
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
    }
    jobs.set(d.id, job)
    fn(job)
      .then(() => {
        job.status = 'done'
      })
      .catch(async (e) => {
        job.status = 'failed'
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
    const { abort, enqueue, ...rest } = j
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
      const list = [...cache.values()]
        .filter((d) => !pid || d.projectId === pid)
        .map((d) => ({ ...meta(d), running: jobs.get(d.id)?.status === 'running' }))
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
        root: emptyRoot(),
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
    .post('/:id/chat', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      if (jobs.get(d.id)?.status === 'running') return bad(c, t('正在处理上一个请求，等它完成或先停止'), 409)
      const p = DesignChatInput.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const settings = await getSettings()
      const cli = chatRun(settings, p.data.run).cli
      if (!cliSettings(settings, cli).enabled) return bad(c, t('{cli} 在设置里被停用了', { cli: getCli(cli)!.name }))
      d.messages.push({
        id: randomUUID(),
        role: 'user',
        text: p.data.text,
        at: now(),
        ...(p.data.annotations.length ? { annotations: p.data.annotations } : {}),
        ...(p.data.attachments.length ? { attachments: p.data.attachments } : {}),
      })
      await save(d)
      startJob(d, async (job) => {
        const ids = await chat(d, p.data, job)
        if (!ids.length || p.data.source.kind === 'none') return
        const failed = await generateImages(d, ids, p.data.source, p.data.count, job)
        if (failed.length)
          throw new Error(t('有 {n} 张图片没有生成出来：\n{list}', { n: failed.length, list: failed.join('\n') }))
      })
      return c.json({ ...d, job: view(jobs.get(d.id)) })
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
      const pack = await buildExport(d, c.req.query('format') === 'json')
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

  /** 导出的文件：<名字>.umg.json + Textures/T_xxx.png */
  async function exportFiles(d: Design) {
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

  async function buildExport(d: Design, single: boolean) {
    const f = await exportFiles(d)
    if (single) {
      // 单个 JSON：图片按 base64 内嵌在 Textures[].Data 里
      const data = {
        ...f.json,
        Textures: f.json.Textures.map((tx) => ({
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
