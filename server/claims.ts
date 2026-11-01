/**
 * 子对话之间、子对话和父对话之间的文件协作约定，按项目的子对话隔离模式分两种：
 * - 共用目录（childIsolation = 'claim'）：改文件前先「认领」，同一个文件同一时间只归一个子对话。
 * - 独立分支（childIsolation = 'worktree'）：不认领，两个子对话可以同时改同一个文件，各在自己的
 *   worktree 里改、互不影响；合并回父对话分支时按 git merge 处理（见 exec/worktree.ts）。
 * 认领只在面板内存里（面板重启后按记录补回改过的文件，见 rebuildClaims），留到这个子对话的改动被交出去为止：
 * 父对话验收（彻底完成，completeChild）或它被删除、归档、换人接手（转给接手的）。一轮结束、停下都不放——
 * 共用目录里没有分支能把两边的改动分开，没验收的改动还算它的（ADR 0035 之后「一轮结束」不再等于「交出去」）。
 * 它是协作约定，不拦 CLI 自己的写文件：没认领就改了别人名下的文件，一轮结束时由 hold 查出来交给父对话。
 */
import type { Task } from '../shared/schema.ts'
import { sharesWorkdir } from '../shared/task.ts'

export interface Claim {
  taskId: string
  title: string
  at: string
}

/** 统一成相对项目根的写法：反斜杠换成斜杠，去掉开头的 ./ 和结尾的 / */
export function normClaimPath(p: string) {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
}

/** 两个路径是否重叠：同一个文件，或者一个是另一个所在的目录 */
export function overlaps(a: string, b: string) {
  if (!a || !b) return false
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
}

/**
 * 一组范围和兄弟子对话重叠的条目（同一个文件，或目录包含关系）。
 * 独立分支模式下只用来提示「两边都改了这些文件」：不据此拦任何一边，也不劝谁拆范围。
 */
export function scopeOverlaps(mine: string[], others: { title: string; files: string[] }[]) {
  const out: { path: string; with: string }[] = []
  const seen = new Set<string>()
  for (const a of mine)
    for (const o of others)
      for (const b of o.files)
        if (overlaps(a, b) && !seen.has(`${a}|${o.title}`)) {
          seen.add(`${a}|${o.title}`)
          out.push({ path: a, with: o.title })
        }
  return out
}

export function createClaims() {
  /** 按父对话 id 分组：不同项目对话之间互不影响 */
  const byRoot = new Map<string, Map<string, Claim>>()

  const table = (root: string) => byRoot.get(root) ?? byRoot.set(root, new Map()).get(root)!

  return {
    /**
     * 认领一批文件或目录：别的子对话占着的（含目录包含关系）不给，返回谁占着；
     * 自己已经认领过的照常算拿到
     */
    claim(root: string, who: { taskId: string; title: string }, paths: string[]) {
      const t = table(root)
      const granted: string[] = []
      const held: { path: string; by: string; byId: string }[] = []
      for (const raw of paths) {
        const p = normClaimPath(raw)
        if (!p) continue
        const other = [...t].find(([k, c]) => c.taskId !== who.taskId && overlaps(k, p))
        if (other) held.push({ path: p, by: other[1].title, byId: other[1].taskId })
        else {
          t.set(p, { taskId: who.taskId, title: who.title, at: new Date().toISOString() })
          granted.push(p)
        }
      }
      return { granted, held }
    },
    /** 释放：不传路径时释放这个子对话的全部认领（exact 时只放和路径一字不差的条目）；返回释放了几条 */
    release(root: string, taskId: string, paths?: string[], exact = false) {
      const t = byRoot.get(root)
      if (!t) return 0
      const want = paths?.map(normClaimPath).filter(Boolean)
      let n = 0
      for (const [k, c] of t)
        if (c.taskId === taskId && (!want || want.some((w) => (exact ? k === w : overlaps(k, w))))) {
          t.delete(k)
          n++
        }
      if (!t.size) byRoot.delete(root)
      return n
    },
    /**
     * 一轮结束时把这一轮真改过的文件记到它名下（没调 claim_files 也算）：共用目录里改动要等父对话验收才算交出去，
     * 这之前别的子对话不该再改。已经归别的子对话的不覆盖，原样返回——那就是撞了
     */
    hold(root: string, who: { taskId: string; title: string }, paths: string[]) {
      const t = table(root)
      const hit: { path: string; by: string; byId: string }[] = []
      for (const raw of paths) {
        const p = normClaimPath(raw)
        if (!p) continue
        const other = [...t].find(([k, c]) => c.taskId !== who.taskId && overlaps(k, p))
        if (other) hit.push({ path: p, by: other[1].title, byId: other[1].taskId })
        else if (![...t].some(([k, c]) => c.taskId === who.taskId && overlaps(k, p)))
          t.set(p, { taskId: who.taskId, title: who.title, at: new Date().toISOString() })
      }
      if (!t.size) byRoot.delete(root)
      return hit
    },
    /** 换人接手（stuck-child 的 replaced）：原子对话名下的认领整份转给接手的，返回转了几条 */
    transfer(root: string, fromId: string, to: { taskId: string; title: string }) {
      const t = byRoot.get(root)
      if (!t) return 0
      let n = 0
      for (const [k, c] of t)
        if (c.taskId === fromId) {
          t.set(k, { ...c, taskId: to.taskId, title: to.title })
          n++
        }
      return n
    },
    /** 父对话删除 / 归档：它名下子对话的认领整组丢掉 */
    dropRoot(root: string) {
      byRoot.delete(root)
    },
    /** 这个父对话下现在的认领（给父对话看谁在改什么） */
    list(root: string) {
      return [...(byRoot.get(root) ?? [])].map(([path, c]) => ({ path, ...c }))
    },
  }
}

