import { useDeferredValue, useMemo, useState } from 'react'
import { t } from '@shared/i18n'
import { cellRef, type CellSet } from '@shared/table-edit'
import { findReplace } from '@shared/table-tools'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'

/** 预览最多列这么多处（全部替换照样改全部） */
const PREVIEW = 200

type Scope = 'sel' | 'col' | 'all'

/**
 * 查找替换（Ctrl+H）：在选中区域、当前列或整张表（只算筛选后看得见的数据行，隐藏的列不算）里找，
 * 下面实时列出每处改成什么，「全部替换」一次写进去（一次撤销）
 */
export function FindReplaceDialog({
  rows,
  order,
  cols,
  focusCol,
  selection,
  colName,
  hidden,
  onApply,
  onClose,
}: {
  rows: string[][]
  /** 看得见的数据行 */
  order: number[]
  cols: number
  focusCol: number | undefined
  /** 打开时选中的一块（多于一格时才有「选中区域」） */
  selection: { rows: number[]; cols: number[] } | null
  colName: (c: number) => string
  hidden: Set<number>
  onApply: (cells: CellSet[]) => void
  onClose: () => void
}) {
  const multi = !!selection && selection.rows.length * selection.cols.length > 1
  const [scope, setScope] = useState<Scope>(multi ? 'sel' : focusCol !== undefined ? 'col' : 'all')
  const [find, setFind] = useState('')
  const [repl, setRepl] = useState('')
  const [caseSensitive, setCase] = useState(false)
  const [whole, setWhole] = useState(false)
  const [regex, setRegex] = useState(false)
  // 打字时先不算，停一下再算：大表上每个字都扫一遍会卡
  const q = useDeferredValue({ find, repl, caseSensitive, whole, regex, scope })
  const res = useMemo(() => {
    const visible = new Set(order)
    const allCols = Array.from({ length: cols }, (_, c) => c).filter((c) => !hidden.has(c))
    const [rs, cs] =
      q.scope === 'sel' && selection
        ? [selection.rows.filter((r) => visible.has(r)), selection.cols.filter((c) => !hidden.has(c))]
        : q.scope === 'col' && focusCol !== undefined
          ? [order, [focusCol]]
          : [order, allCols]
    try {
      return { ...findReplace(rows, rs, cs, q.find, q.repl, q), error: '' }
    } catch (e) {
      return { cells: [], truncated: false, error: (e as Error).message }
    }
  }, [q, rows, order, cols, hidden, selection, focusCol])
  const n = res.cells.length
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('查找替换')}
      size="lg"
      footer={
        <>
          <span className="mr-auto text-footnote text-subtle">
            {find ? (res.truncated ? t('超过 {n} 处，只改前 {n} 处', { n }) : t('{n} 处', { n })) : ''}
          </span>
          <Button variant="secondary" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button
            disabled={!n}
            onClick={() => {
              onApply(res.cells.map(({ r, c, v }) => ({ r, c, v })))
              onClose()
            }}
          >
            {t('全部替换')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('查找')}>
            <Input autoFocus value={find} onChange={(e) => setFind(e.target.value)} className="font-mono" />
          </Field>
          <Field label={t('替换为')}>
            <Input value={repl} onChange={(e) => setRepl(e.target.value)} className="font-mono" />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Segmented
            label={t('范围')}
            size="sm"
            value={scope}
            onChange={setScope}
            options={[
              ...(multi ? [{ id: 'sel' as const, label: t('选中区域') }] : []),
              ...(focusCol !== undefined
                ? [{ id: 'col' as const, label: t('当前列 {col}', { col: colName(focusCol) }) }]
                : []),
              { id: 'all' as const, label: t('整张表') },
            ]}
          />
          <Checkbox checked={caseSensitive} onChange={setCase} label={t('区分大小写')} />
          <Checkbox checked={whole} onChange={setWhole} label={t('整格匹配')} />
          <Checkbox checked={regex} onChange={setRegex} label={t('正则')} tip={t('替换里可以用 $1 引用括号里的内容')} />
        </div>
        <p className="text-caption text-subtle">{t('只在筛选后看得见的数据行里找，表头和隐藏的列不动。')}</p>
        {res.error ? (
          <p className="text-footnote text-danger">{t('正则写得不对：{err}', { err: res.error })}</p>
        ) : (
          find && (
            <div
              role="list"
              aria-label={t('替换预览')}
              className="thin-scroll flex max-h-[320px] flex-col overflow-y-auto rounded-(--c-row-radius) border font-mono text-footnote"
            >
              {!n && <p className="px-3 py-4 text-center font-sans text-subtle">{t('没有找到')}</p>}
              {res.cells.slice(0, PREVIEW).map((x) => (
                <div role="listitem" key={`${x.r}:${x.c}`} className="flex gap-3 border-b px-3 py-1 last:border-b-0">
                  <span className="w-14 shrink-0 text-subtle">{cellRef(x.r, x.c)}</span>
                  <span className="min-w-0 flex-1 truncate text-danger line-through" title={x.old}>
                    {x.old}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-success" title={x.v}>
                    {x.v}
                  </span>
                </div>
              ))}
              {n > PREVIEW && (
                <p className="px-3 py-1.5 font-sans text-caption text-subtle">
                  {t('还有 {n} 处没列出来，「全部替换」会一起改', { n: n - PREVIEW })}
                </p>
              )}
            </div>
          )
        )}
      </div>
    </Modal>
  )
}
