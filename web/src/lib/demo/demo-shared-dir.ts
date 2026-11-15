/**
 * 演示：几个对话共用一个目录时的提醒（shared/shared-dir.ts），和正式后端用同一套判断。
 * 演示里没有真的目录：没开独立分支的都算在项目目录里，开了的各在各的分支。
 * 单独一个文件：demo-backend.ts 贴着行数上限
 */
import type { Task } from '@shared/schema'
import { dirBusy, dirPeers, editedLately, type DirFacts, type SharedDirInfo } from '@shared/shared-dir'
import { sharesWorkdir } from '@shared/task'

function facts(tk: Task, all: Task[]): DirFacts {
  let root = tk
  const seen = new Set<string>()
  while (root.parentTaskId && !seen.has(root.id)) {
    seen.add(root.id)
    const p = all.find((x) => x.id === root.parentTaskId)
    if (!p) break
    root = p
  }
  return {
    id: tk.id,
    title: tk.title,
    dir: tk.worktree?.state === 'active' ? `wt:${tk.id}` : `project:${tk.projectId}`,
    root: root.id,
    busy: dirBusy(tk),
    edited: editedLately(tk.messages),
  }
}

export function demoSharedDir(task: Task, all: Task[]): SharedDirInfo {
  if (!task.projectId || task.imported || !sharesWorkdir(task)) return { peers: [], canIsolate: false }
  const others = all.filter((x) => x.id !== task.id && x.projectId === task.projectId && dirBusy(x))
  const peers = dirPeers(
    facts(task, all),
    others.map((x) => facts(x, all)),
  )
  return { peers, canIsolate: peers.length > 0 && !task.parentTaskId }
}

/** 「这个对话开独立分支」：演示里只挂上一个分支记录，输入框上方的分支状态行跟着出现 */
export function demoIsolate(task: Task) {
  if (task.working) throw new Error('对话正在执行，等这一轮结束后再开独立分支')
  const branch = `agent-panel/${task.id.slice(0, 8)}`
  task.worktree = {
    path: `E:\\Project\\demo\\.agent-panel\\worktrees\\${branch.replace(/[/\\]/g, '-')}`,
    branch,
    baseBranch: 'main',
    state: 'active',
    note: '',
  }
  return task
}
