import type { ReactNode } from 'react'
import { ArrowLeft, Copy, Loader2, MoreHorizontal, Workflow as WorkflowIcon, X } from 'lucide-react'
import { toast } from 'sonner'
import type { StepStatus, Task, ToolUse } from '@shared/schema'
import { topSteps } from '@shared/flow'
import { t } from '@shared/i18n'
import { useEscape } from '@/lib/useEscape'
import { Button } from '@/components/ui/button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu'
import { RunFlow, runState } from './RunCard'

/** 节点状态的说法：复制出去的文本里要能看懂，和列表里的叫法一致 */
const stateText: Record<StepStatus, () => string> = {
  pending: () => t('等待执行'),
  running: () => t('执行中'),
  done: () => t('已完成'),
  failed: () => t('失败'),
  skipped: () => t('跳过'),
}

/** 这次运行的名字：工作流名字；任务上没记时退回「运行 N」 */
function runName(task: Task, run: number) {
  return task.runs?.find((r) => r.id === run)?.workflowName || task.workflowName || t('运行 {n}', { n: run })
}

/**
 * 子对话面板里打开的这一次运行：在子对话这块面板内换成新的一页，标题栏左边是返回子对话的按钮，
 * 正文和右栏的运行面板一样按节点铺开（RunFlow）。子对话本身没有卸载，返回后还是原来的位置。
 *
 * 返回（←）回子对话这一层，✕ 是关掉子对话面板本身，右边那一栏一起收起，两个动作不一样
 */
export function RunView({
  task,
  run,
  tool,
  onBack,
  onClose,
  footer,
}: {
  /** 子对话自己的任务：运行和节点的输出都在它上面 */
  task: Task
  /** 第几次运行；认不回来时是 0，按「没有启动运行」显示原因和这次的输出 */
  run: number
  /** 「启动工作流」那次调用：认不回运行时用它显示原因和输出 */
  tool?: ToolUse
  onBack: () => void
  /** 关掉子对话面板本身；不给时不显示 ✕ */
  onClose?: () => void
  /** 子对话的输入框：跟着这次运行放在底下，和右栏运行面板（RunPanel）用的是同一个 */
  footer?: ReactNode
}) {
  // Esc 和返回按钮一样回子对话，不关面板
  useEscape(true, onBack)
  const state = run > 0 ? runState(task, run) : 'waiting'
  const title = run > 0 ? runName(task, run) : t('启动工作流')
  const output = (tool?.output ?? '').replace(/\s+$/, '')
  // ⋯ 里的复制：粘到别处能看出是哪个对话、第几次运行、每个节点做到哪
  const copyRun = () => {
    const text = [
      [title, task.title].filter(Boolean).join(' · '),
      t('第 {n} 次运行', { n: run }),
      ...topSteps(task, run).map((s, i) => `${i + 1}. ${s.title} · ${stateText[s.status]()}`),
    ].join('\n')
    void Promise.resolve(navigator.clipboard?.writeText(text)).then(
      () => toast.success(t('已复制')),
      () => toast.error(t('复制失败')),
    )
  }

  return (
    // 盖在对话上面，不卸载子对话：返回时滚动位置和已经看到的内容都还在
    <div className="absolute inset-0 z-30 flex min-h-0 flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b px-2 md:px-3">
        <Button variant="ghost" size="icon-sm" aria-label={t('返回子对话')} title={t('返回子对话')} onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <WorkflowIcon className="hidden h-4 w-4 shrink-0 text-muted sm:block" />
        {/* 标题是这次运行的名字，下面一行面包屑说明它在哪个子对话里；窄窗口下两行都截断，不挤掉右边的按钮 */}
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[0.875rem] font-medium">{title}</span>
            {state === 'running' && (
              <span className="flex shrink-0 items-center gap-1 text-[0.6875rem] text-accent">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('执行中')}
              </span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[0.6875rem] text-subtle">
            <span className="min-w-0 truncate">{task.title}</span>
            <span className="shrink-0">›</span>
            <span className="shrink-0">{run > 0 ? t('第 {n} 次运行', { n: run }) : t('启动工作流')}</span>
          </span>
        </span>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('更多操作')}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </MenuTrigger>
          <MenuContent>
            {run > 0 && (
              <MenuItem onSelect={copyRun}>
                <Copy className="h-4 w-4" />
                {t('复制这次运行的结论')}
              </MenuItem>
            )}
            {onClose && (
              <MenuItem onSelect={onClose}>
                <X className="h-4 w-4" />
                {t('关闭子对话面板')}
              </MenuItem>
            )}
          </MenuContent>
        </Menu>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('关闭子对话面板')}
            title={t('关闭子对话面板')}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </header>
      {run > 0 ? (
        <RunFlow task={task} run={run} />
      ) : (
        // 没有运行可看（调用失败、还没开始执行）：把原因和这次的输出照原样留着，和运行窗口里一致
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-(--content-w) px-4 py-5 md:px-6">
            <p className="mb-2 text-[0.8125rem] text-subtle">{t('这次调用没有启动运行。')}</p>
            {output && (
              <pre className="font-mono text-[0.75rem] leading-[1.65] whitespace-pre-wrap text-fg/90 [overflow-wrap:anywhere]">
                {output}
              </pre>
            )}
          </div>
        </div>
      )}
      {footer && <div className="shrink-0 border-t bg-bg px-3 py-3 md:px-4">{footer}</div>}
    </div>
  )
}
