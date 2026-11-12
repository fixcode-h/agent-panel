/**
 * 面板 MCP 工具注册表（重构文档第 4 条）：每个面板工具一个条目 { name, when, def, hint, call }，
 * 清单（orchTools）、用法说明里的条件和措辞（orchHint，server/orch-hint.ts）、执行（callOrchTool）都从这张表生成。
 * 加一个面板工具：在对应文件里写条目，再按清单里该出现的位置加进下面的 PANEL_TOOLS，名字登记进 shared/panel-tools.ts。
 *
 * 顺序就是交给 CLI 的清单顺序（改了会让各身份的清单快照、Pi 桥接的核对跟着变）。
 */
import type { Orchestra } from '../../shared/engine.ts'
import { ASK_PUSH_ENTRY } from '../ask-push.ts'
import { BACKGROUND_TOOLS } from '../background-tools.ts'
import { DIAGNOSIS_TOOLS } from '../diagnosis-tool.ts'
import { END_TURN } from '../end-turn-tool.ts'
import { MEMORY } from '../memory-tool.ts'
import { SUBMIT_TOOLS } from '../submit-tools.ts'
import { USER_ACTION } from '../user-action-tool.ts'
import { WORKFLOW_TOOLS } from '../workflow-tools.ts'
import { PEER_TOOLS, REQUEST_BUILD_CHILD, REQUEST_BUILD_PARENT } from './build.ts'
import { CLAIM_TOOLS, MESSAGE_PARENT, SUBMIT_MERGE, SUGGEST_NEXT_STEP } from './child.ts'
import { CONVERSATION_TOOLS, FINISH_CHILD } from './conversations.ts'
import { BEGIN_EDIT, INLINE_EDIT, USE_CAPABILITY } from './edit.ts'
import { EXPERIENCE_TOOLS, LESSON_TOOLS } from './knowledge.ts'
import { PLAN_TOOLS, START_PLAN } from './plan.ts'
import { SPAWN_TOOLS } from './spawn.ts'
import { GET_STATUS, MESSAGES, SHARED_STATE } from './team.ts'
import { text, type HintAt, type PanelTool, type ToolArgs, type ToolDef, type ToolResult } from './types.ts'
import { CHERRY_PICK, P4_SPLIT } from './vcs.ts'

export const PANEL_TOOLS: readonly PanelTool[] = [
  GET_STATUS,
  BEGIN_EDIT,
  ...BACKGROUND_TOOLS,
  ...PLAN_TOOLS,
  ...WORKFLOW_TOOLS,
  ...CONVERSATION_TOOLS,
  ...INLINE_EDIT,
  USE_CAPABILITY,
  REQUEST_BUILD_PARENT,
  ...PEER_TOOLS,
  FINISH_CHILD,
  MESSAGE_PARENT,
  SUGGEST_NEXT_STEP,
  SUBMIT_MERGE,
  REQUEST_BUILD_CHILD,
  ...CLAIM_TOOLS,
  P4_SPLIT,
  CHERRY_PICK,
  ASK_PUSH_ENTRY,
  END_TURN,
  USER_ACTION,
  ...DIAGNOSIS_TOOLS,
  MEMORY,
  ...LESSON_TOOLS,
  ...EXPERIENCE_TOOLS,
  ...SHARED_STATE,
  ...SPAWN_TOOLS,
  ...MESSAGES,
  ...SUBMIT_TOOLS,
  // 只认调用、不再列出的旧工具
  START_PLAN,
]

/** 按能力给工具（ADR 0038）：这个调用者这一轮的面板工具清单 */
export function orchTools(o: Orchestra): ToolDef[] {
  return PANEL_TOOLS.flatMap((t) => (t.def && t.when(o) ? [t.def(o)] : []))
}

/** 这个调用者有没有这个工具（和清单同一个判断） */
export const hasTool = (o: Orchestra, name: string) => PANEL_TOOLS.some((t) => t.name === name && !!t.def && t.when(o))

/**
 * 工具在用法说明这个位置上的那一句：调用者没有这个工具时是空串。
 * 同名的几份（request_build）各自按位置给，拼在一起
 */
export function toolHint(o: Orchestra, name: string, at: HintAt) {
  return PANEL_TOOLS.filter((t) => t.name === name && t.hint && t.when(o))
    .map((t) => t.hint!(o, at))
    .join('')
}

/** 按名字（或旧名字）找条目：同名的几份执行相同，取第一份 */
export const findTool = (name: string) => PANEL_TOOLS.find((t) => t.name === name || t.aliases?.includes(name))

/**
 * 执行一个工具调用：不看 when（ask-mcp.ts 只把清单里有的交过来；测试和旧会话会直接按名字调，
 * 用不了的由各工具自己说清楚为什么）
 */
export async function callOrchTool(o: Orchestra, name: string, a: ToolArgs, signal?: AbortSignal): Promise<ToolResult> {
  const t = findTool(name)
  return t ? t.call(o, a, signal) : text(`没有这个工具：${name}`, true)
}
