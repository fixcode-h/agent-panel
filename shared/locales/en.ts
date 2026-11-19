import { EN_AGENTS } from './en/agents.ts'
import { EN_ALERTS } from './en/alerts.ts'
import { EN_APP } from './en/app.ts'
import { EN_CHANGES } from './en/changes.ts'
import { EN_DESIGN } from './en/design.ts'
import { EN_EXTEND } from './en/extend.ts'
import { EN_FLOW } from './en/flow.ts'
import { EN_LOCAL_IMAGE } from './en/local-image.ts'
import { EN_MCP } from './en/mcp.ts'
import { EN_MCP_CATALOG } from './en/mcp-catalog.ts'
import { EN_PROJECT_SKILLS } from './en/project-skills.ts'
import { EN_PROJECT_SIDEBAR } from './en/project-sidebar.ts'
import { EN_PROJECT_CAPS } from './en/project-caps.ts'
import { EN_SCHEDULE } from './en/schedule.ts'
import { EN_SCHEDULE_TRIGGER } from './en/schedule-trigger.ts'
import { EN_SERVER } from './en/server.ts'
import { EN_SETTINGS } from './en/settings.ts'
import { EN_MARKDOWN_STYLE } from './en/markdown-style.ts'
import { EN_SHARED } from './en/shared.ts'
import { EN_SUMMARY } from './en/summary.ts'
import { EN_TASKS } from './en/tasks.ts'
import { EN_TOOL_NAMES } from './en/tool-names.ts'
import { EN_SHEETS } from './en/sheets.ts'
import { EN_SHEET_LOOK } from './en/sheet-look.ts'
import { EN_SPEECH } from './en/speech.ts'
import { EN_HOOKS } from './en/hooks.ts'
import { EN_CONFIG_SCAN } from './en/config-scan.ts'
import { EN_PLUGIN_WRAP } from './en/plugin-wrap.ts'
import { EN_CLI_MORE } from './en/cli-more.ts'
import { EN_NOTIFY_CHANNELS } from './en/notify-channels.ts'
import { EN_EXPERIENCE } from './en/experience.ts'
import { EN_KNOWLEDGE_UI } from './en/knowledge-ui.ts'
import { EN_FILE_REF } from './en/file-ref.ts'
import { EN_MD_TABLE } from './en/md-table.ts'
import { EN_SHEET } from './en/sheet.ts'
import { EN_BUG_FLOW } from './en/bug-flow.ts'
import { EN_BUG_LOCATE } from './en/bug-locate.ts'
import { EN_CALL_TREE } from './en/call-tree.ts'
import { EN_STRUCTURE_VIEWS } from './en/structure-views.ts'
import { EN_WEB_VIEW } from './en/web-view.ts'
import { EN_TURN_OUTPUTS } from './en/turn-outputs.ts'
import { EN_TURN_SCOPE } from './en/turn-scope.ts'
import { EN_FOLD_BAR } from './en/fold-bar.ts'
import { EN_LIVE_TEXT } from './en/live-text.ts'
import { EN_BUG_OVERVIEW } from './en/bug-overview.ts'
import { EN_FLOW_OVERVIEW } from './en/flow-overview.ts'
import { EN_BUG_EVIDENCE } from './en/bug-evidence.ts'
import { EN_BUG_PROBE } from './en/bug-probe.ts'
import { EN_BUG_INPLACE } from './en/bug-inplace.ts'
import { EN_BUG_AUTO } from './en/bug-auto.ts'
import { EN_BUG_ASK } from './en/bug-ask.ts'
import { EN_BUG_CHAT } from './en/bug-chat.ts'
import { EN_USER_ACTION } from './en/user-action.ts'
import { EN_STAGE_REPORT } from './en/stage-report.ts'
import { EN_AWAY } from './en/away.ts'
import { EN_QUOTA_RESUME } from './en/quota-resume.ts'
import { EN_STATE_WORD } from './en/state-word.ts'
import { EN_RESTORE } from './en/restore.ts'
import { EN_RESTORE_FLOW } from './en/restore-flow.ts'
import { EN_REMOTE } from './en/remote.ts'
import { EN_PLUGINS } from './en/plugins.ts'
import { EN_SHARED_DIR } from './en/shared-dir.ts'
import { EN_DONE_GUARD } from './en/done-guard.ts'
import { EN_UI_POLISH } from './en/ui-polish.ts'
import { EN_SELECT_SEARCH } from './en/select-search.ts'
import { EN_MODAL_RESIZE } from './en/modal-resize.ts'
import { EN_TOAST } from './en/toast.ts'
import { EN_SCROLLBAR } from './en/scrollbar.ts'
import { EN_SECTION_RAIL } from './en/section-rail.ts'
import { EN_GRAPH_CANVAS } from './en/graph-canvas.ts'
import { EN_MODEL_CATALOG } from './en/model-catalog.ts'

