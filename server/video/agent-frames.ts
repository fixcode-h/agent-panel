/**
 * 给 Agent 的受控截帧工具 video_frames（用户 2026-11-07 拍板）：Agent 收不了视频，以前只能等用户在弹窗里截好帧发过来；
 * 现在它想看视频的某一段、某一秒时，可以自己调这个工具，面板用 FFmpeg 截出 PNG 放进这个对话的目录，返回路径让它去读。
 *
 * 受控的意思：只读视频不改视频；帧只写进这个对话自己的 attachments/ 目录（和用户发的图片同一个地方，Agent 本来就能读）；
 * 一次最多 MAX 张；不碰用户在截帧弹窗里的截帧记录。
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isAbsolutePath } from '../../shared/composer.ts'
import {
  AUTO_MODES,
  clampRange,
  frameName,
  rangePickTimes,
  rangeUniformTimes,
  timeText,
  type AutoMode,
} from '../../shared/video.ts'
import { taskAttachDir } from '../task-files.ts'
import { ffmpegBin, runFfmpeg } from './ffmpeg.ts'
import { candidates, probe, sharpestNear, videoStat } from './frames.ts'

/** 一次最多截几张：Agent 一次看太多图既慢又占上下文 */
const MAX = 12

const text = (s: string, isError = false) => ({ content: [{ type: 'text', text: s }], ...(isError ? { isError } : {}) })

export async function callVideoTool(taskId: string, a: any, signal?: AbortSignal) {
  const file = typeof a?.path === 'string' ? a.path.trim() : ''
  if (!file || !isAbsolutePath(file)) return text('要给视频文件的绝对路径（path）', true)
  let full: string
  try {
    full = (await videoStat(file)).full
  } catch (e) {
    return text((e as Error).message, true)
  }
  const info = await probe(full)
  const range = clampRange({ start: a?.start ?? 0, end: a?.end ?? info.duration }, info.duration)
  const mode: AutoMode = (AUTO_MODES as readonly string[]).includes(a?.mode) ? a.mode : 'scene'
  const count = Math.min(MAX, Math.max(1, Math.round(Number(a?.count) || 6)))
  const times: number[] = Array.isArray(a?.times)
    ? [...new Set((a.times as unknown[]).map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x <= info.duration))]
        .sort((x, y) => x - y)
        .slice(0, MAX)
    : mode === 'uniform'
      ? rangeUniformTimes(range, count)
      : rangePickTimes(await candidates(full, mode, range, signal), range, count)
  if (!times.length) return text('没有可截的时间点：times 都超出了视频时长（' + timeText(info.duration) + '）', true)
  // 每个视频一个子目录（名字带路径哈希，同名视频不会混）
  const tag = createHash('sha1').update(full).digest('hex').slice(0, 8)
  const dir = path.join(taskAttachDir(taskId), `video-${tag}`)
  await mkdir(dir, { recursive: true })
  const bin = await ffmpegBin()
  const out: { time: number; path: string }[] = []
  for (const want of times) {
    if (signal?.aborted) break
    // 给了具体秒数就截那一秒；按范围挑的点在前后 0.25 秒里挑最清楚的
    const at = Array.isArray(a?.times) ? want : await sharpestNear(full, want, info, range, signal)
    const r = await runFfmpeg(
      bin,
      [
        '-ss',
        Math.min(at, Math.max(0, info.duration - 0.05)).toFixed(3),
        '-i',
        full,
        '-frames:v',
        '1',
        '-an',
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        'pipe:1',
      ],
      { timeoutMs: 30_000, signal, maxOut: 200 * 1024 * 1024 },
    )
    if (r.error || !r.stdout.length) continue
    const p = path.join(dir, frameName(full, at))
    await writeFile(p, r.stdout)
    out.push({ time: at, path: p })
  }
  if (!out.length) return text('一张都没截出来，视频可能损坏或编码不支持', true)
  const head = `视频 ${path.basename(full)}：时长 ${timeText(info.duration)}，${info.width}×${info.height}${info.fps ? `，${Math.round(info.fps)} fps` : ''}。截了 ${out.length} 张：`
  return text([head, ...out.map((f) => `- ${timeText(f.time)}  ${f.path}`)].join('\n'))
}
