import { useEffect, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { Download, FolderOpen, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react'
import { DATA_KINDS, EXPORTABLE_KINDS, type DataKind, type DataUsage } from '@shared/data'
import { MEMORY_ASK, MEMORY_TOPIC, formatBytes, formatSampleTime, formatUptime, memoryReport } from '@shared/memory'
import { pad2 } from '@shared/datetime'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useData } from '@/lib/data'
import type { FixIssue } from '@/lib/ai-fix'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Select } from '@/components/ui/input'
import { AiFixButton } from '@/components/ui/ai-fix'
import { Card } from '@/components/ui/card'
import { MemoryChart } from '@/components/settings/MemoryChart'
import { TrashSection } from '@/components/settings/TrashSection'
import { CleanupSection } from '@/components/settings/CleanupSection'
import { KeepAliveList } from '@/components/settings/KeepAliveList'
import { TaskDiskUsage } from '@/components/settings/TaskDiskUsage'
import { t } from '@shared/i18n'

/** 和共享的格式化保持一致：数据占用、内存都按同一套单位显示 */
export const size = formatBytes

const demo = !!import.meta.env.VITE_DEMO

/** 设置里的「数据」：用户目录里各类数据的占用、清理，以及导入导出（换电脑时迁移） */
export function DataSection() {
  const [usage, setUsage] = useState<DataUsage>()
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState<DataKind | null>(null)
  const [picked, setPicked] = useState<DataKind[]>(['config', 'projects', 'tasks'])
  // 对话占用里删掉的进了回收站，换个 key 让回收站重新读
  const [trashKey, setTrashKey] = useState(0)
  const [importing, setImporting] = useState<{ name: string; data: any } | null>(null)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const { settings, setSettings } = useData()
  /** 内存采样定时刷新失败的原因：显示出来，不悄悄一直重试 */
  const [memoryError, setMemoryError] = useState('')
  /** 刷新一次就换一个值：定时刷新的 effect 依赖它，点「刷新占用」能重新开始（失败后定时器已经停了） */
  const [memoryRestart, setMemoryRestart] = useState(0)

  const load = async () => {
    setLoading(true)
    try {
      setUsage(await api.dataUsage())
      // 这次拉成功了就清掉上次的错误，并让下面的定时刷新重新起来：否则失败一次后定时器一直停着、错误也永远留着
      setMemoryError('')
      setMemoryRestart((n) => n + 1)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  // 内存曲线按采样间隔刷新：只拉内存这一块（/data/memory），不把数据目录整个再 stat 一遍。
  // 失败就停下并显示原因，不悄悄重试；用户点右上角的刷新可以重新开始
  const intervalMs = usage?.sampling.intervalMs
  useEffect(() => {
    if (!intervalMs) return
    let stopped = false
    let id: ReturnType<typeof setInterval> | undefined
    const tick = async () => {
      try {
        const m = await api.memoryUsage()
        if (!stopped) setUsage((u) => (u ? { ...u, ...m } : u))
      } catch (e) {
        if (stopped) return
        stopped = true
        if (id) clearInterval(id)
        setMemoryError((e as Error).message)
      }
    }
    id = setInterval(() => void tick(), intervalMs)
    return () => {
      stopped = true
      if (id) clearInterval(id)
    }
  }, [intervalMs, memoryRestart])

  const of = (k: DataKind) => usage?.kinds.find((x) => x.id === k)
  const total = usage?.kinds.reduce((n, k) => n + k.bytes, 0) ?? 0

  /** 采样间隔改完，服务端下一次采样就用新的；界面上的说明马上跟着变 */
  const saveInterval = async (seconds: number) => {
    if (!settings || seconds === settings.memorySampleSeconds) return
    try {
      setSettings(await api.saveSettings({ ...settings, memorySampleSeconds: seconds }))
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  /** 「AI 分析」：这段采样和趋势交给本机 CLI 体检，结论在弹窗里聊，对话留在聊天列表 */
  const memoryIssue = (u: DataUsage): FixIssue => ({
    title: t('面板内存分析'),
    topic: MEMORY_TOPIC,
    ask: MEMORY_ASK,
    context: memoryReport(u),
  })

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
      const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
      a.href = URL.createObjectURL(blob)
      a.download = `agent-panel-${t('数据')}-${stamp}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
      const skipped = (data as { skipped?: string[] }).skipped ?? []
      if (skipped.length)
        toast.warning(
          t('{n} 个文件导出时正在写入或刚被删除，没放进备份：{files}', {
            n: skipped.length,
            files: skipped.slice(0, 3).join('、'),
          }),
        )
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
        <p className="text-[0.8125rem] leading-relaxed text-subtle">
          {t('面板的配置、项目、任务记录都保存在用户目录下，和 ~/.codex、~/.claude 一样，升级或换安装位置都不受影响。')}
        </p>
        <div className="flex items-center gap-2 rounded-xl bg-sel/40 px-3.5 py-2.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]" title={usage?.dir}>
            {usage?.dir ?? '…'}
          </span>
          {!demo && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                api
                  .revealData()
                  .then((r) => toast.success(t('已在文件夹中打开：{dir}', { dir: r.dir })))
                  .catch((e) => toast.error((e as Error).message))
              }
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t('打开')}
            </Button>
          )}
        </div>
      </section>

      {usage?.logs && (
        // 运行日志：出了问题把这个文件夹里最新的文件发出来
        <section className="flex flex-col gap-2">
          <div className="flex items-center">
            <h3 className="text-[0.8125rem] font-semibold">{t('运行日志')}</h3>
            <span className="ml-2 text-xs text-subtle">
              {t('{n} 个文件 · {size}', { n: usage.logs.files, size: size(usage.logs.bytes) })}
            </span>
          </div>
          <p className="text-[0.8125rem] leading-relaxed text-subtle">
            {t(
              '报错和关键操作都记在这里。每次启动写一个新文件，单个文件超过 5 MB 换下一个，只保留最近 30 个。遇到问题时把最新的日志文件发出来就能查原因。',
            )}
          </p>
          <div className="flex items-center gap-2 rounded-xl bg-sel/40 px-3.5 py-2.5">
            <span
              className="min-w-0 flex-1 truncate font-mono text-[0.8125rem]"
              title={usage.logs.current || usage.logs.dir}
            >
              {usage.logs.current || usage.logs.dir}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                api
                  .revealLogs()
                  .then((r) => toast.success(t('已在文件夹中打开：{dir}', { dir: r.dir })))
                  .catch((e) => toast.error((e as Error).message))
              }
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t('打开')}
            </Button>
          </div>
        </section>
      )}

      <section className="flex flex-col">
        <div className="flex items-center pb-2">
          <h3 className="text-[0.8125rem] font-semibold">{t('占用')}</h3>
          <span className="ml-2 text-xs text-subtle">{t('共 {size}', { size: size(total) })}</span>
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
        <Card className="overflow-hidden">
          {DATA_KINDS.map((k) => {
            const u = of(k.id)
            return (
              <div key={k.id} className="flex items-center gap-3 border-b px-3.5 py-3 last:border-b-0">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[0.8125rem]">{k.label}</span>
                  <span className="text-xs leading-relaxed text-subtle">{k.hint}</span>
                </span>
                <span className="shrink-0 text-right font-mono text-[0.75rem] text-muted">
                  {u ? size(u.bytes) : '…'}
                  <span className="block text-[0.6875rem] text-subtle">{u ? t('{n} 个文件', { n: u.files }) : ''}</span>
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
        </Card>
      </section>

      {/* 对话记录按项目、父子对话的磁盘占用，很久没动的可以批量删（进回收站） */}
      {!demo && (
        <TaskDiskUsage
          onChanged={() => {
            void load()
            setTrashKey((k) => k + 1)
          }}
        />
      )}

      {/* 回收站：删掉的对话先放 7 天，这里能恢复或永久删除 */}
      <TrashSection key={trashKey} />

      {/* 内存：面板自己的进程 + 它拉起的 CLI 子进程，按采样间隔画曲线；AI 分析把这份采样交给本机 CLI 体检 */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[0.8125rem] font-semibold">{t('内存')}</h3>
          {usage && (
            <span className="text-xs text-subtle">
              {t('合计 {total} · 面板 {panel} · 进程 {child}', {
                total: formatBytes(usage.memory.rss + (usage.memory.child ?? 0)),
                panel: formatBytes(usage.memory.rss),
                child:
                  usage.memory.child === null
                    ? t('{n} 个未采集', { n: usage.child.processes })
                    : usage.child.processes === 0
                      ? // 0 个进程是真实的 0，但写成「0 B」会被当成采集失败（就是之前「进程 0 MB」那个观感）
                        t('没有子进程')
                      : formatBytes(usage.memory.child),
              })}
            </span>
          )}
          <AiFixButton
            className="ml-auto"
            label={t('AI 分析')}
            title={t('把这次的内存采样交给 AI 分析有没有问题、怎么优化')}
            disabled={!usage}
            issue={() => (usage ? memoryIssue(usage) : { title: t('面板内存分析') })}
          />
        </div>
        {usage ? (
          <>
            <MemoryChart samples={usage.samples} />
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
              <span>{t('每 {n} 秒采样一次', { n: Math.round(usage.sampling.intervalMs / 1000) })}</span>
              <span>·</span>
              <span>{t('最近一次采样 {time}', { time: formatSampleTime(usage.memory.at) })}</span>
              <span>·</span>
              <span>{t('已运行 {time}', { time: formatUptime(usage.uptimeMs) })}</span>
              <Select
                className="ml-auto h-7 w-[112px] text-xs"
                aria-label={t('采样间隔')}
                value={String(settings?.memorySampleSeconds ?? 30)}
                onChange={(e) => void saveInterval(Number(e.target.value))}
                options={[
                  { value: '10', label: t('每 10 秒') },
                  { value: '30', label: t('每 30 秒') },
                  { value: '60', label: t('每 1 分钟') },
                  { value: '300', label: t('每 5 分钟') },
                ]}
              />
            </div>
            {memoryError && (
              <p className="text-xs leading-relaxed text-danger">
                {t('刷新内存采样失败：{msg}', { msg: memoryError })}
              </p>
            )}
          </>
        ) : (
          <p className="text-[0.8125rem] leading-relaxed text-subtle">{t('正在读取内存…')}</p>
        )}
        <p className="text-[0.8125rem] leading-relaxed text-subtle">
          {t(
            '「面板」是面板服务这个本机 Node 进程自己的内存，「进程」是它拉起的编码 Agent（运行中的任务）合计占用；读不到时显示「未采集」，不会当成 0。曲线按上面的间隔记点、保留最近两小时，在曲线上按住右键左右拖动可以往前看，拖到最右边回到最新。',
          )}
        </p>
        <KeepAliveList />
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-[0.8125rem] font-semibold">{t('迁移')}</h3>
        <p className="text-[0.8125rem] leading-relaxed text-subtle">
          {t('导出成一个文件，在另一台电脑的设置里导入。导入时，文件里包含的每类数据会整体替换掉这里现有的。')}
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-2.5">
          {EXPORTABLE_KINDS.map((k) => (
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

      {/* 清理：对话工作目录、失效的独立分支、构建产物（都在末尾，不挤在占用表和迁移之间） */}
      <CleanupSection onCleared={load} />

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
