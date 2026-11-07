import { Check, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import type { Stage, StageId } from '@/lib/design-stages'

/**
 * 画板标题行左边的流程条：风格 → 原画 → 模板 → 界面 → 切图 → 导出（状态由 design-stages.ts 推出来）。
 * 以前只有「原画—界面」两步，而且没出过原画时整条都不显示，用户看不到完整流程。
 * 顺序不强制：点原画 / 模板切到原画面板，点界面 / 切图回到画布（切图再打开「图片」页签）；
 * 当前这一步高亮，悬停看下一步做什么；窄的时候（@container）只留当前这一步的名字，其余只剩圆点
 */
export function StageSteps<T extends string = StageId>({
  stages,
  onPick,
}: {
  /** 照原画还原也用这条（六步：原画 → 拆解 → 切图 → 搭建 → 校验 → 交付） */
  stages: (Omit<Stage, 'id'> & { id: T })[]
  onPick: (id: T) => void
}) {
  const cur = stages.find((s) => s.state === 'current' || s.state === 'busy')
  return (
    <nav aria-label={t('流程')} className="flex shrink-0 items-center gap-0.5">
      {stages.map((s, i) => {
        const on = s === cur
        const done = s.state === 'done'
        return (
          <div key={s.id} className="flex items-center gap-0.5">
            {i > 0 && <span aria-hidden className={cn('h-[1.5px] w-2.5', done ? 'bg-success' : 'bg-line-strong')} />}
            <button
              type="button"
              aria-current={on ? 'step' : undefined}
              data-stage={s.id}
              data-state={s.state}
              title={
                s.state === 'skipped'
                  ? t('{name}：跳过了', { name: s.label })
                  : on
                    ? t('下一步：{hint}', { hint: s.hint })
                    : s.label
              }
              onClick={() => onPick(s.id)}
              className={cn(
                'flex h-8 cursor-pointer items-center gap-1.5 rounded-xl px-2 text-body font-semibold whitespace-nowrap transition-colors',
                on
                  ? 'bg-panel text-fg shadow-[inset_0_1px_2px_rgb(0_0_0/0.08)]'
                  : cn('hover:bg-sel', done ? 'text-fg' : 'text-subtle'),
              )}
            >
              <span
                className={cn(
                  'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-micro tabular-nums',
                  done
                    ? 'bg-success text-on-primary'
                    : on
                      ? 'bg-fg text-bg'
                      : s.state === 'skipped'
                        ? 'text-subtle/70 shadow-[inset_0_0_0_1.5px_var(--line)]'
                        : 'text-subtle shadow-[inset_0_0_0_1.5px_var(--line-strong)]',
                )}
              >
                {done ? (
                  <Check className="h-3 w-3" strokeWidth={2.6} />
                ) : s.state === 'busy' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : s.state === 'skipped' ? (
                  '–'
                ) : (
                  i + 1
                )}
              </span>
              {/* 窄的时候只留当前这一步的名字 */}
              <span className={cn(on ? '' : 'hidden @min-[760px]:inline')}>{s.label}</span>
            </button>
          </div>
        )
      })}
    </nav>
  )
}
