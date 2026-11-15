/**
 * 对话页这一行（中间对话 + 右栏）的尺寸：整行实测宽度、右栏挂载时机、文件面板和功能面板各自的宽度。
 * 从 TaskView.tsx 拆出来（复查报告 B2）：页面只拿 ref 和宽度交给 railLayout、TaskSideRail
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EMBED_FILES_PANE_CAP,
  FILES_PANE_CAP,
  PANE_MIN,
  REPORT_PANE_MIN,
  paneMax,
  useHalfPane,
} from '../task-view-pane'

/** embed：放在 AI 分析窗口里，文件面板单独记宽度、上限也不同 */
export function useTaskRail(embed: boolean) {
  // 对话加右栏这一整行的宽度：按它算会话栏放不放得下
  const [rowW, setRowW] = useState(0)
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!rowEl) return
    const ro = new ResizeObserver(() => setRowW(rowEl.clientWidth))
    ro.observe(rowEl)
    return () => ro.disconnect()
  }, [rowEl])
  // 右栏自己这一栏：量拖动上限、量对半都以它为基准，不按全局第一个右栏（见 paneMax）
  const rail = useRef<HTMLElement>(null)
  // 右栏挂上没有要等任务加载完才知道：aside 挂上前 ref 是 null（useEffect 里那时读到的也是 null，
  // 量出来会是窗口估算值），所以用回调 ref 记下挂载时机，挂上之后再按真实容器对半
  const [railMounted, setRailMounted] = useState(false)
  const setRail = useCallback((el: HTMLElement | null) => {
    rail.current = el
    setRailMounted(!!el)
  }, [])
  // 这一行有多宽（右栏加中间的对话）：右栏默认宽度按它的一半算，每次现量（见 useHalfPane）
  const rowWidth = useCallback(() => rail.current?.parentElement?.clientWidth ?? 0, [])
  // 功能面板默认和中间对话对半（见 lib/pane-width.ts）；文件面板对半但最宽 FILES_PANE_CAP，右栏只是辅助。
  // 手动拖过之后按拖动后的宽度、双击拖动条也回到对半；上限至少留出中间 320
  // AI 分析窗口单独记一个宽度：对话页上拖宽过的文件面板不该把弹窗里的也撑宽
  const taskPanel = useHalfPane(
    embed ? 'ai-task-panel' : 'task-panel',
    PANE_MIN,
    () => Math.max(340, paneMax(rail.current, PANE_MIN)),
    rowWidth,
    railMounted,
    embed ? EMBED_FILES_PANE_CAP : FILES_PANE_CAP,
  )
  // 和文件面板并排在同一栏，但宽度偏好不同，各自记一个（共用 key 会互相改成对方拖过的宽度）
  const reportPane = useHalfPane(
    'report-panel',
    REPORT_PANE_MIN,
    () => paneMax(rail.current, REPORT_PANE_MIN),
    rowWidth,
    railMounted,
  )
  return { rowW, setRowEl, setRail, taskPanel, reportPane }
}
