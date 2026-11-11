import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { tablesApi, type SyncResult, type TablePair } from '@/lib/tables-api'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'

type Mode = 'file' | 'column'

const ACTION: Record<SyncResult['action'], { label: (r: SyncResult) => string; cls: string }> = {
  create: { label: () => t('右边新建'), cls: 'text-(--c-grid-added)' },
  replace: { label: (r) => t('整个替换（差 {n} 格）', { n: r.cells }), cls: 'text-warning' },
  cells: {
    label: (r) =>
      r.missing ? t('改 {n} 格（右边少 {m} 行，不加）', { n: r.cells, m: r.missing }) : t('改 {n} 格', { n: r.cells }),
    cls: 'text-warning',
  },
  same: { label: () => t('已经一样'), cls: 'text-subtle' },
  skip: { label: (r) => r.error ?? t('跳过'), cls: 'text-danger' },
}

/**
 * 跨项目批量同步：勾选几个文件，整文件（字节原样拷到右边，没有就新建）或只同步一列（按主键改右边已有的行）。
 * 先预览每个文件会怎样，再确认写入；写之前都备份，失败的文件单独列出原因
 */
export function BatchSyncDialog({
  left,
  right,
  pairs,
  onDone,
  onClose,
}: {
  left: { id: string; name: string }
  right: { id: string; name: string }
  pairs: TablePair[]
  onDone: () => void
  onClose: () => void
}) {
  const cands = pairs.filter((p) => p.status === 'diff' || p.status === 'left')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<Mode>('file')
  const [field, setField] = useState('')
  const [preview, setPreview] = useState<SyncResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const items = cands.filter((p) => picked.has(p.path)).map(({ path, left, right }) => ({ path, left, right }))
  const run = async (apply: boolean) => {
    setBusy(true)
    try {
      const { results } = await tablesApi.sync(left.id, { other: right.id, items, mode, field, apply })
      if (!apply) return setPreview(results)
      const failed = results.filter((r) => r.action === 'skip')
      const done = results.filter((r) => r.action !== 'skip' && r.action !== 'same').length
      if (failed.length) {
        setPreview(results)
        toast.error(t('同步了 {n} 个文件，{m} 个失败，原因见列表', { n: done, m: failed.length }))
      } else {
        toast.success(t('已同步 {n} 个文件到 {name}', { n: done, name: right.name }))
        onClose()
      }
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const reset = () => setPreview(null)
  const toWrite = preview?.filter((r) => r.action !== 'skip' && r.action !== 'same').length ?? 0
  return (
    <Modal
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title={t('批量同步到 {name}', { name: right.name })}
      size="lg"
      footer={
        <>
          <span className="mr-auto text-footnote text-subtle">
            {preview
              ? t('{n} 个文件会被改，写之前都会备份', { n: toWrite })
              : t('选了 {n} 个文件', { n: items.length })}
          </span>
          <Button variant="secondary" disabled={busy} onClick={preview ? reset : onClose}>
            {preview ? t('返回修改') : t('取消')}
          </Button>
          {preview ? (
            <Button disabled={busy || !toWrite} onClick={() => void run(true)}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('同步 {n} 个文件', { n: toWrite })}
            </Button>
          ) : (
            <Button
              disabled={busy || !items.length || (mode === 'column' && !field.trim())}
              onClick={() => void run(false)}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('预览')}
            </Button>
          )}
        </>
      }
    >
      {preview ? (
        <div role="list" aria-label={t('同步预览')} className="thin-scroll flex max-h-[420px] flex-col overflow-y-auto">
          {preview.map((r) => (
            <div role="listitem" key={r.path} className="flex items-center gap-3 border-b px-1 py-1.5 last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-body" title={r.path}>
                {r.path}
              </span>
              <span className={cn('max-w-[55%] shrink-0 truncate text-caption', ACTION[r.action].cls)} title={r.error}>
                {ACTION[r.action].label(r)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-caption text-subtle">{t('从 {l} 同步到 {r}。', { l: left.name, r: right.name })}</p>
          <Segmented
            label={t('同步什么')}
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { id: 'file', label: t('整个文件') },
              { id: 'column', label: t('只同步一列') },
            ]}
          />
          {mode === 'column' && (
            <Field label={t('字段名')} tip={t('按主键对行，只改右边已有的行；右边没有的行不加')}>
              <Input value={field} onChange={(e) => setField(e.target.value)} className="font-mono" placeholder="HP" />
            </Field>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              checked={items.length > 0 && items.length === cands.length}
              onChange={(on) => setPicked(on ? new Set(cands.map((p) => p.path)) : new Set())}
              label={t('全选（{n} 个有差异或只在左边的文件）', { n: cands.length })}
            />
          </div>
          <div
            role="list"
            aria-label={t('要同步的文件')}
            className="thin-scroll flex max-h-[320px] flex-col overflow-y-auto rounded-(--c-row-radius) border p-1"
          >
            {cands.map((p) => (
              <div role="listitem" key={p.path} className="px-1.5 py-1">
                <Checkbox
                  checked={picked.has(p.path)}
                  onChange={(on) =>
                    setPicked((s) => {
                      const n = new Set(s)
                      if (on) n.add(p.path)
                      else n.delete(p.path)
                      return n
                    })
                  }
                  label={`${p.path}${p.status === 'left' ? ` · ${t('只在左边')}` : ''}`}
                />
              </div>
            ))}
            {!cands.length && <p className="p-3 text-center text-footnote text-subtle">{t('没有要同步的文件')}</p>}
          </div>
        </div>
      )}
    </Modal>
  )
}
