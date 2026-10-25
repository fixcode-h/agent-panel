import type { Agent, Task } from './schema.ts'

/**
 * AI 分析开在哪里（归属）：面板上所有「AI 分析」「AI 排查」都先按这一份规则定好放哪，再新建对话。
 *
 * - 对话、子对话、子任务里的分析：在它所属的那棵对话树的父对话（顶层对话）下开一个子对话。
 *   子对话的父对话、子任务所在对话的父对话都一样往上找到顶层对话——子对话不能再开子对话，这条底线不破。
 * - 项目相关（项目设置、项目的 Skill / MCP、导入的只读记录、跨对话的执行分析）：在这个项目里开一个顶层对话。
 * - 归不到项目的（面板设置、CLI、本机环境、面板内存）：开 Chat 模式的对话。
 *
 * 分析对话统一用必备角色「分析」（builtin:analyzer），找不到时退回不用角色。
 */
export type AnalysisScope =
  /** 某个对话（顶层或子对话）或它名下子任务的分析；task 只用到这几个字段 */
  | { kind: 'task'; task: Pick<Task, 'id' | 'projectId' | 'parentTaskId' | 'rootTaskId' | 'mode' | 'imported'> }
  /** 项目里的分析，不挂在某个对话下 */
  | { kind: 'project'; projectId: string }
  /** 和项目无关：Chat 模式 */
  | { kind: 'chat' }

export interface AnalysisHome {
  projectId: string
  /** 开成哪个对话的子对话；空表示顶层对话（项目对话或 Chat） */
  parentTaskId: string
  /** 给界面说明放在哪：子对话 / 项目对话 / Chat */
  place: 'child' | 'project' | 'chat'
}

/**
 * 能挂子对话的父对话：项目里的直接对话（工作流执行和导入的只读记录不行，Chat 模式的没有子对话）。
 * 传进来的是顶层对话本身
 */
const canHostChild = (root: Pick<Task, 'projectId' | 'mode' | 'imported'>) =>
  !!root.projectId && root.mode === 'chat' && !root.imported

/**
 * 按归属规则定分析对话放哪。scope 是 task 时要传它的顶层对话（rootOf 取），
 * 因为子对话里的 mode / imported 说明不了父对话能不能挂子对话
 */
export function analysisHome(
  scope: AnalysisScope,
  root?: Pick<Task, 'id' | 'projectId' | 'mode' | 'imported'>,
): AnalysisHome {
  if (scope.kind === 'chat') return { projectId: '', parentTaskId: '', place: 'chat' }
  if (scope.kind === 'project')
    return scope.projectId
      ? { projectId: scope.projectId, parentTaskId: '', place: 'project' }
      : { projectId: '', parentTaskId: '', place: 'chat' }
  const tk = scope.task
  if (!tk.projectId) return { projectId: '', parentTaskId: '', place: 'chat' }
  const top = root && root.id === rootIdOf(tk) ? root : !tk.parentTaskId ? tk : undefined
  if (top && canHostChild(top)) return { projectId: tk.projectId, parentTaskId: top.id, place: 'child' }
  return { projectId: tk.projectId, parentTaskId: '', place: 'project' }
}

/** 对话所在那棵树的顶层对话 id：顶层对话是它自己，子对话是它的父对话（只有一层子对话，rootTaskId 兜旧数据） */
export const rootIdOf = (tk: Pick<Task, 'id' | 'parentTaskId' | 'rootTaskId'>) =>
  tk.parentTaskId ? tk.rootTaskId || tk.parentTaskId : tk.id

/** 分析对话用的角色：必备角色「分析」；没装上（旧数据、演示）时返回空，按不用角色开 */
export const analyzerId = (agents: Pick<Agent, 'id' | 'origin' | 'enabled'>[]) =>
  agents.find((a) => a.origin === 'builtin:analyzer' && a.enabled)?.id ?? ''
