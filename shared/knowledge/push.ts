import type { ProjectLesson } from '../schema.ts'
import type { ProjectExperience } from '../experience.ts'
import { globToRegExp } from '../lessons.ts'
import { commandSegments } from '../hooks/defs.ts'
import { commandWords, searchWords, wordsOf } from './match/normalize.ts'
import { errorPrint, printScore } from './match/fingerprint.ts'
import type { ErrorPrint } from '../schema.ts'

/**
 * 教训、经验的事件推送（设计稿「经验与教训重新设计 2026-11-15」一期）：不改数据格式，用现有字段做粗匹配，
 * 在跑命令、改文件、搜索之前和工具报错之后把对得上的几条推给模型。
 * 全是纯函数、不调模型：面板钩子（server/hooks/knowledge-push.ts）和回放评测（scripts/knowledge-replay.mjs）共用这一份，
 * 门槛都在 PUSH_RULES 里，回放调准了只改这一处
 */

export const PUSH_RULES = {
  /** 一次推送最多几条、合计多少字：多了就成了噪音 */
  maxItems: 3,
  maxChars: 600,
  /** 报错匹配：至少几个词对上、占报错词的比例，或者错误码对上 */
  errorMinWords: 3,
  errorMinRatio: 0.3,
  /** 搜索匹配经验：别名（关键词）整词相同直接算；否则至少几个词命中 */
  searchMinTerms: 2,
} as const

/** 命中了哪一条、按什么命中：推送文字和对话里的标签都用它 */
export interface PushHit {
  kind: 'lesson' | 'experience'
  id: string
  title: string
  /** 命中的依据：command 跑命令前、path 改文件前、error 报错后、search 搜索前 */
  why: 'command' | 'path' | 'error' | 'search'
  /** 推给模型的那一行 */
  line: string
}

/** 只有程序名、说明不了目的的命令：教训里单写一个 `git` 不能拿来匹配所有 git 命令 */
// 模块状态：常量，加载后不改
const GENERIC_PROG = new Set(
  'ls cd cat echo node npm pnpm yarn git python python3 py bash sh pwsh powershell rm cp mv mkdir grep rg find sed awk head tail make go cargo dotnet code type dir'.split(
    ' ',
  ),
)

