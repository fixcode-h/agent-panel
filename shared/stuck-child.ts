import type { Task } from './schema.ts'
import { CHILD_IDLE_ASK_MAX, type ChildWait } from './task.ts'
import { activePlan, planText } from './plan.ts'

/**
 * 子对话卡住时由面板接着处理：自动询问（childIdleAsk）之后一直没回复 → 停掉 CLI、接回原会话重启；
 * 重启没成功（起不来、起来了还是一个字都不回）→ 对话里记一条警告，新开一个子对话带上原任务和进展接手。
 * 判定都写在这里，server/tasks/stuck-child.ts 只拿结论执行。
 */

/**
 * 问过之后 CLI 正在跑前台工具（编译、跑测试）时多等几倍：CLI 要等工具跑完才看得到询问，
 * 不能把正常的长命令当成卡住杀掉。真挂死的工具交给 idleTimeoutMinutes 那一条兜底
 */
export const CHILD_TOOL_REPLY_FACTOR = 5

/** 同一个子对话最多由面板重启几次：重启过这么多次又卡住，就不再重启，直接新开子对话接手 */
export const CHILD_RESTART_MAX = 2

/** 最近一条 Agent 回复里有还在跑的工具：没有输出是在等工具，不是模型没反应 */
export function childToolRunning(tk: Pick<Task, 'messages'>): boolean {
  for (let i = tk.messages.length - 1; i >= 0; i--) {
    const m = tk.messages[i]
    if (m.role !== 'agent' || m.step) continue
    return m.tools.some((x) => x.running)
  }
  return false
}

/**
 * 自动询问之后到时间还没有任何回复：该停掉它、接回会话重启了。
 * 窗口和询问的阈值是同一个设置（childIdleAskMinutes），正在跑前台工具时乘 CHILD_TOOL_REPLY_FACTOR。
 * 没交出去的询问（held，CLI 这会儿收不下插话）不算问过；连着问满 CHILD_IDLE_ASK_MAX 次都收不下，也按没回复算
 */
export function childAskUnanswered(
  x: {
    /** 设置里的分钟数，0 关闭 */
    minutes: number
    working?: boolean
    /** 能解释的等待（见 childWait）：等用户、等后台命令、等工作流、等子任务时不算卡住 */
    wait?: ChildWait
    lastActivityAt?: string
    autoAsk?: { at: string; count: number; held?: boolean }
    toolRunning?: boolean
    /** 一分钟多少毫秒：测试里缩短时间用 */
    unitMs?: number
  },
  now = Date.now(),
): boolean {
  if (x.minutes <= 0 || !x.working) return false
  if (x.wait && x.wait.kind !== 'next') return false
  const ask = x.autoAsk
  const asked = ask ? Date.parse(ask.at) : NaN
  if (!ask || !Number.isFinite(asked)) return false
  if (ask.held && ask.count < CHILD_IDLE_ASK_MAX) return false
  // 问过之后有了输出：回复了，不算卡住
  const last = x.lastActivityAt ? Date.parse(x.lastActivityAt) : NaN
  if (Number.isFinite(last) && last > asked) return false
  const window = x.minutes * (x.unitMs ?? 60_000) * (x.toolRunning ? CHILD_TOOL_REPLY_FACTOR : 1)
  return now - asked >= window
}

/** 某个时间之后 Agent 有没有说过话、调过工具：重启后据此判断接回的会话真的动起来了 */
export function agentOutputSince(tk: Pick<Task, 'messages'>, iso: string): boolean {
  return tk.messages.some((m) => m.role === 'agent' && !m.step && m.at > iso)
}

/**
 * 重启之后的结论：ok 接回的会话有了输出（或者这一轮正常结束了）；failed 没起来（这一轮失败、又被当成没响应停掉）
 * 或起来了还是不回；gone 被别的原因停掉了（用户停止、父对话收尾、归档），不再管它；wait 还说不准。
 * stalledSince 是 runner 标「没有响应」的时间（stalledTurn），晚于重启才算这次重启后又卡住
 */
