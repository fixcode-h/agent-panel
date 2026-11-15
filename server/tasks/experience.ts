import { randomUUID } from 'node:crypto'
import { makeAlert } from '../../shared/alerts.ts'
import { createExperienceLearner } from '../experience/learn.ts'
import type { TasksScope } from './scope.ts'

/**
 * 把经验学习（server/experience/learn.ts）接到任务存储上：取整份任务、找子对话、判「这一轮结束」、在对话里写一行。
 * 「一轮结束」只看这个对话还在不在跑（ADR 0066 改的：以前要整个对话树完成）
 */
export function createTaskLearner(sc: TasksScope) {
  const learner = createExperienceLearner({
    getTask: async (id) => sc.live.get(id)?.task ?? (await sc.store.get(id).catch(() => null)),
    listTasks: () => sc.store.list(),
    // 一轮结束就学（ADR 0066 / 设计稿 Q3）：不再等整棵对话树（子对话、后台命令）都完成——
    // 等全树完成时，长对话里前面绕的路早就过了用得上的时候；只看上次学过之后的新调用，学多次不会重复
    isDone: async (tk) => !sc.live.get(tk.id)?.task.working,
    projects: sc.deps.projects,
    agents: sc.deps.agents,
    // 学到什么、失败的原因都写进对话：学到的画成按条展示的卡片，失败画成可点开的警告行（原始报错在里面），不只留在日志
    note: async (taskId, text, { error, learned } = {}) => {
      const entry = sc.live.get(taskId)
      const tk = entry?.task ?? (await sc.store.get(taskId).catch(() => null))
      if (!tk || tk.archived) return
      tk.messages.push({
        id: randomUUID(),
        role: 'system',
        agentId: '',
        step: '',
        text,
        tools: [],
        ...(error !== undefined && { alert: makeAlert('warn', error, 'panel') }),
        ...(learned && { learned }),
        at: new Date().toISOString(),
      })
      if (entry) entry.rev++
      else await sc.store.update(tk.id, tk).catch(() => {})
    },
  })
  return { learnExperience: learner.schedule, learnNow: learner.learn }
}
