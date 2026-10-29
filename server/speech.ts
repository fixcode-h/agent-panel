/**
 * 本机语音输入：下载识别库和模型、把录音转成文字（见 shared/speech.ts）。
 *
 * 识别库 sherpa-onnx-node 是原生扩展，打不进单文件的 server.mjs，所以和模型一起按需下载到数据目录：
 * 从 npm 取 sherpa-onnx-node 和这台电脑对应的 sherpa-onnx-<平台> 两个 tgz，解到
 * speech/sherpa-onnx-<版本>/node_modules/ 下，再用 createRequire 从那里加载。两个包是兄弟目录，
 * 它的 addon.js 就是按 ../sherpa-onnx-<平台>/ 找原生库的。
 */
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, availableParallelism, platform } from 'node:os'
import path from 'node:path'
import { t } from '../shared/i18n.ts'
import {
  SHERPA_VERSION,
  SPEECH_MAX_BYTES,
  SPEECH_RATE,
  cleanTranscript,
  decodePcm16,
  npmTarball,
  recognizerConfig,
  sherpaPlatformPackage,
  speechFileUrl,
  speechModel,
  SPEECH_MODELS,
  type SpeechJob,
  type SpeechModel,
  type SpeechStatus,
} from '../shared/speech.ts'
import { DATA_DIR } from './store.ts'
import { downloadFile, removeDownload } from './download.ts'
import { capture } from './exec/process.ts'
import { getSettings } from './settings.ts'
import { log } from './log.ts'

const speechDir = () => path.join(DATA_DIR, 'speech')
const runtimeDir = () => path.join(speechDir(), `sherpa-onnx-${SHERPA_VERSION}`)
const modelDir = (id: string) => path.join(speechDir(), 'models', id)
const platformPackage = () => sherpaPlatformPackage(platform(), arch())

function runtimeReady() {
  const pkg = platformPackage()
  const mods = path.join(runtimeDir(), 'node_modules')
  return (
    !!pkg &&
    existsSync(path.join(mods, 'sherpa-onnx-node', 'package.json')) &&
    existsSync(path.join(mods, pkg, 'sherpa-onnx.node'))
  )
}

const modelReady = (m: SpeechModel) => m.files.every((f) => existsSync(path.join(modelDir(m.id), f.name)))

let job: (SpeechJob & { abort: AbortController }) | undefined

export function speechStatus(): SpeechStatus {
  return {
    supported: !!platformPackage(),
    platform: `${platform()}-${arch()}`,
    runtime: runtimeReady(),
    models: SPEECH_MODELS.filter(modelReady).map((m) => m.id),
    dir: speechDir(),
    job: job && (({ abort: _, ...rest }) => rest)(job),
  }
}

/** 解一个 npm 包的 tgz 到 node_modules/<名字>：tgz 里的内容都在 package/ 下面 */
async function installPackage(name: string, version: string, mirror: boolean, j: NonNullable<typeof job>) {
  const work = path.join(speechDir(), '.download')
  const file = path.join(work, `${name}-${version}.tgz`)
  const url = npmTarball(name, version, mirror)
  j.step = t('下载识别库 {name}', { name })
  await downloadFile(url, file, {
    signal: j.abort.signal,
    onTotal: (n) => j.progress && (j.progress.total += n),
    onBytes: (n) => j.progress && (j.progress.done += n),
  })
  const stage = path.join(work, `${name}-stage`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  // Windows 10 起自带 tar，macOS / Linux 都有；和在线更新解压用的是同一个办法
  const r = await capture('tar', ['-xzf', file, '-C', stage], work, process.env, 120_000)
  if (r.spawnError) throw new Error(t('解压识别库失败：{error}', { error: r.spawnError }))
  if (r.code !== 0) throw new Error(t('解压识别库失败：{error}', { error: r.stdout.trim() || `exit ${r.code}` }))
  const to = path.join(runtimeDir(), 'node_modules', name)
  await rm(to, { recursive: true, force: true })
  await mkdir(path.dirname(to), { recursive: true })
  await rename(path.join(stage, 'package'), to)
  await rm(stage, { recursive: true, force: true })
  await rm(file, { force: true })
}

/** 下载一个模型；识别库还没有时先下识别库。同一时间只做一个下载 */
export function downloadSpeechModel(id: string) {
  const m = speechModel(id)
  if (!m) throw new Error(t('没有这个语音模型'))
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
    const { mirror } = (await getSettings()).speech
    if (!runtimeReady()) {
      await installPackage('sherpa-onnx-node', SHERPA_VERSION, mirror, j)
      await installPackage(platformPackage(), SHERPA_VERSION, mirror, j)
    }
    for (const f of m.files) {
      const to = path.join(modelDir(m.id), f.name)
      if (existsSync(to)) continue
      j.step = t('下载 {file}', { file: f.name })
      await downloadFile(speechFileUrl(m, f.name, mirror), to, {
        signal: j.abort.signal,
        onTotal: (n) => (j.progress!.total += n),
        onBytes: (n) => (j.progress!.done += n),
      })
    }
    j.step = t('{name} 下载完成', { name: m.name })
  })()
    .then(() => {
      j.status = 'done'
      j.progress = undefined
    })
    .catch((e) => {
      j.status = 'failed'
      j.error = j.abort.signal.aborted ? t('已取消') : (e as Error).message
      log.warn('speech', '下载失败', { model: id, error: j.error })
    })
  return j
}