/** 「web/a.ts（「甲」）、…」这种展示，同一个文件被多个子对话改过只留一次 */
const withTitles = (list: { path: string; with: string }[]) =>
  [...new Set(list.map((x) => `${x.path}（「${x.with}」）`))].join('、')

/**
 * 新建子对话时告诉父对话这些文件怎么了。两种隔离模式的措辞差别就是需求本身：
 * 独立分支里重叠只是信息（各改各的、合并时按 git merge 处理），只有共用目录才有
 * 「没认领、等对方做完」这种限制。发给 Agent 的提示，不翻英文。
 */
export function childFilesInfo(input: {
  isolation: 'claim' | 'worktree'
  granted: string[]
  held: { path: string; by: string }[]
  both: { path: string; with: string }[]
}) {
  const { isolation, granted, held, both } = input
  // 独立分支：两个子对话的文件重叠不影响谁能不能改，不提认领，也不劝拆范围
  if (isolation === 'worktree')
    return both.length
      ? [
          `这些文件和别的子对话重叠了：${withTitles(both)}。两边各在自己的独立分支里改，互不影响；合并回这个分支时按 git merge 处理：能自动合上的直接合，真冲突会撤回并把冲突交回那个子对话。合并结果里会列出两边都改过的文件，合并后核对内容。`,
        ]
      : []
  return [
    granted.length ? `已替它认领：${granted.join('、')}` : '',
    held.length
      ? `这些已经归别的子对话，没有认领：${held.map((h) => `${h.path}（「${h.by}」）`).join('、')}。让它等那边做完再改，或者把这部分交给那个子对话`
      : '',
  ].filter(Boolean)
}

/** 认领判定要用的字段：子对话的父对话、收尾进度、隔离方式和改过的文件 */
export type ClaimTask = Pick<
  Task,
  | 'id'
  | 'title'
  | 'parentTaskId'
  | 'resolved'
  | 'deletedAt'
  | 'archived'
  | 'stopReason'
  | 'wantsWorktree'
  | 'worktree'
  | 'changes'
>

/**
 * 认领还算数的子对话：没彻底完成、没删、没归档、没被换人接手，而且和父对话共用目录。
 * 用户停下、跟父对话一起停、用量上限、卡住重启的都还算：改动还在共用目录里，没人验收
 */
export function holdsClaims(tk: Omit<ClaimTask, 'id' | 'title' | 'changes'>) {
  return (
    !!tk.parentTaskId &&
    tk.resolved !== true &&
    !tk.deletedAt &&
    !tk.archived &&
    tk.stopReason !== 'replaced' &&
    sharesWorkdir(tk)
  )
}

