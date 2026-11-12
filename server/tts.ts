/**
 * 本机语音朗读：下载开源的 Kokoro 模型、把文字念成 WAV（见 shared/tts.ts）。
 *
 * 识别库和语音输入共用（server/speech.ts 的 installRuntime / sherpaLib）。模型是 sherpa-onnx 发布的
 * tar.bz2（里面有词典、espeak 数据等一百多个文件），整包下载后用系统的 tar 解开，解完才算装好。
 */
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { arch, availableParallelism, platform } from 'node:os'
import path from 'node:path'
import { t } from '../shared/i18n.ts'
import {
  TTS_MAX_CHARS,
  TTS_MODELS,
  TTS_SPEED_MAX,
  TTS_SPEED_MIN,
  TTS_VOICE_COUNT,
  encodeWav,
  ttsConfig,
  ttsModel,
  ttsModelFiles,
  type TtsModel,
  type TtsStatus,
} from '../shared/tts.ts'
import { downloadFile } from './download.ts'
import { capture } from './exec/process.ts'
import { log } from './log.ts'
import { getSettings } from './settings.ts'
import { installRuntime, platformPackage, runtimeReady, sherpaLib, speechDir } from './speech.ts'

const ttsDir = () => path.join(speechDir(), 'tts')
const modelDir = (m: TtsModel) => path.join(ttsDir(), m.dir)
const modelReady = (m: TtsModel) => ttsModelFiles(m).every((f) => existsSync(path.join(modelDir(m), f)))

let job: (NonNullable<TtsStatus['job']> & { abort: AbortController }) | undefined // 模块状态：会话，跟着进程或连接一起没

export function ttsStatus(): TtsStatus {
  return {
    supported: !!platformPackage(),
    platform: `${platform()}-${arch()}`,
    runtime: runtimeReady(),
    models: TTS_MODELS.filter(modelReady).map((m) => m.id),
    dir: ttsDir(),
    job: job && (({ abort: _, ...rest }) => rest)(job),
  }
}

/** 下载一个朗读模型；识别库还没有时先下识别库。同一时间只做一个下载 */
export function downloadTtsModel(id: string) {
  const m = ttsModel(id)
  if (!m) throw new Error(t('没有这个朗读模型'))
  if (!platformPackage())
    throw new Error(t('语音识别库没有这台电脑（{platform}）的版本', { platform: `${platform()}-${arch()}` }))
  if (job?.status === 'running') throw new Error(t('还有下载在进行：{step}', { step: job.step }))
  const j: NonNullable<typeof job> = {
    id: randomUUID(),
    model: id,
    status: 'running',
    step: t('准备下载'),
    progress: { done: 0, total: 0 },
    abort: new AbortController(),
  }
  job = j
  void (async () => {
    // 识别库的镜像跟着语音输入的设置走（npmmirror）；模型只在 GitHub 发布
    await installRuntime((await getSettings()).speech.mirror, j)
    const work = path.join(ttsDir(), '.download')
    const file = path.join(work, path.basename(m.archive))
    j.step = t('下载 {file}', { file: path.basename(m.archive) })
    await downloadFile(m.archive, file, {
      signal: j.abort.signal,
      onTotal: (n) => (j.progress!.total += n),
      onBytes: (n) => (j.progress!.done += n),
    })
    j.step = t('解压 {name}', { name: m.name })
    j.progress = undefined
    const stage = path.join(work, `${m.dir}-stage`)
    await rm(stage, { recursive: true, force: true })
    await mkdir(stage, { recursive: true })
    // Windows 10 起自带的 tar（bsdtar）、macOS 的 tar 都认 bz2；Linux 的 GNU tar 要装了 bzip2
    const r = await capture('tar', ['-xjf', file, '-C', stage], work, process.env, 10 * 60_000)
    if (r.spawnError) throw new Error(t('解压朗读模型失败：{error}', { error: r.spawnError }))
    if (r.code !== 0)
      throw new Error(t('解压朗读模型失败：{error}', { error: (r.stderr || r.stdout).trim() || `exit ${r.code}` }))
    await rm(modelDir(m), { recursive: true, force: true })
    await rename(path.join(stage, m.dir), modelDir(m))
    await rm(stage, { recursive: true, force: true })
    await rm(file, { force: true })
    if (!modelReady(m)) throw new Error(t('模型包里缺文件，解压后没有 {file}', { file: m.model }))
    j.step = t('{name} 下载完成', { name: m.name })
  })()
    .then(() => {
      j.status = 'done'
      j.progress = undefined
    })
    .catch((e) => {
      j.status = 'failed'
      j.error = j.abort.signal.aborted ? t('已取消') : (e as Error).message
      log.warn('tts', '下载失败', { model: id, error: j.error })
    })
  return j
}

