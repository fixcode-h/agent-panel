import { useMemo, useState } from 'react'
import { t } from '@shared/i18n'
import { cellRef, type CellSet } from '@shared/table-edit'
import { batchEdit, type BatchOp } from '@shared/table-batch'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Segmented } from '@/components/ui/segmented'

/** 预览最多列这么多格 */
const PREVIEW = 200

type Kind = BatchOp['kind']

/**
 * 批量修改选中的格子：加减乘除、前后缀、正则替换、按序列重新编号。
 * 下面实时预览每一格从什么改成什么；「放进表格」一次放进去，Ctrl+Z 一步撤销
 */
export function BatchEditDialog({
  rows,
  cells,
  onApply,
  onClose,
}: {
  rows: string[][]
  /** 选中的格子（按显示顺序，表头和隐藏的列已去掉） */
  cells: { r: number; c: number }[]
  onApply: (cells: CellSet[]) => void
  onClose: () => void
}) {
  const [kind, setKind] = useState<Kind>('math')
  const [fn, setFn] = useState<'+' | '-' | '*' | '/'>('+')
  const [n, setN] = useState('1')
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState('')
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [start, setStart] = useState('1')
  const [step, setStep] = useState('1')
  const num = (s: string) => (s.trim() && Number.isFinite(Number(s)) ? Number(s) : NaN)
  const result = useMemo(() => {
    try {
      const op: BatchOp | null =
        kind === 'math'
          ? Number.isNaN(num(n))
            ? null
            : { kind, fn, n: num(n) }
          : kind === 'affix'
            ? { kind, prefix, suffix }
            : kind === 'regex'
              ? { kind, find, replace }
              : Number.isNaN(num(start)) || Number.isNaN(num(step))
                ? null
                : { kind, start: num(start), step: num(step) }
      return { cells: op ? batchEdit(rows, cells, op) : [], error: '' }
    } catch (e) {
      return { cells: [], error: (e as Error).message }
    }
  }, [kind, fn, n, prefix, suffix, find, replace, start, step, rows, cells])
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('批量修改（选中 {n} 格）', { n: cells.length })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button
            disabled={!result.cells.length}
            onClick={() => {
              onApply(result.cells)
              onClose()
            }}
          >
            {t('放进表格（{n} 格）', { n: result.cells.length })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Segmented
          label={t('怎么改')}
          value={kind}
          onChange={(v) => setKind(v as Kind)}
          options={[
            { id: 'math', label: t('加减乘除') },
            { id: 'affix', label: t('前后缀') },
            { id: 'regex', label: t('正则替换') },
            { id: 'renumber', label: t('重新编号') },
          ]}
        />
        {kind === 'math' && (
          <div className="flex items-end gap-2">
            <Field label={t('运算')}>
              <Select
                size="sm"
                value={fn}
                onChange={(e) => setFn(e.target.value as typeof fn)}
                options={[
                  { value: '+', label: t('加 +') },
                  { value: '-', label: t('减 −') },
                  { value: '*', label: t('乘 ×') },
                  { value: '/', label: t('除 ÷') },
                ]}
              />
            </Field>
            <Field label={t('数')}>
              <Input size="sm" value={n} onChange={(e) => setN(e.target.value)} inputMode="decimal" />
            </Field>
          </div>
        )}
        {kind === 'affix' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('前缀')}>
              <Input size="sm" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
            </Field>
            <Field label={t('后缀')}>
              <Input size="sm" value={suffix} onChange={(e) => setSuffix(e.target.value)} />
            </Field>
          </div>
        )}
        {kind === 'regex' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('查找（正则）')}>
              <Input size="sm" value={find} onChange={(e) => setFind(e.target.value)} className="font-mono" />
            </Field>
            <Field label={t('替换为（$1 引用分组）')}>
              <Input size="sm" value={replace} onChange={(e) => setReplace(e.target.value)} className="font-mono" />
            </Field>
          </div>
        )}
        {kind === 'renumber' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('从几开始')}>
              <Input size="sm" value={start} onChange={(e) => setStart(e.target.value)} inputMode="decimal" />
            </Field>
            <Field label={t('每次加')}>
              <Input size="sm" value={step} onChange={(e) => setStep(e.target.value)} inputMode="decimal" />
            </Field>
          </div>
        )}
        {result.error ? (
          <p className="text-footnote text-danger">{result.error}</p>
        ) : (
          <div
            aria-label={t('批量修改预览')}
            className="thin-scroll max-h-[40vh] overflow-y-auto rounded-md border text-footnote"
          >
            {result.cells.length === 0 && (
              <p className="px-3 py-3 text-subtle">
                {kind === 'math' ? t('选中的格子里没有能算的数字') : t('没有要改的格子')}
              </p>
            )}
            {result.cells.slice(0, PREVIEW).map((x) => (
              <div key={`${x.r}:${x.c}`} className="flex h-7 items-center gap-3 border-b px-3 last:border-b-0">
                <span className="w-14 shrink-0 font-mono text-subtle">{cellRef(x.r, x.c)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-muted">{rows[x.r]?.[x.c] || '—'}</span>
                <span className="text-subtle">→</span>
                <span className="min-w-0 flex-1 truncate font-mono text-success">{x.v || t('（空）')}</span>
              </div>
            ))}
            {result.cells.length > PREVIEW && (
              <p className="px-3 py-1.5 text-caption text-subtle">
                {t('还有 {n} 格', { n: result.cells.length - PREVIEW })}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
