import { z } from 'zod'
import { t } from './i18n.ts'

/**
 * 项目经验（设计稿 docs/openspec/changes/project-knowledge/design.md）：「做某类事最快的路」——
 * 在哪个目录找、用户的说法在代码里叫什么、用什么命令、怎么验证。和教训分开：教训防错（被纠正、返工过才记），
 * 经验提速（这次绕了路、下次不用再绕）。经验由面板在整个对话完成后自动学（server/experience-learn.ts），
 * 不预加载进提示词，Agent 需要时用 project_experience 按关键词查。
 * 存在项目文档根的 agent-knowledge/experience/，一条一个文件（server/project-experience.ts）。
 */

/** 五种经验：找位置、叫法对照、命令、验证方法、某类改动的固定做法 */
export const EXPERIENCE_KINDS = ['locate', 'vocab', 'command', 'verify', 'flow'] as const
export const ExperienceKind = z.enum(EXPERIENCE_KINDS)
export type ExperienceKind = z.infer<typeof ExperienceKind>

/** 字段上限：经验是指路牌不是文档，写细了反而没人用、也更容易过期 */
export const EXP_TITLE_MAX = 60
export const EXP_BODY_MAX = 300
export const EXP_KEYWORDS_MAX = 8
export const EXP_PATHS_MAX = 4
/** 一个项目最多存多少条：再多就该让 AI 评审清一清 */
export const MAX_EXPERIENCES = 300

export const ProjectExperience = z.object({
  id: z.string().min(1),
  kind: ExperienceKind.catch('locate'),
  /** 一句话：要做的事 + 去哪 / 用什么，例如「表格相关的代码和配置在哪」 */
  title: z.string().trim().min(1, t('标题不能为空')).max(EXP_TITLE_MAX),
  /** 补一两句：路径之间的关系、命令的参数、别走的弯路 */
  body: z.string().trim().max(EXP_BODY_MAX).default(''),
  /** 检索的主要依据：用户的说法和代码里的叫法都写上（「表格」「DataTable」） */
  keywords: z.array(z.string().trim().min(1).max(30)).max(EXP_KEYWORDS_MAX).default([]),
  /** 目录或 glob（相对项目根），命令类写命令本身；写到目录为止，不写具体行号 */
  paths: z.array(z.string().trim().min(1).max(200)).max(EXP_PATHS_MAX).default([]),
  enabled: z.boolean().default(true),
  /** auto：对话完成后面板学到的；user：用户手动加的 */
  source: z.enum(['auto', 'user']).catch('user').default('user'),
  /** 从哪几个对话学到 / 补充的（顶层对话 id） */
  taskIds: z.array(z.string()).max(10).catch([]).default([]),
  /** P4 / SVN 各分支共用文档根时：学到它的分支（ADR 0052），别的分支路径不在时提示来源 */
  branch: z.string().default(''),
  createdAt: z.string().default(''),
  updatedAt: z.string().default(''),
})
export type ProjectExperience = z.infer<typeof ProjectExperience>

/** 设置 →「经验」：总开关管全部（检索、开头提示、自动学习），关了等于没有这个功能 */
export const ExperienceSettings = z
  .object({
    enabled: z.boolean().catch(true).default(true),
    /** 整个对话完成后自动学 */
    autoLearn: z.boolean().catch(true).default(true),
    /** 新会话开头按需求原文本地匹配，命中时附上最多两条（不花 token 调模型） */
    preHint: z.boolean().catch(true).default(true),
    /** 学得勤不勤：绕路多少次才值得学（见 shared/experience-gate.ts 的 GATE） */
    sensitivity: z.enum(['low', 'normal', 'high']).catch('normal').default('normal'),
    /** 提炼和 AI 评审用的 CLI / 模型：都空着时跟随这个对话的 Agent */
    cli: z.string().default(''),
    model: z.string().trim().default(''),
    /** 每个项目每天最多提炼几次；0 表示不限（用户要求默认不限，成本由「学得勤不勤」的门槛控制） */
    dailyLimit: z.number().int().min(0).max(200).catch(0).default(0),
  })
  .prefault({})
export type ExperienceSettings = z.infer<typeof ExperienceSettings>

export const kindLabel = (k: ExperienceKind) =>
  ({
    locate: t('找位置'),
    vocab: t('叫法对照'),
    command: t('命令'),
    verify: t('验证'),
    flow: t('做法'),
  })[k]

/**
 * 什么该记成经验、什么不该：提炼的提示词、AI 评审的提示词都引用这一份（规则只写一处）。
 * 发给 Agent 的，不翻译
 */
