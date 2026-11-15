import type { ProjectLesson } from '../schema.ts'
import type { ProjectExperience } from '../experience.ts'
import { globToRegExp } from '../lessons.ts'
import { commandSegments } from '../hooks/defs.ts'

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
  /** 报错只看前这么多字（命令输出可能很长） */
  errorHead: 4000,
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

/** 太常见、匹配了也说明不了什么的词 */
// 模块状态：常量，加载后不改
const STOP = new Set(
  (
    'the and for with from this that are was not but you your have has can will all any use used using get set new ' +
    'src lib dist test tests spec file files dir path line col error errors warn warning info debug failed fail failure ' +
    'true false null undefined const let var function return import export default class type types string number ' +
    'object array value values name names data json yml yaml txt log logs cmd exe ' +
    'npm node git run main dev index'
  ).split(' '),
)

/**
 * 拆成检索词：英文按驼峰、下划线、点、连字符拆开并保留整词（UDropTable → u、drop、table、udroptable），
 * 中文两字一组（和 shared/experience.ts 的 queryTerms 同一个思路）。一个字母的、停用词不算
 */
export function wordsOf(s: string): string[] {
  const out = new Set<string>()
  for (const raw of s.split(/[^A-Za-z0-9一-鿿]+/)) {
    if (!raw) continue
    if (/[一-鿿]/.test(raw)) {
      for (const han of raw.match(/[一-鿿]+/g) ?? [])
        if (han.length <= 2) out.add(han)
        else for (let i = 0; i + 2 <= han.length; i++) out.add(han.slice(i, i + 2))
      for (const x of raw.split(/[一-鿿]+/)) addAscii(out, x)
    } else addAscii(out, raw)
  }
  return [...out].filter((w) => !STOP.has(w))
}

function addAscii(out: Set<string>, raw: string) {
  if (!raw) return
  const whole = raw.toLowerCase()
  if (whole.length >= 2 && !/^\d+$/.test(whole)) out.add(whole)
  // 驼峰：UDropTable → U Drop Table；HTTPServer → HTTP Server
  const parts = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_]+/)
  if (parts.length > 1) for (const p of parts) if (p.length >= 3 && !/^\d+$/.test(p)) out.add(p.toLowerCase())
}