export function cancelSpeechJob() {
  if (job?.status === 'running') job.abort.abort()
}

export async function removeSpeechModel(id: string) {
  const m = speechModel(id)
  if (!m) throw new Error(t('没有这个语音模型'))
  if (job?.status === 'running' && job.model === id) throw new Error(t('这个模型正在下载，先取消再删除'))
  if (loaded?.id === id) loaded = undefined
  for (const f of m.files) await removeDownload(path.join(modelDir(id), f.name))
  await rm(modelDir(id), { recursive: true, force: true })
}

interface Recognizer {
  createStream(): { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void }
  decodeAsync(stream: unknown): Promise<{ text?: string }>
}

/** 加载好的识别器只留一个：换模型时丢掉旧的（几百 MB 的内存） */
let loaded: { id: string; rec: Promise<Recognizer> } | undefined

function recognizer(m: SpeechModel) {
  if (loaded?.id === m.id) return loaded.rec
  const rec = (async () => {
    const require = createRequire(path.join(runtimeDir(), 'node_modules', 'sherpa-onnx-node', 'package.json'))
    let lib: { OfflineRecognizer: { createAsync(config: unknown): Promise<Recognizer> } }
    try {
      lib = require('sherpa-onnx-node')
    } catch (e) {
      throw new Error(t('加载语音识别库失败：{error}', { error: (e as Error).message }))
    }
    const threads = Math.max(1, Math.min(4, availableParallelism() - 1))
    return lib.OfflineRecognizer.createAsync(recognizerConfig(m, (f) => path.join(modelDir(m.id), f), threads))
  })()
  const entry = { id: m.id, rec }
  loaded = entry
  // 加载失败不缓存：用户修好（重新下载）后再点就重新加载
  rec.catch(() => loaded === entry && (loaded = undefined))
  return rec
}

/** 识别排队一个一个来：同一个识别器并发解码没有好处，还会把内存翻倍 */
let queue: Promise<unknown> = Promise.resolve()

/** 把一段 16kHz 单声道 16 位 PCM 转成文字 */
export async function transcribe(pcm: Uint8Array) {
  const s = (await getSettings()).speech
  if (!s.enabled) throw new Error(t('语音输入没有打开，请到设置 → 语音输入里打开'))
  const m = speechModel(s.model)
  if (!m) throw new Error(t('没有这个语音模型'))
  if (!runtimeReady() || !modelReady(m))
    throw new Error(t('还没有下载 {name}，请到设置 → 语音输入里下载', { name: m.name }))
  if (!pcm.length) return ''
  const run = queue.then(async () => {
    const rec = await recognizer(m)
    const stream = rec.createStream()
    stream.acceptWaveform({ samples: decodePcm16(pcm), sampleRate: SPEECH_RATE })
    const r = await rec.decodeAsync(stream)
    return cleanTranscript(r.text ?? '')
  })
  queue = run.catch(() => {})
  return run
}

export function speechApi() {
  const routes = new Hono()
  const wrap = (fn: () => unknown) => async (c: import('hono').Context) => {
    try {
      await fn()
      return c.json(speechStatus())
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }
  routes.get(
    '/status',
    wrap(() => {}),
  )
  routes.post('/cancel', wrap(cancelSpeechJob))
  routes.post('/models/:id/download', (c) => wrap(() => downloadSpeechModel(c.req.param('id')))(c))
  routes.delete('/models/:id', (c) => wrap(() => removeSpeechModel(c.req.param('id')))(c))
  routes.post('/transcribe', async (c) => {
    // 写操作只收 JSON（防跨站，见 server/index.ts），录音是 base64 编码的 16 位 PCM
    const body = (await c.req.json().catch(() => ({}))) as { audio?: unknown }
    if (typeof body.audio !== 'string') return c.json({ error: t('没有收到录音') }, 400)
    const pcm = Buffer.from(body.audio, 'base64')
    if (pcm.length > SPEECH_MAX_BYTES) return c.json({ error: t('录音太长了，一次最多两分钟') }, 400)
    try {
      return c.json({ text: await transcribe(pcm) })
    } catch (e) {
      log.warn('speech', '识别失败', { error: (e as Error).message })
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  return routes
}
