import { EN_AGENTS } from './en/agents.ts'
import { EN_ALERTS } from './en/alerts.ts'
import { EN_APP } from './en/app.ts'
import { EN_CHANGES } from './en/changes.ts'
import { EN_DESIGN } from './en/design.ts'
import { EN_EXTEND } from './en/extend.ts'
import { EN_FLOW } from './en/flow.ts'
import { EN_LOCAL_IMAGE } from './en/local-image.ts'
import { EN_MCP } from './en/mcp.ts'
import { EN_PROJECT_SKILLS } from './en/project-skills.ts'
import { EN_SCHEDULE } from './en/schedule.ts'
import { EN_SERVER } from './en/server.ts'
import { EN_SETTINGS } from './en/settings.ts'
import { EN_MARKDOWN_STYLE } from './en/markdown-style.ts'
import { EN_SHARED } from './en/shared.ts'
import { EN_SUMMARY } from './en/summary.ts'
import { EN_TASKS } from './en/tasks.ts'
import { EN_TOOL_NAMES } from './en/tool-names.ts'
import { EN_SPEECH } from './en/speech.ts'
import { EN_HOOKS } from './en/hooks.ts'
import { EN_CLI_MORE } from './en/cli-more.ts'
import { EN_EXPERIENCE } from './en/experience.ts'
import { EN_FILE_REF } from './en/file-ref.ts'
import { EN_BUG_FLOW } from './en/bug-flow.ts'
import { EN_BUG_LOCATE } from './en/bug-locate.ts'
import { EN_BUG_OVERVIEW } from './en/bug-overview.ts'
import { EN_USER_ACTION } from './en/user-action.ts'
import { EN_VIDEO } from './en/video.ts'
import { EN_RESTORE } from './en/restore.ts'
import { EN_RESTORE_FLOW } from './en/restore-flow.ts'
import { EN_REMOTE } from './en/remote.ts'
import { EN_PLUGINS } from './en/plugins.ts'

/** 英文词典：键是中文原文（含 {变量} 占位），值是英文。按界面区域分文件，scripts/i18n-check.mjs 检查有没有漏翻 */
export const EN: Record<string, string> = {
  // 视频截帧放最前：和别处同名的词（手动、自动、增强…）以别处已有的英文为准
  ...EN_VIDEO,
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
  ...EN_BUG_OVERVIEW,
  ...EN_USER_ACTION,
  ...EN_DESIGN,
  ...EN_RESTORE,
  ...EN_RESTORE_FLOW,
  ...EN_REMOTE,
  ...EN_EXTEND,
  ...EN_LOCAL_IMAGE,
  ...EN_MCP,
  ...EN_PROJECT_SKILLS,
  ...EN_SCHEDULE,
  ...EN_ALERTS,
  ...EN_SPEECH,
  ...EN_HOOKS,
  ...EN_CLI_MORE,
  ...EN_EXPERIENCE,
  ...EN_FILE_REF,
  ...EN_PLUGINS,
}