export const EXPERIENCE_SCOPE = `### 经验记什么、不记什么
该记（下次同类请求能直接用上、能省掉一大段搜索或试错的）：
- 找位置（locate）：某类东西在哪个目录，例如「表格相关的代码在 Source/Game/Table/，数据在 Content/DataTables/」；
- 叫法对照（vocab）：用户的说法和代码里的名字，例如「表格 / 配表 = UDataTable、FTableRowBase」；
- 命令（command）：编译、跑测试、看日志的正确命令（试错过才找到的）；
- 验证（verify）：怎么确认改对了；
- 做法（flow）：某类改动固定要动的几处，三四步说完。
不记：
- 太细的：具体行号、某个函数内部怎么写、单个变量、一次性的文件列表——经验写到目录或入口文件为止；
- 一次性的：这次需求的进度、这次改了什么、某个 Bug 的经过（Bug 进 Bug 记录）；
- 规则类：「这么做会错、要那样做」是教训，不是经验；
- 读一眼目录名或模块文档就知道的、项目说明文件里已经写了的；
- 拿不准对不对的推测。
写法：标题一句话（不超过 ${EXP_TITLE_MAX} 字），说明一两句（不超过 ${EXP_BODY_MAX} 字），关键词同时写用户的说法和代码里的叫法，路径最多 ${EXP_PATHS_MAX} 个、写到目录或 glob。`

/** 搜索用的全文（小写）：界面搜索框和 project_experience 用同一套 */
export const experienceHaystack = (e: ProjectExperience) =>
  [e.id, e.title, e.body, ...e.keywords, ...e.paths].join('\n').toLowerCase()

