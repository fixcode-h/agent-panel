import { Hono, type Context } from 'hono'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { Design } from '../shared/design.ts'
import { t } from '../shared/i18n.ts'
import { LabelReply } from '../shared/restore/label.ts'
import { RESTORE_STEPS, RestoreElement, RepeatGroup, stepOf, type RestoreStep } from '../shared/restore/schema.ts'
import {
  acceptDiff,
  confirmStep,
  editElements,
  runStep,
  setSource,
  stateOf,
  stepName,
} from '../shared/restore/steps.ts'
import { decodePng, encodePng, type Img } from './image.ts'
import { isPsd, readPsdLayers } from './design-psd.ts'
import { log } from './log.ts'
import { getSettings } from './settings.ts'

/**
 * 照原画还原的接口：上传原画、跑某一步、确认、改元素、接受差异。每一步怎么跑在 shared/restore/steps.ts，
 * 这里只管读写文件、问模型、后台跑和出错提示。一步在后台跑，页面照常轮询设计拿进度；出的错写进这一步和对话
 */

interface Deps {
  get: (id: string) => Promise<Design | undefined>
  save: (d: Design) => Promise<void>
  storeImage: (d: Design, buf: Buffer) => Promise<{ file: string; width: number; height: number }>
  imagesDir: (id: string) => string
  askJson: <T>(prompt: string, schema: z.ZodType<T>, scope: string, signal: AbortSignal) => Promise<T>
  systemNote: (id: string, text: string, error?: boolean) => void
  /** 设计正在跑别的（AI 对话、生成图片）：还原的步骤不能同时改 */
  busy: (id: string) => boolean
  reply: (c: Context, d: Design) => Response
  now: () => string
  /** 带一张参考图生成一张图（拆件图：原画当参考） */
  generateWithRef?: (d: Design, prompt: string, ref: string, abort: AbortController) => Promise<Buffer>
}

const Run = z.object({ step: z.enum(RESTORE_STEPS), feedback: z.string().max(4000).default('') })
const Edit = z.object({ elements: z.array(RestoreElement).max(600), groups: z.array(RepeatGroup).max(40).optional() })