/** 程序名归一：去掉目录和 .exe / .cmd，小写 */
const prog = (s: string) =>
  s
    .replace(/^["']|["']$/g, '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase()

/** 一段命令拆成词，去掉环境变量赋值、sudo、npx、env 这类前缀：剩下的开头几个词就是这条命令的「目的」 */
export function commandWords(seg: string): string[] {
  const words = seg.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^(sudo|npx|time|command|exec|call|&)$/i.test(w)) i++
    else if (/^env$/i.test(w)) {
      i++
      // env -u NAME / env -i / env NAME=value
      while (i < words.length && (words[i].startsWith('-') || /=/.test(words[i]))) i += words[i] === '-u' ? 2 : 1
    } else break
  }
  const rest = words.slice(i)
  if (!rest.length) return []
  return [prog(rest[0]), ...rest.slice(1).map((w) => w.replace(/^["']|["']$/g, ''))]
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

/** 要跑的这条命令对不对得上教训里写的命令：任一段的开头几个非选项词和教训里的「目的」一样 */
export function commandHits(lesson: Pick<ProjectLesson, 'title' | 'rule' | 'cause'>, command: string): boolean {
  const wants = lessonCommands(lesson)
  if (!wants.length) return false
  for (const seg of commandSegments(command)) {
    const ws = commandWords(seg)
    if (!ws.length) continue
    const purpose = [ws[0], ...ws.slice(1).filter((w) => !w.startsWith('-'))]
    if (wants.some((w) => w.every((x, i) => purpose[i] === x))) return true
  }
  return false
}

/** 报错的特征：错误码（ENOENT、TS2589、LNK2019、xxxError）和抹掉路径、数字后的词 */
export interface ErrorPrint {
  codes: string[]
  words: string[]
}

const ERROR_LINE = /error|err!|failed|fatal|exception|denied|unauthorized|not found|cannot|错误|失败|找不到|无法/i
const CODE_RE =
  /\b(E[A-Z]{3,}|TS\d{4}|[CE]\d{4}|LNK\d{4}|MSB\d{4}|CS\d{4}|[A-Z][A-Za-z]+(?:Error|Exception)|HTTP\s?[45]\d\d|\b[45]\d\d\s+(?:Unauthorized|Forbidden|Not Found))\b/g
/** 太泛的错误名：只当普通词，不当错误码 */
// 模块状态：常量，加载后不改
const GENERIC_CODE = new Set(['Error', 'TypeError', 'SyntaxError', 'ReferenceError', 'RangeError', 'Exception'])

/** 从失败输出里取报错特征：挑含报错字样的行（最多 5 行），没有就取最后 5 个非空行 */
export function errorPrint(output: string): ErrorPrint {
  const head = output.slice(0, PUSH_RULES.errorHead)
  const lines = head.split('\n').map((x) => x.trim())
  const nonEmpty = lines.filter(Boolean)
  let pick = nonEmpty.filter((x) => ERROR_LINE.test(x)).slice(0, 5)
  if (!pick.length) pick = nonEmpty.slice(-5)
  const text = pick
    .join('\n')
    // 绝对路径只留文件名，十六进制、UUID、时间戳、数字都是会变的
    .replace(/(?:[A-Za-z]:)?[\\/][^\s:'"()]+[\\/]([^\s\\/:'"()]+)/g, ' $1 ')
    .replace(/\b[0-9a-f]{8,}\b/gi, ' ')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, ' ')
  const codes = [...new Set([...text.matchAll(CODE_RE)].map((m) => m[1].replace(/\s+/g, ' ')))].filter(
    (c) => !GENERIC_CODE.has(c),
  )
  const words = wordsOf(text.replace(/\d+/g, ' '))
    .filter((w) => /[一-鿿]/.test(w) || w.length >= 3)
    .slice(0, 20)
  return { codes, words }
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

/** 这条教训和这次报错有多相关：错误码对上 +5，词对上的个数够多、占比够高再按个数加分；0 表示不推 */
export function errorScore(l: Pick<ProjectLesson, 'title' | 'rule' | 'cause'>, p: ErrorPrint): number {
  const text = `${l.title}\n${l.rule}\n${l.cause}`
  const code = p.codes.some((c) => text.includes(c)) ? 5 : 0
  const ws = wordsOfLesson(l)
  const n = p.words.filter((w) => ws.has(w)).length
  const enough = n >= PUSH_RULES.errorMinWords && n / Math.max(1, p.words.length) >= PUSH_RULES.errorMinRatio
  const score = code + (enough ? n : 0)
  // 错误码对上但一个词都不沾边的（同一个码在别的工具上出现）不算
  return code && n === 0 ? 0 : score >= 5 ? score : 0
}

/**
 * 搜索工具（Grep、Glob、rg、grep、find…）要搜什么：从参数里抠出字面量词。
 * 读文件类工具看 pattern / query / glob / regex 这几个参数（各家搜索工具都这么叫，不按工具名判断）；
 * 跑命令看每段命令是不是搜索命令。不是搜索返回 null
 */
export function searchText(kind: string, input: Record<string, unknown>): string | null {
  if (kind === 'read') {
    const v = ['pattern', 'query', 'regex', 'glob', 'name']
      .map((k) => input[k])
      .filter((x): x is string => typeof x === 'string' && !!x.trim())
    return v.length ? v.join(' ') : null
  }
  if (kind !== 'shell') return null
  const out: string[] = []
  for (const seg of commandSegments(String(input.command ?? ''))) {
    const ws = commandWords(seg)
    const p = ws[0]
    if (!p) continue
    const sub =
      p === 'git' && ws[1] === 'grep' ? 2 : /^(rg|grep|egrep|ag|ack|findstr|select-string|sls|fd)$/.test(p) ? 1 : 0
    if (sub) {
      // 第一个不是选项的参数是要搜的东西（-e 后面跟的也是）；带值的选项（--type ts、-g '*.h'）跳过它的值
      for (let i = sub; i < ws.length; i++) {
        if (ws[i] === '-e' || ws[i] === '--regexp' || ws[i] === '-Pattern') {
          if (ws[i + 1]) out.push(ws[i + 1])
          break
        }
        if (VALUE_OPTS.has(ws[i])) {
          i++
          continue
        }
        if (!ws[i].startsWith('-')) {
          out.push(ws[i])
          break
        }
      }
    } else if (p === 'find' || p === 'get-childitem' || p === 'gci') {
      for (let i = 1; i < ws.length - 1; i++) if (/^-(i?name|i?path|filter|include)$/i.test(ws[i])) out.push(ws[i + 1])
    }
  }
  return out.length ? out.join(' ') : null
}

/** 搜索命令里后面跟一个值的选项：值不是要搜的东西 */
// 模块状态：常量，加载后不改
const VALUE_OPTS = new Set(
  '-t --type -T --type-not -g --glob --iglob -A -B -C --context --after-context --before-context -m --max-count --max-depth -d -j --threads -M --max-columns --include --exclude --exclude-dir -f --file -Path -Include'.split(
    ' ',
  ),
)

/** 正则、glob 里的字面量：去掉转义类和量词（DT_\w+Row → DT Row），再拆成检索词 */
export function searchWords(q: string): string[] {
  const lit = q
    .replace(/\\[wdsbWDSB]/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[.*+?^$(){}|\\]/g, ' ')
  return wordsOf(lit)
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

export const lessonLine = (l: Pick<ProjectLesson, 'id' | 'title' | 'rule'>) =>
  `- [教训 ${l.id}] ${clip(l.title, 80)}${l.rule ? `：${clip(l.rule.replace(/\s+/g, ' '), 160)}` : ''}`

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
  return `${head}\n${hits.map((h) => h.line).join('\n')}${why === 'error' ? '' : '\n要看全文用 project_lessons / project_experience 带 id 查。'}`
}

/** 跑命令之前：命令对得上教训里写的命令 */
export function commandLessons(lessons: ProjectLesson[], command: string): PushHit[] {
  return lessons
    .filter((l) => l.enabled && commandHits(l, command))
    .map((l) => ({ kind: 'lesson' as const, id: l.id, title: l.title, why: 'command' as const, line: lessonLine(l) }))
}

/** 改文件之前：路径对得上教训的 paths（不写 paths 的「全局适用」条目开头已经给过，不在这里推） */
export function pathLessons(lessons: ProjectLesson[], rel: string): PushHit[] {
  if (!rel) return []
  return lessons
    .filter((l) => l.enabled && l.paths.length && l.paths.some((g) => globToRegExp(g).test(rel)))
    .map((l) => ({ kind: 'lesson' as const, id: l.id, title: l.title, why: 'path' as const, line: lessonLine(l) }))
}

/** 工具失败之后：报错特征对得上教训的正文，分高的在前 */
export function errorLessons(lessons: ProjectLesson[], output: string): PushHit[] {
  const p = errorPrint(output)
  if (!p.words.length && !p.codes.length) return []
  return lessons
    .filter((l) => l.enabled)
    .map((l) => ({ l, s: errorScore(l, p) }))
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
