import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { findCore } from '../shared/builtin/core.ts'
import { DOC_PLACE_SIBLING, joinPath, resolveDocRoot, vcsDocRoot } from '../shared/doc-root.ts'
import { hash53 } from '../shared/hash.ts'
import { t } from '../shared/i18n.ts'
import { ProjectLesson, type Agent, type Project } from '../shared/schema.ts'
import { log } from './log.ts'
import { detectVcs } from './projects-analyze.ts'

/**
 * 项目教训存进项目文档目录的单个 Markdown 文件（用户 2026-11 定的）：
 * - Git / 没有版本管理：<项目目录>/docs/lessons.md
 * - P4：<项目目录上一级>/ProjectDoc/docs/lessons.md，同一父目录下的项目 / 分支共用一个文件，不受「文档根」下拉影响
 * - SVN：按「文档」角色的文档根（shared/doc-root.ts 的 resolveDocRoot），和模块说明、ADR 放在一起
 *
 * 旧位置（projects.json 里 Project.lessons）继续读取：同 id 或同标题时以文件为准。
 * 任何一次写入都写整份文件，由调用方随即把项目 JSON 里的 lessons 清空，旧条目删掉后不会再从 JSON 里冒出来。
 */

const LESSONS_FILE = 'lessons.md'
const LESSON_START = '<!-- lesson -->'
const LESSON_END = '<!-- /lesson -->'
const HEADER_START = '<!-- panel-lessons:header -->'
const HEADER_END = '<!-- /panel-lessons:header -->'

const HEADER = `${HEADER_START}
# 项目教训

这个文件由 Agent 面板维护：项目设置里的「项目教训」和对话里的 record_lesson 都写到这里。
每条教训在 lesson 起止标记之间：字段写成「名字: 值」，标题、规则、起因用 | 开头，下面缩进两行的内容可以多行。
直接改这些内容也可以，面板下次读取时按这里解析；标记之外不要放别的文字，面板认不出来时会拒绝覆盖这个文件。
${HEADER_END}`

/** 这条项目教训的文件在哪；项目没有目录（独立聊天、没填路径）时返回 undefined，仍用旧的项目 JSON */
export async function projectLessonsFile(
  project: Pick<Project, 'path' | 'agentParams'>,
  agents: Agent[],
): Promise<string | undefined> {
  const dir = project.path?.trim()
  if (!dir) return undefined
  const vcs = (await detectVcs(dir).catch(() => null))?.vcs
  // P4 固定放项目外层的 ProjectDoc/docs：同一父目录下的分支共用一个文件，换个分支也能看到同一份教训
  if (vcs === 'p4') return joinPath(vcsDocRoot(dir, DOC_PLACE_SIBLING), LESSONS_FILE)
  if (vcs === 'svn') {
    const docs = findCore(agents, 'docsync')
    const root = resolveDocRoot(dir, 'svn', (docs && project.agentParams?.[docs.id]) || {})
    return root ? joinPath(root.root, LESSONS_FILE) : undefined
  }
  return joinPath(dir, 'docs/lessons.md')
}

/** 把一条教训写成人和面板都能读的 Markdown：字段在上面，正文用缩进两行的 | 块 */
function renderLesson(l: ProjectLesson): string {
  const block = (key: string, value: string) => [
    `${key}: |`,
    ...value.split('\n').map((line) => (line ? `  ${line}` : '')),
  ]
  return [
    LESSON_START,
    `id: ${l.id}`,
    ...block('title', l.title),
    `enabled: ${l.enabled}`,
    `source: ${l.source}`,
    `taskId: ${l.taskId}`,
    `createdAt: ${l.createdAt}`,
    `updatedAt: ${l.updatedAt}`,
    `tags: ${JSON.stringify(l.tags)}`,
    `paths: ${JSON.stringify(l.paths)}`,
    ...block('rule', l.rule),
    ...block('cause', l.cause),
    // 改写记录是给界面看的元数据，用 JSON 一行写完，不占正文
    `history: ${JSON.stringify(l.history)}`,
    LESSON_END,
  ].join('\n')
}

/** 整份文件的内容：顶部维护说明 + 每条教训一段 */
export function renderProjectLessons(lessons: ProjectLesson[]): string {
  return [HEADER, ...lessons.map(renderLesson)].join('\n\n') + '\n'
}

const parseFail = (error: string) => ({ lessons: [] as ProjectLesson[], error })

