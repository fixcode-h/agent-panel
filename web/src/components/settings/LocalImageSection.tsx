import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Check, Download, Loader2, Play, RefreshCw, Square, Trash2, Wrench, X } from 'lucide-react'
import { LOCAL_MODELS, modelGb, modelReady, type LocalModel, type LocalStatus } from '@shared/local-image'
import type { Settings } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/ui/dialog'
import { ScopeRequests } from '@/components/chat/AskToggle'
import { Group, ReadValue, Row } from './parts'

type LocalSettings = Settings['imageGen']['local']

/** 本机生图的状态；有操作在跑（或 fast）时问得勤一些 */
export function useLocalImage(fast = false) {
  const [st, setSt] = useState<LocalStatus>()
  const running = st?.job?.status === 'running'
  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .localImage()
        .then((s) => alive && setSt(s))
        .catch(() => {})
    void load()
    const timer = setInterval(load, running || fast ? 1000 : 6000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [running, fast])
  return [st, setSt] as const
}

const gb = (n: number) => (n >= 10 ? `${Math.round(n)} GB` : `${n.toFixed(1)} GB`)
const GPU_LABEL: Record<LocalStatus['gpu'], string> = {
  cuda: 'NVIDIA CUDA',
  rocm: 'AMD ROCm',
  mps: 'Apple Metal',
  cpu: 'CPU',
}

/**
 * 设置里的「本机生图」：一键安装 ComfyUI、下载模型（每个模型写明用在哪里）、启动停止；
 * 出错时可以让 AI 排查修复。也可以填已有的 ComfyUI 地址直接用
 */
