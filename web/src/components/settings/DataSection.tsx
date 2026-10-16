import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Download, FolderOpen, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react'
import { DATA_KINDS, type DataKind, type DataUsage } from '@shared/data'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { t } from '@shared/i18n'

export const size = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

const demo = !!import.meta.env.VITE_DEMO

/** 设置里的「数据」：用户目录里各类数据的占用、清理，以及导入导出（换电脑时迁移） */
export function DataSection() {
  const [usage, setUsage] = useState<DataUsage>()
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState<DataKind | null>(null)
  const [picked, setPicked] = useState<DataKind[]>(['config', 'projects', 'tasks'])
  const [importing, setImporting] = useState<{ name: string; data: any } | null>(null)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const load = async () => {
    setLoading(true)
    try {
      setUsage(await api.dataUsage())
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const of = (k: DataKind) => usage?.kinds.find((x) => x.id === k)
  const total = usage?.kinds.reduce((n, k) => n + k.bytes, 0) ?? 0

  const clear = async (k: DataKind) => {
    try {
      await api.clearData(k)
      toast.success(t('已清理{name}', { name: DATA_KINDS.find((x) => x.id === k)!.label }))
      // 项目、任务清掉后页面上的列表也要刷新
      if (k === 'projects' || k === 'tasks') setTimeout(() => location.reload(), 600)
      else await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setClearing(null)
    }
  }

  const exportData = async () => {
    setBusy(true)
    try {
      const data = await api.exportData(picked)
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
      const a = document.createElement('a')
      const d = new Date()
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      a.href = URL.createObjectURL(blob)
      a.download = `agent-panel-${t('数据')}-${stamp}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pickFile = async (f: File | undefined) => {
    if (!f) return
    try {
      const data = JSON.parse(await f.text())
      if (data?.app !== 'agent-panel' || !Array.isArray(data.kinds)) throw new Error(t('不是 Agent 面板导出的数据文件'))
      setImporting({ name: f.name, data })
    } catch (e) {
      toast.error(e instanceof SyntaxError ? t('文件不是有效的 JSON') : (e as Error).message)
    }
  }

  const importData = async () => {
    if (!importing) return
    setBusy(true)
    try {
      const r = await api.importData(importing.data)
      toast.success(t('已导入 {n} 个文件，正在刷新', { n: r.files }))
      setTimeout(() => location.reload(), 600)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
      setImporting(null)
    }
  }

  const label = (k: DataKind) => DATA_KINDS.find((x) => x.id === k)!.label

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <p className="text-[13px] leading-relaxed text-subtle">
          {t('面板的配置、项目、任务记录都保存在用户目录下，和 ~/.codex、~/.claude 一样，升级或换安装位置都不受影响。')}
        </p>
        <div className="flex items-center gap-2 rounded-xl border bg-field/50 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]" title={usage?.dir}>
            {usage?.dir ?? '…'}
          </span>
          {!demo && (
            <Button variant="ghost" size="sm" onClick={() => api.revealData().catch((e) => toast.error(e.message))}>
              <FolderOpen className="h-3.5 w-3.5" />
              {t('打开')}
            </Button>
          )}
        </div>
      </section>

      <section className="flex flex-col">
        <div className="flex items-center pb-2">
          <h3 className="text-[13px] font-semibold">{t('占用')}</h3>
          <span className="ml-2 text-xs text-subtle">
            {t('共 {size}', { size: size(total) })}
            {usage && ` · ${t('面板进程内存 {size}', { size: size(usage.memory.rss) })}`}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label={t('刷新占用')}
            onClick={load}
            disabled={loading}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
        <div className="overflow-hidden rounded-xl border">
          {DATA_KINDS.map((k) => {
            const u = of(k.id)
            return (
              <div key={k.id} className="flex items-center gap-3 border-b px-3.5 py-3 last:border-b-0">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13.5px]">{k.label}</span>
                  <span className="text-xs leading-relaxed text-subtle">{k.hint}</span>
                </span>
                <span className="shrink-0 text-right font-mono text-[12.5px] text-muted">
                  {u ? size(u.bytes) : '…'}
                  <span className="block text-[11px] text-subtle">{u ? t('{n} 个文件', { n: u.files }) : ''}</span>
                </span>
                {k.clearable ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    disabled={!u?.files}
                    onClick={() => setClearing(k.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('清理')}
                  </Button>
                ) : (
                  <span className="w-[68px] shrink-0" />
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-[13px] font-semibold">{t('迁移')}</h3>
        <p className="text-[13px] leading-relaxed text-subtle">
          {t('导出成一个文件，在另一台电脑的设置里导入。导入时，文件里包含的每类数据会整体替换掉这里现有的。')}
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-2.5">
          {DATA_KINDS.filter((k) => k.id !== 'cache').map((k) => (
            <Checkbox
              key={k.id}
              checked={picked.includes(k.id)}
              onChange={(v) => setPicked((p) => (v ? [...p, k.id] : p.filter((x) => x !== k.id)))}
              label={`${k.label}${of(k.id) ? ` · ${size(of(k.id)!.bytes)}` : ''}`}
            />
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={exportData} disabled={busy || !picked.length}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {t('导出数据')}
          </Button>
          <Button variant="secondary" onClick={() => file.current?.click()} disabled={busy}>
            <Upload className="h-3.5 w-3.5" />
            {t('导入数据')}
          </Button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              void pickFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
      </section>

      <ConfirmDialog
        open={!!clearing}
        onOpenChange={(o) => !o && setClearing(null)}
        title={clearing ? t('清理{name}？', { name: label(clearing) }) : ''}
        description={
          clearing === 'projects'
            ? t('会删除所有项目和它们的任务记录。项目目录里的文件不会动。删除后不能恢复，需要的话先导出。')
            : clearing === 'tasks'
              ? t('会删除所有任务记录，包括输出和用量。删除后不能恢复，需要的话先导出。')
              : clearing === 'uploads'
                ? t('会删除任务里附上的文件和图片，任务记录里的附件就打不开了。')
                : t('会删除下载的更新包和损坏文件的备份。')
        }
        onConfirm={() => clearing && clear(clearing)}
      />
      <ConfirmDialog
        open={!!importing}
        onOpenChange={(o) => !o && setImporting(null)}
        title={t('导入数据？')}
        description={
          importing
            ? t('「{name}」包含：{kinds}。这些数据会整体替换成文件里的，导入后页面会刷新。', {
                name: importing.name,
                kinds: (importing.data.kinds as DataKind[]).map(label).join(t('、')),
              })
            : ''
        }
        onConfirm={importData}
      />
    </div>
  )
}
