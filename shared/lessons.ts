import type { GlobalLesson, ProjectLesson } from './schema.ts'

/**
 * 项目教训怎么交给 Agent：条目会越积越多，全文塞进每次的提示太费 token。
 * 所以提示里只放「所有改动都适用」的全文和其余条目的标题，Agent 想好要改哪些文件后
 * 用面板工具 project_lessons 按文件取命中的全文；没有面板工具的 CLI 按预算给全文，超出的只给标题。
 */

/** 一次最多存多少条：再多就该合并同类项了 */
export const MAX_LESSONS = 200
/** 全文的预算（字数）：超出的只列标题 */
const FULL_BUDGET = 3000
const FULL_BUDGET_NO_TOOL = 6000
/** 全局教训的全文预算：排在项目教训后面，给少一些 */
const GLOBAL_BUDGET = 2000
/** 标题最多列多少条，再多只报个数 */
const MAX_TITLES = 60

/** `paths` 里的 glob 转成正则：`**` 跨目录，`*` 不跨；不带通配符的写法同时匹配这个目录下的文件 */
export function globToRegExp(g: string) {
  const body = norm(g)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')
  return new RegExp(/[*?]/.test(g) ? `^${body}$` : `^${body}(/.*)?$`)
}

const norm = (p: string) => p.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')

/** 这条教训管不管这些文件；没写 paths 的对所有改动都适用 */
export function lessonMatches(l: { paths: string[] }, files: string[]) {
  if (!l.paths.length) return true
  const res = l.paths.map(globToRegExp)
  return files.some((f) => res.some((re) => re.test(norm(f))))
}

/** withId：带上 id，Agent 要改写这一条时用（record_lesson 的 id） */
export function lessonText(l: ProjectLesson | GlobalLesson, withId = false) {
  return [
    `### ${l.title}${withId ? `（id: ${l.id}）` : ''}`,
    l.rule,
    l.cause ? `起因：${l.cause}` : '',
    l.paths.length ? `范围：${l.paths.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** project_lessons 的结果：按文件命中的全文（项目的在前，全局的在后）；没给文件时列出全部标题 */
export function findLessons(lessons: ProjectLesson[], files: string[], globals: GlobalLesson[] = []) {
  const on = lessons.filter((l) => l.enabled)
  const gs = globals.filter((l) => l.enabled)
  if (!on.length && !gs.length) return '这个项目还没有教训。'
  const list = files.map(norm).filter(Boolean)
  if (!list.length)
    return [
      on.length ? `这个项目的教训（${on.length} 条），传 files 取相关条目的全文：\n${titles(on, true)}` : '',
      gs.length ? `全局教训（${gs.length} 条，优先级低于项目教训）：\n${titles(gs)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  const hit = on.filter((l) => lessonMatches(l, list))
  const ghit = gs.filter((l) => lessonMatches(l, list))
  if (!hit.length && !ghit.length) return '这些文件没有相关的教训。'
  return [
    hit.map((l) => lessonText(l, true)).join('\n\n'),
    ghit.length
      ? `## 全局教训（优先级低于上面的项目教训，冲突时以项目教训为准）\n${ghit.map((l) => lessonText(l)).join('\n\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const titles = (ls: (ProjectLesson | GlobalLesson)[], withId = false) =>
  [
    ...ls
      .slice(0, MAX_TITLES)
      .map((l) => `- ${l.title}${l.paths.length ? `（${l.paths.join('、')}）` : ''}${withId ? `〔id: ${l.id}〕` : ''}`),
    ls.length > MAX_TITLES ? `- 另有 ${ls.length - MAX_TITLES} 条` : '',
  ]
    .filter(Boolean)
    .join('\n')

/** 按预算挑出给全文的条目：pool 按顺序放，放不下的只列标题 */
function pick<T extends ProjectLesson | GlobalLesson>(pool: T[], budget: number, withId: boolean) {
  const full: T[] = []
  let used = 0
  for (const l of pool) {
    const n = lessonText(l, withId).length
    if (used + n > budget) break
    full.push(l)
    used += n
  }
  return full
}

/**
 * 新会话开头的「项目教训」：tools 表示这次调用挂了面板工具，能按文件查和自己记。
 * globals 是全局教训：所有项目共用，排在项目教训后面、优先级也更低。
 * 没有启用的条目时返回空串，不占提示
 */
export function lessonsPrompt(lessons: ProjectLesson[], tools: boolean, globals: GlobalLesson[] = []) {
  const on = lessons.filter((l) => l.enabled)
  const gs = globals.filter((l) => l.enabled)
  if (!on.length && !gs.length) return tools ? `## 项目教训\n${RECORD_HINT}` : ''
  // 有工具时「所有改动都适用」的条目给全文、按文件的只给标题；没工具时 Agent 没法再查，按预算尽量给全文
  const pool = tools ? on.filter((l) => !l.paths.length) : on
  const full = pick(pool, tools ? FULL_BUDGET : FULL_BUDGET_NO_TOOL, tools)
  const rest = on.filter((l) => !full.includes(l))
  const gpool = tools ? gs.filter((l) => !l.paths.length) : gs
  const gfull = pick(gpool, GLOBAL_BUDGET, false)
  const grest = gs.filter((l) => !gfull.includes(l))
  const restHint = tools
    ? '下面这些按文件生效：想好要改哪些文件后，先把文件路径传给 project_lessons 取相关条目的全文再动手'
    : '下面这些只列了标题，改到括号里的文件时照着做'
  return [
    '## 项目教训',
    '以前返工过的地方写成了规则，照做能少走弯路。优先级：用户这次的要求 > 项目教训 > 全局教训；冲突时按前面的做。',
    on.length ? '这个项目的教训：' : '',
    full.map((l) => lessonText(l, tools)).join('\n\n'),
    rest.length ? `${restHint}：\n${titles(rest, tools)}` : '',
    gs.length ? '### 全局教训（所有项目共用，只有用户能改）' : '',
    gfull.map((l) => lessonText(l)).join('\n\n'),
    grest.length ? `${restHint}：\n${titles(grest)}` : '',
    tools ? RECORD_HINT : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const RECORD_HINT = `### 记教训（record_lesson）
什么时候记：
- 用户纠正了你的做法；
- 你发现自己用的办法不对、绕了弯路才换成对的（例如用某种方式等待或计时，结果被判定立即结束，换了别的方式才成）：把最后行得通的做法记下来，下次直接用；
- 你在修这个项目里之前（你或别的 Agent）改出来的问题。
写成下次换个场景也能照做的通用规则，具体事件只写进起因，paths 填它管的文件或目录。同类的已经有了就带上它的 id 改写那一条，不要重复记。
用户这次的要求和某条项目教训相反时：先想有没有两全的做法（既满足这次的要求，又避开那条教训要防的问题）。有就照它做，并用 record_lesson 带上那条的 id 改写教训，在 change 里写清为什么改；没有就先别动手，用提问工具让用户选：按教训做 / 按这次的要求做并改写教训 / 只这次例外。
和全局教训冲突时直接以用户和项目教训为准，不用问；全局教训你改不了，需要时记一条项目教训写明这个项目的例外。`
export const newLessonId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * 加一条或更新一条：带 replaces（要改写的那条的 id）时改写那一条，旧版本留进 history；
 * 否则同名的就地更新（Agent 重复记同一个规则时不堆出两条），没有同名的才新加
 */
export function upsertLesson(
  lessons: ProjectLesson[],
  l: ProjectLesson,
  opts: { replaces?: string; why?: string } = {},
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
