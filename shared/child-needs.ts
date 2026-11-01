/**
 * 后代对话在等用户处理（确认请求、回答提问）时往上冒泡：父对话、祖先对话和侧栏都显示「等你处理」。
 * 实测报告问题 1：子对话卡在权限确认 10 分钟，父对话和侧栏一直写「执行中」，用户看不出要处理。
 * 从 task.ts 拆出来（那个文件到了行数上限），状态判定本身仍在 convState（childNeeds 一项）
 */
import { t } from './i18n.ts'
import type { Task, TaskRequest } from './schema.ts'

/** 请求标题在状态说明里最多留这么多字：命令可能很长，完整内容在确认卡上 */
const REQUEST_NOTE_MAX = 80

/** 等用户处理的那一项的一句话：「等用户确认：运行命令：npm test」；问题写成「等用户回答：……」 */
export function requestNote(req: Pick<TaskRequest, 'kind' | 'title'>, n = 1): string {
  const title = req.title.length > REQUEST_NOTE_MAX ? `${req.title.slice(0, REQUEST_NOTE_MAX)}…` : req.title
  const head = req.kind === 'question' ? t('等用户回答：{title}', { title }) : t('等用户确认：{title}', { title })
  return n > 1 ? head + t('（共 {n} 项）', { n }) : head
}

/** 这个对话自己在等用户：有待确认的请求或没答的提问（和 convState 的 requests / asking 同一口径） */
export const ownNeeds = (tk: Partial<Pick<Task, 'requests' | 'parentAsks'>>) =>
  !!(tk.requests?.length || tk.parentAsks?.length)

/**
 * 每个对话名下（任意层的后代）有几个对话在等用户处理：一次扫完整份任务列表，按 parentTaskId 一路往上记。
 * 进了回收站、已收起（归档、独立分支被删）的不算：它们的请求不会再有人处理，也不在用户眼前。
 * 链上出现环（坏数据）时最多走 list.length 层就停，不会死循环
 */
export function descendantNeeds(
  list: (Pick<Task, 'id' | 'parentTaskId'> &
    Partial<Pick<Task, 'requests' | 'parentAsks' | 'archived' | 'deletedAt' | 'worktree'>>)[],
): Map<string, number> {
  const parentOf = new Map(list.map((k) => [k.id, k.parentTaskId ?? '']))
  const out = new Map<string, number>()
  for (const k of list) {
    if (!ownNeeds(k) || k.archived || k.deletedAt || k.worktree?.state === 'discarded') continue
    let up = k.parentTaskId ?? ''
    for (let hops = 0; up && hops < list.length; hops++) {
      out.set(up, (out.get(up) ?? 0) + 1)
      up = parentOf.get(up) ?? ''
    }
  }
  return out
}

/** 父对话页子对话行上的那条待确认请求（/children 带上，见 pendingRequest） */
export interface ChildRequest {
  id: string
  kind: TaskRequest['kind']
  title: string
  detail: string
  /** 只是允许 / 拒绝一个操作（命令、改文件、工具、推送授权）：行上直接给两个按钮；提问、节点确认要点进子对话答 */
  quick: boolean
}

/** 说明在行上只用来悬停看，留这么多字够看清命令；完整内容在子对话的确认卡上 */
const REQUEST_DETAIL_MAX = 2000

/** 子对话第一条待确认的请求：父对话页直接写出确认什么、给「允许 / 拒绝」，不用点进子对话 */
export function pendingRequest(tk: Pick<Task, 'requests'>): ChildRequest | undefined {
  const r = tk.requests?.[0]
  if (!r) return undefined
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    detail: r.detail.slice(0, REQUEST_DETAIL_MAX),
    quick: r.kind === 'command' || r.kind === 'file' || r.kind === 'tool',
  }
}

/** 子对话在等确认（childWait 的 confirm）：带上第一项的标题，界面写得出确认的是哪条命令 */
export function confirmWait(requests: Pick<TaskRequest, 'kind' | 'title'>[]) {
  const first = requests[0]
  return { kind: 'confirm' as const, n: requests.length, title: first?.title, question: first?.kind === 'question' }
}

/** 子对话在等确认 / 等后代时的一句话（childWaitText 的 confirm、children 两种） */
export function confirmWaitText(
  w: { kind: 'confirm'; n: number; title?: string; question?: boolean } | { kind: 'children'; n: number },
): string {
  if (w.kind === 'children') return t('它的 {n} 个子对话等用户处理', { n: w.n })
  // 写出确认的是什么（哪条命令、哪个文件）：父对话页、计划窗口里不点进子对话就知道要处理什么
  if (!w.title) return t('等用户确认 {n} 项', { n: w.n })
  return requestNote({ kind: w.question ? 'question' : 'command', title: w.title }, w.n)
}

/**
 * 子对话给父对话上报「等你处理」时的原因（childReport 的 needs）：确认请求写出是哪条命令 / 哪个文件，
 * 后代对话在等用户时说清是它的子对话——父对话据此知道不用催它，该提醒用户
 */
export function needsReason(task: Partial<Pick<Task, 'requests' | 'parentAsks'>>, childNeeds = 0): string {
  const req = task.requests?.[0]
  if (req) return requestNote(req, task.requests!.length)
  if (!task.parentAsks?.length && childNeeds) return t('它的子对话在等用户处理（确认请求或回答提问）')
  return t('有没答的提问，在等用户回答')
}
