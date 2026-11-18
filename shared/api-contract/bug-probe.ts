/**
 * 补排查的接口契约（写法见 ./define.ts，规则见 shared/bug/probe.ts）：
 * 两个接口都只记下来、返回交给子对话的话，页面再把它作为用户消息发过去
 */
import { z } from 'zod'
import { Task } from '../schema.ts'
import { ProbeAction, ProbeStart } from '../bug/probe-schema.ts'
import { endpoint } from './define.ts'

const Reply = z.object({ task: Task, message: z.string() })

export const bugProbeContract = {
  /** 「马上加」：开一个补排查窗口 */
  start: endpoint({ method: 'POST', path: '/tasks/:id/bug-probe', body: ProbeStart, res: Reply }),
  /** 清单上的撤掉 / 让它改 */
  action: endpoint({ method: 'POST', path: '/tasks/:id/bug-probe-action', body: ProbeAction, res: Reply }),
}
