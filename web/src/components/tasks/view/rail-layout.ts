/**
 * 对话页这一行里谁显示：会话栏、右侧文件栏 / 功能面板 / Chat 右栏放不放得下，放不下时谁让。
 * 从 TaskView.tsx 拆出来（重构文档第 13 条），只按传进来的宽度和开关算，不碰状态
 */
import { CONVERSATION_MIN, SESSION_BAR_W } from '../task-view-pane'

export interface RailInput {
  /** 对话加右栏这一整行的宽度 */
  rowW: number
  /** 会话栏这一边能不能出现（右栏里的子对话、AI 窗口、中间开着运行页签时都不画） */
  sessionAllowed: boolean
  sessionOpen: boolean
  /** Chat 页的右栏：开着、有内容、没被功能面板占着 */
  chatRailWanted: boolean
  reportOn: boolean
  reportW: number
  taskPanelW: number
  childOn: boolean
  /** 诊断报告停靠在右栏 */
  bugRail: boolean
  filesFolded: boolean
  noFiles: boolean
  /** 后打开的是哪一边：auto 是还没手动开过 */
  lastRail: 'session' | 'files' | 'auto'
  /** 插件页签标了 home 的对话：放不下时会话栏让开 */
  pluginHome: boolean
}

export function railLayout(c: RailInput) {
  const chatRailW = Math.min(420, c.rowW * 0.4)
  const sideW = c.reportOn ? c.reportW : c.chatRailWanted ? chatRailW : c.taskPanelW
  const sideWanted = c.reportOn || c.childOn || c.bugRail || (!c.filesFolded && !c.noFiles) || c.chatRailWanted
  // 会话栏放不放得下：先保中间对话的最小宽度；再加上右侧那一栏（文件或功能面板）也放得下就并排，
  // 放不下时后打开的那个留着，另一个让开（文件栏让开时只是不显示，不记成收起）
  const sessionFits = c.rowW >= SESSION_BAR_W + CONVERSATION_MIN
  const bothFit = c.rowW >= SESSION_BAR_W + CONVERSATION_MIN + sideW
  const sessionShown =
    c.sessionAllowed &&
    c.sessionOpen &&
    sessionFits &&
    // 插件右栏页签标了 home 的对话（例如模型设计的 3D 预览）：放不下时会话栏让开，不让预览被挤掉
    (bothFit ||
      !sideWanted ||
      (c.lastRail !== 'files' && !c.reportOn && !c.pluginHome && !(c.chatRailWanted && c.lastRail === 'auto')))
  const filesYield = !c.reportOn && !c.childOn && !c.bugRail && !c.filesFolded && sessionShown && !bothFit
  // 放不下时 Chat 右栏和文件栏一样给会话栏让开（后打开的那个留着）
  const chatRailShown = c.chatRailWanted && !(sessionShown && !bothFit)
  const filesHidden = (c.filesFolded && !c.childOn && !c.bugRail) || filesYield
  return { sessionFits, sessionShown, filesYield, chatRailShown, filesHidden }
}
