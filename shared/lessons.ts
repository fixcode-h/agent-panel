import type { GlobalLesson, ProjectLesson } from './schema.ts'
// 循环引用（push.ts 也用这里的 globToRegExp）：两边都只在调用时用，模块加载时不取值，没问题
import { lessonCommands } from './knowledge/push.ts'

/**
 * 项目教训怎么交给 Agent：条目会越积越多，全文塞进每次的提示太费 token。
 * 所以提示里只放「所有改动都适用」的全文和其余条目的标题，Agent 想好要改哪些文件后
 * 用面板工具 project_lessons 按文件取命中的全文；没有面板工具的 CLI 按预算给全文，超出的只给标题。
 */

/** 一次最多存多少条：再多就该合并同类项了 */
export const MAX_LESSONS = 200
/** 没有面板工具时全文的预算（字数）：超出的只列标题。有工具时见下面的 PROMPT_CAP */
const FULL_BUDGET_NO_TOOL = 6000
/** 全局教训的全文预算：排在项目教训后面，给少一些 */
const GLOBAL_BUDGET = 2000
/** 标题最多列多少条，再多只报个数 */
const MAX_TITLES = 60
/** project_lessons 一次返回的全文预算：命中再多也只给最相关的这些，其余列标题，免得一次吐出几十万字 */
const FIND_BUDGET = 8000
const FIND_GLOBAL_BUDGET = 3000
/** 每条最多几个标签、每个多长 */
export const MAX_TAGS = 5
export const MAX_TAG_LEN = 20
/** 提示里列出的已有标签数：让 Agent 记新条目时复用，不另造近义词 */
const MAX_TAG_HINT = 30

/** `paths` 里的 glob 转成正则：`**` 跨目录，`*` 不跨；不带通配符的写法同时匹配这个目录下的文件 */
export function globToRegExp(g: string) {
  const body = norm(g)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    // oxlint-disable-next-line no-control-regex -- 故意匹配控制字符（ANSI 转义序列、不可见字符）
    .replace(/\u0000/g, '.*')
  return new RegExp(/[*?]/.test(g) ? `^${body}$` : `^${body}(/.*)?$`)
}

const norm = (p: string) => p.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')

// 同一批 glob 每次查找都要用：编译一次缓存起来（上万条时省掉大半耗时）。条目都是用户和 Agent 写的，数量有限，超了清空重来即可
const globCache = new Map<string, RegExp>() // 模块状态：缓存，丢了重算
function globRe(g: string) {
  let re = globCache.get(g)
  if (!re) {
    if (globCache.size > 5000) globCache.clear()
    re = globToRegExp(g)
    globCache.set(g, re)
  }
  return re
}

/**
 * 这条教训和这些文件有多相关：0 不相关；没写 paths 的对所有改动都适用，算最低的 1；
 * 写死的文件或目录最具体，`*` 次之，`**` 最宽。files 要先 norm 过
 */
function matchScore(l: { paths: string[] }, files: string[]) {
  if (!l.paths.length) return 1
  let best = 0
  for (const g of l.paths) {
    const score = g.includes('**') ? 2 : /[*?]/.test(g) ? 3 : 4
    if (score > best && files.some((f) => globRe(g).test(f))) best = score
  }
  return best
}

/** 这条教训管不管这些文件；没写 paths 的对所有改动都适用 */
export function lessonMatches(l: { paths: string[] }, files: string[]) {
  return matchScore(l, files.map(norm)) > 0
}

