import { useRef, useState } from 'react'
import { ChevronRight, ClipboardList, RefreshCw } from 'lucide-react'
import type { TaskStep } from '@shared/schema'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { helperBriefView, type BriefBlock } from '@/lib/helper-brief'
import { Markdown } from './Markdown'
import { Badge } from '@/components/ui/badge'

/** 重点小节的标题颜色：验收标准这类必须满足的要求要一眼看到 */
const TONE_CLASS: Record<BriefBlock['tone'], string> = {
  key: 'text-accent-text',
  note: 'text-muted',
  plain: 'text-subtle',
}

/** 小节左边那条竖线：重点、补充、照常三种深浅，和标题颜色对应 */
const TONE_BAR: Record<BriefBlock['tone'], string> = {
  key: 'border-accent/45',
  note: 'border-line-strong',
  plain: 'border-line',
}

/** 正文最多占 38vh，且不超过 320px：再长就在块里滚，不把下面的对话流挤出窗口 */
const BODY_MAX_H = 'max-h-[min(38vh,320px)]'

/** 小节左边竖线与内容的间距：标题和正文用同一个值，两行对齐 */
const BAR_PAD = 'pl-2.5'

/**
 * 子任务窗口最上面的「派给它的要求」：派发时交给它的原文（`TaskStep.brief`），
 * 按 `##` 小节排成几块，一眼看出这个子任务要做什么、有什么要求和验收标准。只读，不改记录。
 *
 * 它就是滚动区里的第一块普通内容，跟着内容一起滚、不吸顶：吸顶的卡片会盖住下面的对话流（用户说的「不要悬浮在那」）。
 * 打开时能看到它靠的是窗口的滚动位置——`HelperWindow` 在有要求时按 `startAt: 'top'` 打开就停在顶部，
 * 而不是像对话页那样贴底。有对话流时默认收起（只留摘要一行），只有还没输出时展开（这时它就是要看的内容）。
 * 点「展开」时先停下跟随（`unpin`）再把卡片滚到视野顶部：展开后块变高，跟在底部时
 * `useStickToBottom` 的 `ResizeObserver` 会立刻把 scrollTop 拉到新的底部，刚展开的正文留在视野之上（看起来像点了没反应）。
 * 旧记录没有 brief（schema 加这个字段之前的 step）时整块不显示，窗口照旧从对话流开始。
 */
export function HelperBriefCard({
  step,
  teamNames,
  msgs,
  pin,
  unpin,
}: {
  step: TaskStep
  teamNames: Set<string>
  /** 这个子任务已有的消息条数：决定默认收起还是展开 */
  msgs: number
  /** 继续跟着底部走（`useStickToBottom` 的 pin） */
  pin?: () => void
  /** 暂时不跟着底部走（`useStickToBottom` 的 unpin） */
  unpin?: () => void
}) {
  const view = helperBriefView(step.brief)
  const box = useRef<HTMLElement | null>(null)
  // 还没输出时展开：打开的窗口里只有这块要看的东西；有对话流时收起，不抢最新输出的位置
  const [open, setOpen] = useState(msgs === 0)
  if (view.empty) return null
  // 派发之后又追加过几次要求（只数真正的「重试时补充」块）：不能拿 reruns 算，整体重跑也会加它却不追加要求
  const again = view.added

  const flip = () => {
    if (open) {
      setOpen(false)
      // 收起就看回最新输出，接着跟底部走
      pin?.()
      return
    }
    // 展开：先停下贴底，再把卡片滚到视野顶部（布局在旁边才变高，所以等下一帧）
    unpin?.()
    setOpen(true)
    requestAnimationFrame(() => box.current?.scrollIntoView({ block: 'start' }))
  }

  return (
    <section
      ref={box}
      aria-label={t('派给它的要求')}
      className={cn(
        'overflow-hidden rounded-xl border border-line',
        // 展开时底色浅一点分出正文区；收起时用卡片底色，和下面的对话流分开
        open ? 'bg-field/40' : 'bg-card',
      )}
    >
      <button
        type="button"
        onClick={flip}
        aria-expanded={open}
        title={open ? t('收起派给它的要求') : t('展开派给它的要求')}
        className="flex w-full cursor-pointer items-start gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-sel/40"
      >
        <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-xs font-medium text-muted">{t('派给它的要求')}</span>
            {again > 0 && (
              <Badge className="shrink-0 px-1.5 text-caption" title={t('派发之后又补充过 {n} 次要求', { n: again })}>
                <RefreshCw className="h-2.5 w-2.5" />
                {t('补充过 {n} 次', { n: again })}
              </Badge>
            )}
          </span>
          {/* 摘要只在收起时显示：展开后正文里就有这段（「要做的事」第一节），两处一起写会重复一遍 */}
          {!open && <span className="line-clamp-2 text-body text-muted">{view.summary}</span>}
        </span>
        <ChevronRight className={cn('mt-0.5 h-4 w-4 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className={cn('flex flex-col gap-3 overflow-y-auto border-t px-3.5 py-3', BODY_MAX_H)}>
          {view.blocks.length ? (
            view.blocks.map((b, i) => (
              // 排序在 helperBriefView 里定好；同一标题可能出现多次（两次重试补充），所以带上下标
              <section
                key={`${b.title}-${i}`}
                className={cn('flex flex-col gap-1', b.title && `border-l-2 ${BAR_PAD} ${TONE_BAR[b.tone]}`)}
              >
                {b.title && (
                  <p className={cn('text-caption font-medium tracking-wide', TONE_CLASS[b.tone])}>{b.title}</p>
                )}
                <Markdown text={b.body} teamNames={teamNames} compact />
              </section>
            ))
          ) : (
            // 没有小节的纯文字：按段落显示，不套小节标题
            <div className="flex flex-col gap-2">
              {(view.paragraphs ?? []).map((p, i) => (
                <Markdown key={i} text={p} teamNames={teamNames} compact />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
