/**
 * 视频帧的画面增强：列出能用的增强方式，把一张帧图按选的方式处理成新图。
 *
 * 三类方式（用户 2026-11-07 要的：ComfyUI 要有现成能用的工作流，能提清晰度、去噪点）：
 * - FFmpeg 内置：放大锐化、去噪点，不用模型，马上出结果；
 * - 面板内置的 ComfyUI 画质工作流（shared/comfy-restore.ts）：Real-ESRGAN 提升清晰度 / 去噪点、SeedVR2 画质修复，
 *   ComfyUI 没装、模型没下载时照样列出来，标上缺什么，弹窗里可以直接下载；
 * - 用户自己做的吃一张图的工作流和工作流链。
 * 去背景、图生图这两个内置处理工作流不列：前者对视频帧没用，后者会重画画面内容，AI 拿到的就不是原视频的样子了。
 */
import { readFile } from 'node:fs/promises'
import { t } from '../../shared/i18n.ts'
import { chainSize, localModel, modelGb, needsInputImage } from '../../shared/local-image.ts'
import {
  FFMPEG_DENOISE,
  FFMPEG_ENHANCE,
  comfyMethod,
  parseComfyMethod,
  type EnhanceMethod,
  type VideoFrame,
} from '../../shared/video.ts'
import { allWorkflows, comfyUsable, fileDownloaded, localGenerateChain, userChains, workflowReady } from '../comfy.ts'
import { ffmpegBin, runFfmpeg } from './ffmpeg.ts'

/** 面板内置、给视频帧用的 ComfyUI 工作流：id 以 restore- 开头（shared/comfy-restore.ts） */
const isRestore = (id: string) => id.startsWith('restore-')

/** 能用的增强方式：FFmpeg 两种 → 内置画质工作流 → 用户的工作流和链 */
export async function enhanceMethods(): Promise<EnhanceMethod[]> {
  const out: EnhanceMethod[] = [
    {
      id: FFMPEG_ENHANCE,
      label: t('放大锐化（FFmpeg）'),
      note: t('2 倍放大再锐化，不用模型，马上出结果'),
      group: 'ffmpeg',
    },
    {
      id: FFMPEG_DENOISE,
      label: t('去噪点（FFmpeg）'),
      note: t('尺寸不变，抹掉噪点和颗粒，不用模型；细节会略软'),
      group: 'ffmpeg',
    },
  ]
  const workflows = await allWorkflows().catch(() => [])
  const usable = await comfyUsable().catch(() => false)
  for (const w of workflows) {
    if (!w.builtin || !isRestore(w.id)) continue
    const m = localModel(w.model)
    let missing: EnhanceMethod['missing']
    if (!usable) missing = { kind: 'comfy' }
    else if (m && !(await workflowReady(w))) {
      // 只算还没下载的文件：下过一部分时显示剩下的量
      const gb = modelGb(m, fileDownloaded)
      missing = { kind: 'model', model: m.id, name: m.name, gb }
    }
    out.push({ id: comfyMethod('wf', w.id), label: w.name, note: w.description, group: 'builtin', missing })
  }
  for (const w of workflows)
    if (!w.builtin && needsInputImage(w.graph))
      out.push({ id: comfyMethod('wf', w.id), label: w.name, note: t('本机 ComfyUI 工作流'), group: 'custom' })
  const byId = new Map(workflows.map((w) => [w.id, w]))
  for (const c of await userChains().catch(() => [])) {
    const first = byId.get(c.steps[0]?.workflowId ?? '')
    if (first && needsInputImage(first.graph))
      out.push({ id: comfyMethod('chain', c.id), label: c.name, note: t('本机 ComfyUI 工作流链'), group: 'custom' })
  }
  return out
}

/** FFmpeg 处理一张图，输出 PNG */
async function ffmpegImage(file: string, filter: string, signal?: AbortSignal) {
  const r = await runFfmpeg(
    await ffmpegBin(),
    ['-i', file, '-vf', filter, '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'],
    { timeoutMs: 120_000, signal, maxOut: 300 * 1024 * 1024 },
  )
  if (r.error || !r.stdout.length)
    throw new Error(t('增强失败：{error}', { error: r.error ?? r.stderr.trim().split('\n').pop() ?? '' }))
  return r.stdout
}

/** 增强一张帧图，返回增强图的内容 */
export async function enhanceOne(method: string, frame: VideoFrame, signal?: AbortSignal): Promise<Buffer> {
  if (method === FFMPEG_ENHANCE) {
    // 太大的图只放大到长边 4096：再大模型也看不过来，只会白占 token
    const scale = Math.max(frame.width, frame.height) * 2 > 4096 ? 4096 / Math.max(frame.width, frame.height, 1) : 2
    const s = scale.toFixed(4)
    return ffmpegImage(
      frame.file,
      `scale=trunc(iw*${s}/2)*2:trunc(ih*${s}/2)*2:flags=lanczos,unsharp=5:5:0.8:5:5:0`,
      signal,
    )
  }
  // 非局部均值去噪：s 是强度（3 去得掉一般的录像噪点，又不至于把文字抹糊），p / r 是比对块和搜索范围
  if (method === FFMPEG_DENOISE) return ffmpegImage(frame.file, 'nlmeans=s=3:p=7:r=15', signal)
  const comfy = parseComfyMethod(method)
  if (!comfy) throw new Error(t('不认识的增强方式：{id}', { id: method }))
  if (comfy.kind === 'wf' && isRestore(comfy.id) && !(await comfyUsable()))
    throw new Error(t('还没有安装本机生图（ComfyUI），请到设置 → 本机生图里一键安装'))
  const chain =
    comfy.kind === 'chain'
      ? (await userChains()).find((c) => c.id === comfy.id)
      : { id: `video-${comfy.id}`, name: comfy.id, steps: [{ workflowId: comfy.id, prompt: '' }], updatedAt: '' }
  if (!chain) throw new Error(t('工作流链已经不在了，请重新选一种增强方式'))
  const images: Buffer[] = []
  await localGenerateChain(
    {
      chain,
      image: await readFile(frame.file),
      prompt: '',
      negative: '',
      ...chainSize(frame.width, frame.height),
      count: 1,
      onImage: (b) => images.push(b),
    },
    signal ?? new AbortController().signal,
  )
  if (!images[0]) throw new Error(t('ComfyUI 没有返回图片'))
  return images[0]
}
