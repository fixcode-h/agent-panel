import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDown, Check, Download, Loader2, Play, RefreshCw, Square, Trash2, X } from 'lucide-react'
import {
  LOCAL_MODELS,
  PYTHON_RANGE,
  PYTHON_SUPPORT,
  modelGb,
  modelReady,
  type LocalModel,
  type LocalStatus,
} from '@shared/local-image'
import type { Settings } from '@shared/schema'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/ui/dialog'
import { AiFixButton } from '@/components/ui/ai-fix'
import { Group, Row } from './parts'

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

/** 环境清单的一行：左边小标题，右边值和说明；路径这类长文本用 mono 并允许折行 */
function EnvLine({ label, value, hint, mono }: { label: string; value: string; hint?: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-3">
      <span className="shrink-0 text-[0.75rem] text-subtle sm:w-20">{label}</span>
      <div className="min-w-0 flex-1">
        <span
          className={cn('block break-all', mono ? 'font-mono text-[0.75rem] text-muted' : 'text-[0.8125rem] text-fg')}
        >
          {value}
        </span>
        {hint && <span className="mt-0.5 block break-all text-[0.75rem] leading-relaxed text-subtle">{hint}</span>}
      </div>
    </div>
  )
}

/**
 * 安装 / 下载的日志区：高度固定不撑高整页，始终停在最新一行（安装过程的输出一直在往下追加）。
 * 往上翻看历史时不打扰，滚回底部附近再接着跟；换一轮任务或任务结束时重新贴底，
 * 保证报错和最后一行不会停在可视区外
 */