export function cancelTtsJob() {
  if (job?.status === 'running') job.abort.abort()
}

export async function removeTtsModel(id: string) {
  const m = ttsModel(id)
  if (!m) throw new Error(t('没有这个朗读模型'))
  if (job?.status === 'running' && job.model === id) throw new Error(t('这个模型正在下载，先取消再删除'))
  if (loaded?.id === id) loaded = undefined
  await rm(modelDir(m), { recursive: true, force: true })
}

interface OfflineTts {
  generateAsync(o: { text: string; sid: number; speed: number }): Promise<{ samples: Float32Array; sampleRate: number }>
}

/** 加载好的模型只留一个：换模型时丢掉旧的 */
let loaded: { id: string; tts: Promise<OfflineTts> } | undefined // 模块状态：会话，跟着进程或连接一起没

function engine(m: TtsModel) {
  if (loaded?.id === m.id) return loaded.tts
  const tts = (async () => {
    const lib = sherpaLib<{ OfflineTts: { createAsync(config: unknown): Promise<OfflineTts> } }>()
    const threads = Math.max(1, Math.min(4, availableParallelism() - 1))
    return lib.OfflineTts.createAsync(ttsConfig(m, (f) => path.join(modelDir(m), f), threads))
  })()
  const entry = { id: m.id, tts }
  loaded = entry
  // 加载失败不缓存：用户重新下载后再点就重新加载
  tts.catch(() => loaded === entry && (loaded = undefined))
  return tts
}

/** 生成排队一个一个来：同一个模型并发生成没有好处，只会互相抢 CPU */
let queue: Promise<unknown> = Promise.resolve() // 模块状态：排队，丢了没事

/** 把一段文字念成 WAV；音色、语速不传时用设置里的（设置页试听会传还没保存的值） */
export async function synthesize(text: string, opts: { voice?: number; speed?: number; model?: string } = {}) {
  const s = (await getSettings()).readAloud
  const m = ttsModel(opts.model ?? s.model)
  if (!m) throw new Error(t('没有这个朗读模型'))
  if (!runtimeReady() || !modelReady(m))
    throw new Error(t('还没有下载 {name}，请到设置 → 语音朗读里下载', { name: m.name }))
  const sid = Math.round(Math.min(TTS_VOICE_COUNT - 1, Math.max(0, opts.voice ?? s.voice)))
  const speed = Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, opts.speed ?? s.speed))
  const run = queue.then(async () => {
    const tts = await engine(m)
    const a = await tts.generateAsync({ text, sid, speed })
    return encodeWav(a.samples, a.sampleRate)
  })
  queue = run.catch(() => {})
  return run
}

export function ttsApi() {
  const routes = new Hono()
  const wrap = (fn: () => unknown) => async (c: import('hono').Context) => {
    try {
      await fn()
      return c.json(ttsStatus())
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }
  routes.get(
    '/status',
    wrap(() => {}),
  )
  routes.post('/cancel', wrap(cancelTtsJob))
  routes.post('/models/:id/download', (c) => wrap(() => downloadTtsModel(c.req.param('id')))(c))
  routes.delete('/models/:id', (c) => wrap(() => removeTtsModel(c.req.param('id')))(c))
  routes.post('/speak', async (c) => {
    // 写操作只收 JSON（防跨站，见 server/index.ts）；回的是 WAV
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: unknown
      voice?: unknown
      speed?: unknown
      model?: unknown
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: t('没有要朗读的文字') }, 400)
    if (text.length > TTS_MAX_CHARS) return c.json({ error: t('一次最多朗读 {n} 个字', { n: TTS_MAX_CHARS }) }, 400)
    try {
      const wav = await synthesize(text, {
        voice: typeof body.voice === 'number' ? body.voice : undefined,
        speed: typeof body.speed === 'number' ? body.speed : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
      })
      return new Response(wav, { headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store' } })
    } catch (e) {
      log.warn('tts', '朗读失败', { error: (e as Error).message })
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  return routes
}
