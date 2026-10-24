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
import { EN_SERVER } from './en/server.ts'
import { EN_SETTINGS } from './en/settings.ts'
import { EN_SHARED } from './en/shared.ts'
import { EN_TASKS } from './en/tasks.ts'

/** 英文词典：键是中文原文（含 {变量} 占位），值是英文。按界面区域分文件，scripts/i18n-check.mjs 检查有没有漏翻 */
export const EN: Record<string, string> = {
  ...EN_SHARED,
  ...EN_SERVER,
  ...EN_APP,
  ...EN_CHANGES,
  ...EN_AGENTS,
  ...EN_FLOW,
  ...EN_SETTINGS,
  ...EN_TASKS,
  ...EN_DESIGN,
  ...EN_EXTEND,
  ...EN_LOCAL_IMAGE,
  ...EN_MCP,
  ...EN_PROJECT_SKILLS,
  ...EN_ALERTS,
}
