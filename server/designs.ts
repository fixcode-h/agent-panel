import { Hono, type Context } from 'hono'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { extractJson } from '../shared/assist.ts'
import { getCli } from '../shared/clis.ts'
import {
  Design,
  DesignChatInput,
  DesignDoc,
  DesignImage,
  GenerateImageInput,
  NewDesignInput,
  buildDesignPrompt,
  emptyRoot,
  imagePrompt,
  resolveDesignResult,
  type DesignJob,
  type DesignMeta,
  type ImageSource,
} from '../shared/design.ts'
import type { Project } from '../shared/schema.ts'
import { agentRun, cliSettings, defaultCli } from '../shared/settings.ts'
import { exportDesign, normalizeTree, uniqueName } from '../shared/umg.ts'
import { t } from '../shared/i18n.ts'
import { READ_ONLY, safeArgs } from './assist.ts'
import { browserGenerate, browserStatus } from './bridge.ts'
import { invokeCli } from './exec/invoke.ts'
import { childEnv } from './exec/process.ts'
import { log } from './log.ts'
import { getSettings } from './settings.ts'
import { DATA_DIR, readJson, writeJsonAtomic } from './store.ts'
import { imageSize, zip } from './zip.ts'

/**
 * UI 设计：每个设计一个 JSON（designs/<id>.json），生成和上传的图片放在 designs/<id>/images/。
 * 和任务分开存放，侧栏也分开列。
 */
const DIR = path.join(DATA_DIR, 'designs')
const fileOf = (id: string) => path.join(DIR, `${id}.json`)
const imagesDir = (id: string) => path.join(DIR, id, 'images')
const TIMEOUT = 10 * 60_000