const norm = (p: string) => p.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
/** glob 的固定前缀（第一个通配符之前的目录）：「Source/Game/Table/**」→「Source/Game/Table」 */
export const globBase = (g: string) => {
  const parts = norm(g).split('/')
  const i = parts.findIndex((x) => /[*?[]/.test(x))
  return (i < 0 ? parts : parts.slice(0, i)).join('/')
}

/**
 * 中文没有空格：把查询拆成词，再把每段中文切成两字一组（「加一张掉落表」切出「掉落」，能命中关键词「掉落」）。
 * 英文、路径按空白和标点分开，一个字母的不算
 */
export function queryTerms(q: string): string[] {
  const out = new Set<string>()
  for (const raw of q.toLowerCase().split(/[\s,，、。；;:：/\\()（）「」"'`]+/)) {
    const w = raw.trim()
    if (!w) continue
    if (/[一-鿿]/.test(w)) {
      const han = w.replace(/[^一-鿿]/g, '')
      if (han.length <= 2) out.add(han)
      else for (let i = 0; i + 2 <= han.length; i++) out.add(han.slice(i, i + 2))
      const rest = w.replace(/[一-鿿]+/g, ' ').trim()
      for (const x of rest.split(/\s+/)) if (x.length >= 2) out.add(x)
    } else if (w.length >= 2) out.add(w)
  }
  return [...out]
}

/** 这条经验和查询 / 文件有多相关：关键词命中最重，标题、说明次之，路径覆盖要改的文件也算 */
export function experienceScore(e: ProjectExperience, terms: string[], files: string[] = []) {
  let score = 0
  const kws = e.keywords.map((k) => k.toLowerCase())
  const title = e.title.toLowerCase()
  const rest = [e.body, ...e.paths].join('\n').toLowerCase()
  for (const w of terms) {
    if (kws.some((k) => k === w)) score += 4
    else if (kws.some((k) => k.includes(w) || (w.length >= 3 && w.includes(k)))) score += 3
    else if (title.includes(w)) score += 2
    else if (rest.includes(w)) score += 1
  }
  const fs = files.map(norm).filter(Boolean)
  if (fs.length)
    for (const p of e.paths) {
      const base = globBase(p)
      if (base && fs.some((f) => f === base || f.startsWith(`${base}/`) || base.startsWith(`${f}/`))) score += 3
    }
  return score
}

/** 按相关度排好的命中条目（停用的不算） */
export function rankExperience(list: ProjectExperience[], query: string, files: string[] = []) {
  const terms = queryTerms(query)
  return list
    .filter((e) => e.enabled)
    .map((e) => ({ e, score: experienceScore(e, terms, files) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e)
}

export function experienceText(e: ProjectExperience) {
  return [
    `### ${e.title}（${e.kind}）`,
    e.body,
    e.paths.length ? `位置：${e.paths.join('、')}` : '',
    e.keywords.length ? `关键词：${e.keywords.join('、')}` : '',
    e.branch ? `（在 ${e.branch} 分支学到）` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** project_experience 一次最多给几条全文：经验是指路，给多了反而要 Agent 再挑 */
const FIND_MAX = 3
const FIND_BUDGET = 1500

/** project_experience 的结果：最相关的几条全文，其余列标题；什么都没给时列出全部标题 */
export function findExperience(list: ProjectExperience[], query: string, files: string[] = []) {
  const on = list.filter((e) => e.enabled)
  if (!on.length) return '这个项目还没有经验。'
  if (!query.trim() && !files.length)
    return `这个项目的经验（${on.length} 条），传 query 按关键词查全文：\n${on
      .slice(0, 60)
      .map((e) => `- ${e.title}〔${e.keywords.slice(0, 4).join('、')}〕`)
      .join('\n')}${on.length > 60 ? `\n- 另有 ${on.length - 60} 条` : ''}`
  const hit = rankExperience(on, query, files)
  if (!hit.length) return '没有相关的经验，按正常的办法找。'
  const full: ProjectExperience[] = []
  let used = 0
  for (const e of hit) {
    const n = experienceText(e).length
    if (full.length >= FIND_MAX || (full.length && used + n > FIND_BUDGET)) break
    full.push(e)
    used += n
  }
  const more = hit.slice(full.length, full.length + 10)
  return [
    full.map(experienceText).join('\n\n'),
    more.length ? `另有相关的：\n${more.map((e) => `- ${e.title}`).join('\n')}` : '',
    '经验是以前的对话学到的捷径，路径可能已经变了：对不上时按正常的办法找。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 新会话开头的「项目经验」：不放条目，只说有多少条、怎么查；preHint 打开时按这次的需求原文本地匹配，
 * 命中的最多附两条的标题和位置（不调模型）。没有经验时返回空串，不占提示
 */
export function experiencePrompt(list: ProjectExperience[], request: string, preHint: boolean) {
  const on = list.filter((e) => e.enabled)
  if (!on.length) return ''
  const hint = `## 项目经验\n这个项目有 ${on.length} 条以前对话学到的经验（找位置、叫法对照、命令、验证方法）。要在全项目搜索之前，先用 project_experience 按关键词查一下。`
  if (!preHint || !request.trim()) return hint
  const hit = rankExperience(on, request.slice(0, 2000)).slice(0, 2)
  if (!hit.length) return hint
  return `${hint}\n可能相关的：\n${hit
    .map((e) => `- ${e.title}${e.paths.length ? `：${e.paths.join('、')}` : ''}`)
    .join('\n')}`
}

export const newExperienceId = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** 一条经验写得合不合规矩：太长、路径太多、没有关键词都拦下，返回原因 */
export function experienceProblems(e: Pick<ProjectExperience, 'title' | 'body' | 'keywords' | 'paths'>) {
  const out: string[] = []
  if (!e.title.trim()) out.push(t('标题不能为空'))
  if (e.title.length > EXP_TITLE_MAX) out.push(t('标题不超过 {n} 字', { n: EXP_TITLE_MAX }))
  if (e.body.length > EXP_BODY_MAX) out.push(t('说明不超过 {n} 字', { n: EXP_BODY_MAX }))
  if (!e.keywords.length) out.push(t('至少写一个关键词'))
  if (e.keywords.length > EXP_KEYWORDS_MAX) out.push(t('关键词最多 {n} 个', { n: EXP_KEYWORDS_MAX }))
  if (e.paths.length > EXP_PATHS_MAX) out.push(t('路径最多 {n} 个', { n: EXP_PATHS_MAX }))
  return out
}

/** 两条经验算不算同一件事：路径前缀重合且关键词有交集，或者标题一样 */
export function sameExperience(a: ProjectExperience, b: Pick<ProjectExperience, 'title' | 'keywords' | 'paths'>) {
  const key = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  if (key(a.title) === key(b.title)) return true
  const kw = new Set(a.keywords.map((k) => k.toLowerCase()))
  const shareKw = b.keywords.some((k) => kw.has(k.toLowerCase()))
  const bases = a.paths.map(globBase).filter(Boolean)
  const sharePath = b.paths
    .map(globBase)
    .some((p) => !!p && bases.some((x) => x === p || x.startsWith(`${p}/`) || p.startsWith(`${x}/`)))
  return shareKw && sharePath
}

/** 界面上加 / 改一条时交给服务端的字段（id、来源、时间由面板定） */
export type ExperienceEdit = Pick<ProjectExperience, 'kind' | 'title' | 'body' | 'keywords' | 'paths' | 'enabled'>

/** GET /projects/:id/experience */
export interface ExperienceListView {
  items: ProjectExperience[]
  /** 格式不对、被跳过的文件 */
  errors: string[]
  /** 存在哪个目录 */
  dir?: string
}

/** AI 评审的一条结论：keep 符合；delete 不该记；trim 该记但写得太细（附精简后的写法） */
export interface ExperienceVerdict {
  id: string
  verdict: 'keep' | 'delete' | 'trim'
  why: string
  title?: string
  body?: string
}

/** POST /projects/:id/experience/review */
export interface ExperienceReviewView {
  verdicts: ExperienceVerdict[]
  /** 面板核对过、已经不存在的路径（经验 id → 路径） */
  missing?: Record<string, string[]>
  total?: number
}

/** Agent 用 record_experience 记的一条（/learn 命令）：id 填了表示更新那一条 */
export interface ExperienceInput {
  id?: string
  kind: string
  title: string
  body: string
  keywords: string[]
  paths: string[]
}
