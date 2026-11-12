import { randomUUID } from 'node:crypto'
import { makeAlert } from '../../shared/alerts.ts'
import { createExperienceLearner } from '../experience-learn.ts'
import type { TasksScope } from './scope.ts'

/**
 * 把经验学习（server/experience-learn.ts）接到任务存储上：取整份任务、找子对话、判「整个对话完成」、在对话里写一行。
 * 「完成」只认 live.state（ADR 0005 的唯一判定，服务端 liveOf 带上后台命令和子对话数才算得全）
 */
export function createTaskLearner(sc: TasksScope) {
  const learner = createExperienceLearner({
    getTask: async (id) => sc.live.get(id)?.task ?? (await sc.store.get(id).catch(() => null)),
    listTasks: () => sc.store.list(),
    isDone: async (tk) => !sc.live.get(tk.id)?.task.working && (await sc.liveOf(tk)).state === 'done',
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
