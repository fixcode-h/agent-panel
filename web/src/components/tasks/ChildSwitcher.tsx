import { Fragment } from 'react'
import * as M from '@radix-ui/react-dropdown-menu'
import { Check, CheckCircle2, GitBranch, ListTree } from 'lucide-react'
import { t } from '@shared/i18n'
import { childIcon, childStage, sortChildren, stopReasonText, type TaskStage } from '@shared/task'
import { cn } from '@/lib/utils'
import { popoverPanel } from '@/components/ui/menu'
import { TaskStatusIcon } from './TaskStatusIcon'
import { AnalysisMark } from './AnalysisMark'
import { childClosedHint, childLabelClass, childLabels, childNote, staleLine, type ChildSummary } from './child-line'

/**
 * 子对话列表的一行内容：图标、标题、状态标签、正在做什么 / 在等什么、独立分支。
 * 悬浮层列表和标题旁的下拉读同一份，两处不再各画一套
 */
export function ChildRowContent({ c }: { c: ChildSummary }) {
  const icon = childIcon(c)
  // 执行中写正在做什么，其余写在等什么或最近结果；很久没新输出时标色
  const line = childNote(c, icon === 'running')
  const stale = staleLine(c)
  const labels = childLabels(c)
  return (
    <>
      <span className="mt-0.5 shrink-0">
        <TaskStatusIcon
          status={c.status}
          icon={icon}
          label={c.status === 'stopped' ? stopReasonText(c.stopReason) : undefined}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          {c.analysis && <AnalysisMark kind={c.analysis} />}
          {/* CLI 还活着：标题流光（和侧栏、标题栏同一个效果）；关了变灰。
              进程回收了但对话还在跑：行上不写「已关闭」，悬停说清进程没了、继续会重新拉起 */}
          <span
            className={cn('min-w-0 truncate text-[0.8125rem]', c.cliAlive ? 'cli-alive-title' : 'text-muted')}
            title={childClosedHint(c) || undefined}
          >
            {c.title}
          </span>
          {/* 状态标签全部从 childIcon / childState 派生：同一行只说一件事，不会「已解决」和「执行中」一起出现 */}
          {labels.map((l) => (
            <span key={l.text} className={childLabelClass[l.tone]}>
              {l.icon === 'check' && <CheckCircle2 className="h-3 w-3" />}
              {l.text}
            </span>
          ))}
        </span>
        {(line || stale) && (
          <span className="flex min-w-0 items-center gap-1">
            {line && <span className="line-clamp-1 min-w-0 text-xs text-subtle">{line}</span>}
            {stale && <span className={cn('shrink-0 text-xs', stale.cls)}>· {stale.text}</span>}
          </span>
        )}
        {c.branch && (
          <span className="flex min-w-0 items-center gap-1 font-mono text-[0.6875rem] text-subtle">
            <GitBranch className="h-3 w-3 shrink-0" />
            <span className="truncate">{c.branch}</span>
          </span>
        )}
      </span>
    </>
  )
}

/**
 * 「全部」里按状态分组看子对话：要你处理的（等确认、失败）在最上面，然后执行中、未完成、做完的、停下的；
 * 「运行中」只列真正在执行（working）的几个，不分组。分组用 childStage（taskStage 再加上「计划没做完」）：
 * 和状态图标、行内标签是同一套映射，排序也用这一套，组内顺序和 sortChildren 一致
 */
export function childGroups(list: ChildSummary[], grouped: boolean) {
  if (!grouped) return [{ key: 'all', label: '', items: list }]
  const groups: { key: TaskStage; label: string; items: ChildSummary[] }[] = [
    { key: 'you', label: t('需要你处理'), items: [] },
    { key: 'running', label: t('执行中'), items: [] },
    { key: 'unfinished', label: t('未完成'), items: [] },
    { key: 'done', label: t('已完成'), items: [] },
    { key: 'stopped', label: t('已停止'), items: [] },
  ]
  for (const c of list) {
    const g = groups.find((x) => x.key === childStage(c))
    if (g) g.items.push(c)
  }
  return groups.filter((g) => g.items.length)
}

/**
 * 子对话切换下拉：标题旁的小按钮，列出这个父对话的全部子对话，点一项就在右栏打开。
 * 排序和分组复用悬浮层「全部」那一套（sortChildren + childGroups），当前打开的那项带勾选。
 * Radix 的 DropdownMenu 自己处理点外部关闭、Esc、上下键和 Enter
 */
export function ChildSwitcher({
  list,
  current,
  onOpen,
  className,
}: {
  list: ChildSummary[]
  /** 右栏当前打开的子对话 id：没有时为空 */
  current: string
  onOpen: (id: string) => void
  className?: string
}) {
  if (!list.length) return null
  return (
    <M.Root modal={false}>
      <M.Trigger asChild>
        <button
          type="button"
          // 行本身是可点的（打开子对话）：点这个按钮只开列表，不跟着打开当前行
          onClick={(e) => e.stopPropagation()}
          aria-label={t('切换子对话')}
          title={t('切换子对话')}
          className={cn(
            'grid h-5 w-5 shrink-0 cursor-pointer place-items-center rounded-md text-subtle transition-colors hover:bg-sel hover:text-fg data-[state=open]:bg-sel data-[state=open]:text-fg',
            className,
          )}
        >
          <ListTree className="h-3.5 w-3.5" />
        </button>
      </M.Trigger>
      <M.Portal>
        <M.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          // Portal 的事件冒泡走 React 树：点菜单项会一路冒到所在行的 RowShell（整行打开子对话），
          // 把刚选的那一项覆盖成那一行自己的子对话。在这里拦下，菜单里的点击只交给 onSelect
          onClick={(e) => e.stopPropagation()}
          className={cn(popoverPanel, 'max-h-[min(60vh,360px)] w-[min(360px,calc(100vw-16px))] overflow-y-auto')}
        >
          {childGroups(sortChildren(list), true).map((g) => (
            <Fragment key={g.key}>
              {g.label && (
                <M.Label className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium text-subtle">
                  {g.label} · {g.items.length}
                </M.Label>
              )}
              {g.items.map((c) => (
                <M.Item
                  key={c.id}
                  data-child-item
                  data-child-id={c.id}
                  // 界面检查用它确认当前打开的那项有选中标记
                  data-current={c.id === current ? '' : undefined}
                  onSelect={() => onOpen(c.id)}
                  className={cn(
                    'flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left outline-none data-[highlighted]:bg-sel',
                    c.id === current && 'bg-sel',
                  )}
                >
                  <ChildRowContent c={c} />
                  {c.id === current && <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />}
                </M.Item>
              ))}
            </Fragment>
          ))}
        </M.Content>
      </M.Portal>
    </M.Root>
  )
}
