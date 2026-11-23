/**
 * 标题栏 / 「更多操作」里开关右侧几栏的按钮：会话栏、功能面板、文件面板、Chat 右栏。
 * 放不下时有一栏是给别人让开、只是没显示，开关要连它一起算，规则都在这里。
 * 从 TaskView.tsx 拆出来（复查报告 B2）：只按传进来的状态和开关动作算，不自己持有状态
 */
import { SESSION_BAR_KEY, writeStored } from '../task-view-pane'
import type { useTaskPanes } from './use-task-panes'

export interface RailTogglesCtx {
  panes: ReturnType<typeof useTaskPanes>
  /** 文件栏给会话栏让开了位置（见 railLayout） */
  filesYield: boolean
  chatRailWanted: boolean
  chatRailShown: boolean
  /** 只有来源：右栏开关只管这段聊天里看一眼（panes.chatRailPeek），不动全局开关 */
  chatRail: { quiet: boolean }
  reportOn: boolean
  closeReport: () => void
}

export function railToggles({
  panes,
  filesYield,
  chatRailWanted,
  chatRailShown,
  chatRail,
  reportOn,
  closeReport,
}: RailTogglesCtx) {
  const toggleChat = () => (chatRail.quiet ? panes.setChatRailPeek((v) => !v) : panes.toggleChatRail())
  return {
    session: (v: boolean) => {
      panes.setSessionOpen(v)
      writeStored(SESSION_BAR_KEY, v ? '' : 'closed')
      if (v) panes.setLastRail('session')
      // 放不下时右侧那一栏是给会话栏让开、只是没显示：收起会话栏时一起记成收起，
      // 不然它会立刻补回原位，看起来像右边的面板没收起来（用户报「收起面板点击无效」）
      else if (filesYield) panes.toggleFiles()
      else if (chatRailWanted && !chatRailShown) toggleChat()
    },
    reportWide: () => {
      if (reportOn) return closeReport()
      panes.foldReport(false)
    },
    // 宽屏右栏一直占着位置，这个按钮把文件面板收起来，让对话用满整个宽度
    filesWide: () => {
      panes.setLastRail('files')
      // 功能面板占着右栏：收起它换成文件
      if (reportOn) {
        panes.foldReport(true)
        if (panes.filesFolded) panes.toggleFiles()
        return
      }
      // 给会话栏让开了位置的：点了就换回文件，不是收起
      if (filesYield) return
      panes.toggleFiles()
    },
    chatRail: () => {
      panes.setLastRail('files')
      // 给会话栏让开了位置的：点了就换回右栏，不是收起
      if (chatRailWanted && !chatRailShown) return
      toggleChat()
    },
  }
}
