/**
 * 输入框语音输入的录音：麦克风 → AudioWorklet 收原始采样 → 停下时重采样成 16kHz、编成 16 位 PCM 的 base64，
 * 交给服务端识别（server/speech.ts）。
 *
 * 不用 MediaRecorder：它只出 webm / ogg 这类压缩格式，服务端还得解码；直接收 PCM 最省事。
 * worklet 代码很短，用 Blob 地址加载，不用另外放一个静态文件。
 */
import { SPEECH_MAX_SECONDS, encodePcm16, resample } from '@shared/speech'

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('speech-tap', Tap)
`

export interface Recording {
  /** 停下并拿到录音（base64 的 16kHz 16 位 PCM）和时长（秒） */
  stop(): Promise<{ audio: string; seconds: number }>
  /** 丢掉这段录音 */
  cancel(): void
}

/** base64 分段拼：几 MB 的录音一次 String.fromCharCode(...) 会爆调用栈 */
function toBase64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/**
 * 开始录音。onLevel 每块报一次音量（0~1，画按钮上的音量）；onLimit 在录到上限时调用，调用方接着 stop。
 * 没有麦克风权限、没有设备时抛错，错误信息交给界面显示
 */
export async function startRecording(o: { onLevel?: (v: number) => void; onLimit?: () => void } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('NO_MEDIA')
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const ctx = new AudioContext()
  const release = () => {
    stream.getTracks().forEach((tr) => tr.stop())
    void ctx.close().catch(() => {})
  }
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = ctx.createMediaStreamSource(stream)
    const tap = new AudioWorkletNode(ctx, 'speech-tap')
    const chunks: Float32Array[] = []
    let length = 0
    const max = ctx.sampleRate * SPEECH_MAX_SECONDS
    let limited = false
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (length >= max) {
        if (!limited) {
          limited = true
          o.onLimit?.()
        }
        return
      }
      chunks.push(e.data)
      length += e.data.length
      if (o.onLevel) {
        let peak = 0
        for (const v of e.data) peak = Math.max(peak, Math.abs(v))
        o.onLevel(peak)
      }
    }
    source.connect(tap)
    const rec: Recording = {
      async stop() {
        source.disconnect()
        tap.port.onmessage = null
        const rate = ctx.sampleRate
        release()
        const all = new Float32Array(length)
        let at = 0
        for (const c of chunks) {
          all.set(c, at)
          at += c.length
        }
        return { audio: toBase64(encodePcm16(resample(all, rate))), seconds: length / rate }
      },
      cancel() {
        source.disconnect()
        tap.port.onmessage = null
        release()
      },
    }
    return rec
  } catch (e) {
    release()
    throw e
  }
}