type Lister<T> = { get(id: string): Promise<T | null>; list(): Promise<T[]> }
type Job = DesignJob & { abort: AbortController }

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
      if (!f.endsWith('.json')) continue
      const raw = await readJson(path.join(DIR, f))
      const p = Design.safeParse(raw)
      if (p.success) cache.set(p.data.id, p.data as Design)
      else log.warn('designs', `设计文件格式不对，跳过：${f}`)
    }
    loaded = true
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

  async function generateOne(d: Design, img: DesignImage, source: ImageSource, count: number, job: Job) {
    const cur = () => cache.get(d.id)!.images.find((i) => i.id === img.id)
    const set = (patch: Partial<DesignImage>) => {
      const dd = cache.get(d.id)!
      dd.images = dd.images.map((i) => (i.id === img.id ? { ...i, ...patch } : i))
      void save(dd)
    }
    set({ status: 'generating', error: undefined })
    try {
      const bufs =
        source.kind === 'browser'
          ? await browserGenerate(
              {
                tabId: source.tabId,
                prompt: imagePrompt(img, d.style, img.transparent),
                count,
                chroma: img.transparent,
                onProgress: (text) => (job.text = `${img.name}：${text}`),
              },
              job.abort.signal,
            )
          : await cliGenerate(imagePrompt(img, d.style, false), count, job)
      const added = []
      for (const b of bufs) {
        const s = await storeImage(cache.get(d.id)!, b)
        added.push({ ...s, source: source.kind === 'browser' ? ('browser' as const) : ('cli' as const), at: now() })
      }
      const before = cur()?.variants.length ?? 0
      // 新生成的这版默认选中
      set({ status: 'idle', variants: [...(cur()?.variants ?? []), ...added], selected: before })
    } catch (e) {
      set({ status: 'failed', error: (e as Error).message })
      throw e
    }
  }

  /** 用设置里的图片 CLI（Codex 的 image_gen）生成，返回图片数据 */
  async function cliGenerate(prompt: string, count: number, job: Job): Promise<Buffer[]> {
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
    const out: Buffer[] = []
    // 图片文件要等 CLI 写完才读，收集起来最后一起等
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
            reads.push(read.then((b) => void (b?.length && out.push(b))))
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
    if (!out.length)
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
    return out
  }
  async function generateImages(d: Design, ids: string[], source: ImageSource, count: number, job: Job) {
    job.phase = 'images'
    const list = ids.map((id) => d.images.find((i) => i.id === id)).filter(Boolean) as DesignImage[]
    // 浏览器只有一个标签页，一张张来；CLI 同时跑两个
    const width = source.kind === 'browser' ? 1 : 2
    const failed: string[] = []
    let next = 0
    const worker = async () => {
      while (next < list.length && !job.abort.signal.aborted) {
        const img = list[next++]
        job.text = t('正在生成 {name}（{i}/{n}）', { name: img.name, i: next, n: list.length })
        try {
          await generateOne(cache.get(d.id)!, img, source, count, job)
        } catch (e) {
          failed.push(`${img.name}：${(e as Error).message}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(width, list.length) }, worker))
    // 没轮到的（停止了）恢复成未生成
    const dd = cache.get(d.id)!
    dd.images = dd.images.map((i) => (ids.includes(i.id) && i.status === 'pending' ? { ...i, status: 'idle' } : i))
    await save(dd)
    return failed
  }

  // ---- AI 对话 ----

  async function chat(d: Design, input: z.infer<typeof DesignChatInput>, job: Job) {
    const settings = await getSettings()
    const cliId = defaultCli(settings)
    const def = getCli(cliId)!
    const cs = cliSettings(settings, cliId)
    // 对话用默认 CLI 的高档模型
    const run = agentRun({ cli: cliId, model: '@high' }, settings)
    const cwd = path.join(tmpdir(), 'agent-panel-design')
    await mkdir(cwd, { recursive: true })
    const history = d.messages.slice(0, -1)
    let extra = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      job.attempt = attempt
      job.text = ''
      job.thinking = undefined
      job.tools = undefined
      job.outChars = 0
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
        },
        cwd,
        env: childEnv(cs.env),
        input: buildDesignPrompt(cache.get(d.id)!, history, input.text) + extra,
        signal: job.abort.signal,
        timeoutMs: TIMEOUT,
        onEvent: (ev) => {
          if (ev.type === 'text_delta') text += ev.text
          else if (ev.type === 'text') text = text ? `${text.trimEnd()}\n\n${ev.text}` : ev.text
          else if (ev.type === 'thinking')
            job.thinking = (ev.delta ? (job.thinking ?? '') + ev.text : ev.text).slice(-1500)
          else if (ev.type === 'tool') job.tools = [...(job.tools ?? []), ev.tool.label].slice(-5)
          else if (ev.type === 'error') errors.push(ev.message)
          else if (ev.type === 'result') result = ev
          job.text = text.split('```')[0].trim()
          job.outChars = text.length
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
          run: { cli: cliId, model: run.model, effort: run.effort },
        })
        await save(cur)
        return ids
      }
      if (attempt === 2) throw new Error(t('{cli} 两次都没有按格式输出：{error}', { cli: def.name, error: res.error }))
      extra = `\n\n## 你上一次的输出\n${text}\n\n上面的 JSON 不符合要求：${res.error}\n请修正后重新输出完整的说明和 JSON。`
    }
    return []
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
    const { abort, ...rest } = j
    return rest
  }

  const routes = new Hono()
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
      if (!(await deps.projects.get(p.data.projectId))) return bad(c, t('项目不存在'), 404)
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
        messages: [],
        rev: 0,
        createdAt: at,
        updatedAt: at,
      }
      await save(d, false)
      return c.json(d, 201)
    })
    .get('/browser', (c) => c.json(browserStatus()))
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
      })
      await save(d)
      return c.json({ ...d, job: view(jobs.get(d.id)) })
    })
    .delete('/:id', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      jobs.get(d.id)?.abort.abort()
      jobs.delete(d.id)
      cache.delete(d.id)
      await writing.get(d.id)?.catch(() => {})
      await rm(fileOf(d.id), { force: true })
      await rm(path.join(DIR, d.id), { recursive: true, force: true })
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
    .post('/:id/images/:imageId/generate', async (c) => {
      const d = await get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      if (jobs.get(d.id)?.status === 'running') return bad(c, t('正在处理上一个请求，等它完成或先停止'), 409)
      const img = d.images.find((i) => i.id === c.req.param('imageId'))
      if (!img) return bad(c, t('图片不存在'), 404)
      const p = GenerateImageInput.safeParse(await c.req.json())
      if (!p.success) return bad(c, z.prettifyError(p.error))
      if (p.data.source.kind === 'none') return bad(c, t('请选择生成图片的方式'))
      if (p.data.prompt !== undefined) img.prompt = p.data.prompt
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
      if (!cliSettings(settings, defaultCli(settings)).enabled)
        return bad(c, t('{cli} 在设置里被停用了', { cli: getCli(defaultCli(settings))!.name }))
      d.messages.push({ id: randomUUID(), role: 'user', text: p.data.text, at: now() })
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
      const p = await deps.projects.get(d.projectId)
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
    removeByProject: async (projectId: string) => {
      await loadAll()
      for (const d of [...cache.values()])
        if (d.projectId === projectId) {
          jobs.get(d.id)?.abort.abort()
          cache.delete(d.id)
          await rm(fileOf(d.id), { force: true })
          await rm(path.join(DIR, d.id), { recursive: true, force: true })
        }
    },
  }
}
