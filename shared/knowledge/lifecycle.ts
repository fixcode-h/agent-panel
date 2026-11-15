import type { ProjectLesson } from '../schema.ts'
import type { KnowledgeHits } from '../knowledge-hits.ts'
import type { LessonSuggestion } from './candidate.ts'
import { t } from '../i18n.ts'

/**
 * 教训的升降级建议（设计稿 4.7，三期）：只看面板记下的命中和反馈（shared/knowledge-hits.ts），不调模型。
 * 只给建议，改不改由用户在知识页点：拦截（block）尤其只能用户升级（Q4）
 */
export const LIFECYCLE_RULES = {
  /** 推了还是犯了几次，建议升级成拦截 */
  upgradeViolated: 2,
  /** 多少天没用上、又从没帮上过，建议标为过时 */
  staleDays: 60,
  /** 在几个对话里用上、帮上过几次，建议提炼进 AGENTS.md / 钩子 */
  promoteConvs: 3,
  promoteHelped: 2,
} as const

const DAY = 86_400_000

export function lessonSuggestions(
  lessons: Pick<ProjectLesson, 'id' | 'enabled' | 'severity' | 'status' | 'createdAt' | 'paths'>[],
  hits: KnowledgeHits,
  staleAnchors: Record<string, string[]> = {},
  now = Date.now(),
): LessonSuggestion[] {
  const out: LessonSuggestion[] = []
  for (const l of lessons) {
    if (!l.enabled || l.status === 'promoted') continue
    const h = hits[l.id]
    if (l.severity !== 'block' && (h?.violated ?? 0) >= LIFECYCLE_RULES.upgradeViolated) {
      out.push({ id: l.id, action: 'upgrade', why: t('推送后仍犯了 {n} 次', { n: h!.violated }) })
      continue
    }
    if (l.status !== 'stale') {
      if (staleAnchors[l.id]?.length) {
        out.push({ id: l.id, action: 'stale', why: t('管的路径已经不在了') })
        continue
      }
      const since = Date.parse(h?.lastAt || l.createdAt || '')
      if (!h?.helped && !Number.isNaN(since) && now - since > LIFECYCLE_RULES.staleDays * DAY) {
        out.push({ id: l.id, action: 'stale', why: t('{n} 天没用上', { n: Math.floor((now - since) / DAY) }) })
        continue
      }
    }
    if ((h?.taskIds.length ?? 0) >= LIFECYCLE_RULES.promoteConvs && (h?.helped ?? 0) >= LIFECYCLE_RULES.promoteHelped)
      out.push({ id: l.id, action: 'promote', why: t('在 {n} 个对话里帮上过', { n: h!.taskIds.length }) })
  }
  return out
}
