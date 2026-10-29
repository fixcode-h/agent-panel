import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Mic } from 'lucide-react'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { startRecording, type Recording } from '@/lib/speech-recorder'
import { IconButton } from '@/components/ui/icon-button'

/** 浏览器给的录音错误换成能照着做的话 */
function micError(e: unknown) {
  const name = (e as { name?: string })?.name
  const msg = (e as Error)?.message ?? String(e)
  if (msg === 'NO_MEDIA') return t('这个页面不能录音：浏览器只允许 localhost / 127.0.0.1 或 https 的页面使用麦克风')
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return t('没有麦克风权限：在浏览器地址栏左边的网站设置里允许使用麦克风后再试')
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('没有找到麦克风')
  if (name === 'NotReadableError') return t('麦克风被别的程序占用了')
  return t('录音失败：{error}', { error: msg })
}

/**
 * 输入框上的语音输入按钮：只在设置 →「语音输入」打开后显示。
 * 点一下开始录音，再点一下停止并识别，识别出的文字插到光标处；录音中按 Esc 放弃。
 * 识别在本机做（server/speech.ts），出错时把原因显示出来，不悄悄重试
 */
export function SpeechButton({ onText, className }: { onText: (text: string) => void; className?: string }) {
  const on = useData().settings?.speech.enabled
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'busy'>('idle')
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)
  const rec = useRef<Recording | null>(null)
  const textCb = useRef(onText)
  textCb.current = onText

  const stop = async () => {
    const r = rec.current
    if (!r) return
    rec.current = null
    setState('busy')
    try {
      const { audio, seconds } = await r.stop()
      // 不到 0.3 秒基本是误点，不发去识别
      if (seconds < 0.3) return
      const { text } = await api.transcribe(audio)
      if (text) textCb.current(text)
      else toast.info(t('没有听清说了什么，再说一遍试试'))
    } catch (e) {
      toast.error(t('语音识别失败：{error}', { error: (e as Error).message }))
    } finally {
      setState('idle')
    }
  }
  const stopRef = useRef(stop)
  stopRef.current = stop

  const start = async () => {
    setState('starting')
    try {
      rec.current = await startRecording({
        onLevel: setLevel,
        // 录到上限就当用户点了停止，录下的照常识别
        onLimit: () => void stopRef.current(),
      })
      setSeconds(0)
      setState('recording')
    } catch (e) {
      rec.current = null
      setState('idle')
      toast.error(micError(e))
    }
  }

  const cancel = useCallback(() => {
    rec.current?.cancel()
    rec.current = null
    setState('idle')
  }, [])

  // 录音中：计时，Esc 放弃
  useEffect(() => {
    if (state !== 'recording') return
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', key, true)
    return () => {
      clearInterval(timer)
      window.removeEventListener('keydown', key, true)
    }
  }, [state, cancel])
  // 关掉设置或输入框卸载时把麦克风放掉，不然浏览器标签上的录音标记一直亮着
  useEffect(() => {
    if (!on) cancel()
  }, [on, cancel])
  useEffect(() => () => rec.current?.cancel(), [])

  if (!on) return null
  const recording = state === 'recording'
  const label =
    state === 'busy'
      ? t('正在识别…')
      : recording
        ? t('停止录音并识别（Esc 放弃）')
        : t('语音输入：点一下开始说话，再点一下转成文字')
  return (
    <IconButton
      size="sm"
      tone="bare"
      label={label}
      aria-pressed={recording}
      disabled={state === 'starting' || state === 'busy'}
      onClick={() => void (recording ? stop() : start())}
      // 外面传的尺寸在前：录音时要放下计时，宽度改成自适应
      className={cn(
        className,
        recording && 'flex w-auto gap-1 px-1.5 text-danger hover:text-danger aria-pressed:text-danger',
      )}
    >
      {state === 'busy' || state === 'starting' ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : recording ? (
        <>
          {/* 音量圈：说话时跟着变大，让人知道麦克风确实收到了声音 */}
          <span className="relative grid h-4 w-4 place-items-center">
            <span
              className="absolute inset-0 rounded-full bg-danger/25 transition-transform duration-100"
              style={{ transform: `scale(${1 + Math.min(1, level * 3) * 0.6})` }}
            />
            <Mic className="relative h-3.5 w-3.5" />
          </span>
          <span className="font-mono text-[0.6875rem] tabular-nums">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </span>
        </>
      ) : (
        <Mic className="h-4 w-4" />
      )}
    </IconButton>
  )
}