type Claims = ReturnType<typeof createClaims>

/**
 * 子对话一轮结束：认领不放，这一轮真改过的文件记到它名下。返回撞了哪些（已经归别的还没交出去的兄弟，
 * 停下等验收的也算，不只看正在跑的）；走独立分支、已经交出去的子对话不记、不算撞
 */
export function holdTurn(claims: Claims, child: ClaimTask) {
  if (!holdsClaims(child)) return []
  return claims.hold(
    child.parentTaskId,
    { taskId: child.id, title: child.title },
    child.changes.map((c) => c.path),
  )
}

/** 撞了的清单：「src/a.ts（「甲」）、…」，同一个文件同一个对方只列一次 */
export const hitList = (hit: { path: string; by: string }[]) =>
  [...new Set(hit.map((h) => `${h.path}（「${h.by}」）`))].join('、')

/** submit_merge 成功（共用目录）：交了就不再改，声明了没碰的让出来；改过的留到父对话验收 */
export function shrinkClaims(claims: Claims, child: ClaimTask) {
  if (!holdsClaims(child)) return
  claims.release(child.parentTaskId, child.id)
  holdTurn(claims, child)
}

/** release_files：改过的文件不让提前放（放了兄弟就能接着改同一个没验收的文件）。返回放了几条 */
export function releaseUnchanged(claims: Claims, child: ClaimTask, paths: string[]) {
  const mine = claims.list(child.parentTaskId).filter((c) => c.taskId === child.id)
  const changed = child.changes.map((c) => normClaimPath(c.path))
  const want = paths.map(normClaimPath).filter(Boolean)
  // 只放名下和改过的文件不重叠的条目，按条目原样放：按重叠放会把包着改过文件的目录那条也放掉
  const keys = mine
    .map((c) => c.path)
    .filter((k) => (!paths.length || want.some((w) => overlaps(k, w))) && !changed.some((c) => overlaps(c, k)))
  return keys.length ? claims.release(child.parentTaskId, child.id, keys, true) : 0
}

/** 删除、归档：它自己名下的认领放掉；它要是别人的父对话，名下子对话的整组丢掉 */
export function forgetClaims(claims: Claims, tk: Pick<Task, 'id' | 'parentTaskId'>) {
  if (tk.parentTaskId) claims.release(tk.parentTaskId, tk.id)
  claims.dropRoot(tk.id)
}

/** 认领被拒时对方现在怎样：Agent 据此知道是等一会儿，还是该找父对话协调 */
export function holderState(tk: Pick<Task, 'working' | 'wrapRequest'> | undefined) {
  // 不在内存里：这一轮早结束了，进程也回收了
  if (!tk) return '不在执行，改动还没被父对话验收'
  if (tk.wrapRequest) return '已交给父对话验收，改动还没被收下'
  if (tk.working) return '正在改'
  return '已停下，改动还没交给父对话验收'
}

/**
 * P4 共用目录的子对话没写 files 时分哪些：它名下的认领 ∪ 改过的文件。兄弟在同一个 workspace、同一个 default changelist，
 * 不限定就会把兄弟打开的文件一起分走。目录认领按 p4 路径语法写成 dir/...（isDir 由调用方查）
 */
export function ownP4Files(claims: Claims, child: ClaimTask, isDir: (p: string) => boolean) {
  if (!holdsClaims(child)) return []
  const claimed = claims
    .list(child.parentTaskId)
    .filter((c) => c.taskId === child.id)
    .map((c) => (isDir(c.path) ? `${c.path}/...` : c.path))
  return [...new Set([...claimed, ...child.changes.map((c) => normClaimPath(c.path))])]
}

/**
 * 面板重启后认领表是空的：按记录里每个还没交出去的共用目录子对话改过的文件补回来
 * （认领了还没改的那部分丢了，下一轮它再认领）。先建的先占：两个都改过同一个文件时归先建的那个
 */
export function rebuildClaims(claims: Claims, tasks: (ClaimTask & Pick<Task, 'createdAt'>)[]) {
  for (const tk of tasks.filter(holdsClaims).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    holdTurn(claims, tk)
}
