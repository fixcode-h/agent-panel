import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { makeAlert } from '../../shared/alerts.ts'
import type { ResOf } from '../../shared/api-contract/define.ts'
import type { experienceContract } from '../../shared/api-contract/experience.ts'
import { type LearnResult, learnResultText } from '../../shared/experience.ts'
import { createExperienceLearner } from '../experience/learn.ts'
import type { TasksScope } from './scope.ts'
import { readTask } from './read.ts'

/**
 * 把经验学习（server/experience/learn.ts）接到任务存储上：取整份任务、找子对话、判「这一轮结束」、在对话里写一行。
 * 「一轮结束」只看这个对话还在不在跑（ADR 0066 改的：以前要整个对话树完成）
 */
export function createTaskLearner(sc: TasksScope) {
  const learner = createExperienceLearner({
    getTask: (id) => readTask(sc, id).catch(() => null),
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
  return { learnExperience: learner.schedule, learnNow: (id: string) => learner.learn(id, { manual: true }) }
}

/**
 * 对话标题栏「立即学经验」：手动学一次，等学完再回（要调一次模型，几十秒）。
 * 学到的、失败的原因照旧由 learn 写进对话；这里只回结论，界面弹一句提示
 */
export function learnRoutes(learnNow: (id: string) => Promise<LearnResult>) {
  const app = new Hono()
  app.post('/:id/experience/learn', async (c) => {
    const result = await learnNow(c.req.param('id'))
    return c.json({ result, message: learnResultText(result) } satisfies ResOf<typeof experienceContract.learnNow>)
  })
  return app
}