/** 解析一份 Markdown；结构不对时返回 error，调用方据此拒绝覆盖原文件 */
export function parseProjectLessons(text: string): { lessons: ProjectLesson[]; error?: string } {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = withoutBom.replace(/\r\n?/g, '\n').split('\n')
  const out: ProjectLesson[] = []
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    // 文件顶部的维护说明：跳过整块，不参与解析
    if (raw.trim() === HEADER_START) {
      i++
      while (i < lines.length && lines[i].trim() !== HEADER_END) i++
      if (i >= lines.length) return parseFail(t('教训文件的维护说明没有结束标记'))
      i++
      continue
    }
    if (raw.trim() !== LESSON_START) {
      // 标记之外还有文字：面板没法保留它，当成解析失败，写入时就拒绝覆盖用户手写的内容
      if (!raw.trim()) {
        i++
        continue
      }
      return parseFail(t('第 {n} 行在教训标记之外，无法识别：{line}', { n: i + 1, line: raw.trim().slice(0, 60) }))
    }
    const startLine = i + 1
    const fields: Record<string, string> = {}
    i++
    let closed = false
    while (i < lines.length) {
      if (lines[i].trim() === LESSON_END) {
        closed = true
        i++
        break
      }
      const line = lines[i]
      if (!line.trim()) {
        i++
        continue
      }
      const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]?(.*)$/.exec(line)
      if (!m)
        return parseFail(t('第 {n} 行不是「字段: 值」的形式：{line}', { n: i + 1, line: line.trim().slice(0, 60) }))
      const key = m[1]
      const rest = m[2]
      i++
      if (rest.trim() === '|') {
        // 正文是后面缩进两行的内容；空行也算正文（编辑器去掉行尾空格后仍要能读）
        const parts: string[] = []
        while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('  '))) {
          parts.push(lines[i].startsWith('  ') ? lines[i].slice(2) : '')
          i++
        }
        while (parts.length && !parts[parts.length - 1].trim()) parts.pop()
        fields[key] = parts.join('\n')
      } else fields[key] = rest.trim()
    }
    if (!closed) return parseFail(t('第 {n} 行的教训没有 {end} 结束标记', { n: startLine, end: LESSON_END }))
    const got = lessonFromFields(fields, startLine)
    if ('error' in got) return parseFail(got.error)
    out.push(got.lesson)
  }
  // 手抄重了时保留第一条，不让同一 id 在界面上出现两次
  const seen = new Set<string>()
  return {
    lessons: out.filter((l) => {
      if (seen.has(l.id)) return false
      seen.add(l.id)
      return true
    }),
  }
}

function lessonFromFields(fields: Record<string, string>, line: number): { lesson: ProjectLesson } | { error: string } {
  const title = (fields.title ?? '').trim()
  if (!title) return { error: t('第 {n} 行的教训缺 title', { n: line }) }
  const rule = fields.rule ?? ''
  const stringList = (key: string): string[] | null => {
    const raw = (fields[key] ?? '').trim()
    if (!raw) return []
    try {
      const v: unknown = JSON.parse(raw)
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null
    } catch {
      return null
    }
  }
  const paths = stringList('paths')
  if (!paths) return { error: t('第 {n} 行的 paths 要写成 JSON 数组', { n: line }) }
  const tags = stringList('tags')
  if (!tags) return { error: t('第 {n} 行的 tags 要写成 JSON 数组', { n: line }) }
  const enabledText = (fields.enabled ?? '').trim()
  if (enabledText && enabledText !== 'true' && enabledText !== 'false')
    return { error: t('第 {n} 行的 enabled 只能是 true 或 false', { n: line }) }
  let history: unknown = []
  const historyText = (fields.history ?? '').trim()
  if (historyText) {
    try {
      history = JSON.parse(historyText)
    } catch {
      return { error: t('第 {n} 行的 history 要写成 JSON 数组', { n: line }) }
    }
  }
  const parsed = ProjectLesson.safeParse({
    // 手写的条目没写 id 时按内容算一个稳定的 id，下次读取还是同一个
    id: (fields.id ?? '').trim() || `l${hash53(`${title}\n${rule}`).slice(0, 12)}`,
    title,
    rule,
    cause: fields.cause ?? '',
    paths,
    tags,
    enabled: enabledText !== 'false',
    source: fields.source === 'agent' ? 'agent' : 'user',
    taskId: fields.taskId ?? '',
    createdAt: fields.createdAt ?? '',
    updatedAt: fields.updatedAt ?? '',
    history,
  })
  if (!parsed.success)
    return {
      error: t('第 {n} 行的教训不符合格式：{error}', {
        n: line,
        error: parsed.error.issues.map((x) => x.message).join('；'),
      }),
    }
  return { lesson: parsed.data }
}

/** 读文件：不存在算空；解析失败返回 error（调用方不能拿它覆盖原文件） */
export async function readProjectLessonsFile(file: string): Promise<{ lessons: ProjectLesson[]; error?: string }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { lessons: [] }
    return parseFail(t('教训文件读取失败：{error}', { error: (e as Error).message }))
  }
  return parseProjectLessons(text)
}

