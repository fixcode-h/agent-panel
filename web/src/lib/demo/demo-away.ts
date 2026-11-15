/**
 * 演示：「我不在」。开关和记录存在浏览器里；第一次打开时放一条自动选过的记录（挂在演示里第一个项目对话上），
 * 总览上能看到「自动选过的」长什么样、点「去改」能回到那个对话。演示版没有真的 CLI 在提问，开关不会再选别的
 */
import { addPick, AwayState, dropPicks, switchAway } from '@shared/away'
import type { Task } from '@shared/schema'

const KEY = 'demo-away'

const read = (): AwayState | undefined => {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? AwayState.parse(JSON.parse(raw)) : undefined
  } catch {
    return undefined
  }
}

const write = (s: AwayState) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {}
  return s
}

/**
 * 演示后端存数据的键（demo-backend.ts）。直接读浏览器里的演示数据，不走演示后端的请求：
 * 那边的请求会把内存里的整份数据写回去，多一个请求就多一次盖掉界面检查刚改过的数据的机会
 */
const DB_KEY = 'agent-panel-demo-v3'

const demoTasks = (): Task[] => {
  try {
    return JSON.parse(localStorage.getItem(DB_KEY) ?? '{}').tasks ?? []
  } catch {
    return []
  }
}

/** 第一次：挂一条示例记录在第一个项目对话上（演示数据还没生成时先不记，下次再试） */
async function seed(): Promise<AwayState> {
  const tasks = demoTasks()
  const tk = tasks.find((x) => x.projectId && !x.parentTaskId && !x.archived)
  let s = AwayState.parse({})
  if (tk)
    s = addPick(s, {
      id: 'demo-away-1',
      taskId: tk.id,
      projectId: tk.projectId,
      taskTitle: tk.title,
      items: [{ question: '新加的配置项放在哪个文件？', picked: '放进现有的 settings.ts（推荐）' }],
      at: new Date(Date.now() - 40 * 60_000).toISOString(),
    })
  return tasks.length ? write(s) : s
}

export const demoAwayGet = async () => read() ?? (await seed())
export const demoAwaySet = async (on: boolean) => write(switchAway(await demoAwayGet(), on))
export const demoAwayDrop = async (id?: string) => write(dropPicks(await demoAwayGet(), id))