export function LocalImageSection({ value, onChange }: { value: LocalSettings; onChange: (v: LocalSettings) => void }) {
  const [st, setSt] = useLocalImage()
  const [removing, setRemoving] = useState<LocalModel | null>(null)
  const job = st?.job
  const busy = job?.status === 'running'
  const act = async (fn: () => Promise<LocalStatus>) => {
    try {
      setSt(await fn())
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  if (!st)
    return (
      <div className="grid place-items-center py-16 text-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  const ready = st.installed || st.external
  const pct = job?.progress?.total ? Math.min(100, (job.progress.done / job.progress.total) * 100) : undefined

  return (
    <>
      <p className="text-[13px] leading-relaxed text-subtle">
        {t(
          '用 ComfyUI 在本机跑开源图片模型，不花额度、不用联网生成，适合大批量的图标和素材。安装在软件目录下的 comfyui 文件夹里，需要 Python 3.10 ~ 3.13；有独立显卡（NVIDIA 8GB 显存以上）或苹果芯片的电脑才实用。',
        )}
      </p>

      <Group title={t('ComfyUI')}>
        <Row
          title={t('状态')}
          desc={st.external ? t('使用已有的 ComfyUI：{url}', { url: st.url }) : t('安装目录：{dir}', { dir: st.dir })}
        >
          <div className="flex items-center justify-end gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 text-[13px]',
                st.running ? 'text-success' : ready ? 'text-muted' : 'text-subtle',
              )}
            >
              <span
                className={cn(
                  'h-2 w-2 rounded-full',
                  st.running ? 'bg-success' : ready ? 'bg-muted' : 'bg-line-strong',
                )}
              />
              {st.running ? t('运行中') : ready ? t('已安装，未启动') : t('未安装')}
            </span>
            {!ready ? (
              <Button size="sm" disabled={busy} onClick={() => void act(() => api.localImageAction('install'))}>
                <Download className="h-3.5 w-3.5" />
                {t('一键安装')}
              </Button>
            ) : st.running ? (
              !st.external && (
                <Button size="sm" variant="ghost" onClick={() => void act(() => api.localImageAction('stop'))}>
                  <Square className="h-3.5 w-3.5" />
                  {t('停止')}
                </Button>
              )
            ) : (
              <Button size="sm" variant="ghost" onClick={() => void act(() => api.localImageAction('start'))}>
                <Play className="h-3.5 w-3.5" />
                {t('启动')}
              </Button>
            )}
          </div>
        </Row>
        <Row title={t('电脑环境')} desc={t('显卡决定装哪个版本的 PyTorch；没有检测到显卡时用 CPU，能出图但很慢')}>
          <div className="flex items-center gap-2">
            <ReadValue>
              {[
                st.gpuName ?? GPU_LABEL[st.gpu],
                st.vram ? t('{n}GB 显存', { n: st.vram }) : '',
                st.installed ? '' : st.python ? `Python ${st.python}` : t('没有找到 Python'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </ReadValue>
            <Button
              size="icon"
              variant="ghost"
              title={t('重新检测')}
              aria-label={t('重新检测')}
              onClick={() => void act(() => api.localImageAction('detect'))}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </Row>
        {job && (
          <div className="my-2 rounded-xl border bg-card p-3">
            <div className="flex items-center gap-2 text-[13px]">
              {job.status === 'running' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
              ) : job.status === 'done' ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <X className="h-3.5 w-3.5 shrink-0 text-danger" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{job.step}</span>
              {pct !== undefined && job.status === 'running' && (
                <span className="font-mono text-[12px] text-subtle">
                  {gb(job.progress!.done / 1024 ** 3)} / {gb(job.progress!.total / 1024 ** 3)}
                </span>
              )}
              {busy && (
                <Button size="sm" variant="ghost" onClick={() => void act(() => api.localImageAction('cancel'))}>
                  {t('取消')}
                </Button>
              )}
              {job.status === 'failed' && (
                <Button size="sm" onClick={() => void act(() => api.localImageAction('repair'))}>
                  <Wrench className="h-3.5 w-3.5" />
                  {t('AI 修复')}
                </Button>
              )}
              {job.status === 'failed' && job.kind !== 'repair' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void act(() =>
                      job.kind === 'download' && job.model
                        ? api.localModel(job.model, 'download')
                        : api.localImageAction('install'),
                    )
                  }
                >
                  {t('重试')}
                </Button>
              )}
            </div>
            {pct !== undefined && job.status === 'running' && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sel">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            )}
            {job.error && (
              <p className="mt-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-danger">{job.error}</p>
            )}
            {job.log && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-field p-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">
                {job.log.slice(-6000)}
              </pre>
            )}
            <ScopeRequests scope="local-image" active={job.kind === 'repair' && busy} className="mt-2" />
            {job.status === 'failed' && (
              <p className="mt-2 text-[12px] text-subtle">
                {t('「AI 修复」会把出错的步骤和输出交给「AI 创建」里设置的 CLI，让它在安装目录里排查并修好环境。')}
              </p>
            )}
          </div>
        )}
      </Group>

      <Group title={t('模型')}>
        <p className="pb-2 text-[12.5px] leading-relaxed text-subtle">
          {t(
            '选一个下载即可开始用，推荐的模型放在最前面。下载好的模型会出现在 UI 设计的「生成图片的方式」里；显存比建议的少也能跑，只是慢一些。',
          )}
        </p>
        <div className="flex flex-col gap-2">
          {LOCAL_MODELS.map((m) => {
            const ok = modelReady(m, st)
            const downloading = busy && job?.kind === 'download' && job.model === m.id
            const size = modelGb(m, (f) => st.files.includes(f))
            const tight = !!st.vram && st.vram < m.vram
            return (
              <div
                key={m.id}
                className={cn('flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:gap-4')}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium">
                    {m.name}
                    {m.recommended && (
                      <span className="rounded bg-accent-soft px-1.5 py-px text-[11px] font-normal text-accent">
                        {t('推荐')}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{m.use}</p>
                  <p className={cn('mt-0.5 text-[12px] text-subtle', tight && 'text-warning')}>
                    {t('建议显存 {n}GB', { n: m.vram })} · {ok ? t('已下载') : t('下载约 {size}', { size: gb(size) })} ·{' '}
                    {m.license}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {!st.external &&
                    (ok ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        title={t('删除模型文件')}
                        aria-label={t('删除模型文件')}
                        onClick={() => setRemoving(m)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={m.recommended ? 'primary' : 'secondary'}
                        disabled={busy || !st.installed}
                        title={st.installed ? undefined : t('先安装 ComfyUI')}
                        onClick={() => void act(() => api.localModel(m.id, 'download'))}
                      >
                        {downloading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        {t('下载')}
                      </Button>
                    ))}
                </div>
              </div>
            )
          })}
        </div>
      </Group>

      <Group title={t('下载和连接')}>
        <Row
          title={t('使用国内镜像')}
          desc={t('打不开 Hugging Face 时打开：模型从 hf-mirror.com 下载，Python 依赖从清华镜像安装')}
        >
          <div className="flex justify-end">
            <Switch
              aria-label={t('使用国内镜像')}
              checked={value.mirror}
              onCheckedChange={(mirror) => onChange({ ...value, mirror })}
            />
          </div>
        </Row>
        <Row title={t('端口')} desc={t('ComfyUI 只在本机监听这个端口')}>
          <Input
            aria-label={t('端口')}
            type="number"
            value={value.port}
            onChange={(e) => onChange({ ...value, port: Number(e.target.value) || 8188 })}
          />
        </Row>
        <Row
          title={t('已有的 ComfyUI')}
          desc={t('已经装了 ComfyUI 时填它的地址，就不用再装；模型要自己放进它的 models 目录')}
        >
          <Input
            aria-label={t('已有的 ComfyUI')}
            placeholder="http://127.0.0.1:8188"
            value={value.url}
            onChange={(e) => onChange({ ...value, url: e.target.value })}
          />
        </Row>
      </Group>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('删除 {name} 的模型文件？', { name: removing?.name ?? '' })}
        description={t('会删掉这个模型下载的文件（别的模型共用的文件保留），之后要用需要重新下载。')}
        confirmText={t('删除')}
        onConfirm={() => {
          const m = removing!
          setRemoving(null)
          void act(() => api.localModel(m.id, 'remove'))
        }}
      />
    </>
  )
}
