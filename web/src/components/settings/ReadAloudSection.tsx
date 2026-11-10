import { useEffect, useState } from 'react'
import { Check, Download, Loader2, Square, Trash2, Volume2, X } from 'lucide-react'
import { TTS_MODELS, TTS_VOICES, ttsVoiceGroupLabel, type TtsEngine, type TtsModel, type TtsStatus } from '@shared/tts'
import type { Settings } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { usePolling } from '@/lib/polling'
import { browserVoices, readAloud, readAloudSupported, stopReading, useReadAloud } from '@/lib/read-aloud'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Select } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Segmented } from '@/components/ui/segmented'
import { Group, Row } from './parts'

type ReadAloudSettings = Settings['readAloud']

/** 下载状态；有下载在跑时问得勤一些 */
function useTtsStatus() {
  const [st, setSt] = useState<TtsStatus>()
  const running = st?.job?.status === 'running'
  usePolling(() => api.tts().then(setSt), running ? 1000 : 6000)
  return [st, setSt] as const
}

/** 浏览器的语音列表是异步加载的：第一次拿可能是空的，等 voiceschanged 再拿一次 */
function useBrowserVoices() {
  const [list, setList] = useState(browserVoices)
  useEffect(() => {
    if (!readAloudSupported()) return
    const update = () => setList(browserVoices())
    window.speechSynthesis.addEventListener('voiceschanged', update)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', update)
  }, [])
  return list
}

const mb = (n: number) => `${Math.max(1, Math.round(n))} MB`
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2]
/** 试听念的句子：中英混着来，听得出两边的口音 */
const SAMPLE = '你好，我是你的编码助手。这一轮改了 3 个文件，单元测试全部通过，可以合并了。'

/**
 * 设置里的「语音朗读」（和语音输入分开）：回复下面的朗读按钮念没折叠的总结。
 * 默认用浏览器语音，开箱能用；下载开源的 Kokoro 模型后换成本机模型，可以挑音色、调语速
 */
