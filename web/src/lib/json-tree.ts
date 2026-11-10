/**
 * 文件弹窗的 JSON 树形视图用的纯函数：解析（.jsonl 一行一条）、搜索时算出哪些节点要自动展开。
 */

/** 阅读时可以切到树形视图的文件：JSON，和一行一条 JSON 的 .jsonl（Agent 的会话记录就是这种） */
export const isJsonPath = (path: string) => /\.(json|jsonl|ndjson|uproject|uplugin)$/i.test(path)
const isLines = (path: string) => /\.(jsonl|ndjson)$/i.test(path)

export type JsonParsed = { ok: true; value: unknown } | { ok: false; error: string }

/** 解析：.jsonl 按行解析成一个数组（空行跳过）；解析不了时给出原因（带第几行） */
export function parseJsonFile(text: string, path: string): JsonParsed {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  try {
    if (!isLines(path)) return { ok: true, value: JSON.parse(body) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const out: unknown[] = []
  let line = 0
  for (const raw of body.split('\n')) {
    line++
    if (!raw.trim()) continue
    try {
      out.push(JSON.parse(raw))
    } catch (e) {
      return { ok: false, error: `line ${line}: ${(e as Error).message}` }
    }
  }
  return { ok: true, value: out }
}

export const isBranch = (v: unknown): v is object => typeof v === 'object' && v !== null

/** 一个节点的子项：数组按下标，对象按键 */
export function childrenOf(v: object): [string | number, unknown][] {
  return Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v)
}

/** 命中超过这么多就不自动展开了：搜一个字母时等于把整棵树全画出来 */
export const TREE_HIT_MAX = 2000

/**
 * 搜索时要自动展开的节点：键名或值里有这个词的节点，它的每一层上级都要展开才看得见。
 * 返回「节点路径 → 它下面至少要画到第几个子项」（长数组只画前面一段，命中在后面时要画到那里）；
 * 命中太多返回 null，不自动展开，只搜已经展开的部分。路径是每层的子项序号用 / 连起来，根是空串。
 */
export function revealPaths(root: unknown, query: string, caseSensitive: boolean): Map<string, number> | null {
  const out = new Map<string, number>()
  if (!query) return out
  const needle = caseSensitive ? query : query.toLowerCase()
  const has = (s: string) => (caseSensitive ? s : s.toLowerCase()).includes(needle)
  let hits = 0
  // 返回这棵子树里有没有命中；有的话沿路把上级记下来
  const walk = (v: unknown, path: string): boolean => {
    if (!isBranch(v)) return has(typeof v === 'string' ? v : String(v))
    let any = false
    const kids = childrenOf(v)
    for (let i = 0; i < kids.length && hits <= TREE_HIT_MAX; i++) {
      const [k, child] = kids[i]
      const self = typeof k === 'string' && has(k)
      const below = walk(child, path ? `${path}/${i}` : String(i))
      if (self || (below && !isBranch(child))) hits++
      if (self || below) {
        any = true
        out.set(path, i)
      }
    }
    return any
  }
  walk(root, '')
  return hits > TREE_HIT_MAX ? null : out
}
