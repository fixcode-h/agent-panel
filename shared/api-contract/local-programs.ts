/**
 * 面板要用的本机程序没装时的提醒（shared/local-programs/defs.ts）：输入框上方的卡片取一次，之后跟着推送（local-programs）走
 */
import { z } from 'zod'
import { ProgramOffer } from '../local-programs/defs.ts'
import { endpoint } from './define.ts'

const Offers = z.object({ offers: z.array(ProgramOffer) })

export const localProgramsContract = {
  offers: endpoint({ method: 'GET', path: '/local-programs/offers', res: Offers }),
  /** 一键安装：开一条后台作业，装好后这条提醒自己消失 */
  install: endpoint({ method: 'POST', path: '/local-programs/:id/install', body: z.object({}), res: Offers }),
  /** 拒绝：这次面板运行期间不再提醒（重启面板后又没装，再问） */
  decline: endpoint({ method: 'POST', path: '/local-programs/:id/decline', body: z.object({}), res: Offers }),
}
