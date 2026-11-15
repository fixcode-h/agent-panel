import { z } from 'zod'

/**
 * 任务停在 stopped 的原因。只有 'user' 是用户自己按的暂停，其余都是别的动作顺带把这一轮结束了：
 * 以前 stopTask 只有一个 boolean，全走同一条，界面一律显示「已暂停」，用户没按暂停却看到几只子对话被停了。
 * 界面按它决定说「已暂停」还是说清是谁结束的（见 shared/task.ts 的 childIcon / stopReasonText）。
 */
export const StopReason = z.enum([
  'user', // 用户点「暂停」
  'parent', // 父对话收尾，名下子对话一起结束（closeChildren）
  'switch', // 换 CLI / 模型 / 角色，这一轮重启
  'archive', // 归档
  'delete', // 删除对话（进回收站时结束）
  'restart', // 面板重启、服务退出
  'presence', // 页面切走、宽限期到了，CLI 不再等下一句
  'idle', // 闲置回收（手动释放保活会话等，不是用户按的暂停）
  'supersede', // 用户发了新消息，打断当前这一轮
  'finish', // 任务自己彻底完成，收尾时结束等下一句的 CLI
  'stalled', // CLI 没有响应，用户发新消息时面板停掉它、接回会话重开
  'close', // 用户从对话菜单点「关闭 Agent」，只结束 CLI 进程，下一条消息续接会话
  'lost', // 记录写着在执行，面板里却已经没人在跑它（哪条路径忘了落状态），定时核对时收口（见 shared/tasks/settle.ts）
  'budget', // 对话树用到了项目设的用量上限（见 shared/budget.ts）
  'replaced', // 子对话卡住、面板重启也没恢复，换成新开的子对话接手（见 shared/stuck-child.ts）
  'after', // 建好了还没开始：排在别的子对话之后，等它们合回再由面板启动（见 shared/children/after.ts）
])
export type StopReason = z.infer<typeof StopReason>

/**
 * 这一轮是被叫停的（用户暂停、父对话停下、归档、用量上限……），不是做完后收掉进程：
 * 页面切走（presence）、闲置回收（idle）、做完收尾（finish）、用户关掉 Agent 进程（close）时这一轮已经正常结束。
 * 被叫停的子对话不能在这时按「没有剩下的事」判成做完：刚建好、还没开工就被父对话一起停下的子对话
 * 没有计划、分支上也没改动，按完成条件看什么都不缺，实测被报成「已完成：交付完了」、独立分支被删（摸底报告第 3 条）
 */
export const haltedTurn = (reason: StopReason | undefined) =>
  !!reason && reason !== 'presence' && reason !== 'idle' && reason !== 'finish' && reason !== 'close'
