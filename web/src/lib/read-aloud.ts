/**
 * 朗读回复里没折叠的那部分（总结）。两种引擎（设置 → 语音朗读）：
 * - 本机模型：开源的 Kokoro，服务端一句句生成 WAV（server/tts.ts），这里排着队播放；
 * - 浏览器语音：speechSynthesis，不用下载，在线演示也能用。
 *
 * 同一时间只念一段：点另一段的朗读会先停掉正在念的。界面用 useReadAloud 订阅「正在念哪一段」。
 */
import { useSyncExternalStore } from 'react'

/** 一次交给语音引擎的最长字数：Chrome 念超过十几秒的一整句会无声地断掉，按句切开分几次念 */
const CHUNK_CHARS = 180

/** 路径只念文件名：念整串 a/b/c/d.ts 很难听，也听不出重点 */
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/**
 * 把回复的 Markdown 整理成适合念的文字：代码块整段不念，表格只念单元格的字，
 * 链接念文字不念网址，去掉标题、列表、加粗这些符号，长路径只念文件名
 */
export function speakableText(md: string): string {
  return (
    md
      // 代码块：念出来全是符号，跳过
      .replace(/```[\s\S]*?(```|$)/g, '\n')
      // 表格的分隔行
      // 用 [ \t] 不用 \s：\s 会吃掉换行，把上下两行粘在一起
      .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '')
      // 表格行：单元格之间停顿一下
      .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) =>
        row
          .split('|')
          .map((c) => c.trim())
          .filter(Boolean)
          .join('，'),
      )
      // 图片整个不念，链接只念文字
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // 裸网址不念
      .replace(/https?:\/\/\S+/g, '')
      // 行内代码：去掉反引号；像路径的只念文件名
      .replace(/`([^`\n]+)`/g, (_, code: string) => (/[\\/]/.test(code) && !/\s/.test(code) ? baseName(code) : code))
      // 正文里的路径（含 / 且像文件）也只念文件名
      .replace(/(?:[\w.-]+[\\/]){2,}[\w.-]+/g, baseName)
      // 标题、引用、列表符号
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      // 加粗、斜体、删除线
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?!\s)([^*\n]+)\*/g, '$1$2')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim()
  )
}

/** 按句子切成小段，每段不超过 CHUNK_CHARS；一句话本身太长时按逗号再切，还长就硬切 */
export function speechChunks(text: string, max = CHUNK_CHARS): string[] {
  const sentences = text.match(/[^。！？!?；;\n]+[。！？!?；;]?|\n/g) ?? []
  const out: string[] = []
  let cur = ''
  const push = (s: string) => {
    if (cur && (cur + s).length > max) {
      out.push(cur)
      cur = ''
    }
    cur += s
  }
  for (const raw of sentences) {
    const s = raw.trim()
    if (!s) {
      // 换行当一句的结束：标题、列表项各念各的，不和下一行连成一句
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    if (s.length <= max) {
      push(s)
      continue
    }
    for (const part of s.match(/[^，,、]+[，,、]?/g) ?? [s])
      for (let i = 0; i < part.length; i += max) push(part.slice(i, i + max))
  }
  if (cur) out.push(cur)
  return out.filter((x) => /[\p{L}\p{N}]/u.test(x))
}

/** 文字是哪种语言：中文字占多数时用中文语音，否则用英文的 */
const langOf = (text: string) => ((text.match(/\p{Script=Han}/gu)?.length ?? 0) * 3 >= text.length ? 'zh' : 'en')

/** 浏览器里能用的语音（设置页列出来给用户挑）；第一次调用时有的浏览器还没加载完，会是空的 */
export const browserVoices = () => (readAloudSupported() ? window.speechSynthesis.getVoices() : [])

/**
 * 挑一个语音：设置里指定了就用它（语言对不上也用，用户自己选的）；
 * 否则同语言里优先系统的「自然」语音（Edge 的 Natural / Online，macOS 的高质量语音），没有就交给浏览器默认
 */
function pickVoice(lang: string, wanted: string): SpeechSynthesisVoice | undefined {
  const all = window.speechSynthesis.getVoices()
  const named = wanted && all.find((v) => v.name === wanted)
  if (named) return named
  const score = (v: SpeechSynthesisVoice) =>
    (/natural|online|neural|premium|enhanced/i.test(v.name) ? 4 : 0) +
    (lang === 'zh' && /zh-cn|cmn/i.test(v.lang) ? 2 : 0) +
    (v.localService ? 1 : 0)
  return all.filter((v) => v.lang.toLowerCase().startsWith(lang)).sort((a, b) => score(b) - score(a))[0]
}

export const readAloudSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window

/** 朗读用的设置（Settings.readAloud 里的几项） */
export interface ReadAloudOptions {
  engine: 'local' | 'browser'
  voice: number
  speed: number
  browserVoice: string
  /** 设置页试听：用还没保存的模型 */
  model?: string
}

/** 正在念的那一段的 id；没在念是空串 */
let current = ''
/** 每次开始 / 停止都加一：旧的那一轮回调晚到时认出自己已经作废 */
let session = 0
/** 本机模型那条路正在放的音频和还没回来的请求：停止时一起掐掉 */
let audio: HTMLAudioElement | undefined
let aborter: AbortController | undefined
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const setCurrent = (id: string) => {
  current = id
  emit()
}

export function stopReading() {
  session++
  if (readAloudSupported()) window.speechSynthesis.cancel()
  aborter?.abort()
  aborter = undefined
  if (audio) {
    audio.pause()
    URL.revokeObjectURL(audio.src)
    audio = undefined
  }
  setCurrent('')
}

/** 浏览器语音：一段段交给 speechSynthesis 排队念 */
function speakBrowser(mine: number, chunks: string[], o: ReadAloudOptions, onError: (m: string) => void) {
  const synth = window.speechSynthesis
  const lang = langOf(chunks.join(''))
  const voice = pickVoice(lang, o.browserVoice)
  chunks.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = voice?.lang ?? (lang === 'zh' ? 'zh-CN' : 'en-US')
    if (voice) u.voice = voice
    u.rate = o.speed
    if (i === chunks.length - 1) u.onend = () => mine === session && setCurrent('')
    u.onerror = (e) => {
      // 自己 cancel 掉的（点了停止、换了一段）不算错
      if (mine !== session || e.error === 'canceled' || e.error === 'interrupted') return
      stopReading()
      onError(e.error)
    }
    synth.speak(u)
  })
}

/**
 * 本机模型：一句一句请服务端生成 WAV 播放。放这一句的同时就去要下一句，
 * 句子之间不用干等生成；第一句回来就开始出声
 */
async function speakLocal(mine: number, chunks: string[], o: ReadAloudOptions) {
  const ctrl = new AbortController()
  aborter = ctrl
  const { api } = await import('./api')
  const fetchChunk = (text: string) =>
    api.ttsSpeak({ text, voice: o.voice, speed: o.speed, model: o.model }, ctrl.signal)
  let next = fetchChunk(chunks[0])
  for (let i = 0; i < chunks.length; i++) {
    const blob = await next
    if (mine !== session) return
    if (i + 1 < chunks.length) next = fetchChunk(chunks[i + 1])
    // 下一句先挂个空处理：这句播放期间它失败了，等轮到它时再报，不算没人接的 Promise 错误
    next.catch(() => {})
    const el = new Audio(URL.createObjectURL(blob))
    audio = el
    await new Promise<void>((resolve, reject) => {
      el.onended = () => resolve()
      el.onerror = () => reject(new Error(String(el.error?.message || el.error?.code || 'audio error')))
      el.play().catch(reject)
    })
    URL.revokeObjectURL(el.src)
    if (mine !== session) return
  }
  if (mine === session) setCurrent('')
}

/**
 * 开始念：id 标出是哪一段（界面按它显示「停止」）。念完或出错都回到没在念；
 * 出错（没下载模型、系统没有语音……）时交给 onError，界面提示原因，不悄悄不出声
 */
export function readAloud(id: string, markdown: string, o: ReadAloudOptions, onError: (message: string) => void) {
  stopReading()
  const chunks = speechChunks(speakableText(markdown))
  if (!chunks.length) return
  const mine = ++session
  setCurrent(id)
  if (o.engine === 'browser') {
    if (!readAloudSupported()) {
      stopReading()
      onError('speechSynthesis unsupported')
      return
    }
    speakBrowser(mine, chunks, o, onError)
    return
  }
  speakLocal(mine, chunks, o).catch((e: Error) => {
    if (mine !== session || e.name === 'AbortError') return
    stopReading()
    onError(e.message)
  })
}

/** 正在念的是不是这一段 */
export function useReadAloud(id: string) {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current === id,
    () => false,
  )
}