/** 新文件 + 旧项目 JSON：同 id 或同标题去重，新文件优先 */
export function mergeProjectLessons(fileLessons: ProjectLesson[], jsonLessons: ProjectLesson[]): ProjectLesson[] {
  const key = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const ids = new Set(fileLessons.map((l) => l.id))
  const titles = new Set(fileLessons.map((l) => key(l.title)))
  const out = [...fileLessons]
  for (const l of jsonLessons) {
    if (ids.has(l.id) || titles.has(key(l.title))) continue
    ids.add(l.id)
    titles.add(key(l.title))
    out.push(l)
  }
  return out
}

export interface LessonSource {
  lessons: ProjectLesson[]
  /** 教训文件的位置；没有目录时为 undefined */
  file?: string
  /** 读文件出错时的说明：这时 lessons 只有旧 JSON 里的条目 */
  error?: string
}

/** 读取项目教训的合并结果：对话提示词、project_lessons、AI 分析、项目接口都用这一份 */
export async function loadProjectLessons(
  project: Pick<Project, 'path' | 'agentParams' | 'lessons'>,
  agents: Agent[],
): Promise<LessonSource> {
  const json = project.lessons ?? []
  const file = await projectLessonsFile(project, agents)
  if (!file) return { lessons: json }
  const r = await readProjectLessonsFile(file)
  if (r.error) {
    log.warn('lessons', '项目教训文件读不出来，先用项目 JSON 里的旧教训', { file, error: r.error })
    return { lessons: json, file, error: r.error }
  }
  return { lessons: mergeProjectLessons(r.lessons, json), file }
}

/** 带合并后教训的项目：GET /projects 和几个写接口的返回值都用它 */
export async function projectWithLessons(project: Project, agents: Agent[]): Promise<Project> {
  return { ...project, lessons: (await loadProjectLessons(project, agents)).lessons }
}

export interface SaveLessonsResult {
  ok: boolean
  /** 是否写进了文件；false 表示项目没有目录，调用方仍存回项目 JSON */
  inFile: boolean
  lessons: ProjectLesson[]
  error?: string
}

/**
 * 把整份教训写进文件：先读一遍确认能解析，解析不了就不覆盖。
 * 同一个路径的写入排队，几个对话同时记时不会互相盖掉（读改写由调用方的 queue 串行）。
 */
export async function saveProjectLessons(
  project: Pick<Project, 'path' | 'agentParams'>,
  agents: Agent[],
  lessons: ProjectLesson[],
): Promise<SaveLessonsResult> {
  const file = await projectLessonsFile(project, agents)
  if (!file) return { ok: true, inFile: false, lessons }
  // 没有教训、文件也还没有：不建一个只有文件头的空文件。保存项目设置时也会走到这里，
  // 以前每次保存都在用户仓库里留下一个没人要的未跟踪文件（2026-11-03 真实 API 实测：父对话目录里冒出 docs/lessons.md）
  if (!lessons.length && !existsSync(file)) return { ok: true, inFile: true, lessons }
  return enqueueWrite(file, async () => {
    const current = await readProjectLessonsFile(file)
    if (current.error)
      return {
        ok: false,
        inFile: true,
        lessons,
        error: t('教训文件格式不对，没有覆盖：{error}', { error: current.error }),
      }
    try {
      await writeTextAtomic(file, renderProjectLessons(lessons))
    } catch (e) {
      return {
        ok: false,
        inFile: true,
        lessons,
        error: t('教训文件写入失败：{error}', { error: (e as Error).message }),
      }
    }
    return { ok: true, inFile: true, lessons }
  })
}

// 同一个文件同时只写一份：P4 不同分支共用 ProjectDoc/docs/lessons.md 时也不会交错
const writing = new Map<string, Promise<unknown>>()

function enqueueWrite<T>(file: string, run: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
  const prev = writing.get(key) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(run)
  writing.set(key, next)
  // 队列尾部自己吞掉异常，失败已经通过返回值交给调用方了
  void next
    .finally(() => {
      if (writing.get(key) === next) writing.delete(key)
    })
    .catch(() => {})
  return next
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** rename 之后刷新父目录，让目录项本身也落盘；Windows 打不开目录句柄，跳过 */
async function fsyncDir(dir: string) {
  if (process.platform === 'win32') return
  let fh
  try {
    fh = await open(dir, 'r')
    await fh.sync()
  } catch {
    // 部分网络盘、容器挂载不支持对目录 fsync
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** 原子写文本：先写临时文件并刷盘，再改名；Windows 上文件被占用时重试几次 */
async function writeTextAtomic(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(text, 'utf8')
    await fh.sync()
  } catch (e) {
    await fh.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw e
  }
  try {
    await fh.close()
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, file)
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (i >= 5 || !code || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) {
        await unlink(tmp).catch(() => {})
        throw e
      }
      await sleep(50 * 2 ** i)
    }
  }
  await fsyncDir(path.dirname(file))
}