/** 英文词典：键是中文原文（含 {变量} 占位），值是英文。按界面区域分文件，scripts/i18n-check.mjs 检查有没有漏翻 */
export const EN: Record<string, string> = {
  // 视频截帧放最前：和别处同名的词（手动、自动、增强…）以别处已有的英文为准
  ...EN_SHARED,
  ...EN_SERVER,
  ...EN_APP,
  ...EN_SUMMARY,
  ...EN_CHANGES,
  ...EN_AGENTS,
  ...EN_FLOW,
  ...EN_SETTINGS,
  ...EN_MARKDOWN_STYLE,
  ...EN_TASKS,
  ...EN_TOOL_NAMES,
  ...EN_BUG_FLOW,
  ...EN_BUG_LOCATE,
  ...EN_CALL_TREE,
  ...EN_STRUCTURE_VIEWS,
  ...EN_WEB_VIEW,
  ...EN_TURN_OUTPUTS,
  ...EN_TURN_SCOPE,
  ...EN_FOLD_BAR,
  ...EN_LIVE_TEXT,
  ...EN_BUG_OVERVIEW,
  ...EN_FLOW_OVERVIEW,
  ...EN_BUG_EVIDENCE,
  ...EN_BUG_PROBE,
  ...EN_BUG_INPLACE,
  ...EN_BUG_AUTO,
  ...EN_BUG_ASK,
  ...EN_BUG_CHAT,
  ...EN_USER_ACTION,
  ...EN_STAGE_REPORT,
  ...EN_AWAY,
  ...EN_QUOTA_RESUME,
  ...EN_DESIGN,
  ...EN_RESTORE,
  ...EN_RESTORE_FLOW,
  ...EN_REMOTE,
  ...EN_EXTEND,
  ...EN_LOCAL_IMAGE,
  ...EN_MCP,
  ...EN_MCP_CATALOG,
  ...EN_PROJECT_SKILLS,
  ...EN_PROJECT_SIDEBAR,
  ...EN_PROJECT_CAPS,
  ...EN_SCHEDULE,
  ...EN_SCHEDULE_TRIGGER,
  ...EN_ALERTS,
  ...EN_SPEECH,
  ...EN_HOOKS,
  ...EN_CONFIG_SCAN,
  ...EN_PLUGIN_WRAP,
  ...EN_CLI_MORE,
  ...EN_NOTIFY_CHANNELS,
  ...EN_EXPERIENCE,
  ...EN_KNOWLEDGE_UI,
  ...EN_FILE_REF,
  ...EN_MD_TABLE,
  ...EN_SHEET,
  ...EN_PLUGINS,
  ...EN_SHARED_DIR,
  ...EN_STATE_WORD,
  ...EN_DONE_GUARD,
  ...EN_UI_POLISH,
  ...EN_SELECT_SEARCH,
  ...EN_MODAL_RESIZE,
  ...EN_TOAST,
  ...EN_SCROLLBAR,
  ...EN_SECTION_RAIL,
  ...EN_GRAPH_CANVAS,
  ...EN_MODEL_CATALOG,
  ...EN_SHEETS,
  ...EN_SHEET_LOOK,
}
