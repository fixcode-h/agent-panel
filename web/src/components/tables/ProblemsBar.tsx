import { CircleCheck, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { cellRef } from '@shared/table-edit'
import type { ColInfo, Problem } from '@shared/table-struct'
import { ResizeHandle, usePaneWidth } from '@/components/ui/resize'

/** 列表最多列这么多处 */
const SHOW = 300

/**
 * 表格底下的「不合规」列表：哪一格、哪个字段、为什么（不是整数、不在枚举里、引用的表里没有、主键重复……），
 * 点一行跳到那一格
 */
export function ProblemsBar({
  problems,
  infos,
  onPick,
  onClose,
}: {
  problems: Problem[]
  infos: ColInfo[]
  onPick: (p: Problem) => void
  onClose: () => void
}) {
  // 高度可以拖上边缘调，记在本机；最高到窗口的七成
  const pane = usePaneWidth('tables-problems', 220, 96, () => Math.round(window.innerHeight * 0.7))
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
          {problems.length ? t('{n} 处不合规', { n: problems.length }) : t('这张表没有发现问题')}
        </span>
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
        <div className="min-h-0 overflow-y-auto px-1.5 pb-1.5">
          {problems.slice(0, SHOW).map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onPick(p)}
              className="flex h-7 w-full cursor-pointer items-center gap-3 rounded-(--c-row-radius) px-2 text-left text-footnote hover:bg-hover"
            >
              <span className="w-14 shrink-0 font-mono text-subtle">{cellRef(p.r, p.c)}</span>
              <span className="w-40 shrink-0 truncate font-mono text-muted">{infos[p.c]?.field}</span>
              <span className="min-w-0 truncate text-danger">{p.msg}</span>
            </button>
          ))}
          {problems.length > SHOW && (
            <p className="px-2 py-1 text-caption text-subtle">{t('还有 {n} 处', { n: problems.length - SHOW })}</p>
          )}
        </div>
      )}
    </section>
  )
}
