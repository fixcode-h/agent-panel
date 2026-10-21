import type { ProjectLesson } from './schema.ts'

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
export function lessonMatches(l: ProjectLesson, files: string[]) {
  if (!l.paths.length) return true
  const res = l.paths.map(globToRegExp)
  return files.some((f) => res.some((re) => re.test(norm(f))))
}

export function lessonText(l: ProjectLesson) {
  return [
    `### ${l.title}`,
    l.rule,
    l.cause ? `起因：${l.cause}` : '',
    l.paths.length ? `范围：${l.paths.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** project_lessons 的结果：按文件命中的全文；没给文件时列出全部标题 */
export function findLessons(lessons: ProjectLesson[], files: string[]) {
  const on = lessons.filter((l) => l.enabled)
  if (!on.length) return '这个项目还没有教训。'
  const list = files.map(norm).filter(Boolean)
  if (!list.length) return `这个项目的教训（${on.length} 条），传 files 取相关条目的全文：\n${titles(on)}`
  const hit = on.filter((l) => lessonMatches(l, list))
  if (!hit.length) return '这些文件没有相关的教训。'
  return hit.map(lessonText).join('\n\n')
}

const titles = (ls: ProjectLesson[]) =>
  [
    ...ls.slice(0, MAX_TITLES).map((l) => `- ${l.title}${l.paths.length ? `（${l.paths.join('、')}）` : ''}`),
    ls.length > MAX_TITLES ? `- 另有 ${ls.length - MAX_TITLES} 条` : '',
  ]
    .filter(Boolean)
    .join('\n')

/**
 * 新会话开头的「项目教训」：tools 表示这次调用挂了面板工具，能按文件查和自己记。
 * 没有启用的条目时返回空串，不占提示
 */
export function lessonsPrompt(lessons: ProjectLesson[], tools: boolean) {
  const on = lessons.filter((l) => l.enabled)
  if (!on.length) return tools ? `## 项目教训\n${RECORD_HINT}` : ''
  // 有工具时全局条目给全文、按文件的只给标题；没工具时 Agent 没法再查，按预算尽量给全文
  const pool = tools ? on.filter((l) => !l.paths.length) : on
  const full: ProjectLesson[] = []
  let used = 0
  for (const l of pool) {
    const n = lessonText(l).length
    if (used + n > (tools ? FULL_BUDGET : FULL_BUDGET_NO_TOOL)) break
    full.push(l)
    used += n
  }
  const rest = on.filter((l) => !full.includes(l))
  return [
    '## 项目教训',
    '以前在这个项目里返工过的地方，写成了规则，照做能少返工：',
    full.map(lessonText).join('\n\n'),
    rest.length
      ? `${tools ? '下面这些按文件生效：想好要改哪些文件后，先把文件路径传给 project_lessons 取相关条目的全文再动手' : '下面这些只列了标题，改到括号里的文件时照着做'}：\n${titles(rest)}`
      : '',
    tools ? RECORD_HINT : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

const RECORD_HINT =
  '用户纠正了你的做法，或者你在修这个项目里之前（你或别的 Agent）改出来的问题时，用 record_lesson 记一条教训：写成下次换个场景也能照做的通用规则，具体事件只写进起因，paths 填它管的文件或目录。同类的已经有了就不要重复记。'

export const newLessonId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** 加一条或更新同名的一条（Agent 重复记同一个规则时不堆出两条） */
export function upsertLesson(lessons: ProjectLesson[], l: ProjectLesson) {
  const key = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const same = lessons.find((x) => x.id === l.id || key(x.title) === key(l.title))
  if (same)
    return {
      list: lessons.map((x) => (x === same ? { ...l, id: same.id, createdAt: same.createdAt } : x)),
      added: false,
    }
  if (lessons.length >= MAX_LESSONS) return { list: lessons, added: false, full: true }
  return { list: [...lessons, l], added: true }
}
