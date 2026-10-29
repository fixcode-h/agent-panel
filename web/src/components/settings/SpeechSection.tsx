import { useEffect, useState } from 'react'
import { Check, Download, Loader2, Trash2, X } from 'lucide-react'
import { SPEECH_MODELS, speechModel, speechModelMb, type SpeechModel, type SpeechStatus } from '@shared/speech'
import type { Settings } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import { Group, Row } from './parts'

type SpeechSettings = Settings['speech']

/** 下载状态；有下载在跑时问得勤一些 */
function useSpeechStatus() {
  const [st, setSt] = useState<SpeechStatus>()
  const running = st?.job?.status === 'running'
  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .speech()
        .then((s) => alive && setSt(s))
        .catch(() => {})
    void load()
    const timer = setInterval(load, running ? 1000 : 6000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [running])
  return [st, setSt] as const
}

const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(n))} MB`)

/**
 * 设置里的「语音输入」：开关（关着时输入框上没有麦克风按钮）、选模型下载、选用哪个模型识别。
 * 默认什么都不下载，模型和识别库都要用户在这里自己点下载
 */
export function SpeechSection({ value, onChange }: { value: SpeechSettings; onChange: (v: SpeechSettings) => void }) {
  const [st, setSt] = useSpeechStatus()
  const [removing, setRemoving] = useState<SpeechModel | null>(null)
  const act = async (fn: () => Promise<SpeechStatus>) => {
    try {
      setSt(await fn())
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const job = st?.job
  const busy = job?.status === 'running'
  const using = speechModel(value.model)
  const ready = !!st && st.runtime && st.models.includes(value.model)
  const pct = job?.progress?.total ? Math.min(100, (job.progress.done / job.progress.total) * 100) : undefined

  return (
    <>
      <p className="text-[0.8125rem] leading-relaxed text-subtle">
        {t(
          '在本机把说的话转成文字，录音不上传到任何网站。识别用开源的 sherpa-onnx，模型和识别库都要在下面自己选了才下载，放在数据目录里。',
        )}
      </p>

      <Group title={t('语音输入')}>
        <Row
          title={t('启用语音输入')}
          desc={t(
            '打开后对话输入框上多一个麦克风按钮：点一下开始说话，再点一下转成文字插到光标处，录音中按 Esc 放弃。要先在下面下载一个模型。',
          )}
        >
          <div className="flex justify-end">
            <Switch
              aria-label={t('启用语音输入')}
              checked={value.enabled}
              onCheckedChange={(enabled) => onChange({ ...value, enabled })}
            />
          </div>
        </Row>
        <Row
          title={t('正在使用的模型')}
          desc={
            !st
              ? undefined
              : !st.supported
                ? t('语音识别库没有这台电脑（{platform}）的版本，暂时用不了语音输入', { platform: st.platform })
                : ready
                  ? t('已下载，可以直接用')
                  : t('还没下载：在下面的模型列表里点「下载」')
          }
        >
          <span
            className={cn('flex items-center justify-end gap-1.5 text-[0.8125rem]', ready ? 'text-fg' : 'text-subtle')}
          >
            <span className={cn('h-2 w-2 shrink-0 rounded-full', ready ? 'bg-success' : 'bg-line-strong')} />
            <span className="truncate">{using?.name}</span>
          </span>
        </Row>
      </Group>

      <Group title={t('模型')}>
        <p className="pb-2 text-[0.75rem] leading-relaxed text-subtle">
          {t(
            '选一个下载，下载好后点「使用」切换。中文为主推荐 SenseVoice；电脑内存小选 Paraformer；英文和其它语言多选 Whisper。第一次下载还会带上识别库（约 30 MB）。',
          )}
        </p>
        {!st ? (
          <div className="grid place-items-center py-10 text-subtle">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {SPEECH_MODELS.map((m) => {
              const have = st.models.includes(m.id)
              const current = value.model === m.id
              const downloading = busy && job?.model === m.id
              return (
                <Card key={m.id} padding="sm" className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[0.8125rem] font-medium">
                      {m.name}
                      {m.recommended && (
                        <span className="rounded bg-accent-soft px-1.5 py-px text-[0.6875rem] font-normal text-accent-text">
                          {t('推荐')}
                        </span>
                      )}
                      {current && (
                        <span className="rounded bg-sel px-1.5 py-px text-[0.6875rem] font-normal text-muted">
                          {t('使用中')}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[0.75rem] leading-relaxed text-muted">{m.use}</p>
                    <p className="mt-0.5 text-[0.75rem] text-subtle">
                      {m.langs} · {have ? t('已下载') : t('下载约 {size}', { size: mb(speechModelMb(m)) })} ·{' '}
                      {m.license}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {have ? (
                      <>
                        {!current && (
                          <Button size="sm" variant="secondary" onClick={() => onChange({ ...value, model: m.id })}>
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
                        onClick={() => {
                          // 下载的就是想用的：没在用别的已下载模型时顺手切过去
                          if (!st.models.includes(value.model)) onChange({ ...value, model: m.id })
                          void act(() => api.speechModel(m.id, 'download'))
                        }}
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
            <div className="flex items-center gap-2 text-[0.8125rem]">
              {job.status === 'running' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-text" />
              ) : job.status === 'done' ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <X className="h-3.5 w-3.5 shrink-0 text-danger" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{job.step}</span>
              {pct !== undefined && busy && (
                <span className="font-mono text-[0.75rem] text-subtle">
                  {mb(job.progress!.done / 1024 ** 2)} / {mb(job.progress!.total / 1024 ** 2)}
                </span>
              )}
              {busy && (
                <Button size="sm" variant="ghost" onClick={() => void act(() => api.speechCancel())}>
                  {t('取消')}
                </Button>
              )}
              {job.status === 'failed' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void act(() => api.speechModel(job.model, 'download'))}
                >
                  {t('重试')}
                </Button>
              )}
            </div>
            {pct !== undefined && busy && <Progress value={pct} label={t('进度')} className="mt-2" />}
            {job.error && (
              <p className="mt-2 text-[0.75rem] leading-relaxed whitespace-pre-wrap text-danger">{job.error}</p>
            )}
          </Card>
        )}
      </Group>

      <Group title={t('下载')}>
        <Row
          title={t('使用国内镜像下载语音模型')}
          desc={t('打不开 Hugging Face 时打开：模型从 hf-mirror.com 下载，识别库从 npmmirror 下载')}
        >
          <div className="flex justify-end">
            <Switch
              aria-label={t('使用国内镜像下载语音模型')}
              checked={value.mirror}
              onCheckedChange={(mirror) => onChange({ ...value, mirror })}
            />
          </div>
        </Row>
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
        description={t('删掉后要用需要重新下载。识别库保留，别的模型不受影响。')}
        confirmText={t('删除')}
        onConfirm={() => {
          const m = removing!
          setRemoving(null)
          void act(() => api.speechModel(m.id, 'remove'))
        }}
      />
    </>
  )
}
