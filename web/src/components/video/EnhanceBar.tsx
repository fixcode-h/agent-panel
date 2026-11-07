// 截帧弹窗右栏的「画面增强」：选增强方式（FFmpeg 内置 / 面板内置的 ComfyUI 画质工作流 / 自己的工作流和链），处理勾选的帧。
// 内置的 ComfyUI 工作流缺模型时就地下载（复用设置 → 本机生图的下载通道，进度在这里显示），ComfyUI 没装时带去设置页装。
import { useEffect, useState } from 'react'
import { Download, Loader2, Sparkles } from 'lucide-react'
import type { LocalJob } from '@shared/local-image'
import type { EnhanceMethod } from '@shared/video'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useNav } from '@/lib/data'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'

/** 下拉框里的分组名（放函数里：切换界面语言后要重新取） */
const groupName = (g: EnhanceMethod['group']) =>
  g === 'ffmpeg' ? t('FFmpeg（不用模型）') : g === 'builtin' ? t('ComfyUI 画质（面板内置）') : t('我的 ComfyUI 工作流')

export function EnhanceBar(p: {
  methods: EnhanceMethod[]
  method: string
  onMethod: (id: string) => void
  /** 截帧 / 增强正在跑 */
  busy: boolean
  running: boolean
  frames: number
  chosen: number
  anyEnhanced: boolean
  onEnhance: () => void
  onUnenhance: () => void
  /** 模型下载完：重新拉一遍增强方式（缺不缺模型由服务端算） */
  onReload: () => void
}) {
  const { openSettings } = useNav()
  const cur = p.methods.find((m) => m.id === p.method)
  /** 正在下载的模型（本机生图同一时间只跑一个安装 / 下载） */
  const [job, setJob] = useState<LocalJob | null>(null)
  const downloading = job?.kind === 'download' && job.status === 'running'
  // 下载时每秒看一次进度；下完（或失败）停下，成功了重新拉增强方式
  useEffect(() => {
    if (!downloading) return
    const id = setInterval(() => {
      void api
        .localImage()
        .then((s) => {
          const j = s.job ?? null
          setJob(j)
          if (j?.status === 'failed') toast.error(j.error || j.step)
          if (j?.status === 'done') p.onReload()
        })
        .catch(() => {})
    }, 1000)
    return () => clearInterval(id)
    // p.onReload 每次渲染都是新的，只按「在不在下载」重排定时器
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [downloading])

  const download = (model: string) =>
    void api
      .localModel(model, 'download')
      .then((s) => setJob(s.job ?? null))
      .catch((e: Error) => toast.error(e.message))

  const missing = cur?.missing
  const pct = job?.progress?.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0
  return (
    <div className="flex flex-col gap-2">
      <Select
        size="sm"
        aria-label={t('增强方式')}
        value={p.method}
        onChange={(e) => p.onMethod(e.target.value)}
        className="w-full min-w-0"
        options={p.methods.map((m) => ({
          value: m.id,
          label: m.missing ? t('{name}（未就绪）', { name: m.label }) : m.label,
          group: groupName(m.group),
        }))}
      />
      <p className="text-footnote leading-relaxed text-subtle">
        {missing?.kind === 'model'
          ? t('这个方式要先下载模型 {name}，下载一次之后离线也能用', { name: missing.name })
          : missing?.kind === 'comfy'
            ? t('这个方式在本机 ComfyUI 里跑，要先在设置 → 本机生图里装好 ComfyUI')
            : `${cur?.note ?? ''}${cur?.note ? ' · ' : ''}${t('增强会补出原来没有的细节，读文字、数字以原图为准')}`}
      </p>
      <div className="flex items-center gap-1.5">
        {missing?.kind === 'model' ? (
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            disabled={downloading}
            onClick={() => download(missing.model)}
          >
            {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {downloading
              ? t('下载中 {pct}%', { pct })
              : t('下载 {name}（{gb} GB）', { name: missing.name, gb: missing.gb.toFixed(missing.gb < 1 ? 2 : 1) })}
          </Button>
        ) : missing?.kind === 'comfy' ? (
          <Button variant="secondary" size="sm" className="flex-1" onClick={() => openSettings('local-image')}>
            {t('去安装 ComfyUI')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            disabled={p.busy || !p.chosen}
            onClick={p.onEnhance}
            title={!p.frames ? t('先截几帧再增强') : !p.chosen ? t('先勾选要处理的帧') : undefined}
          >
            {p.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {t('处理选中的帧（{n}）', { n: p.chosen })}
          </Button>
        )}
        {p.anyEnhanced && (
          <Button variant="ghost" size="sm" disabled={p.busy} onClick={p.onUnenhance}>
            {t('去掉增强')}
          </Button>
        )}
      </div>
    </div>
  )
}
