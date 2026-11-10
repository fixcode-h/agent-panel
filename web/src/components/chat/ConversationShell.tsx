// 对话页的外壳：任务对话和 UI 设计对话共用消息流布局、贴底滚动、回到底部和输入框停靠区。
// 业务内容（消息、工具栏、进度、状态栏）都从插槽传进来，壳里不判断是哪种对话。
import { ArrowDown } from 'lucide-react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { STICK_THRESHOLD, useStickToBottom } from '@/lib/useStickToBottom'

/** 对话页统一的贴底：换看另一个对话、切到不显示消息的视图时重新贴底 */
export function useConversationScroll<K = unknown>(key?: K, active = true) {
  return useStickToBottom(key, STICK_THRESHOLD, active)
}

type Scroller = ReturnType<typeof useConversationScroll>

export function ConversationShell({
  scroller,
  children,
  fill,
  contentClassName,
  className,
  onScroll,
  overlay,
  dock,
  rail = 0,
  floatPad = 0,
}: {
  /** `useConversationScroll` 的返回值：滚动容器、贴底状态和「回到底部」 */
  scroller: Scroller
  /** 消息流的内容，放在统一宽度和内边距的内容区里 */
  children?: React.ReactNode
  /** 自己管滚动的视图（流程图）：替换消息流，不套内容区和「回到底部」 */
  fill?: React.ReactNode
  /** 内容区追加的类：默认和任务对话一致（`--content-w`、`px-4 pt-4 pb-8 md:px-6`） */
  contentClassName?: string
  /** 外层追加的类 */
  className?: string
  /** 滚动容器自己的滚动处理（跟着贴底一起调用） */
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void
  /** 盖在消息区上的浮层（任务进度面板） */
  overlay?: React.ReactNode
  /** 输入框停靠区：状态栏、提问、进度、输入框，由调用方决定顺序和内边距 */
  dock?: React.ReactNode
  /**
   * 右边固定浮着的一栏（会话栏）占的宽度：消息区和停靠区右边让出这么多，但滚动容器本身铺满到最右，
   * 滚动条贴在中间页面的最右边，不夹在消息和会话栏中间；会话栏由调用方绝对定位盖在这块空白上，不跟着滚
   */
  rail?: number
  /**
   * 输入框上方悬浮层（FloatAbove）的高度：消息流底部多留这么多，被浮层盖住的最后几行还能滚出来看；
   * 「回到底部」也跟着抬到浮层上面
   */
  floatPad?: number
}) {
  return (
    <>
      {/* 定位容器只包消息区：回到底部相对消息区底部浮着，不会落到底下的输入框和信息条上 */}
      {/* data-float-bound：输入框上方的悬浮层（FloatAbove）最高只到这一块的上沿 */}
      <div data-float-bound="" className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
        {overlay}
        <div
          ref={scroller.ref}
          onScroll={(e) => {
            scroller.onScroll()
            onScroll?.(e)
          }}
          // 界面检查按它找消息区（消息视图是 messages，流程图视图是 fill），不依赖具体的类名组合
          data-conversation-scroll={fill ? 'fill' : 'messages'}
          // 消息流：细滚动条（悬停才显出），见 index.css 的 thin-scroll。顶部不再渐隐：吸顶的回复头是毛玻璃通栏，
          // 渐隐会把它的上沿也淡掉；overflow-x 隐藏也是给通栏裁边用的（见 frost-bar）
          className={
            fill
              ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
              : 'thin-scroll flex-1 overflow-x-hidden overflow-y-auto'
          }
          style={rail ? { paddingRight: rail } : undefined}
        >
          {fill ?? (
            <div
              className={cn('mx-auto flex max-w-(--content-w) flex-col gap-7 px-4 pt-4 pb-8 md:px-6', contentClassName)}
              style={floatPad ? { paddingBottom: `calc(2rem + ${floatPad}px)` } : undefined}
            >
              {children}
            </div>
          )}
        </div>
        {!fill && scroller.away && (
          <button
            type="button"
            onClick={scroller.toBottom}
            aria-label={t('回到底部')}
            title={t('回到底部')}
            // 有会话栏时按消息区（让出会话栏之后那块）居中
            style={{
              ...(rail ? { left: `calc((100% - ${rail}px) / 2)` } : null),
              // 浮层快占满消息区时不顶出上沿
              ...(floatPad ? { bottom: `min(calc(0.75rem + ${floatPad}px), calc(100% - 3rem))` } : null),
            }}
            className="absolute bottom-3 left-1/2 z-20 grid h-9 w-9 -translate-x-1/2 cursor-pointer place-items-center rounded-full border border-line-strong frost-card text-muted shadow-pop transition-colors hover:text-fg"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
      </div>
      {/* 停靠区是定位容器的兄弟：消息区、状态栏、输入框还是同一个 flex 列里的三项 */}
      {rail && dock ? (
        <div className="flex shrink-0 flex-col" style={{ paddingRight: rail }}>
          {dock}
        </div>
      ) : (
        dock
      )}
    </>
  )
}
