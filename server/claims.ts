/**
 * 子对话之间、子对话和父对话之间的文件协作约定，按项目的子对话隔离模式分两种：
 * - 共用目录（childIsolation = 'claim'）：改文件前先「认领」，同一个文件同一时间只归一个子对话。
 * - 独立分支（childIsolation = 'worktree'）：不认领，两个子对话可以同时改同一个文件，各在自己的
 *   worktree 里改、互不影响；合并回父对话分支时按 git merge 处理（见 exec/worktree.ts）。
 * 认领只在面板内存里，子对话这一轮结束（或停止）就释放；它是协作约定，不拦 CLI 自己的写文件。
 */

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
    /** 释放：不传路径时释放这个子对话的全部认领；返回释放了几条 */
    release(root: string, taskId: string, paths?: string[]) {
      const t = byRoot.get(root)
      if (!t) return 0
      const want = paths?.map(normClaimPath).filter(Boolean)
      let n = 0
      for (const [k, c] of t)
        if (c.taskId === taskId && (!want || want.some((w) => overlaps(k, w)))) {
          t.delete(k)
          n++
        }
      if (!t.size) byRoot.delete(root)
      return n
    },
    /** 这个父对话下现在的认领（给父对话看谁在改什么） */
    list(root: string) {
      return [...(byRoot.get(root) ?? [])].map(([path, c]) => ({ path, ...c }))
    },
  }
}

/**
 * 这一轮改动和兄弟子对话正在改的文件撞了哪些：
 * mine 是这个子对话改过的文件，others 是其他还在执行的子对话（标题 + 改过的文件）
 */
export function collisions(mine: string[], others: { title: string; files: string[] }[]) {
  const out: { path: string; with: string }[] = []
  const seen = new Set<string>()
  for (const f of mine.map(normClaimPath))
    for (const o of others)
      if (o.files.some((g) => normClaimPath(g) === f) && !seen.has(`${f}\n${o.title}`)) {
        seen.add(`${f}\n${o.title}`)
        out.push({ path: f, with: o.title })
      }
  return out
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