/** 教训正文里用反引号写出来的命令：取它的「目的」（程序名 + 前两个参数，不带选项） */
export function lessonCommands(l: Pick<ProjectLesson, 'title' | 'rule' | 'cause'>): string[][] {
  const out: string[][] = []
  const seen = new Set<string>()
  for (const text of [l.title, l.rule, l.cause])
    for (const m of text.matchAll(/`([^`\n]{2,200})`/g)) {
      for (const seg of commandSegments(m[1])) {
        const ws = commandWords(seg)
        if (!ws.length || !/^[a-z][\w.:-]*$/.test(ws[0])) continue
        // 开头是路径、文件名的不算命令（`scripts/fake-cli`、`shared/clis/pi.json`）
        if (/[/\\]/.test(seg.trim().split(/\s+/)[0])) continue
        if (/\.(ts|tsx|js|json|md|cs|cpp|h|py|lua)$/.test(ws[0])) continue
        const purpose = [
          ws[0],
          ...ws
            .slice(1)
            .filter((w) => !w.startsWith('-'))
            .slice(0, 2),
        ]
        if (purpose.length === 1 && (GENERIC_PROG.has(purpose[0]) || purpose[0].length < 6)) continue
        // 只有程序名 + 一个参数、而程序又很通用的（`git status`），要求参数也对上，下面按前缀比
        const key = purpose.join(' ')
        if (!seen.has(key)) {
          seen.add(key)
          out.push(purpose)
        }
      }
    }
  return out
}

/** 明确写下的命令触发键（triggers.commands）：取「目的」的写法和正文里的一样，只是不挑通用程序名（用户写了就算） */
export function triggerCommands(l: Partial<Pick<ProjectLesson, 'triggers'>>): string[][] {
  return (
    (l.triggers?.commands ?? [])
      .flatMap((c) => commandSegments(c).slice(0, 1))
      .map((seg) => {
        const ws = commandWords(seg)
        return ws.length ? [ws[0], ...ws.slice(1).filter((w) => !w.startsWith('-'))].slice(0, 3) : []
      })
      // 只有一个通用程序名的（`node`、`git`）不能当触发键：会对上这个程序的所有命令
      .filter((w) => w.length > 1 || (w.length === 1 && !GENERIC_PROG.has(w[0])))
  )
}

/** 当场捕获存触发键前用：只有通用程序名的目的不存 */
export const specificPurpose = (purpose: string) => !!purpose && (purpose.includes(' ') || !GENERIC_PROG.has(purpose))

/** 要跑的这条命令对不对得上教训里写的命令：任一段的开头几个非选项词和教训里的「目的」或命令触发键一样 */
export function commandHits(
  lesson: Pick<ProjectLesson, 'title' | 'rule' | 'cause'> & Partial<Pick<ProjectLesson, 'triggers'>>,
  command: string,
): boolean {
  const wants = [...triggerCommands(lesson), ...lessonCommands(lesson)]
  if (!wants.length) return false
  for (const seg of commandSegments(command)) {
    const ws = commandWords(seg)
    if (!ws.length) continue
    const purpose = [ws[0], ...ws.slice(1).filter((w) => !w.startsWith('-'))]
    if (wants.some((w) => w.every((x, i) => purpose[i] === x))) return true
  }
  return false
}

const lessonWords = new WeakMap<object, Set<string>>() // 模块状态：缓存，丢了重算（按教训对象记，对象没了跟着回收）
function wordsOfLesson(l: Pick<ProjectLesson, 'title' | 'rule' | 'cause'>) {
  let s = lessonWords.get(l)
  if (!s) {
    s = new Set(wordsOf(`${l.title}\n${l.rule}\n${l.cause}`))
    lessonWords.set(l, s)
  }
  return s
}

/**
 * 这条教训和这次报错有多相关：先比存下的报错指纹（triggers.errors，录入时用真实报错算的，最准）；
 * 再比正文：错误码对上 +5，词对上的个数够多、占比够高再按个数加分；0 表示不推
 */
export function errorScore(
  l: Pick<ProjectLesson, 'title' | 'rule' | 'cause'> & Partial<Pick<ProjectLesson, 'triggers'>>,
  p: ErrorPrint,
): number {
  const stored = Math.max(0, ...(l.triggers?.errors ?? []).map((e) => printScore(e, p)))
  if (stored) return stored + 5
  const text = `${l.title}\n${l.rule}\n${l.cause}`
  const code = p.codes.some((c) => text.includes(c)) ? 5 : 0
  const ws = wordsOfLesson(l)
  const n = p.words.filter((w) => ws.has(w)).length
  const enough = n >= PUSH_RULES.errorMinWords && n / Math.max(1, p.words.length) >= PUSH_RULES.errorMinRatio
  const score = code + (enough ? n : 0)
  // 错误码对上但一个词都不沾边的（同一个码在别的工具上出现）不算
  return code && n === 0 ? 0 : score >= 5 ? score : 0
}

/** 搜索词和经验的关键词、标题对不对得上：关键词整词相同直接算；否则要至少两个词命中 */
export function searchScore(e: ProjectExperience, words: string[]): number {
  if (!words.length) return 0
  // 整个关键词（UDropTable、掉落表）对上才算「整词相同」；关键词拆出来的部分（drop、table）只算沾边
  const whole = e.keywords.map((k) => k.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ''))
  const kws = e.keywords.flatMap((k) => [k.toLowerCase(), ...wordsOf(k)])
  const title = e.title.toLowerCase()
  let score = 0
  let exact = false
  let terms = 0
  for (const w of words) {
    if (whole.includes(w) && (w.length >= 3 || /[一-鿿]/.test(w))) {
      score += 4
      terms++
      exact = true
    } else if (
      kws.includes(w) ||
      (w.length >= 3 && kws.some((k) => k.length >= 3 && (k.includes(w) || w.includes(k))))
    ) {
      score += 3
      terms++
    } else if (title.includes(w)) {
      score += 2
      terms++
    }
  }
  return exact || terms >= PUSH_RULES.searchMinTerms ? score : 0
}

/** 搜索已经限定在这条经验的位置下面了：不必再推（Agent 已经在对的地方找） */
export function insideAnchor(e: ProjectExperience, searchPath: string): boolean {
  const p = searchPath.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!p || p === '.') return false
  return e.paths.some((g) => {
    try {
      return globToRegExp(g).test(p) || globToRegExp(g).test(`${p}/x`)
    } catch {
      return false
    }
  })
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export const lessonLine = (l: Pick<ProjectLesson, 'id' | 'title' | 'rule'> & Partial<Pick<ProjectLesson, 'wrong'>>) =>
  `- [教训 ${l.id}] ${clip(l.title, 80)}${l.rule ? `：${clip(l.rule.replace(/\s+/g, ' '), 160)}` : ''}${l.wrong ? `（别这样：${clip(l.wrong.replace(/\s+/g, ' '), 80)}）` : ''}`

export const experienceLine = (e: Pick<ProjectExperience, 'id' | 'title' | 'body' | 'paths'>) =>
  `- [经验 ${e.id}] ${clip(e.title, 60)}${e.body ? `：${clip(e.body.replace(/\s+/g, ' '), 140)}` : ''}${e.paths.length ? `（位置：${e.paths.slice(0, 4).join('、')}）` : ''}`

/** 按预算挑：最多 maxItems 条、合计不超过 maxChars 字（第一条再长也给） */
export function budgetHits(hits: PushHit[]): PushHit[] {
  const out: PushHit[] = []
  let used = 0
  for (const h of hits) {
    if (out.length >= PUSH_RULES.maxItems) break
    if (out.length && used + h.line.length > PUSH_RULES.maxChars) break
    out.push(h)
    used += h.line.length
  }
  return out
}

/** 推给模型的一段话：开头说明为什么推，后面一条一行 */
export function pushText(hits: PushHit[], why: PushHit['why'], subject: string): string {
  if (!hits.length) return ''
  const head = {
    command: `【面板】要跑的命令（${clip(subject, 60)}）有相关的项目教训，先对照再跑：`,
    path: `【面板】${clip(subject, 80)} 有相关的项目教训，照着改：`,
    error: '【面板】以前遇到过类似的报错，当时记下的做法（对不上就照常排查）：',
    search: '【面板】项目经验里记过这个位置，先去这里看，对不上再照常搜：',
  }[why]
  return `${head}\n${hits.map((h) => h.line).join('\n')}${why === 'error' ? '' : '\n要看全文用 knowledge_lookup 查，query 写这条的 id。'}`
}

/**
 * 会推送的教训（设计稿 4.7）：停用的、只在查询里出现的（hint）、已经提炼进 AGENTS.md 或钩子的（promoted）不推；
 * 置顶的排前面，锚点核对不过的（stale）排后面。旧数据没有这两个字段时按 warn / active
 */
export function pushable<T extends Partial<Pick<ProjectLesson, 'severity' | 'status'>> & { enabled: boolean }>(
  lessons: T[],
): T[] {
  const rank = (l: T) => (l.status === 'pinned' ? 0 : l.status === 'stale' ? 2 : 1)
  return lessons
    .filter((l) => l.enabled && l.severity !== 'hint' && l.status !== 'promoted')
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i)
    .map((x) => x.l)
}

/** 升级成拦截（block）的教训里，这条命令对得上的第一条：跑之前直接拒绝，给出对的做法 */
export function blockingLesson(lessons: ProjectLesson[], command: string): ProjectLesson | undefined {
  return lessons.find((l) => l.enabled && l.severity === 'block' && l.status !== 'promoted' && commandHits(l, command))
}

/** 拦截时给模型的说明：错在哪、该怎么做；不是真要这么跑的，让用户在知识页把这条降回提醒 */
export function blockText(l: Pick<ProjectLesson, 'id' | 'title' | 'rule' | 'wrong'>, command: string): string {
  return `【面板】这条命令（${clip(command.replace(/\s+/g, ' '), 80)}）被项目教训拦下了（用户把它升级成了拦截）：${l.title}${l.wrong ? `\n错的做法：${clip(l.wrong, 200)}` : ''}${l.rule ? `\n对的做法：${clip(l.rule.replace(/\s+/g, ' '), 300)}` : ''}\n照对的做法改了再跑；确实要这么跑，停下来说明原因，请用户在项目设置的教训里把 ${l.id} 降回提醒。`
}

/** 跑命令之前：命令对得上教训里写的命令 */
export function commandLessons(lessons: ProjectLesson[], command: string): PushHit[] {
  return pushable(lessons)
    .filter((l) => commandHits(l, command))
    .map((l) => ({ kind: 'lesson' as const, id: l.id, title: l.title, why: 'command' as const, line: lessonLine(l) }))
}

/** 改文件之前：路径对得上教训的 paths（不写 paths 的「全局适用」条目开头已经给过，不在这里推） */
export function pathLessons(lessons: ProjectLesson[], rel: string): PushHit[] {
  if (!rel) return []
  return pushable(lessons)
    .filter((l) => l.paths.length && l.paths.some((g) => globToRegExp(g).test(rel)))
    .map((l) => ({ kind: 'lesson' as const, id: l.id, title: l.title, why: 'path' as const, line: lessonLine(l) }))
}

/** 工具失败之后：报错特征对得上教训的正文，分高的在前 */
export function errorLessons(lessons: ProjectLesson[], output: string): PushHit[] {
  const p = errorPrint(output)
  if (!p.words.length && !p.codes.length) return []
  return pushable(lessons)
    .map((l) => ({ l, s: errorScore(l, p) * (l.status === 'stale' ? 0.3 : 1) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(({ l }) => ({ kind: 'lesson' as const, id: l.id, title: l.title, why: 'error' as const, line: lessonLine(l) }))
}

/** 搜索之前：搜索词对得上经验的关键词、标题；已经在这条经验的位置里搜的不推 */
export function searchExperience(list: ProjectExperience[], query: string, searchPath = ''): PushHit[] {
  const words = searchWords(query)
  return list
    .filter((e) => e.enabled && !insideAnchor(e, searchPath))
    .map((e) => ({ e, s: searchScore(e, words) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(({ e }) => ({
      kind: 'experience' as const,
      id: e.id,
      title: e.title,
      why: 'search' as const,
      line: experienceLine(e),
    }))
}
