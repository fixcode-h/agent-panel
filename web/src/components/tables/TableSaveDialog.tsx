import { useState } from 'react'
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react'
import { t } from '@shared/i18n'
import { applyRowOps, cellRef, type SheetEdit } from '@shared/table-edit'
import type { SheetData } from '@shared/files'
import type { TableDoc } from '@shared/tables'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** 列表里最多列这么多处改动 */
const SHOW = 200

/**
 * 保存确认：列出每张表改了哪些格子（旧值 → 新值）、插删了几行，说明保存只改这些格子的值、格式不变。
 * 保存失败（文件正被打开、外面改过、表里有公式不能插删行……）把原因显示在这里，不悄悄重试；
 * 外面改过且只改了格子时，可以选「只写我改的格子」
 */
export function TableSaveDialog({
  open,
  doc,
  sheets,
  pending,
  problems = [],
  mode = 'warn',
  onCancel,
  onSave,
}: {
  /** 改到的格子里不合规的（当前工作表），按项目设置的「保存前检查」提醒或拦下 */
  problems?: { r: number; c: number; msg: string; field: string }[]
  mode?: 'off' | 'warn' | 'block'
  open: boolean
  doc: TableDoc
  /** 现在页面上的各张表（取新值） */
  sheets: Record<string, string[][]>
  pending: SheetEdit[]
  onCancel: () => void
  onSave: (force: boolean) => Promise<string | null>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; canForce: boolean } | null>(null)
  const base = (name: string): SheetData | undefined => doc.sheets.find((s) => s.name === name)
  const cells = pending.reduce((n, s) => n + s.cells.length, 0)
  const shown = mode === 'off' ? [] : problems
  const blocked = mode === 'block' && shown.length > 0
  const save = async (force: boolean) => {
    setBusy(true)
    setError(null)
    const err = await onSave(force)
    setBusy(false)
    if (err) setError({ text: err, canForce: /被改过/.test(err) && pending.every((s) => !s.rows.length) })
  }
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && !busy && onCancel()}
      title={t('保存 {name}', { name: doc.path.slice(doc.path.lastIndexOf('/') + 1) })}
      size="md"
      footer={
        <>
          <span className="mr-auto text-footnote text-subtle">{t('{n} 个格子', { n: cells })}</span>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t('取消')}
          </Button>
          {error?.canForce && (
            <Button variant="secondary" onClick={() => void save(true)} disabled={busy}>
              {t('只写我改的格子')}
            </Button>
          )}
          <Button onClick={() => void save(false)} disabled={busy || blocked}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('保存')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="flex gap-2 rounded-lg bg-sel px-3 py-2.5 text-footnote leading-relaxed text-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          {doc.kind === 'csv'
            ? t('只改下面这些格子的值，分隔符、换行、编码照原样。保存前原文件会备份到数据目录。')
            : t(
                '只改下面这些格子的值，样式、公式、其它工作表、图片都原样保留，文件仍是原来的 Excel / WPS 格式。保存前原文件会备份到数据目录。',
              )}
        </p>
        {shown.length > 0 && (
          <div
            role="alert"
            className={cn(
              'flex flex-col gap-1 rounded-lg px-3 py-2.5 text-footnote',
              blocked ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning',
            )}
          >
            <p className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {blocked
                ? t('改到的格子里有 {n} 处不合规，项目设置里定了不合规就不让保存', { n: shown.length })
                : t('改到的格子里有 {n} 处不合规，仍然可以保存', { n: shown.length })}
            </p>
            {shown.slice(0, 6).map((p) => (
              <p key={`${p.r}:${p.c}:${p.msg}`} className="flex gap-2 font-mono text-caption">
                <span className="w-12 shrink-0 opacity-70">{cellRef(p.r, p.c)}</span>
                <span className="w-32 shrink-0 truncate opacity-80">{p.field}</span>
                <span className="min-w-0 flex-1 truncate font-sans">{p.msg}</span>
              </p>
            ))}
            {shown.length > 6 && <p className="text-caption opacity-80">{t('还有 {n} 处', { n: shown.length - 6 })}</p>}
          </div>
        )}
        {error && (
          <p className="rounded-lg bg-danger/10 px-3 py-2.5 text-body leading-relaxed text-danger">{error.text}</p>
        )}
        <div className="max-h-[50vh] overflow-auto rounded-lg border">
          {pending.map((s) => {
            // 旧值按做完行操作之后的位置取：插删过行时行号对得上
            const old = applyRowOps(base(s.name)?.rows ?? [], s.rows)
            const now = sheets[s.name] ?? []
            const ins = s.rows.filter((o) => o.n > 0).reduce((n, o) => n + o.n, 0)
            const del = s.rows.filter((o) => o.n < 0).reduce((n, o) => n - o.n, 0)
            return (
              <section key={s.name} className="border-b last:border-b-0">
                <header className="flex items-center gap-2 bg-panel px-3 py-1.5 text-footnote font-medium">
                  {s.name}
                  {ins > 0 && <Badge tone="accent">{t('插入 {n} 行', { n: ins })}</Badge>}
                  {del > 0 && <Badge tone="warning">{t('删除 {n} 行', { n: del })}</Badge>}
                </header>
                <table className="w-full text-footnote">
                  <tbody>
                    {s.cells.slice(0, SHOW).map((c) => (
                      <tr key={`${c.r}:${c.c}`} className="border-t">
                        <td className="w-16 px-3 py-1 font-mono text-subtle">{cellRef(c.r, c.c)}</td>
                        <td className="max-w-0 truncate px-2 py-1 text-subtle line-through" title={old[c.r]?.[c.c]}>
                          {old[c.r]?.[c.c] ?? ''}
                        </td>
                        <td className="max-w-0 truncate px-2 py-1 text-fg" title={now[c.r]?.[c.c]}>
                          {c.v || <span className="text-subtle">{t('（清空）')}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {s.cells.length > SHOW && (
                  <p className="px-3 py-1.5 text-caption text-subtle">
                    {t('还有 {n} 处', { n: s.cells.length - SHOW })}
                  </p>
                )}
              </section>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
