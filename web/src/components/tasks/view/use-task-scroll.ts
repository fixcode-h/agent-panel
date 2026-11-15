/**
 * 对话页的视图和滚动：对话 / 流程图两种视图、流程图里选中的节点、贴底跟随、标题栏下的分隔线、
 * 输入框上方悬浮层的留白、父对话点结果卡片后滚到总结，以及切到流程图、定位到某一步。
 * 从 TaskView.tsx 拆出来（复查报告 B2）：页面只拿结果往下传
 */
import { useState } from 'react'
import { t } from '@shared/i18n'
import { toast } from '@/lib/toast'
import { useConversationScroll } from '@/components/chat/ConversationShell'
import { useSummaryJump } from '../summary-jump'

export interface TaskScrollCtx {
  taskId: string
  /** 子对话面板：父对话里点了它的结果卡片（时间戳），打开后滚到最后一份总结 */
  jumpSummary?: number
  /** 已经拿到的任务 id 和消息条数：消息异步到，到了再找总结 */
  loadedId?: string
  messageCount?: number
}

export function useTaskScroll(c: TaskScrollCtx) {
  // 标题栏下的分隔线：消息往上滚过一点才画
  const [scrolled, setScrolled] = useState(false)
  const [view, setView] = useState<'chat' | 'flow'>('chat')
  // 流程图里选中的节点，右栏只看它
  const [flowSel, setFlowSel] = useState('')
  // 右栏「任务进度」里点了哪一步：切到流程视图并选中它，和点流程图的节点一样
  const [focus, setFocus] = useState<{ id: string; at: number }>()
  // 消息区的贴底：打开就在最新内容，流式输出、工具卡片展开、Markdown 变高都跟着走；
  // 用户往上翻时不打扰，回到底部附近再接着跟。切到流程图视图时这个容器不放对话，停止跟随
  const scroller = useConversationScroll(c.taskId, view === 'chat')
  // 输入框上方悬浮层的高度：消息流底部按它多留一段（见 FloatAbove）
  const [floatPad, setFloatPad] = useState(0)
  const { el: scrollerEl } = scroller
  // 父对话点了结果卡片：滚到最后一份总结的标题（见 summary-jump.ts）
  useSummaryJump(scroller, c.jumpSummary, c.loadedId, c.messageCount)
  // 对话里的工作流卡片：和标题栏点「流程图」一样就地切到流程图，点了某个节点就在流程图里选中它
  const openFlow = (id?: string) => {
    setView('flow')
    if (scrollerEl.current) scrollerEl.current.scrollTop = 0
    if (id) setFocus({ id, at: Date.now() })
  }
  // 标题栏切视图
  const switchView = (v: 'chat' | 'flow') => {
    setView(v)
    // 切回对话视图由贴底自己停在最新一行；切到流程图时它把视图自己的滚动放在顶部
    if (v === 'flow' && scrollerEl.current) scrollerEl.current.scrollTop = 0
  }
  return {
    scroller,
    scrolled,
    setScrolled,
    view,
    setView,
    flowSel,
    setFlowSel,
    focus,
    setFocus,
    floatPad,
    setFloatPad,
    openFlow,
    switchView,
  }
}

export interface StepJumpCtx {
  scroll: ReturnType<typeof useTaskScroll>
  /** 还没画出来的较早段数（见 use-task-blocks） */
  hidden: number
  setLimit: (n: number) => void
  closePanel: () => void
}

/** 点了任务进度里的某一步：流程视图里选中它，对话视图里滚到这一步的输出（只给工作流对话） */
export function stepJumper({ scroll, hidden, setLimit, closePanel }: StepJumpCtx) {
  const { view, setFocus, scroller } = scroll
  const openStep = (id: string): void => {
    closePanel()
    // 流程视图里和点流程图的节点一样，选中它；对话视图里滚到这一步的输出，不切换视图
    if (view === 'flow') return setFocus({ id, at: Date.now() })
    const el = scroller.el.current
    const sec = el?.querySelector<HTMLElement>(`[data-step="${CSS.escape(id)}"]`)
    // 这一步在还没显示的较早内容里：先全部显示，画出来后再滚过去
    if (!sec && hidden) {
      setLimit(Infinity)
      requestAnimationFrame(() => requestAnimationFrame(() => openStep(id)))
      return
    }
    if (!el || !sec) return void toast(t('这一步还没有输出'))
    // 定格在这一步：后面的输出不要再把它顶走
    scroller.unpin()
    el.scrollTo({
      top: sec.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 8,
      behavior: 'smooth',
    })
  }
  return openStep
}