export function ReadAloudSection({
  value,
  onChange,
}: {
  value: ReadAloudSettings
  onChange: (v: ReadAloudSettings) => void
}) {
  const [st, setSt] = useTtsStatus()
  const voices = useBrowserVoices()
  const [removing, setRemoving] = useState<TtsModel | null>(null)
  const trying = useReadAloud('settings-sample')
  const act = async (fn: () => Promise<TtsStatus>) => {
    try {
      setSt(await fn())
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const job = st?.job
  const busy = job?.status === 'running'
  const ready = !!st && st.runtime && st.models.includes(value.model)
  const pct = job?.progress?.total ? Math.min(100, (job.progress.done / job.progress.total) * 100) : undefined
  const local = value.engine === 'local'

  // 下载完成后自动换成本机模型：下载的就是想用的
  const doneId = job?.status === 'done' ? job.id : ''
  useEffect(() => {
    if (!doneId || !job) return
    onChange({ ...value, engine: 'local', model: job.model })
    // 只在这一次下载刚完成时切一次；value / onChange 每次渲染都是新的
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [doneId])

  const sample = () =>
    trying
      ? stopReading()
      : readAloud('settings-sample', SAMPLE, value, (error) => toast.error(t('朗读失败：{error}', { error })))

  return (
    <>
      <p className="text-body text-subtle">
        {t('回复下面的朗读按钮念没折叠的总结。本机模型在这台电脑上生成语音，文字不上传。')}
      </p>

      <Group title={t('语音朗读')}>
        <Row
          title={t('朗读引擎')}
          desc={
            local
              ? ready
                ? t('开源的 Kokoro 模型，在本机生成语音')
                : t('还没下载模型，在下面的列表里下载')
              : t('浏览器自带的语音，不用下载；音质看系统，Edge 里的「自然」语音最好')
          }
        >
          <div className="flex justify-end">
            <Segmented<TtsEngine>
              label={t('朗读引擎')}
              value={value.engine}
              onChange={(engine) => onChange({ ...value, engine })}
              options={[
                { id: 'local', label: t('本机模型') },
                { id: 'browser', label: t('浏览器语音') },
              ]}
            />
          </div>
        </Row>
        {local ? (
          <Row title={t('音色')} desc={t('Kokoro 中文版的音色，名字是模型里的编号；挑一个试听看看')}>
            <Select
              aria-label={t('朗读音色')}
              className="w-56"
              value={String(value.voice)}
              onChange={(e) => onChange({ ...value, voice: Number(e.target.value) })}
              options={TTS_VOICES.map((v) => ({
                value: String(v.sid),
                label: v.name,
                group: ttsVoiceGroupLabel(v.group),
              }))}
            />
          </Row>
        ) : (
          <Row title={t('语音')} desc={t('系统和浏览器装了哪些语音就列哪些')}>
            <Select
              aria-label={t('浏览器语音')}
              className="w-56"
              value={value.browserVoice}
              onChange={(e) => onChange({ ...value, browserVoice: e.target.value })}
              options={[
                { value: '', label: t('自动（优先「自然」语音）') },
                ...voices.map((v) => ({ value: v.name, label: `${v.name} · ${v.lang}` })),
              ]}
            />
          </Row>
        )}
        <Row title={t('语速')} desc={t('1 倍是正常语速')}>
          <Select
            aria-label={t('朗读语速')}
            className="w-28"
            value={String(value.speed)}
            onChange={(e) => onChange({ ...value, speed: Number(e.target.value) })}
            options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
          />
        </Row>
        <Row title={t('试听')} desc={t('用上面的设置念一句示例')}>
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" onClick={sample} disabled={local && !ready}>
              {trying ? <Square className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              {trying ? t('停止') : t('试听')}
            </Button>
          </div>
        </Row>
      </Group>

      <Group title={t('本机模型')}>
        <p className="pb-2 text-footnote leading-relaxed text-subtle">
          {t(
            '开源的 Kokoro 中文版，中英混读。下载好后自动换成本机模型。第一次下载还会带上识别库（约 30 MB，和语音输入共用，已经下过就不再下）。',
          )}
        </p>
        {!st ? (
          <div className="grid place-items-center py-10 text-subtle">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {!st.supported && (
              <p className="text-footnote text-warning">
                {t('语音识别库没有这台电脑（{platform}）的版本，只能用浏览器语音', { platform: st.platform })}
              </p>
            )}
            {TTS_MODELS.map((m) => {
              const have = st.models.includes(m.id)
              const current = local && value.model === m.id
              const downloading = busy && job?.model === m.id
              return (
                <Card key={m.id} padding="sm" className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-body font-medium">
                      {m.name}
                      {m.recommended && (
                        <span className="rounded-sm bg-accent-soft px-1.5 py-px text-caption font-normal text-accent-text">
                          {t('推荐')}
                        </span>
                      )}
                      {current && (
                        <span className="rounded-sm bg-sel px-1.5 py-px text-caption font-normal text-muted">
                          {t('使用中')}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-footnote leading-relaxed text-muted">{m.use}</p>
                    <p className="mt-0.5 text-footnote text-subtle">
                      {have ? t('已下载') : t('下载约 {size}', { size: mb(m.mb) })} · {m.license}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {have ? (
                      <>
                        {!current && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onChange({ ...value, engine: 'local', model: m.id })}
                          >
                            {t('使用')}
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          title={t('删除模型文件')}
                          aria-label={t('删除模型文件')}
                          onClick={() => setRemoving(m)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant={m.recommended ? 'primary' : 'secondary'}
                        disabled={busy || !st.supported}
                        onClick={() => void act(() => api.ttsModel(m.id, 'download'))}
                      >
                        {downloading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        {t('下载')}
                      </Button>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
        {job && (
          <Card padding="sm" className="my-2">
            <div className="flex items-center gap-2 text-body">
              {job.status === 'running' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text" />
              ) : job.status === 'done' ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <X className="h-3.5 w-3.5 shrink-0 text-danger" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{job.step}</span>
              {pct !== undefined && busy && (
                <span className="font-mono text-footnote text-subtle">
                  {mb(job.progress!.done / 1024 ** 2)} / {mb(job.progress!.total / 1024 ** 2)}
                </span>
              )}
              {busy && (
                <Button size="sm" variant="ghost" onClick={() => void act(() => api.ttsCancel())}>
                  {t('取消')}
                </Button>
              )}
              {job.status === 'failed' && (
                <Button size="sm" variant="ghost" onClick={() => void act(() => api.ttsModel(job.model, 'download'))}>
                  {t('重试')}
                </Button>
              )}
            </div>
            {pct !== undefined && busy && <Progress value={pct} label={t('进度')} className="mt-2" />}
            {job.error && (
              <p className="mt-2 text-footnote leading-relaxed whitespace-pre-wrap text-danger">{job.error}</p>
            )}
          </Card>
        )}
        {st && (
          <Row title={t('存放位置')} desc={st.dir}>
            <span />
          </Row>
        )}
      </Group>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('删除 {name} 的模型文件？', { name: removing?.name ?? '' })}
        description={t('删掉后要用需要重新下载。识别库保留，语音输入不受影响。')}
        confirmText={t('删除')}
        onConfirm={() => {
          const m = removing!
          setRemoving(null)
          if (value.model === m.id && value.engine === 'local') onChange({ ...value, engine: 'browser' })
          void act(() => api.ttsModel(m.id, 'remove'))
        }}
      />
    </>
  )
}
