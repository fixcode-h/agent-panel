import { useState } from 'react'
import { ChevronRight, Undo2 } from 'lucide-react'
import type { DesignMessage } from '@shared/design'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'

type Changes = NonNullable<DesignMessage['changes']>

/** 改了什么的简称：属性名原样，位置写成「位置」 */
const keyName = (k: string) => (k === 'Slot' ? t('位置') : k === 'Class' ? t('引用的子控件') : k)

// 文案在渲染时取（切换界面语言后跟着变），颜色是固定的
const kindOf = (k: Changes['list'][number]['kind']) =>
  ({
    add: { label: t('新增'), tone: 'text-success' },
    remove: { label: t('删除'), tone: 'text-danger' },
    change: { label: t('修改'), tone: 'text-accent-text' },
    rename: { label: t('改名'), tone: 'text-peer' },
  })[k]

/**
 * AI 回复下面的「改了 N 处」：点开列出这一轮新增、删除、修改、改名的控件，点一条在画布上选中它；
 * 最后一条回复还有「撤销这一轮」，恢复这一轮开始前自动存的版本（恢复前又会存一个版本，撤销也能再撤回）
 */
export function ChangeList({
  changes,
  onPick,
  onUndo,
  disabled,
}: {
  changes: Changes
  onPick?: (tree: string, name: string) => void
  /** 只有最后一条、没在跑时给 */
  onUndo?: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rest = changes.total - changes.list.length
  return (
    <div className="pl-[38px] text-caption">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex cursor-pointer items-center gap-1 text-subtle hover:text-fg"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          {t('改了 {n} 处', { n: changes.total })}
        </button>
        {onUndo && (
          <button
            type="button"
            disabled={disabled}
            onClick={onUndo}
            title={t('恢复到这一轮开始之前；恢复前会自动存一个版本，可以在「版本」里找回')}
            className="flex cursor-pointer items-center gap-1 text-subtle hover:text-fg disabled:cursor-default disabled:opacity-50"
          >
            <Undo2 className="h-3.5 w-3.5" />
            {t('撤销这一轮')}
          </button>
        )}
      </div>
      {open && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {changes.list.map((c, i) => {
            const k = kindOf(c.kind)
            const pick = c.kind !== 'remove' && onPick ? () => onPick(c.tree, c.name) : undefined
            return (
              <li key={i}>
                <button
                  type="button"
                  disabled={!pick}
                  onClick={pick}
                  title={pick ? t('在画布上选中它') : undefined}
                  className="flex w-full min-w-0 items-baseline gap-2 rounded-md px-1.5 py-0.5 text-left enabled:cursor-pointer enabled:hover:bg-sel"
                >
                  <span className={cn('shrink-0 font-medium', k.tone)}>{k.label}</span>
                  <span className="min-w-0 truncate font-mono text-fg">
                    {c.tree && <span className="text-subtle">{c.tree} / </span>}
                    {c.from ? `${c.from} → ${c.name}` : c.name}
                  </span>
                  {!!c.keys?.length && (
                    <span className="min-w-0 truncate text-subtle">{c.keys.slice(0, 4).map(keyName).join('、')}</span>
                  )}
                </button>
              </li>
            )
          })}
          {rest > 0 && <li className="px-1.5 text-subtle">{t('还有 {n} 处', { n: rest })}</li>}
        </ul>
      )}
    </div>
  )
}
