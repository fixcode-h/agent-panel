import type { Task, TaskMessage } from './schema.ts'

/**
 * 几个对话共用一个目录时的提醒（分析稿 A1）：发消息前告诉用户「同一个目录里有别的对话正在改文件」。
 *
 * 「独立分支」默认不勾（Project.isolateByDefault），几个顶层对话会一起在项目目录里改；每轮的改动已经按文件归属
 * （server/turn/owners.ts），但两边改到同一个文件、一边的命令动了另一边的文件，仍然会互相影响——只能提醒，不拦。
 * ADR 0051 当时放弃这条提醒的前提（默认开独立分支）已经不成立了。
 *
 * 判断只用面板状态和工具调用记录，不看回复文字。
 */

/** 提醒里列的一个对话 */
export interface DirPeer {
  id: string
  title: string
}

/** 接口返回的事实：peers 为空就不提醒；canIsolate 为假时不给「开独立分支」（子对话、不是 git 仓库） */
export interface SharedDirInfo {
  peers: DirPeer[]
  canIsolate: boolean
}

/**
 * 这一轮或上一轮改过文件：改文件的工具调用（失败的不算）或者记下的每轮改动。
 * 往回只看两条用户消息：很久以前改过、现在只是在查资料的对话不提醒
 */
export function editedLately(messages: Pick<TaskMessage, 'role' | 'step' | 'tools' | 'turnChanges'>[]): boolean {
  let users = 0
  for (let i = messages.length - 1; i >= 0 && users < 2; i--) {
    const m = messages[i]
    if (m.tools?.some((x) => x.kind === 'edit' && !x.failed)) return true
    if (m.turnChanges?.files.length && !m.turnChanges.revertedAt) return true
    if (m.role === 'user' && !m.step) users++
  }
  return false
}

/** 正在动手：自己在回复，或者名下的子任务、节点还在跑（它们也在这个目录里改） */
export const dirBusy = (tk: Pick<Task, 'working' | 'steps'>) =>
  !!tk.working || tk.steps.some((x) => x.status === 'running')

/** 参与判断的一个对话：dir 是它现在执行的目录，root 是它所在这棵对话树的顶层对话 */
export interface DirFacts {
  id: string
  title: string
  dir: string
  root: string
  busy: boolean
  edited: boolean
}

/**
 * 要提醒的对话：和 me 同一个目录、正在动手、最近改过文件，而且不是一家的。
 * 父对话和它的子对话不互相提醒：它们之间由面板协调（合并排队、有子对话在跑时父对话不改），提醒了用户也没法处理
 */
export function dirPeers(me: Pick<DirFacts, 'id' | 'dir' | 'root'>, others: DirFacts[]): DirPeer[] {
  if (!me.dir) return []
  return others
    .filter((x) => x.id !== me.id && x.root !== me.root && x.dir === me.dir && x.busy && x.edited)
    .map((x) => ({ id: x.id, title: x.title }))
}

/** 浏览器里「不再提示」记在哪：按项目记，换个项目照常提醒 */
export const sharedDirMuteKey = (projectId: string) => `agent-panel.shared-dir.mute.${projectId}`
