import { t } from '@shared/i18n'
import { registerPrefs, type PrefFamily } from './index'

/**
 * 面板自己记在本机的界面状态（族的登记，见 ./index.ts）。新加一个要记的东西：在这里加一项（或用已有的前缀），
 * 读写用 local.*；设置 →「外观」→「记住的界面状态」会自动列出来
 */
const BUILTIN: PrefFamily[] = [
  { id: 'pane', prefix: 'pane:', label: () => t('分栏和面板的宽度、高度'), group: 'layout' },
  { id: 'modal-size', prefix: 'modal-size:', label: () => t('弹窗大小'), group: 'layout' },
  { id: 'minimized-chat', key: 'minimized-chat-pos', label: () => t('最小化对话的位置'), group: 'layout' },
  { id: 'rail', key: 'activity-bar', label: () => t('左侧图标栏展开 / 收起'), group: 'layout' },
  { id: 'sidebar', key: 'sidebar', label: () => t('侧栏开关'), group: 'layout' },
  { id: 'chat-rail', key: 'chat-rail', label: () => t('对话右栏'), group: 'layout' },
  // 对话右栏开着哪个子对话、运行、文件、报告：按对话记（lib/ai-window.ts 的 pane*Key）
  { id: 'task-child', prefix: 'task-child:', label: () => t('对话右栏开着的子对话'), group: 'view' },
  { id: 'task-run', prefix: 'task-run:', label: () => t('对话右栏开着的运行'), group: 'view' },
  { id: 'task-files', prefix: 'task-files:', label: () => t('对话右栏开着的文件'), group: 'view' },
  { id: 'task-report', prefix: 'task-report:', label: () => t('对话右栏开着的报告'), group: 'view' },
  { id: 'session-bar', key: 'session-bar:folded', label: () => t('会话栏折叠'), group: 'layout' },
  { id: 'task-session-bar', key: 'task-session-bar', label: () => t('对话页会话栏'), group: 'layout' },
  { id: 'header-pins', key: 'task-header-pins', label: () => t('对话页顶栏固定的按钮'), group: 'view' },
  { id: 'diagnosis', key: 'diagnosis-docked', label: () => t('诊断窗口停靠'), group: 'layout' },
  { id: 'diagnosis-shown', prefix: 'diagnosis-shown:', label: () => t('诊断窗口已看过'), group: 'other' },
  { id: 'sidebar-days', key: 'sidebar-chat-days', label: () => t('侧栏对话按天分组的展开'), group: 'view' },
  { id: 'sidebar-older', key: 'sidebar-project-older-open', label: () => t('侧栏更早的项目展开'), group: 'view' },
  { id: 'agents-collapsed', key: 'agents.collapsed', label: () => t('角色页折叠的分组'), group: 'view' },
  { id: 'role-tab', key: 'role-tab', label: () => t('角色详情的页签'), group: 'view' },
  { id: 'run-view', key: 'run-view-tab', label: () => t('运行卡片的页签'), group: 'view' },
  { id: 'schedules-view', key: 'schedules:view', label: () => t('定时计划的视图'), group: 'view' },
  { id: 'library-tab', key: 'library.tab', label: () => t('资料库的页签'), group: 'view' },
  { id: 'summary-page', key: 'summary-page:v2', label: () => t('总结页的显示方式'), group: 'view' },
  { id: 'web-tabs', prefix: 'web-tabs:', label: () => t('网页查看器打开的标签'), group: 'view' },
  { id: 'web-reader', key: 'web-reader-sites', label: () => t('网页阅读模式的网站'), group: 'view' },
  { id: 'sheet-header', prefix: 'sheet-header:', label: () => t('表格查看的表头设置'), group: 'view' },
  { id: 'gh-download', key: 'tools:gh-download', label: () => t('GitHub 加速下载的输入'), group: 'other' },
  { id: 'chat-quotes', key: 'chat-quotes', label: () => t('对话里待发送的引用'), group: 'other' },
  { id: 'task-unread', key: 'task-unread', label: () => t('对话的未读标记'), group: 'other' },
  { id: 'schedule-seen', key: 'schedule-alerts-seen', label: () => t('看过的定时计划提醒'), group: 'other' },
  { id: 'last-project', key: 'last-project', label: () => t('上次打开的项目'), group: 'other' },
  { id: 'current-project', key: 'current-project', label: () => t('当前项目'), group: 'other' },
  { id: 'ask-user', key: 'ask-user-default', label: () => t('提问卡片的默认选项'), group: 'other' },
  { id: 'notify-done', key: 'notify-task-done', label: () => t('对话完成时的系统通知'), group: 'settings' },
  { id: 'cli-limits', key: 'agent-panel:cli-limits', label: () => t('CLI 用量的显示'), group: 'view' },
  { id: 'theme', key: 'theme', label: () => t('主题（浅色 / 深色）'), group: 'settings' },
  { id: 'lang', key: 'lang', label: () => t('界面语言'), group: 'settings' },
  { id: 'appearance', prefix: 'appearance', label: () => t('外观（配色、字体、Markdown 样式）'), group: 'settings' },
]

let done = false // 模块状态：运行时，只登记一次

export function registerBuiltinPrefs() {
  if (done) return
  done = true
  registerPrefs(BUILTIN)
}
