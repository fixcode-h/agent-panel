/**
 * 经验学习的接口契约（写法见 ./define.ts）：对话标题栏「立即学经验」手动学一次（server/experience/learn.ts）。
 * 不进契约探查（probe.ts）：学经验会起 CLI 调模型，和工作总结的提炼一样不探
 */
import { z } from 'zod'
import { LearnResult } from '../experience.ts'
import { endpoint } from './define.ts'

export const experienceContract = {
  learnNow: endpoint({
    method: 'POST',
    path: '/tasks/:id/experience/learn',
    body: z.object({}),
    res: z.object({ result: LearnResult, message: z.string() }),
  }),
}
