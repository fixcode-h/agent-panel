import type { ProjectLesson } from '../schema.ts'
import type { LessonInput } from '../host/knowledge.ts'
import { lessonCommands } from './push.ts'
import { wordsOf } from './match/normalize.ts'

/**
 * 入库校验（设计稿 4.4，二期）：knowledge_record 记教训前机械地查一遍，不合格的把原因交回 Agent 改了再记，
 * 不悄悄收下也不悄悄丢掉。发给 Agent 的，不翻译。
 * 只挡最常见的几种没用的条目：写成经过而不是规则、只有「注意 / 小心」、没有任何触发键、和已有的一条几乎一样
 */

/** 只说要小心、没说怎么做的词：整条规则只有这些时不收 */
const VAGUE = /^(注意|小心|仔细|谨慎|记得|别忘了|务必|一定要)/
/** 写成经过的开头：「刚才」「这次」「我」 */
const NARRATIVE = /^(刚才|刚刚|这次|本次|今天|我们?|用户让|之前)/

/** 两段文字的词重合度（Jaccard） */
function overlap(a: string, b: string): number {
  const x = new Set(wordsOf(a))
  const y = new Set(wordsOf(b))
  if (!x.size || !y.size) return 0
  let n = 0
  for (const w of x) if (y.has(w)) n++
  return n / (x.size + y.size - n)
}

export interface AdmissionResult {
  ok: boolean
  /** 不合格的原因，一条一行 */
  problems: string[]
  /** 几乎一样的已有条目：建议带它的 id 改写 */
  similar?: Pick<ProjectLesson, 'id' | 'title'>
}

/** 记一条教训前的校验；episode（面板当场捕获的）自带命令和报错指纹，不要求再写触发键 */
export function admitLesson(input: LessonInput, existing: ProjectLesson[], global = false): AdmissionResult {
  const problems: string[] = []
  const title = input.title.trim()
  const rule = input.rule.trim()
  if (title.length < 6) problems.push('title 太短：写成一句能照做的规则（该怎么做），至少 6 个字')
  if (NARRATIVE.test(title)) problems.push('title 写成了经过：改成换个场景也能照做的规则，经过写进 cause')
  if (VAGUE.test(title) && rule.length < 10) problems.push('只说了要小心：在 rule 里写清楚具体怎么做、别做什么')
  if (!rule && !input.episode) problems.push('rule 不能为空：写具体做法和别做的事，命令用反引号')
  const anchored =
    !!input.episode ||
    input.paths.length > 0 ||
    (input.commands?.length ?? 0) > 0 ||
    lessonCommands({ title, rule, cause: input.cause }).length > 0
  if (!anchored && !global)
    problems.push(
      '没有触发键：写 paths（它管的文件）或 commands（跑哪些命令前该看到它），面板才知道什么时候推给下一个 Agent；确实所有改动都适用的，加 "global": true',
    )
  const similar = input.replaces
    ? undefined
    : existing.find((l) => l.enabled && overlap(`${l.title} ${l.rule}`, `${title} ${rule}`) >= 0.7)
  if (similar)
    problems.push(`和已有的教训 ${similar.id}「${similar.title}」几乎一样：带 "id": "${similar.id}" 改写那一条`)
  return { ok: !problems.length, problems, similar: similar && { id: similar.id, title: similar.title } }
}
