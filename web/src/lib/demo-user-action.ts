/**
 * 演示：等你操作（request_user_action）。一个子对话挂着「跑一次 PIE 抓日志」，
 * 父对话的子对话行上有「去操作」，打开它输入框上方是等你操作面板。
 * 从 demo-backend.ts 拆出（那个文件到了行数上限）
 */
import type { Task } from '@shared/schema'
import { settleAction, UserAction, type ActionSettle } from '@shared/user-action'

/** 演示用的那一件：等了 12 分钟，结果要交回日志 */
export const demoUserAction = (): UserAction =>
  UserAction.parse({
    id: 'demo-action-1',
    title: '跑一次 PIE，抓路牌的 Actor 路径',
    why: '确认偏移出在生成时还是加载后：日志里有 Actor 路径才能对上是哪一个蓝图',
    collect: {
      kind: 'result',
      steps: [
        '在编辑器里打开 L_Town 关卡，点「运行（PIE）」',
        '走到路口第一块路牌旁边停 2 秒，然后退出 PIE',
        '在输出日志里按下面的过滤条件筛一下，把那几行贴回来（或者直接拖日志文件进输入框）',
      ],
      where: 'Saved/Logs/Town.log',
      filter: 'OnCreated hit',
      expect: '有 BP_RoadSign_C 的路径说明是生成时就偏了；一行都没有说明路牌是加载后才挪的',
    },
    alternative: {
      title: '不跑 PIE，直接在编辑器里看',
      steps: ['在大纲里搜 RoadSign', '选中第一块，复制它的「路径」发回来'],
    },
    fallback: '先按「加载后偏移」这条线查，改完再请你在 PIE 里看一眼',
    at: new Date(Date.now() - 12 * 60_000).toISOString(),
  })

/** 用户点了完成了 / 做不了 / 跳过：和正式后端一样记下结果，对话里多一行面板推回去的话 */
export function demoSettleAction(task: Task, actionId: string, body: unknown) {
  const b = (body ?? {}) as { how?: ActionSettle; reason?: string }
  const r = settleAction(task, actionId, b.how ?? 'done', { text: b.reason ?? '' })
  if (!r.ok) throw new Error(r.error)
  task.messages.push({
    id: `demo-${crypto.randomUUID()}`,
    role: 'system',
    agentId: '',
    step: '',
    text: r.prompt,
    tools: [],
    panel: 'action',
    at: new Date().toISOString(),
  })
  return task
}