export function restoreRoutes(deps: Deps) {
  const running = new Map<string, AbortController>()
  const bad = (c: Context, error: string, status: 400 | 404 | 409 = 400) => c.json({ error }, status)

  async function artOf(d: Design): Promise<Img> {
    const src = stateOf(d).source
    if (!src) throw new Error(t('还没有原画'))
    const img = decodePng(await readFile(path.join(deps.imagesDir(d.id), src.file)))
    if (!img) throw new Error(t('原画不是 PNG，读不出来'))
    return img
  }

  /** 后台跑一步；跑完（或确认后）接着跑的下一步由 then 决定 */
  function start(d: Design, step: RestoreStep, feedback = '') {
    const r = stateOf(d)
    const abort = new AbortController()
    running.set(d.id, abort)
    const prev = stepOf(r, step)
    r.steps[step] = { ...prev, status: 'running', error: undefined }
    void deps.save(d)
    let artCache: Img | undefined
    const run = async () => {
      const settings = await getSettings()
      await runStep(
        step,
        {
          design: d,
          art: async () => (artCache ??= await artOf(d)),
          store: (img) => deps.storeImage(d, encodePng(img)),
          label: async (overlay, prompt) => {
            // 标注图放在模型的工作目录里，模型用读文件的工具看
            const dir = path.join(tmpdir(), 'agent-panel-design')
            await mkdir(dir, { recursive: true })
            const file = path.join(dir, `restore-${d.id}-${randomUUID().slice(0, 6)}.png`)
            await writeFile(file, encodePng(overlay))
            return deps.askJson(prompt(file), LabelReply, `restore:${d.id}`, abort.signal)
          },
          thresholds: settings.designRestore,
          now: deps.now,
          layer: async (file) => {
            const img = decodePng(await readFile(path.join(deps.imagesDir(d.id), path.basename(file))))
            if (!img) throw new Error(t('PSD 图层文件读不出来：{file}', { file }))
            return img
          },
          ...(deps.generateWithRef
            ? {
                partsSheet: async (prompt: string) => {
                  const src = stateOf(d).source
                  if (!src) throw new Error(t('还没有原画'))
                  const buf = await deps.generateWithRef!(d, prompt, path.join(deps.imagesDir(d.id), src.file), abort)
                  const img = decodePng(buf)
                  if (!img) throw new Error(t('拆件图不是 PNG，读不出来'))
                  return img
                },
              }
            : {}),
        },
        feedback,
      )
    }
    run()
      .catch((e) => {
        const msg = (e as Error).message
        const cur = stepOf(r, step)
        r.steps[step] = { ...cur, status: 'failed', error: msg }
        log.warn('designs', '还原步骤失败', { id: d.id, step, error: msg })
        deps.systemNote(d.id, t('还原「{step}」这一步失败：{error}', { step: stepName(step), error: msg }))
      })
      .finally(() => {
        if (running.get(d.id) === abort) running.delete(d.id)
        void deps.save(d)
      })
  }

  const guard = async (c: Context) => {
    const d = await deps.get(c.req.param('id') ?? '')
    if (!d) return { error: bad(c, t('设计不存在'), 404) }
    if (running.has(d.id) || deps.busy(d.id)) return { error: bad(c, t('正在处理上一个请求，等它完成或先停止'), 409) }
    return { d }
  }

  /** PSD：合成图当原画，每个图层存成一张 PNG，元素里的图层 key 换成文件名 */
  async function psdSource(c: Context, d: Design, buf: Buffer, name: string) {
    if (buf.length > 200 * 1024 * 1024) return bad(c, t('PSD 太大（最多 200 MB）'))
    let p
    try {
      p = readPsdLayers(buf)
    } catch (e) {
      return bad(c, t('PSD 读不出来：{error}', { error: (e as Error).message }))
    }
    const art = await deps.storeImage(d, encodePng(p.composite))
    const files = new Map<string, string>()
    for (const l of p.layers) files.set(l.key, (await deps.storeImage(d, encodePng(l.img))).file)
    const fileOf = (k: string | undefined) => (k ? files.get(k) : undefined)
    const elements = p.elements.map((e) => ({
      ...e,
      layer: fileOf(e.layer),
      ...(e.states
        ? {
            states: {
              hover: fileOf(e.states.hover),
              pressed: fileOf(e.states.pressed),
              disabled: fileOf(e.states.disabled),
            },
          }
        : {}),
    }))
    setSource(d, { kind: 'psd', file: art.file, name, width: p.width, height: p.height }, deps.now(), {
      elements,
      warnings: p.warnings,
    })
    await deps.save(d)
    return deps.reply(c, d)
  }

  return new Hono()
    .post('/:id/restore/source', async (c) => {
      const g = await guard(c)
      if (g.error) return g.error
      const d = g.d
      const body = (await c.req.json().catch(() => ({}))) as { data?: string; name?: string }
      const buf = Buffer.from(String(body.data ?? '').replace(/^data:[^,]*,/, ''), 'base64')
      if (!buf.length) return bad(c, t('没有图片数据'))
      if (isPsd(buf)) return psdSource(c, d, buf, String(body.name ?? ''))
      if (buf.length > 40 * 1024 * 1024) return bad(c, t('图片太大（最多 40 MB）'))
      const img = decodePng(buf)
      if (!img) return bad(c, t('原画要是 PNG（页面上传时会自动转成 PNG）'))
      const stored = await deps.storeImage(d, buf)
      setSource(
        d,
        { kind: 'image', file: stored.file, name: String(body.name ?? ''), width: img.width, height: img.height },
        deps.now(),
      )
      await deps.save(d)
      return deps.reply(c, d)
    })
    .post('/:id/restore/run', async (c) => {
      const g = await guard(c)
      if (g.error) return g.error
      const p = Run.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return bad(c, z.prettifyError(p.error))
      if (!stateOf(g.d).source) return bad(c, t('还没有原画'))
      start(g.d, p.data.step, p.data.feedback)
      return deps.reply(c, g.d)
    })
    .post('/:id/restore/confirm', async (c) => {
      const g = await guard(c)
      if (g.error) return g.error
      const p = Run.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return bad(c, z.prettifyError(p.error))
      const next = confirmStep(g.d, p.data.step)
      if (next) start(g.d, next)
      else await deps.save(g.d)
      return deps.reply(c, g.d)
    })
    .put('/:id/restore/elements', async (c) => {
      const g = await guard(c)
      if (g.error) return g.error
      const p = Edit.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return bad(c, z.prettifyError(p.error))
      editElements(g.d, p.data.elements, p.data.groups)
      await deps.save(g.d)
      return deps.reply(c, g.d)
    })
    .post('/:id/restore/accept', async (c) => {
      const g = await guard(c)
      if (g.error) return g.error
      const body = (await c.req.json().catch(() => ({}))) as { element?: string; on?: boolean }
      acceptDiff(g.d, String(body.element ?? ''), body.on !== false, (await getSettings()).designRestore)
      await deps.save(g.d)
      return deps.reply(c, g.d)
    })
    .post('/:id/restore/stop', async (c) => {
      const d = await deps.get(c.req.param('id'))
      if (!d) return bad(c, t('设计不存在'), 404)
      running.get(d.id)?.abort()
      return deps.reply(c, d)
    })
}