/** 整理标签：去掉 #、空白和重复；和已有标签只差大小写的沿用已有的写法，免得同一个词出现两种拼法 */
export function normTags(tags: string[], existing: string[] = []) {
  const known = new Map(existing.map((x) => [x.toLowerCase(), x]))
  const out: string[] = []
  for (const raw of tags) {
    const x = raw.replace(/^#+/, '').trim().slice(0, MAX_TAG_LEN)
    if (!x) continue
    const v = known.get(x.toLowerCase()) ?? x
    if (!out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v)
  }
  return out.slice(0, MAX_TAGS)
}

/** 各标签用了几条，多的在前 */
export function tagCounts(lessons: { tags?: string[] }[]) {
  const m = new Map<string, number>()
  for (const l of lessons) for (const x of l.tags ?? []) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** 「默认」页签的键：标签不会是空串（normTags 去掉了空的），拿它当默认页签不会和真标签撞 */
export const DEFAULT_TAB = ''
/** 这条教训在不在这个页签里：一个标签都没有的在「默认」，带标签的在它的每个标签页签里 */
export const inTab = (l: { tags: string[] }, tab: string) =>
  tab === DEFAULT_TAB ? !l.tags.length : l.tags.includes(tab)
/** 页签和各自的条数：「默认」在最前，其余按标签用得多少排（tags 是全部教训的标签，搜索时数字按 list 算） */
export function lessonTabs(list: { tags: string[] }[], tags: [string, number][]): [string, number][] {
  return [DEFAULT_TAB, ...tags.map(([x]) => x)].map((x) => [x, list.filter((l) => inTab(l, x)).length])
}

/** 搜索用的全文（小写）：界面搜索框和 project_lessons 的 query 用同一套 */
export const lessonHaystack = (l: ProjectLesson | GlobalLesson) =>
  [l.id, l.title, l.rule, l.cause, ...l.paths, ...('tags' in l ? l.tags : [])].join('\n').toLowerCase()

/** 空格分开的几个词都要出现 */
export function queryMatcher(q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  return (hay: string) => words.every((w) => hay.includes(w))
}

/** withId：带上 id，Agent 要改写这一条时用（record_lesson 的 id） */
export function lessonText(l: ProjectLesson | GlobalLesson, withId = false) {
  return [
    `### ${l.title}${withId ? `（id: ${l.id}）` : ''}`,
    l.rule,
    l.cause ? `起因：${l.cause}` : '',
    l.paths.length ? `范围：${l.paths.join('、')}` : '',
    'tags' in l && l.tags.length ? `标签：${l.tags.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export interface LessonQuery {
  /** 关键词：空格分开的几个词都要出现在标题、说明、起因、范围、标签或 id 里 */
  query?: string
  /** 带其中任一个标签的 */
  tags?: string[]
}

/**
 * project_lessons 的结果：按文件 / 关键词 / 标签命中的条目，最相关的在前，给到预算为止的全文，其余列标题（项目的在前，全局的在后）；
 * 什么条件都没给时列出全部标题
 */
export function findLessons(
  lessons: ProjectLesson[],
  files: string[],
  globals: GlobalLesson[] = [],
  opts: LessonQuery = {},
  /** 交出全文的项目教训算命中（全局教训不算，它不归项目管），给面板记「用没用上」（shared/knowledge-hits.ts） */
  onHit?: (ids: string[]) => void,
) {
  const on = lessons.filter((l) => l.enabled)
  const gs = globals.filter((l) => l.enabled)
  if (!on.length && !gs.length) return '这个项目还没有教训。'
  const list = files.map(norm).filter(Boolean)
  const q = opts.query?.trim() ?? ''
  const tags = normTags(opts.tags ?? []).map((x) => x.toLowerCase())
  if (!list.length && !q && !tags.length) {
    const tc = tagCounts(on)
    return [
      on.length
        ? `这个项目的教训（${on.length} 条），传 files 取相关条目的全文，或用 query / tags 查：\n${titles(on, true)}`
        : '',
      tc.length ? tagLine(tc) : '',
      gs.length ? `全局教训（${gs.length} 条，优先级低于项目教训）：\n${titles(gs)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  const hasQ = queryMatcher(q)
  const rank = <T extends ProjectLesson | GlobalLesson>(ls: T[]) => {
    const out: { l: T; score: number }[] = []
    for (const l of ls) {
      if (tags.length && !('tags' in l && l.tags.some((x) => tags.includes(x.toLowerCase())))) continue
      if (q && !hasQ(lessonHaystack(l))) continue
      const score = list.length ? matchScore(l, list) : 1
      if (score) out.push({ l, score })
    }
    // sort 是稳定的：同样相关时保持原来的顺序
    return out.sort((a, b) => b.score - a.score).map((x) => x.l)
  }
  const hit = rank(on)
  const ghit = rank(gs)
  if (!hit.length && !ghit.length)
    return list.length && !q && !tags.length ? '这些文件没有相关的教训。' : '没有符合条件的教训。'
  const full = pick(hit, FIND_BUDGET, true)
  const gfull = pick(ghit, FIND_GLOBAL_BUDGET, false)
  if (full.length) onHit?.(full.map((l) => l.id))
  const more = (n: number) => `另有 ${n} 条相关的，只列标题（要看全文时把 id 或关键词传给 query）：`
  return [
    full.map((l) => lessonText(l, true)).join('\n\n'),
    hit.length > full.length ? `${more(hit.length - full.length)}\n${titles(hit.slice(full.length), true)}` : '',
    ghit.length
      ? `## 全局教训（优先级低于上面的项目教训，冲突时以项目教训为准）\n${gfull.map((l) => lessonText(l)).join('\n\n')}`
      : '',
    ghit.length > gfull.length ? `${more(ghit.length - gfull.length)}\n${titles(ghit.slice(gfull.length))}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const tagLine = (tc: [string, number][], max = MAX_TAG_HINT) =>
  `已有的标签：${tc
    .slice(0, max)
    .map(([x, n]) => `${x}（${n}）`)
    .join('、')}${tc.length > max ? ` 等 ${tc.length} 个` : ''}`

const titleLine = (l: ProjectLesson | GlobalLesson, withId = false) =>
  `- ${l.title}${l.paths.length ? `（${l.paths.join('、')}）` : ''}${'tags' in l && l.tags.length ? ` ${l.tags.map((x) => `#${x}`).join(' ')}` : ''}${withId ? `〔id: ${l.id}〕` : ''}`

const titles = (ls: (ProjectLesson | GlobalLesson)[], withId = false) =>
  [
    ...ls.slice(0, MAX_TITLES).map((l) => titleLine(l, withId)),
    ls.length > MAX_TITLES
      ? `- 另有 ${ls.length - MAX_TITLES} 条${withId ? '（用 project_lessons 的 query 或 tags 查）' : ''}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

/** 按预算挑出给全文的条目：pool 按顺序放，放不下的只列标题 */
function pick<T extends ProjectLesson | GlobalLesson>(pool: T[], budget: number, withId: boolean) {
  const full: T[] = []
  let used = 0
  for (const l of pool) {
    const n = lessonText(l, withId).length
    // 第一条再长也给全文：不然最相关的那条反而只剩标题
    if (used + n > budget && full.length) break
    full.push(l)
    used += n
  }
  return full
}

/** 有面板工具时开头这一段的总字数上限：其余的按文件、命令、报错在执行中推送（shared/knowledge/push.ts），或用 project_lessons 查 */
export const PROMPT_CAP = 1500
/** 有面板工具时「所有改动都适用」的条目给全文的预算，每条全文最多多少字 */
const CAP_FULL = 650
const CAP_GLOBAL = 250
const CAP_ONE = 360
/** 开头列多少个已有标签 */
const CAP_TAGS = 12

/**
 * 新会话开头的「项目教训」：tools 表示这次调用挂了面板工具，能按文件查；canRecord 表示还能自己记
 * （子任务只查不记，见 shared/engine/index.ts 的 Orchestra.lessons），不能记时不带记教训的说明，省下这段提示。
 * globals 是全局教训：所有项目共用，排在项目教训后面、优先级也更低。
 * 有工具时整段不超过 PROMPT_CAP：条目再多也只给最要紧的全文和放得下的标题，其余执行中由面板按命令、文件、报错推送。
 * 没有启用的条目时返回空串，不占提示
 */
export function lessonsPrompt(
  lessons: ProjectLesson[],
  tools: boolean,
  globals: GlobalLesson[] = [],
  canRecord = tools,
  /** 用户这次的需求原文：教训的意图词（triggers.intents）对得上的开头就给全文（ADR 0066） */
  request = '',
) {
  // 已经提炼进 AGENTS.md / 钩子的（promoted）、只在查询里出现的（hint）开头不带；置顶的排前面
  const on = lessons
    .filter((l) => l.enabled && l.status !== 'promoted' && l.severity !== 'hint')
    .sort((a, b) => Number(b.status === 'pinned') - Number(a.status === 'pinned'))
  const gs = globals.filter((l) => l.enabled)
  if (!on.length && !gs.length) return canRecord ? `## 项目教训\n${RECORD_HINT}` : ''
  if (!tools) return untooledPrompt(on, gs)
  const head = [
    '## 项目教训',
    '以前返工过的地方写成了规则，照做能少走弯路。优先级：用户这次的要求 > 项目教训 > 全局教训；冲突时按前面的做。跑命令、改文件、遇到报错时，面板会把对得上的教训自动补给你。',
  ]
  const tc = tagCounts(on)
  const tail = [
    canRecord && tc.length ? `${tagLine(tc, CAP_TAGS)}。记教训时优先用这些标签，不另造近义词` : '',
    canRecord ? RECORD_HINT : '',
  ].filter(Boolean)
  // 「所有改动都适用」的条目给全文（每条截到 CAP_ONE），按文件的只给标题
  const short = (l: ProjectLesson | GlobalLesson, withId: boolean) => {
    const x = lessonText(l, withId)
    return x.length > CAP_ONE ? `${x.slice(0, CAP_ONE - 1)}…（全文用 knowledge_lookup 带 id 查）` : x
  }
  const takeFull = <T extends ProjectLesson | GlobalLesson>(pool: T[], budget: number, withId: boolean) => {
    const out: T[] = []
    let used = 0
    for (const l of pool) {
      const n = short(l, withId).length
      if (out.length && used + n > budget) break
      out.push(l)
      used += n
    }
    return out
  }
  // 开头给全文的：意图词对上这次需求的（最多 3 条），和没有任何触发键的（路径、命令、报错都没写，执行中推不到它）
  const req = request.toLowerCase()
  const intent = req ? on.filter((l) => l.triggers.intents.some((w) => req.includes(w.toLowerCase()))).slice(0, 3) : []
  const full = takeFull(
    [
      ...intent,
      ...on.filter(
        (l) =>
          !intent.includes(l) &&
          !l.paths.length &&
          !l.triggers.commands.length &&
          !l.triggers.errors.length &&
          (l.status === 'pinned' || !lessonCommands(l).length),
      ),
    ],
    CAP_FULL,
    true,
  )
  const gfull = takeFull(
    gs.filter((l) => !l.paths.length),
    CAP_GLOBAL,
    false,
  )
  const fixed = [...head, ...tail].join('\n\n').length + 40
  let left =
    PROMPT_CAP -
    fixed -
    full.reduce((n, l) => n + short(l, true).length + 2, 0) -
    gfull.reduce((n, l) => n + short(l, false).length + 2, 0)
  // 标题按剩下的预算放，放不下的只报个数
  const fit = (ls: (ProjectLesson | GlobalLesson)[], withId: boolean) => {
    const lines: string[] = []
    for (const l of ls) {
      const line = titleLine(l, withId)
      if (left - line.length - 1 < 60) break
      lines.push(line)
      left -= line.length + 1
    }
    if (ls.length > lines.length)
      lines.push(
        `- 另有 ${ls.length - lines.length} 条（改到相关文件、跑相关命令时面板会推送，也可以用 knowledge_lookup 查）`,
      )
    return lines.join('\n')
  }
  const rest = on.filter((l) => !full.includes(l))
  const grest = gs.filter((l) => !gfull.includes(l))
  return [
    ...head,
    on.length ? '这个项目的教训：' : '',
    full.map((l) => short(l, true)).join('\n\n'),
    rest.length ? `下面这些按文件、命令、报错生效，只列标题：\n${fit(rest, true)}` : '',
    gs.length ? '### 全局教训（所有项目共用，只有用户能改）' : '',
    gfull.map((l) => short(l, false)).join('\n\n'),
    grest.length ? `只列标题：\n${fit(grest, false)}` : '',
    ...tail,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 没有面板工具的 CLI：执行中查不了、也不会被推送，按预算尽量给全文 */
function untooledPrompt(on: ProjectLesson[], gs: GlobalLesson[]) {
  const full = pick(on, FULL_BUDGET_NO_TOOL, false)
  const rest = on.filter((l) => !full.includes(l))
  const gfull = pick(gs, GLOBAL_BUDGET, false)
  const grest = gs.filter((l) => !gfull.includes(l))
  const restHint = '下面这些只列了标题，改到括号里的文件时照着做'
  return [
    '## 项目教训',
    '以前返工过的地方写成了规则，照做能少走弯路。优先级：用户这次的要求 > 项目教训 > 全局教训；冲突时按前面的做。',
    on.length ? '这个项目的教训：' : '',
    full.map((l) => lessonText(l)).join('\n\n'),
    rest.length ? `${restHint}：\n${titles(rest)}` : '',
    gs.length ? '### 全局教训（所有项目共用，只有用户能改）' : '',
    gfull.map((l) => lessonText(l)).join('\n\n'),
    grest.length ? `${restHint}：\n${titles(grest)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 记教训的说明：把要填的参数直接写出来（设计稿一期 ⑥），record_lesson 收在 more_tools 里时也不用先查一次用法。
 * 发给 Agent 的，不翻译
 */
const RECORD_HINT = `### 记教训（knowledge_record）
用户纠正了你的做法、你的办法被证明不对换了做法才成（命令报错后改了参数、换了命令才过）、或你在修之前改出来的问题时记。找位置、叫法、命令这类「找路」的心得是经验（kind 写 experience），不记成教训；一次性的经过也不记。写成换个场景也能照做的规则，具体经过写进 cause；写清它管的文件（paths）或命令（commands），面板据此在下次跑同样的命令、改同样的文件前推送；同类已有就带 id 改写。面板当场提示里给了 episode 编号的，带上它，命令和报错不用再写。
直接调用，参数照这个写（不在工具列表里时经 more_tools 调：name 写 knowledge_record，arguments 照写，不用先查用法）：{"kind":"lesson","title":"一句话规则：该怎么做","rule":"具体做法和别做的事，命令用反引号","wrong":"错的做法","cause":"这次哪里出错、报了什么","paths":["它管的文件 glob"],"commands":["它管的命令，如 npm run test:e2e"],"tags":["已有标签"]}；所有改动都适用、没有文件和命令可写的加 "global": true。
用户这次的要求和某条项目教训冲突时：有两全的做法就照做，并带 id 改写那条（change 写为什么改）；没有就先用提问工具让用户选。全局教训你改不了，需要时记一条项目教训写明这个项目的例外。`
export const newLessonId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * 加一条或更新一条：带 replaces（要改写的那条的 id）时改写那一条，旧版本留进 history；
 * 否则同名的就地更新（Agent 重复记同一个规则时不堆出两条），没有同名的才新加
 */
export function upsertLesson(
  lessons: ProjectLesson[],
  l: ProjectLesson,
  /** keepFlags: false 时用 l 的严重度和状态（用户在界面上改的）；默认沿用原来的 */
  opts: { replaces?: string; why?: string; keepFlags?: boolean } = {},
): { list: ProjectLesson[]; added: boolean; full?: boolean; missing?: boolean } {
  const key = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const same = opts.replaces
    ? lessons.find((x) => x.id === opts.replaces)
    : lessons.find((x) => x.id === l.id || key(x.title) === key(l.title))
  if (opts.replaces && !same) return { list: lessons, added: false, missing: true }
  if (same) {
    const now = new Date().toISOString()
    const changed = same.title !== l.title || same.rule !== l.rule
    const history = changed
      ? [{ title: same.title, rule: same.rule, why: opts.why ?? '', at: now }, ...same.history].slice(0, 5)
      : same.history
    // 改写时没给的字段沿用原来的（Agent 常常只改规则，不重写起因和范围）
    const next: ProjectLesson = {
      ...same,
      ...l,
      cause: l.cause || same.cause,
      paths: l.paths.length ? l.paths : same.paths,
      tags: l.tags.length ? l.tags : same.tags,
      wrong: l.wrong || same.wrong,
      // 触发键取并集：Agent 改写规则时常不带触发键，旧的不能丢；拦截档和状态只由用户在界面上改，记录时沿用原来的
      triggers: mergeTriggers(same.triggers, l.triggers),
      severity: opts.keepFlags === false ? l.severity : same.severity,
      status: opts.keepFlags === false ? l.status : same.status,
      id: same.id,
      createdAt: same.createdAt,
      updatedAt: now,
      history,
    }
    return { list: lessons.map((x) => (x === same ? next : x)), added: false }
  }
  if (lessons.length >= MAX_LESSONS) return { list: lessons, added: false, full: true }
  return { list: [...lessons, l], added: true }
}

/** 两份触发键取并集（报错指纹按错误码 + 词去重），各自不超过上限 */
function mergeTriggers(a: ProjectLesson['triggers'], b: ProjectLesson['triggers']): ProjectLesson['triggers'] {
  const uniq = <T>(xs: T[], key: (x: T) => string, max: number) => {
    const seen = new Set<string>()
    return xs.filter((x) => !seen.has(key(x)) && !!seen.add(key(x))).slice(0, max)
  }
  return {
    commands: uniq([...b.commands, ...a.commands], (x) => x, 10),
    errors: uniq([...b.errors, ...a.errors], (e) => [...e.codes, ...e.words].join(' '), 5),
    intents: uniq([...b.intents, ...a.intents], (x) => x, 8),
  }
}

export const newGlobalLessonId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** AI 提取出来的一条全局教训改动：add 新加，update 改写已有的那条（id） */
export interface GlobalLessonChange {
  op: 'add' | 'update'
  /** update 时是要改的全局教训 id */
  id: string
  title: string
  rule: string
  cause: string
  paths: string[]
  /** 从这个项目的哪几条教训提取的（项目教训的 id） */
  sources: string[]
}

/** 把用户勾选确认的改动写进全局教训；from 是来源项目名 */
export function applyGlobalChanges(list: GlobalLesson[], changes: GlobalLessonChange[], from: string) {
  const now = new Date().toISOString()
  let out = [...list]
  for (const c of changes) {
    const old = c.op === 'update' ? out.find((g) => g.id === c.id) : undefined
    if (old) {
      out = out.map((g) =>
        g === old
          ? {
              ...g,
              title: c.title,
              rule: c.rule,
              cause: c.cause || g.cause,
              paths: c.paths,
              from: from && !g.from.includes(from) ? [...g.from, from].slice(-20) : g.from,
              updatedAt: now,
            }
          : g,
      )
      continue
    }
    out.push({
      id: newGlobalLessonId(),
      title: c.title,
      rule: c.rule,
      cause: c.cause,
      paths: c.paths,
      enabled: true,
      from: from ? [from] : [],
      createdAt: now,
      updatedAt: '',
    })
  }
  return out
}
