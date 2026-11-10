import type { TaskPlan } from './schema.ts'
import type { DriveCount } from './task-runtime-schema.ts'

/**
 * 对话自驱（ADR 0041）的共用规则。这一版先放「进度指纹」：面板推对话接着做的次数按它算，
 * 指纹变了（计划有实质变化）就从头数。
 *
 * 原来的 key 只是「计划 id:已完成几步」：计划加了步骤、某步从待做变进行中都算「没进展」，
 * 推满 3 次后同一进度再也不推（用户 2026-11-02 报：计划没做完就停在那里）。
 * 指纹只看步骤的 id 和状态：只改备注、改标题不算进展，免得模型反复改一个字刷新次数。
 */
export function planProgressKey(plan: Pick<TaskPlan, 'id' | 'steps'>): string {
  const items = plan.steps.flatMap((s) => [
    `${s.id}:${s.status}`,
    ...(s.children ?? []).map((c) => `${s.id}/${c.id}:${c.status}`),
  ])
  return `${plan.id}|${items.join(',')}`
}

/** 日志里写的短指纹：完整的 key 可能很长，排查时只要能看出变没变 */
export function shortKey(key: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 同一条输入（用户或父对话最近的一条消息）之后面板最多推几次（推进和收尾自检合计） */
export const DRIVE_TOTAL_MAX = 10

/**
 * 面板推对话接着做的次数账本（ADR 0041）。两道限制：
 * - 同一个进度（key）最多推 max 次：推了还原地不动就停下；
 * - 同一条输入之后一共最多推 DRIVE_TOTAL_MAX 次：模型把一步在进行中和待做之间来回改，指纹一直在变，靠它兜住。
 * 只在真推出去时记（take）；刚结束那一下只看（can），复查没过不记。用户亲自发消息清零（reset）。
 * 传了 store 时次数存进对话（Task.driveCount，分析稿 A10）：面板重启后接着数，不从 1 重新数
 */
export class DriveBudget {
  private readonly per = new Map<string, { key: string; n: number }>()
  private readonly total = new Map<string, { input: string; n: number }>()
  /** 已经从 store 读过的对话：每个对话只读一次，之后以内存为准 */
  private readonly loaded = new Set<string>()
  constructor(
    private readonly totalMax = DRIVE_TOTAL_MAX,
    private readonly store?: {
      load: (id: string) => DriveCount | undefined
      save: (id: string, c: DriveCount | undefined) => void
    },
  ) {}

  /** 内存里还没有这个对话时，从对话上存着的次数接上（面板重启后） */
  private hydrate(id: string) {
    if (!this.store || this.loaded.has(id)) return
    this.loaded.add(id)
    const c = this.store.load(id)
    if (!c) return
    if (c.key && c.n > 0 && !this.per.has(id)) this.per.set(id, { key: c.key, n: c.n })
    if (c.total > 0 && !this.total.has(id)) this.total.set(id, { input: c.input, n: c.total })
  }

  private nextOf(id: string, key: string, max: number) {
    this.hydrate(id)
    const prev = this.per.get(id)
    const n = prev?.key === key ? prev.n + 1 : 1
    return n > max ? null : { key, n }
  }

  /** 这条输入之后的总次数还没满 */
  totalLeft(id: string, input: string) {
    this.hydrate(id)
    const r = this.total.get(id)
    return !r || r.input !== input || r.n < this.totalMax
  }

  /** 能不能推：返回 'ok'，或者不能推的原因 */
  can(id: string, key: string, max: number, input: string): 'ok' | 'exhausted' | 'total-cap' {
    if (!this.totalLeft(id, input)) return 'total-cap'
    return this.nextOf(id, key, max) ? 'ok' : 'exhausted'
  }

  /** 真推出去时记一次：返回这是这个进度的第几次（从 1 开始），不能推返回 0 */
  take(id: string, key: string, max: number, input: string): number {
    if (this.can(id, key, max, input) !== 'ok') return 0
    const next = this.nextOf(id, key, max)!
    this.per.set(id, next)
    const r = this.total.get(id)
    const total = { input, n: r?.input === input ? r.n + 1 : 1 }
    this.total.set(id, total)
    this.store?.save(id, { key: next.key, n: next.n, input, total: total.n })
    return next.n
  }

  /** 诊断用：最后一个进度和推了几次 */
  state(id: string) {
    this.hydrate(id)
    return this.per.get(id)
  }

  reset(id: string) {
    this.loaded.add(id)
    const had = this.per.has(id) || this.total.has(id)
    this.per.delete(id)
    this.total.delete(id)
    if (had || this.store?.load(id)) this.store?.save(id, undefined)
  }
}
