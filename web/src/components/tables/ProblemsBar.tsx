import { useMemo, useState } from 'react'
import { ChevronRight, CircleCheck, Wand2, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cellRef, type CellSet } from '@shared/table-edit'
import type { ColInfo, Problem } from '@shared/table-struct'
import { groupFixes, groupProblems, type GroupFix, type ProblemGroup } from '@shared/table-problems'
import { cn } from '@/lib/utils'
import { colName } from '@/lib/sheet'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu'

/** 一组展开后最多列这么多处 */
const SHOW = 300
/** 批量修的预览最多列这么多格 */
const PREVIEW = 200

/**
 * 表格底下的检查结果：按「字段 + 规则」分组（「State · 不能大于 1 · 11 处」），展开看每一格，点一行跳过去。
 * 每组能批量修：改成边界值、改成允许的值、清空、让 AI 修这一组。批量改先预览，确认后一次放进表格（一步就能撤销）
 */
export function ProblemsBar({
  problems,
  infos,
  rows,
  onPick,
  onClose,
  onFix,
  onAi,
}: {
  problems: Problem[]
  infos: ColInfo[]
  /** 预览批量修时显示原来的值 */
  rows: string[][]
  onPick: (p: Problem) => void
  onClose: () => void
  /** 只读的表不传：不能批量修 */
  onFix?: (cells: CellSet[]) => void
  /** 让 AI 修这一组 */
  onAi?: (problems: Problem[]) => void
}) {
  // 高度可以拖上边缘调，记在本机；最高到窗口的七成
  const pane = usePaneWidth('tables-problems', 220, 96, () => Math.round(window.innerHeight * 0.7))
  const groups = useMemo(() => groupProblems(problems, infos), [problems, infos])
  // 只有一组时直接展开；多组时先收起，看一眼有哪几类
  const [open, setOpen] = useState<Set<string> | null>(null)
  const isOpen = (g: ProblemGroup) => (open ? open.has(g.key) : groups.length === 1)
  const toggle = (g: ProblemGroup) => {
    const next = new Set(open ?? (groups.length === 1 ? [groups[0].key] : []))
    if (next.has(g.key)) next.delete(g.key)
    else next.add(g.key)
    setOpen(next)
  }
  const [preview, setPreview] = useState<{ g: ProblemGroup; fix: GroupFix } | null>(null)
  return (
    <section
      aria-label={t('不合规的格子')}
      style={{ height: problems.length ? pane.width : undefined }}
      className="relative flex shrink-0 flex-col border-t bg-panel"
    >
      {problems.length > 0 && <ResizeHandle pane={pane} side="top" />}
      <header className="flex h-8 shrink-0 items-center gap-2 px-3 text-footnote">
        <span className="font-medium">{t('检查结果')}</span>
        <span className="text-subtle">
          {problems.length
            ? t('{n} 处不合规，{k} 类', { n: problems.length, k: groups.length })
            : t('这张表没有发现问题')}
        </span>
        {groups.length > 1 && (
          <button
            type="button"
            onClick={() => setOpen(open?.size ? new Set() : new Set(groups.map((g) => g.key)))}
            className="cursor-pointer rounded-sm px-1 text-subtle hover:bg-hover hover:text-fg"
          >
            {open?.size ? t('全部收起') : t('全部展开')}
          </button>
        )}
        <button
          type="button"
          aria-label={t('关闭')}
          onClick={onClose}
          className="ml-auto grid h-6 w-6 cursor-pointer place-items-center rounded-sm text-subtle hover:bg-hover hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      {problems.length === 0 ? (
        <p className="flex items-center gap-2 px-3 pb-3 text-footnote text-subtle">
          <CircleCheck className="h-4 w-4 text-success" />
          {t('按列的类型、枚举、引用、取值范围和主键查过了')}
        </p>
      ) : (
        <div className="thin-scroll min-h-0 overflow-y-auto px-1.5 pb-1.5">
          {groups.map((g) => {
            const on = isOpen(g)
            const fixes = onFix ? groupFixes(g, infos[g.c]) : []
            return (
              <div key={g.key}>
                <div className="group/pg sticky top-0 z-[1] flex h-7 items-center gap-1 rounded-(--c-row-radius) bg-panel pr-1 text-footnote hover:bg-hover">
                  <button
                    type="button"
                    aria-expanded={on}
                    onClick={() => toggle(g)}
                    className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-1 text-left"
                  >
                    <ChevronRight
                      className={cn('h-3.5 w-3.5 shrink-0 text-subtle transition-transform', on && 'rotate-90')}
                    />
                    <span className="max-w-48 shrink-0 truncate font-mono text-fg">{g.field || colName(g.c)}</span>
                    <span className="min-w-0 truncate text-danger">{g.label}</span>
                    <span className="shrink-0 text-subtle tabular-nums">{t('{n} 处', { n: g.items.length })}</span>
                  </button>
                  {(fixes.length > 0 || onAi) && (
                    <Menu>
                      <MenuTrigger asChild>
                        <Button size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-footnote">
                          <Wand2 className="h-3 w-3" />
                          {t('批量修')}
                        </Button>
                      </MenuTrigger>
                      <MenuContent align="end">
                        {fixes.map((f) => (
                          <MenuItem key={f.label} onSelect={() => setPreview({ g, fix: f })}>
                            {f.label}
                          </MenuItem>
                        ))}
                        {fixes.length > 0 && onAi && <MenuSeparator />}
                        {onAi && (
                          <MenuItem onSelect={() => onAi(g.items)}>
                            {t('让 AI 修这一组（{n} 处）', { n: g.items.length })}
                          </MenuItem>
                        )}
                      </MenuContent>
                    </Menu>
                  )}
                </div>
                {on && (
                  <div className="pb-1 pl-5">
                    {g.items.slice(0, SHOW).map((p) => (
                      <button
                        key={`${p.r}:${p.c}`}
                        type="button"
                        onClick={() => onPick(p)}
                        className="flex h-6 w-full cursor-pointer items-center gap-3 rounded-(--c-row-radius) px-2 text-left text-footnote hover:bg-hover"
                      >
                        <span className="w-14 shrink-0 font-mono text-subtle">{cellRef(p.r, p.c)}</span>
                        <span className="w-40 shrink-0 truncate font-mono text-muted">{rows[p.r]?.[p.c] || '—'}</span>
                        <span className="min-w-0 truncate text-subtle">{p.msg}</span>
                      </button>
                    ))}
                    {g.items.length > SHOW && (
                      <p className="px-2 py-1 text-caption text-subtle">
                        {t('还有 {n} 处', { n: g.items.length - SHOW })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {preview && onFix && (
        <FixPreview
          group={preview.g}
          fix={preview.fix}
          rows={rows}
          onCancel={() => setPreview(null)}
          onApply={(cells) => {
            onFix(cells)
            setPreview(null)
          }}
        />
      )}
    </section>
  )
}

/** 批量修之前看一眼：哪一格从什么改成什么 */
function FixPreview({
  group,
  fix,
  rows,
  onCancel,
  onApply,
}: {
  group: ProblemGroup
  fix: GroupFix
  rows: string[][]
  onCancel: () => void
  onApply: (cells: CellSet[]) => void
}) {
  // 同一格只改一次（同一格可能同时有两种问题）
  const cells = useMemo(() => {
    const seen = new Set<string>()
    return group.items.flatMap((p) => {
      const k = `${p.r}:${p.c}`
      if (seen.has(k)) return []
      seen.add(k)
      return [{ r: p.r, c: p.c, v: fix.value }]
    })
  }, [group, fix])
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onCancel()}
      title={t('{field}：{fix}', { field: group.field, fix: fix.label })}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t('取消')}
          </Button>
          <Button onClick={() => onApply(cells)}>{t('放进表格（{n} 格）', { n: cells.length })}</Button>
        </>
      }
    >
      <p className="mb-2 text-footnote text-subtle">{t('改动先放在页面上，点保存才写进文件；Ctrl+Z 一步撤销。')}</p>
      <div className="thin-scroll max-h-[50vh] overflow-y-auto rounded-md border">
        {cells.slice(0, PREVIEW).map((x) => (
          <div
            key={`${x.r}:${x.c}`}
            className="flex h-7 items-center gap-3 border-b px-3 text-footnote last:border-b-0"
          >
            <span className="w-14 shrink-0 font-mono text-subtle">{cellRef(x.r, x.c)}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-danger line-through">
              {rows[x.r]?.[x.c] || '—'}
            </span>
            <span className="text-subtle">→</span>
            <span className="min-w-0 flex-1 truncate font-mono text-success">{x.v || t('（空）')}</span>
          </div>
        ))}
        {cells.length > PREVIEW && (
          <p className="px-3 py-1.5 text-caption text-subtle">{t('还有 {n} 格', { n: cells.length - PREVIEW })}</p>
        )}
      </div>
    </Modal>
  )
}
