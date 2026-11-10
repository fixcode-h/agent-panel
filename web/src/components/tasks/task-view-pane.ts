/**
 * 对话页的栏宽、首屏分段和本地记忆（右栏开着哪个子对话 / 运行、文件面板和功能面板收没收起）。
 * 从 TaskView.tsx 拆出来（文件行数上限，见 docs/lessons/file-caps.md），TaskView 只取用
 */
import { useLayoutEffect } from 'react'
import type { TaskMessage } from '@shared/schema'
import { usePaneWidth } from '@/components/ui/resize'
import { paneHalfWidth, PANE_DEFAULT_SSR, rowWidthFromWindow } from '@/lib/pane-width'
import { paneChildKey, paneFilesKey, paneReportKey, paneRunKey } from '@/lib/ai-window'

/** 任务页一开始最多画多少段（一个节点组、一轮对话算一段） */
export const BLOCK_LIMIT = 30
/**
 * 打开对话时先取最近多少条消息：整份对话可能几 MB，首屏只要最后这一段，
 * 更早的点和翻页一样往前取（见 loadEarlier）
 */
export const OPEN_MESSAGE_LIMIT = 50

/** 右栏拖动：再窄放不下列表里的路径和按钮，再宽中间读对话的地方就没了 */
export const PANE_MIN = 280
/** 文件面板默认最宽多少：右栏是辅助，默认不和对话平分 */
export const FILES_PANE_CAP = 440
/**
 * AI 分析窗口里文件面板默认最宽多少：弹窗本身比页面窄（最宽 1300），440 会占去三分之一，
 * 分析对话才是主体，文件栏只是顺手翻文件（用户 2026-10-30 要求文件栏别太宽、比例合适）
 */
export const EMBED_FILES_PANE_CAP = 320
/** 会话栏的宽度，和中间对话至少要留的宽度：放不下时会话栏和右侧文件栏只显示后打开的那个 */
export const SESSION_BAR_W = 320
/** 会话栏和面板右边缘之间留给消息区滚动条的宽度（和 index.css 的 thin-scroll 一样宽） */
export const RAIL_GUTTER = 12
export const CONVERSATION_MIN = 640
/** 右栏拖动时中间至少留下的宽度 */
const PANE_GAP = 320
/** 功能面板盖在对话上时（窄屏抽屉、pane 里）的宽度：覆盖态没有并排可拖，按原来的定宽铺开 */
export const REPORT_COVER_WIDTH = 440
/** 功能面板比文件面板窄：评审卡片里是「徽标 + 标题」一行，比文件列表的路径行更省宽度 */
export const REPORT_PANE_MIN = 320

/**
 * 右栏的可拖上限：从右栏所在容器的宽度里扣掉中间至少要留的部分，不写死像素。
 * 容器要按自己那一栏量：AI 分析窗口是 Portal 挂在 body 末尾的，背景对话页的右栏同样还挂着，
 * 从 document 里取第一个会量到背景那一页，上限就按错的宽度算（拖动条挂到 max 时才发现拖不动）。
 */
export function paneMax(box: HTMLElement | null, min: number) {
  const row = box?.parentElement?.clientWidth ?? window.innerWidth
  return Math.max(min, row - PANE_GAP)
}

/**
 * 对半的栏宽：这台机器上拖过就用拖过的宽度（usePaneWidth 记的），没拖过就是本栏容器的一半
 * （用户 2026-11 要求有功能面板时默认功能面板和对话面板各占一半）。
 *
 * 一半按本栏自己的容器量，不按窗口：AI 分析窗口是弹窗、比窗口窄，侧栏收起时还会更宽。
 * 容器要等任务加载完、右栏真的挂上才有尺寸（见 TaskView 的 setRail），拿到之前先按窗口减掉左栏估算。
 * `rowWidth` 每次现量、不缓存：双击拖动条恢复默认时 usePaneWidth 会重新调一次初值函数，
 * 那时窗口可能已经改过大小，按缓存会回到旧的一半。
 */
export function useHalfPane(
  key: string,
  min: number,
  max: () => number,
  rowWidth: () => number,
  rowMounted: boolean,
  /** 默认宽度的上限：文件面板（项目文件 / 本对话改动）不用占一半，给对话留出主体宽度 */
  cap = Infinity,
) {
  const half = () =>
    typeof window === 'undefined'
      ? PANE_DEFAULT_SSR
      : Math.min(cap, paneHalfWidth(rowWidth() || rowWidthFromWindow(window.innerWidth), min))
  const pane = usePaneWidth(key, half, min, max)
  useLayoutEffect(() => {
    // 拖过的宽度原样用：用户的选择优先，量到容器也不会改回去
    if (!pane.stored && rowMounted) pane.fit(half())
    // 右栏挂上、能量出真实容器了才对半一次；窗口 resize 后不自动跟（和文件面板一样，栏宽算用户自己的布局）
    // pane 每次渲染都是新对象，放进依赖会一直重跑
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [rowMounted])
  return pane
}

/** 右栏开着哪个子对话按父任务 id 记在本地：切走窗口、重新加载后还显示原来那个 */

export function readStored(key: string) {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export function writeStored(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // 隐私模式禁用本地存储时只是不记住，不影响使用
  }
}

/** Chat 页右栏（代码 / 来源 / 附件）收起过就记一笔：所有聊天共用一个开关，默认开着 */
export const CHAT_RAIL_KEY = 'chat-rail'
export const NO_MESSAGES: TaskMessage[] = []

export const readPaneChild = (taskId: string) => readStored(paneChildKey(taskId))
export const readPaneRun = (taskId: string) => Number(readStored(paneRunKey(taskId))) || 0
/** 文件面板收没收起按对话记在本地：右栏「项目文件 / 本对话改动」默认开着，用户收起过才记一笔 */
export const readFilesFolded = (taskId: string) => readStored(paneFilesKey(taskId)) === 'closed'
export const writeFilesFolded = (taskId: string, folded: boolean) =>
  writeStored(paneFilesKey(taskId), folded ? 'closed' : '')
/** 会话栏（中间对话右边那一列，照 Claude Code）：所有对话共用一个开关，默认开着，收起过才记一笔 */
export const SESSION_BAR_KEY = 'task-session-bar'
/** 分析对话的功能面板默认开着：用户收起过才记一笔 */
export const readReportFolded = (taskId: string) => readStored(paneReportKey(taskId)) === 'closed'
export const writeReportFolded = (taskId: string, folded: boolean) =>
  writeStored(paneReportKey(taskId), folded ? 'closed' : '')
export function writePaneChild(taskId: string, childId: string) {
  writeStored(paneChildKey(taskId), childId)
  // 子对话和运行面板互斥：右栏同一时间只显示一个
  if (childId) writeStored(paneRunKey(taskId), '')
}
export function writePaneRun(taskId: string, run: number) {
  writeStored(paneRunKey(taskId), run ? String(run) : '')
  if (run) writeStored(paneChildKey(taskId), '')
}
