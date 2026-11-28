import { PenLine } from 'lucide-react'
import { t } from '@shared/i18n'
import { fmtDuration } from '@/lib/tasks'
import { cn } from '@/lib/utils'

/** 写参数不到这么久不标：一眨眼就写完的不值得多一个小标 */
export const GEN_BADGE_MIN_MS = 1000

/**
 * 工具卡片耗时旁的小标「· ✎ 写参数 3.2s」（用户 2026-11-28）：模型写入参要几秒，卡片右边的耗时只算工具执行（几百毫秒），
 * 不分开标会以为前面那几秒是卡住了。设置 → 组件微调「写参数小标」能关掉（--c-genBadge-show）
 */
export function GenBadge({ ms, className }: { ms?: number; className?: string }) {
  if (ms === undefined || ms < GEN_BADGE_MIN_MS) return null
  return (
    <span
      data-gen-badge=""
      title={t('模型写这次调用的参数用了 {gen}，右边的耗时是工具执行用的', { gen: fmtDuration(ms) })}
      className={cn(
        'shrink-0 items-center gap-1 text-caption text-subtle tabular-nums [display:var(--c-genBadge-show)]',
        className,
      )}
    >
      <span aria-hidden className="text-subtle/60">
        ·
      </span>
      <PenLine className="h-3 w-3 shrink-0" />
      {t('写参数 {gen}', { gen: fmtDuration(ms) })}
    </span>
  )
}
