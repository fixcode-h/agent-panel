import { useCallback, useEffect, useState } from 'react'
import { GitCommitHorizontal, GitMerge, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import type { TableDoc, TableSchema } from '@shared/tables'
import type { MergeResult } from '@shared/table-merge'
import { tablesApi, type MergeSources, type VcsStatus } from '@/lib/tables-api'
import { toast } from '@/lib/toast'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Field, Textarea } from '@/components/ui/input'
import { MergeDialog } from './MergeDialog'
import { cn } from '@/lib/utils'

const NAME: Record<string, string> = { git: 'Git', p4: 'P4', svn: 'SVN' }

/** 这个文件的版本状态：打开、保存（修改时间变了）后重新取 */
export function useVcsStatus(projectId: string, doc: TableDoc) {
  const [st, setSt] = useState<VcsStatus | null>(null)
  const refresh = useCallback(() => {
    tablesApi
      .vcsStatus(projectId, doc.path)
      .then(setSt)
      .catch(() => setSt(null))
  }, [projectId, doc.path])
  useEffect(() => {
    refresh()
    // 保存、切版本后修改时间会变：跟着重新取
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, doc.mtime])
  return [st, setSt, refresh] as const
}

/** 表头栏上的「提交」：只提交这一个文件，写一句说明 */
export function SubmitButton({
  projectId,
  doc,
  status,
  dirty,
  onDone,
}: {
  projectId: string
  doc: TableDoc
  status: VcsStatus | null
  dirty: boolean
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!status || status.vcs === 'none' || !status.changed || status.conflict) return null
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await tablesApi.vcsSubmit(projectId, doc.path, msg)
      toast.success(t('已提交到 {vcs}', { vcs: NAME[status.vcs] ?? status.vcs }))
      setOpen(false)
      setMsg('')
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-7"
        disabled={dirty}
        title={dirty ? t('先保存再提交') : t('只提交这一个文件')}
        onClick={() => setOpen(true)}
      >
        <GitCommitHorizontal className="h-3.5 w-3.5" />
        {t('提交')}
      </Button>
      {open && (
        <Modal
          open
          onOpenChange={(o) => !o && !busy && setOpen(false)}
          title={t('提交 {file}', { file: doc.path.replace(/^.*\//, '') })}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                {t('取消')}
              </Button>
              <Button disabled={busy || !msg.trim()} onClick={() => void submit()}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('提交')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Field
              label={t('提交说明')}
              tip={
                status.vcs === 'git'
                  ? t('只提交这个文件到本地仓库，不推送；暂存区里别的文件不受影响')
                  : status.vcs === 'p4'
                    ? t('没签出的会先 p4 reconcile，再 p4 submit 这一个文件')
                    : t('svn commit 这一个文件，新文件会先 svn add')
              }
            >
              <Textarea autoFocus rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} />
            </Field>
            {error && <p className="text-footnote text-danger">{error}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}

/**
 * 有冲突时表格上方的提示条：「合并冲突」打开三方合并；合并结果保存后「标记已解决」。
 * 合并前页面上不能有没保存的改动（合并是在本地文件上做的）
 */
export function ConflictBar({
  projectId,
  doc,
  schema,
  status,
  dirty,
  readOnly,
  onReload,
  onMerged,
  onStatus,
}: {
  projectId: string
  doc: TableDoc
  schema: TableSchema
  status: VcsStatus | null
  dirty: boolean
  readOnly: boolean
  /** 工作区文件被换成干净的我这边后重新载入；载入完成后 resolve */
  onReload: () => Promise<TableDoc | undefined>
  onMerged: (r: MergeResult) => void
  onStatus: (s: VcsStatus) => void
}) {
  const [src, setSrc] = useState<(MergeSources & { ours: TableDoc }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [merged, setMerged] = useState(false)
  if (!status?.conflict || readOnly) return null
  const start = async () => {
    setBusy(true)
    try {
      const s = await tablesApi.mergeStart(projectId, doc.path)
      const ours = s.replaced ? await onReload() : doc
      if (!ours) throw new Error(t('重新载入失败'))
      setSrc({ ...s, ours })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const resolve = async () => {
    setBusy(true)
    try {
      onStatus(await tablesApi.vcsResolve(projectId, doc.path))
      toast.success(t('已标记冲突解决'))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      role="alert"
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-footnote',
        merged ? 'bg-warning/8 text-warning' : 'bg-danger/8 text-danger',
      )}
    >
      <GitMerge className="h-3.5 w-3.5 shrink-0" />
      <span className="mr-auto">
        {merged
          ? dirty
            ? t('合并结果已放进表格：看一遍，保存后再标记已解决。')
            : t('合并结果已保存，标记已解决后就能提交了。')
          : t('这个文件有版本冲突（{vcs}）。', { vcs: NAME[status.vcs] ?? status.vcs })}
      </span>
      {!merged && (
        <Button
          size="sm"
          variant="secondary"
          className="h-6"
          disabled={busy || dirty}
          title={dirty ? t('先保存或撤掉页面上的改动') : undefined}
          onClick={() => void start()}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('合并冲突')}
        </Button>
      )}
      <Button
        size="sm"
        variant={merged && !dirty ? 'secondary' : 'ghost'}
        className="h-6"
        disabled={busy || dirty}
        onClick={() => void resolve()}
      >
        {t('标记已解决')}
      </Button>
      {src && (
        <MergeDialog
          schema={schema}
          path={doc.path}
          base={src.base}
          ours={src.ours.sheets}
          theirs={src.theirs}
          theirsLabel={src.theirsLabel}
          onApply={(r) => {
            onMerged(r)
            setMerged(true)
          }}
          onClose={() => setSrc(null)}
        />
      )}
    </div>
  )
}