export function restartOutcome(
  x: {
    output: boolean
    /** 面板里还有它这一轮的执行位 */
    live: boolean
    status: Task['status']
    stopReason?: Task['stopReason']
    stalledSince?: number
  },
  restartedAt: number,
): 'ok' | 'failed' | 'gone' | 'wait' {
  if (x.output) return 'ok'
  if (x.live) return x.stalledSince !== undefined && x.stalledSince >= restartedAt ? 'failed' : 'wait'
  if (x.status === 'failed') return 'failed'
  if (x.status === 'stopped')
    return x.stopReason === 'stalled' || x.stopReason === 'lost' || x.stopReason === 'replaced' ? 'failed' : 'gone'
  return 'ok'
}

/**
 * 父对话计划里等原来那个子对话的步骤改成等接手的子对话：不然原来的停下后那一步要么一直等、要么被退回「需要修复」。
 * 返回改了几处
 */
export function rebindChildWait(
  task: Pick<Task, 'plans'>,
  oldId: string,
  newId: string,
  label: string,
  now = new Date().toISOString(),
): number {
  let n = 0
  for (const plan of task.plans ?? [])
    for (const step of plan.steps)
      for (const item of [step, ...step.children])
        for (const w of item.waits)
          if (w.kind === 'child' && w.ref === oldId && w.state === 'waiting') {
            w.ref = newId
            w.label = label
            w.at = now
            item.updatedAt = now
            n++
          }
  return n
}

/** 接手的子对话的标题：原标题加「（接手）」，和原来的区分开（retryBase 不会把它当成重试） */
export const takeoverTitle = (title: string) => `${title.replace(/（接手）$/, '')}（接手）`.slice(0, 80)

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（后面省略）` : s)

/**
 * 交给接手的子对话的第一条消息：为什么换人、原来的任务（父对话交代的和用户直接说的）、已有进展
 * （计划、改过的文件、独立分支目录、最后的回复）。做过的不用重做，先核对现状再接着做
 */
export function takeoverBrief(
  old: Pick<Task, 'id' | 'title' | 'messages' | 'plans' | 'steps' | 'changes' | 'worktree'>,
  why: string,
): string {
  const asks = old.messages.filter(
    (m) => (m.peer?.rel === 'parent' && m.peer.kind === 'task') || (m.role === 'user' && !m.panel && !m.step),
  )
  // 第一条是交代的任务本身，全留；后面追加的要求按新的优先留
  const [first, ...more] = asks
  const tasks = first ? [clip(first.text.trim(), 4000), ...more.slice(-5).map((m) => clip(m.text.trim(), 1500))] : []
  const plan = activePlan(old)
  const files = [...new Set(old.changes.map((c) => c.path))]
  const wt = old.worktree?.state === 'active' ? old.worktree : undefined
  const reply = [...old.messages]
    .reverse()
    .find((m) => m.role === 'agent' && !m.step && m.text.trim())
    ?.text.trim()
  const parts = [
    `【接手】子对话「${old.title}」（id ${old.id}）卡住了：${why}。面板已经停掉它，由你接手把这件事做完。`,
    `## 原来的任务\n${tasks.length ? tasks.join('\n\n---\n\n') : '（没有找到原来的任务原文）'}`,
    '## 已有进展',
    plan ? `计划：\n${planText(old, plan)}` : '',
    files.length ? `已经改过的文件：\n${files.slice(0, 50).join('\n')}${files.length > 50 ? '\n…' : ''}` : '',
    wt
      ? `它的独立分支 ${wt.branch}（目录 ${wt.path}）里的改动还没合回：先看那里的改动（git diff / git log），需要的搬过来再接着做。`
      : '',
    reply ? `它最后的回复：\n${clip(reply, 1500)}` : '',
    '已经做完的不用重做：先核对现状（文件、计划里标完成的步骤）再从没做完的地方接着做。',
  ]
  return parts.filter(Boolean).join('\n\n')
}