function JobLog({ job }: { job: NonNullable<LocalStatus['job']> }) {
  const { ref, onScroll, away, toBottom } = useStickToBottom(`${job.id}:${job.status}`)
  return (
    <div className="relative mt-2">
      <div ref={ref} onScroll={onScroll} className="max-h-48 overflow-x-hidden overflow-y-auto rounded-lg bg-field p-2">
        {/* 等宽、自动折行：URL 和路径这类长行不把容器撑出横向滚动条 */}
        <pre className="font-mono text-[0.71875rem] leading-relaxed break-all whitespace-pre-wrap text-muted">
          {job.log.slice(-6000)}
        </pre>
      </div>
      {away && (
        <button
          type="button"
          onClick={toBottom}
          aria-label={t('回到底部')}
          title={t('回到底部')}
          className="absolute right-2 bottom-2 grid h-6 w-6 cursor-pointer place-items-center rounded-full border border-line-strong bg-card text-muted shadow-pop transition-colors hover:text-fg"
        >
          <ArrowDown className="h-3 w-3" />
        </button>
      )}
    </div>
  )
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
  const usable = st.pythons.find((p) => p.usable)
  const others = st.pythons.filter((p) => !p.usable)
  const pct = job?.progress?.total ? Math.min(100, (job.progress.done / job.progress.total) * 100) : undefined

  return (
    <>
      <p className="text-[0.8125rem] leading-relaxed text-subtle">
        {t(
          '用 ComfyUI 在本机跑开源图片模型，不花额度、不用联网生成，适合大批量的图标和素材。安装在软件目录下的 comfyui 文件夹里，需要 Python {range}；有独立显卡（NVIDIA 8GB 显存以上）或苹果芯片的电脑才实用。',
          { range: PYTHON_RANGE },
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
                'inline-flex items-center gap-1.5 text-[0.8125rem]',
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
        <Row title={t('电脑环境')} desc={t('显卡决定装哪个版本的 PyTorch；没有检测到显卡时用 CPU，能出图但很慢')} stack>
          <div className="rounded-xl border bg-field/40 px-3 py-1">
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1 divide-y divide-line/60">
                <EnvLine
                  label={t('显卡')}
                  value={
                    st.gpuName
                      ? `${st.gpuName}${st.vram ? ` · ${t('{n}GB 显存', { n: st.vram })}` : ''}`
                      : GPU_LABEL[st.gpu]
                  }
                  hint={st.gpuName ? GPU_LABEL[st.gpu] : undefined}
                />
                <EnvLine
                  label="Python"
                  value={
                    st.venv ? `Python ${st.venv.version}` : usable ? `Python ${usable.version}` : t('没有可用的 Python')
                  }
                  hint={
                    st.venv
                      ? t('已经装好：启动 ComfyUI 用这个虚拟环境的解释器')
                      : usable
                        ? t('安装时会用 {cmd}', { cmd: usable.command })
                        : st.pythons.length
                          ? t('下面的版本用不了，装 Python {v} 后再点「一键安装」', { v: PYTHON_SUPPORT.recommend })
                          : t('没有检测到 Python，装 Python {v} 后再点「一键安装」', { v: PYTHON_SUPPORT.recommend })
                  }
                />
                {(st.venv?.path ?? usable?.path) && (
                  <EnvLine label={t('解释器')} value={st.venv?.path ?? usable!.path!} mono />
                )}
                {others.length > 0 && (
                  <EnvLine
                    label={t('其它 Python')}
                    value={others.map((p) => `${p.version}（${p.command}）`).join(' · ')}
                    hint={others
                      .map((p) => p.problem)
                      .filter(Boolean)
                      .join(' ')}
                  />
                )}
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="mt-1 shrink-0"
                title={t('重新检测')}
                aria-label={t('重新检测')}
                onClick={() => void act(() => api.localImageAction('detect'))}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
            {!st.venv && !usable && (
              <p className="border-t border-line/60 py-2 text-[0.75rem] leading-relaxed text-subtle">
                {t(
                  '装 Python {v}（https://www.python.org/downloads/ ，Windows 安装时勾选 Add to PATH）后回来点「一键安装」；也可以点出错后的「AI 处理」让 AI 帮你装。',
                  { v: PYTHON_SUPPORT.recommend },
                )}
              </p>
            )}
          </div>
        </Row>
        {job && (
          <div className="my-2 rounded-xl border bg-card p-3">
            <div className="flex items-center gap-2 text-[0.8125rem]">
              {job.status === 'running' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
              ) : job.status === 'done' ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <X className="h-3.5 w-3.5 shrink-0 text-danger" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{job.step}</span>
              {pct !== undefined && job.status === 'running' && (
                <span className="font-mono text-[0.75rem] text-subtle">
                  {gb(job.progress!.done / 1024 ** 3)} / {gb(job.progress!.total / 1024 ** 3)}
                </span>
              )}
              {busy && (
                <Button size="sm" variant="ghost" onClick={() => void act(() => api.localImageAction('cancel'))}>
                  {t('取消')}
                </Button>
              )}
              {job.status === 'failed' && (
                <AiFixButton
                  variant="primary"
                  issue={{
                    title: t('本机生图：{step}', { step: job.step }),
                    error: job.error ?? '',
                    output: job.log.slice(-12_000),
                    topic: 'local-image',
                    onDone: () => void act(() => api.localImageAction('detect')),
                  }}
                />
              )}
              {job.status === 'failed' && (
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
              <p className="mt-2 text-[0.78125rem] leading-relaxed whitespace-pre-wrap text-danger">{job.error}</p>
            )}
            {job.log && <JobLog job={job} />}
            {job.status === 'failed' && (
              <p className="mt-2 text-[0.75rem] text-subtle">
                {t('「AI 处理」会把出错的步骤和输出交给「AI 创建」里设置的 Agent，让它在安装目录里排查并修好环境。')}
              </p>
            )}
          </div>
        )}
      </Group>

      <Group title={t('模型')}>
        <p className="pb-2 text-[0.78125rem] leading-relaxed text-subtle">
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
                  <div className="flex flex-wrap items-center gap-1.5 text-[0.84375rem] font-medium">
                    {m.name}
                    {m.recommended && (
                      <span className="rounded bg-accent-soft px-1.5 py-px text-[0.6875rem] font-normal text-accent">
                        {t('推荐')}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[0.78125rem] leading-relaxed text-muted">{m.use}</p>
                  <p className={cn('mt-0.5 text-[0.75rem] text-subtle', tight && 'text-warning')}>
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
