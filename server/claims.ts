/**
 * 同一个项目对话下的子对话共用一个目录（不建独立分支），改文件前先「认领」：
 * 和 Claude Code 的 Agent Teams 一样由负责分派的一方划好范围，同一个文件同一时间只归一个子对话。
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
