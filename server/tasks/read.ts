/**
 * 读任务的唯一入口（复查报告 A1）：正在运行的对话内存里有一份（就地改），盘上还有一份。
 * 各处以前手写「live.get(id)?.task ?? store.get(id)」，绕过了 idle() 的纠正，
 * 会把一个早就没进程的对话当成「执行中」。按 id 取用 currentTask，手里已有一份（列表、快照）用 freshTask（只读显示的再套 idleTask）。
 * 写成只要 live、store 的普通函数，测试里的假 scope 不用跟着加成员。
 */
import type { Task } from '../../shared/schema.ts'
import type { TasksScope } from './scope.ts'

type Reads = Pick<TasksScope, 'live' | 'store'>

/**
 * 落盘里还写着「执行中」、内存里却没有这个任务：进程早就不在了（面板重启过、崩溃过）。
 * 按已停止返回，否则页面会一直显示执行中，也不会把 CLI 重新启动回来。
 */
export const idleTask = (sc: Pick<TasksScope, 'live'>, task: Task): Task =>
  task.status === 'running' && !sc.live.has(task.id)
    ? {
        ...task,
        status: 'stopped' as const,
        stopReason: 'restart' as const,
        working: false,
        awaitingUser: false,
        prewarming: false,
      }
    : task

/**
 * 手里的一份任务（列表、快照、调用方传进来的）换成内存里那份：在跑的以内存为准。
 * 不做 idle 纠正：调用方常常接着就地改它再落盘，纠正会换成一份拷贝，改动就丢了；只读显示的再套一层 idleTask
 */
export const freshTask = (sc: Pick<TasksScope, 'live'>, task: Task): Task => sc.live.get(task.id)?.task ?? task

/**
 * 按 id 取要就地改的那一份：在跑的取内存那份，其余取盘上那份（store 缓存里的同一个对象），不做 idle 纠正。
 * 改完照常落盘；纠正会换成拷贝，别处再读缓存就看不到这次改动。
 * 只读来判断、显示的用 currentTask。等 working、awaitingUser 这些运行时字段搬出任务记录（复查报告 A1 第 3 步），
 * idle 只剩改 status 一件事，两者再合成一个。
 */
export async function readTask(sc: Reads, id: string): Promise<Task | null> {
  return sc.live.get(id)?.task ?? (await sc.store.get(id))
}

/** 按 id 取任务（含完整对话）来判断、显示：在跑的取内存那份，其余读盘并纠正盘上残留的「执行中」 */
export async function currentTask(sc: Reads, id: string): Promise<Task | null> {
  const entry = sc.live.get(id)
  if (entry) return entry.task
  const task = await sc.store.get(id)
  return task ? idleTask(sc, task) : task
}

/**
 * 按 id 取任务本身（用量、节点、状态），不读完整对话：执行中的取内存里那份，其余读任务文件。
 * 每秒刷一次的用量统计用它：currentTask 会把 `.messages.json` 读进 full 缓存，
 * 一个奔跑中的任务带几个子对话，每秒就把整棵树的消息全读一遍，还会把用户刚看过的任务挤出缓存。
 */
export async function metaTask(sc: Reads, id: string): Promise<Task | null> {
  const entry = sc.live.get(id)
  if (entry) return entry.task
  const task = await sc.store.getMeta(id)
  return task ? idleTask(sc, task) : task
}
