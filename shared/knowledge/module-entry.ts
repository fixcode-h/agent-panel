/**
 * 模块入口推送：Agent 第一次读或改某个模块的文件时，把这个模块的职责、对外入口和模块文档路径推给它；
 * 这次改动要新增公开函数时，提醒先按功能搜一次有没有现成的。
 *
 * 为什么：「先用现成的接口」（用户 2026-11-21）写进执行角色和 coding-standards 以后，做不做仍看模型自己，
 * 弱模型读完那一段照样在自己文件里另写一个已有的函数。模块文档的元数据头本来就有「源码」「入口」（ADR 0048），
 * 在碰到这个模块的那一刻推过去，比放在九千字的角色设定里管用。只提醒、不拦截。
 * 全是纯函数：服务端钩子（server/hooks/module-push.ts）调它。交给 Agent 的话是提示词，不翻译
 */
import type { ModuleDoc } from '../module-docs.ts'
import { publicFnsAdded, publicFnsInDiff } from '../code/public-fns.ts'

/** 一段推送最多多少字：和教训推送（PUSH_RULES.maxChars）同一个量级，多了成噪音 */
export const MODULE_PUSH_MAX_CHARS = 600

/** 源码一项写成路径的样子才拿来匹配（「server/」「web/src/lib/ui-actions.ts」）；带说明文字的整句跳过 */
const PATH_LIKE = /^[\w.@~-][\w./@~-]*$/

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '')

/** 一个源码项能不能覆盖这个文件：目录前缀（带不带结尾的 / 都行）或者就是这个文件 */
function covers(source: string, file: string): number {
  const s = norm(source.trim()).replace(/\*+.*$/, '')
  if (!s || !PATH_LIKE.test(s)) return 0
  const dir = s.endsWith('/') ? s : `${s}/`
  if (file === s.replace(/\/$/, '') || file.startsWith(dir)) return s.length
  return 0
}

/**
 * 文件属于哪个模块：按源码项匹配，取最长的那条（server/exec/ 比 server/ 更具体）。
 * file 是相对项目根的路径；对不上任何模块返回 undefined
 */
export function moduleOfFile(docs: ModuleDoc[], file: string): ModuleDoc | undefined {
  const f = norm(file)
  let best: ModuleDoc | undefined
  let bestLen = 0
  for (const d of docs) {
    for (const s of d.sources) {
      const n = covers(s, f)
      if (n > bestLen) {
        best = d
        bestLen = n
      }
    }
  }
  return best
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** 推给模型的那一段：这个文件属于哪个模块、模块对外的入口在哪、模块文档在哪 */
export function moduleEntryText(doc: ModuleDoc, file: string, docPath: string): string {
  const entry = doc.entry.length ? doc.entry.map((e) => `\`${clip(e, 120)}\``).join('、') : '（文档里没写入口）'
  const text = [
    `【面板】\`${file}\` 属于模块「${doc.name}」${doc.role ? `（${clip(doc.role, 80)}）` : ''}。`,
    `它对外的入口：${entry}；模块文档 \`${docPath}\`${doc.status === 'stale' ? '（标了过期，以代码为准）' : ''}。`,
    '要用这个模块的数据或能力，先看这些入口和现有调用方怎么取，有现成的就调用，不在自己这边另写一份。',
  ].join('')
  return clip(text, MODULE_PUSH_MAX_CHARS)
}

/** 新增公开函数时的提醒：按功能搜一次，决定新建的写一行复用检查 */
export function newPublicFnText(names: string[]): string {
  const list = names
    .slice(0, 5)
    .map((n) => `\`${n}\``)
    .join('、')
  return clip(
    `【面板】这次改动要新增公开函数 ${list}。新建前按它的功能关键词用代码索引工具（没有就 rg）搜一次，确认没有现成的、也不是排查中读到过的函数能直接用或小改着用；决定新建的，在结果里写一行「复用检查：看了哪里、为什么不能用」。`,
    MODULE_PUSH_MAX_CHARS,
  )
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const linesOf = (s: string) => (s ? s.replace(/\r\n/g, '\n').split('\n') : [])

/**
 * 改文件工具这次要加进去的行：各家 CLI 的改文件参数不一样，按常见的几种取（新文本减去旧文本里已有的行）。
 * 补丁形式（apply_patch 这类，参数里是 diff）交给 publicFnsInDiff。认不出的返回空，宁可不提醒
 */
export function addedLines(input: Record<string, unknown>): string[] {
  const pairs: [string, string][] = []
  const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : []
  for (const e of edits)
    pairs.push([str(e.old_string ?? e.oldText ?? e.old_str), str(e.new_string ?? e.newText ?? e.new_str)])
  pairs.push([
    str(input.old_string ?? input.oldText ?? input.old_str),
    str(input.new_string ?? input.newText ?? input.new_str),
  ])
  pairs.push(['', str(input.content ?? input.file_text)])
  const out: string[] = []
  for (const [oldText, newText] of pairs) {
    if (!newText) continue
    const old = new Set(linesOf(oldText).map((l) => l.trim()))
    out.push(...linesOf(newText).filter((l) => !old.has(l.trim())))
  }
  return out
}

/** 这次改文件调用要新增的公开函数名：普通改文件按文件规则认，参数里是补丁的按 diff 认 */
export function newPublicFns(input: Record<string, unknown>, file: string): string[] {
  const patch = str(input.patch ?? input.input)
  if (patch.includes('\n+') && /^(?:\*\*\* |diff --git |--- )/m.test(patch))
    return [
      ...new Set(publicFnsInDiff(patch.replace(/^\*\*\* (?:Add|Update) File: (.+)$/gm, '+++ b/$1')).map((f) => f.name)),
    ]
  return file ? publicFnsAdded(file, addedLines(input)) : []
}
