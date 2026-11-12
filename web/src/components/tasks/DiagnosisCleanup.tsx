import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { Diagnosis } from '@shared/bug/diagnosis-schema'
import { failedSummary } from '@shared/bug/diagnosis'
import { failedText } from '@shared/bug/cleanup'
import type { Task } from '@shared/schema'
import { api } from '@/lib/api'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

type Preview = Awaited<ReturnType<typeof api.cleanupPreview>>

/**
 * 「取消修复」确认框（用户 2026-11-10 定）：面板只读地查出代码里的 `[排查-` 临时日志列出来，确认后由 Agent 删、
 * 面板核对干净再关闭报告；为排查新建的文件默认保留，勾上才一起删；共用目录里已经修完的，可以勾「修复也撤掉」
 */
export function useCancelCleanup(taskId: string, verifying: boolean) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [drop, setDrop] = useState<string[]>([])
  const [revertFix, setRevertFix] = useState(false)
  const ask = () => {
    setPreview(null)
    setDrop([])
    setRevertFix(false)
    api
      .cleanupPreview(taskId)
      .then(setPreview)
      // 查不了（导入的对话、目录已删）就按没有日志处理：确认框照常能点
      .catch(() => setPreview({ found: [], created: [], isolated: false }))
  }
  const found = preview?.found ?? []
  const description = !preview
    ? t('正在查代码里的临时日志…')
    : found.length
      ? t(
          '这份诊断报告不再等你确认。代码里还有 {k} 处 [排查-…] 临时日志，确认后它会一处一处删掉（连加日志时带进来的空行），面板核对干净后才关闭报告；之后不会再改别的文件。真要修就在父对话里重新报这个 Bug。',
          { k: found.length },
        )
      : t(
          '这份诊断报告就此关闭：代码里没有临时日志，计划标记为完成，之后不会再改文件，这个对话也不能再交新的报告（真要修就在父对话里重新报这个 Bug）。',
        )
  const extra =
    preview && (found.length || preview.created.length || (verifying && !preview.isolated)) ? (
      <div className="flex flex-col gap-3 text-body">
        {found.length > 0 && (
          <div>
            <div className="mb-1 text-caption text-muted">{t('要删的临时日志')}</div>
            <ul className="max-h-40 overflow-y-auto rounded-md bg-panel px-2 py-1.5 font-mono text-caption">
              {found.map((x) => (
                <li key={`${x.file}:${x.line}`} className="truncate" title={`${x.file}:${x.line}  ${x.text.trim()}`}>
                  <span className="text-muted">
                    {x.file}:{x.line}
                  </span>{' '}
                  {x.text.trim()}
                </li>
              ))}
            </ul>
            {preview.isolated && (
              <p className="mt-1.5 text-caption text-warning">
                {t('这些日志加在它的独立分支里。你照复现步骤在自己的工作区里加过同样几行的话，记得自己删掉。')}
              </p>
            )}
          </div>
        )}
        {preview.created.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="text-caption text-muted">{t('为排查新建的文件（默认保留，勾上一起删）')}</div>
            {preview.created.map((f) => (
              <Checkbox
                key={f}
                checked={drop.includes(f)}
                onChange={(v) => setDrop((d) => (v ? [...d, f] : d.filter((x) => x !== f)))}
                label={<span className="font-mono text-caption">{f}</span>}
              />
            ))}
          </div>
        )}
        {verifying && !preview.isolated && (
          <Checkbox
            checked={revertFix}
            onChange={setRevertFix}
            label={t('修复也撤掉')}
            hint={t('改动就在你的工作区里：勾上后它把方案里的改动也改回去，文件回到加日志之前的样子')}
          />
        )}
      </div>
    ) : undefined
  return { ask, description, extra, drop, revertFix, loading: !preview }
}

/** 取消修复后删临时日志的进度：在删、删干净了、没删干净（用户选再删一次 / 自己删） */
export function CleanupStatus({
  task,
  d,
  onDone,
}: {
  task: Pick<Task, 'id'>
  d: Diagnosis
  onDone?: (t: Task) => void
}) {
  const [busy, setBusy] = useState<'' | 'retry' | 'finish'>('')
  const c = d.cleanup
  if (!c || d.status !== 'cancelled') return null
  const act = async (action: 'retry' | 'finish') => {
    setBusy(action)
    try {
      const r = await api.cleanupAction(task.id, action)
      const next = r.message ? await api.sendMessage(task.id, r.message, []) : r.task
      onDone?.(next)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const tone = { running: 'text-muted', done: 'text-success', failed: 'text-danger', skipped: 'text-muted' }[c.state]
  const text = {
    running: t('正在删 {k} 处临时日志，删完面板核对干净后关闭报告', { k: c.found.length }),
    done: t('临时日志已删干净（{k} 处），报告已关闭', { k: c.found.length }),
    failed: t('临时日志没删干净：{text}', { text: failedSummary(c) }),
    skipped: t('你选了不让它再删，报告已关闭'),
  }[c.state]
  return (
    <div className="mb-3 rounded-lg border border-line bg-card px-3 py-2 text-body">
      <div className={cn('flex items-center gap-2', tone)}>
        {c.state === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        <span>{text}</span>
      </div>
      {c.state === 'failed' && (
        <>
          <pre className="mt-2 max-h-40 overflow-y-auto rounded-md bg-panel px-2 py-1.5 font-mono text-caption whitespace-pre-wrap">
            {failedText(c.failed)}
          </pre>
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void act('finish')}>
              {busy === 'finish' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('我自己处理，关闭报告')}
            </Button>
            <Button size="sm" disabled={!!busy} onClick={() => void act('retry')}>
              {busy === 'retry' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('让它再删一次')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
