import {
  ProjectExperience,
  experienceProblems,
  newExperienceId,
  type ExperienceEdit,
  type LearnedNote,
} from '@shared/experience'
import type { KnowledgeHitsView } from '@shared/knowledge-hits'
import {
  KnowledgeCandidate,
  type DistillRequest,
  type DistillResult,
  type KnowledgeMiss,
  type KnowledgeStateView,
} from '@shared/knowledge/candidate'
import { distill } from '@shared/knowledge/distill'
import { lessonSuggestions } from '@shared/knowledge/lifecycle'
import type { Project } from '@shared/schema'

/**
 * 演示版的项目经验（对应 server/experience/routes.ts）：每个项目一份内存里的列表，带几条示例；
 * AI 评审返回固定的示例结论（不调模型）。刷新页面后回到示例
 */
const now = new Date().toISOString()
const sample = (x: Partial<ProjectExperience> & Pick<ProjectExperience, 'id' | 'title'>) =>
  ProjectExperience.parse({ source: 'auto', createdAt: now, ...x })
const SAMPLES = (): ProjectExperience[] => [
  sample({
    id: 'e-demo-1',
    kind: 'locate',
    title: '支付相关的代码和配置在哪',
    body: '接口在 src/payment/，配置在 config/payment.json；改支付先看这两处，不用全项目搜。',
    keywords: ['支付', '付款', 'payment', 'checkout'],
    paths: ['src/payment/', 'config/payment.json'],
  }),
  sample({
    id: 'e-demo-2',
    kind: 'vocab',
    title: '「购物车」在代码里叫 cart / basket',
    body: '前端叫 cart，后端接口和数据表叫 basket。',
    keywords: ['购物车', 'cart', 'basket'],
    paths: ['src/cart/'],
    updatedAt: now,
  }),
  sample({
    id: 'e-demo-3',
    kind: 'command',
    title: '只跑支付模块的单测',
    keywords: ['测试', '支付', 'test'],
    paths: ['npm test -- src/payment'],
  }),
]
const byProject = new Map<string, ProjectExperience[]>()
const listOf = (id: string) => byProject.get(id) ?? byProject.set(id, SAMPLES()).get(id)!

export function demoExperience(projectId: string, method: string, seg: string[], body: unknown) {
  const list = listOf(projectId)
  const set = (items: ProjectExperience[]) => (byProject.set(projectId, items), { items })
  const [eid] = seg.slice(3)
  if (method === 'GET') return { items: list, errors: [], dir: 'docs/agent-knowledge/experience' }
  if (eid === 'review')
    return {
      total: list.length,
      verdicts: list.map((e, i) =>
        i === 2
          ? { id: e.id, verdict: 'delete', why: '（演示）只是一条普通的测试命令，项目说明里已经写了' }
          : { id: e.id, verdict: 'keep', why: '（演示）目录级的位置，下次同类需求能直接用' },
      ),
    }
  if (eid === 'apply') {
    const b = (body ?? {}) as { remove?: string[]; trim?: { id: string; title: string; body: string }[] }
    const gone = new Set(b.remove ?? [])
    const trims = new Map((b.trim ?? []).map((x) => [x.id, x]))
    return set(list.filter((e) => !gone.has(e.id)).map((e) => ({ ...e, ...trims.get(e.id) })))
  }
  if (eid === 'restore') {
    const b = body as { item: ProjectExperience; expect?: string }
    const cur = list.find((e) => e.id === b.item.id)
    if (b.expect !== undefined && (cur?.updatedAt ?? '') !== b.expect)
      throw Object.assign(new Error('这条经验之后又改过，撤回会丢掉那些改动'), { status: 409 })
    const item = ProjectExperience.parse(b.item)
    return set(cur ? list.map((e) => (e === cur ? item : e)) : [...list, item])
  }
  const edit = body as ExperienceEdit
  const problems = experienceProblems(edit)
  if (problems.length) throw Object.assign(new Error(problems.join('；')), { status: 400 })
  if (method === 'PUT' && eid)
    return set(list.map((e) => (e.id === eid ? ProjectExperience.parse({ ...e, ...edit, updatedAt: now }) : e)))
  return set([
    ...list,
    ProjectExperience.parse({ ...edit, id: newExperienceId(), source: 'user', createdAt: new Date().toISOString() }),
  ])
}

/**
 * 演示对话末尾那张「学到经验」卡片（TaskMessage.learned）：一条新加、一条并入已有（带并入前的样子），
 * 外加一条没收下的。条目 id 和上面的示例经验对得上，卡片的停用、删除、撤回合并在演示里都能点
 */
export function demoLearnedNote(): LearnedNote {
  const [locate, vocab] = SAMPLES()
  const before = ProjectExperience.parse({
    ...vocab,
    title: '「购物车」在代码里叫 cart',
    body: '前端叫 cart。',
    keywords: ['购物车', 'cart'],
    updatedAt: '',
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  })
  return {
    reason: '进入 src/payment 之前搜了 / 读了 14 次',
    items: [
      { id: locate.id, op: 'add', snapshot: locate },
      { id: vocab.id, op: 'merge', snapshot: { ...vocab, updatedAt: now }, before },
    ],
    dropped: [{ title: '角标刷新逻辑在哪', why: '路径都不存在：src/badge/' }],
  }
}

/**
 * 演示版的命中记录（对应 GET /projects/:id/knowledge-hits）：两条经验、一条教训用上过，
 * 一条教训的路径标成已不在，设置页的「很久没用上」排序和过期标记能看出效果
 */
export function demoKnowledgeHits(): KnowledgeHitsView {
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
  return {
    experience: {
      'e-demo-1': { count: 7, lastAt: ago(0.2), taskIds: [], helped: 0, violated: 0, missed: 0 },
      'e-demo-2': { count: 2, lastAt: ago(12), taskIds: [], helped: 0, violated: 0, missed: 0 },
    },
    // 推了还犯了两次：教训列表上出现「升级为拦截」
    lessons: { 'demo-lesson-2': { count: 4, lastAt: ago(1), taskIds: [], helped: 1, violated: 2, missed: 0 } },
    stale: { experience: {}, lessons: { 'demo-lesson-3': ['mock/**'] } },
  }
}

/**
 * 演示版的候选和没配上的查询（对应 GET /projects/:id/knowledge、POST …/candidates/:cid、POST …/distill）：
 * 一条「失败后改对」的教训候选（两个对话里复发过）、一条子对话记下的经验候选；收下、忽略只是从列表拿掉。
 * 建议和提炼调 shared 里的同一份逻辑（lessonSuggestions、distill），演示数据不翻译
 */
const DEMO_CANDIDATES = (): KnowledgeCandidate[] => {
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
  return [
    KnowledgeCandidate.parse({
      id: 'cand-demo-1',
      kind: 'lesson',
      origin: 'episode',
      title: '类型检查用 npx tsc -b，不要直接 npx tsc',
      rule: '项目是多个 tsconfig 的引用工程，`npx tsc` 只查根目录、会报找不到模块；用 `npx tsc -b`。',
      commands: ['npx tsc'],
      errors: [
        {
          codes: ['TS2307'],
          words: ['cannot', 'find', 'module'],
          sample: "error TS2307: Cannot find module '@shared/schema'",
        },
      ],
      failed: 'npx tsc --noEmit',
      fixed: 'npx tsc -b',
      convs: ['demo-task-1', 'demo-task-2'],
      count: 2,
      firstAt: ago(3),
      lastAt: ago(0.1),
    }),
    KnowledgeCandidate.parse({
      id: 'cand-demo-2',
      kind: 'experience',
      origin: 'subtask',
      title: '优惠券规则在 src/payment/coupon/',
      body: '优惠券的计算和校验都在这个目录，配置在 config/coupon.json。',
      keywords: ['优惠券', 'coupon'],
      paths: ['src/payment/coupon/'],
      convs: ['demo-task-3'],
      firstAt: ago(1),
      lastAt: ago(1),
    }),
  ]
}
const DEMO_MISSES = (): KnowledgeMiss[] => [
  { query: '会员等级 折扣', count: 3, convs: [], lastAt: new Date(Date.now() - 7_200_000).toISOString() },
  { query: 'refund webhook', count: 2, convs: [], lastAt: new Date(Date.now() - 86_400_000).toISOString() },
]
const knowledgeByProject = new Map<string, { candidates: KnowledgeCandidate[]; misses: KnowledgeMiss[] }>()

export function demoKnowledge(
  project: Project | undefined,
  method: string,
  seg: string[],
  body: unknown,
): KnowledgeStateView | DistillResult | { ok: boolean; info: string } {
  const id = project?.id ?? ''
  const cur =
    knowledgeByProject.get(id) ??
    knowledgeByProject.set(id, { candidates: DEMO_CANDIDATES(), misses: DEMO_MISSES() }).get(id)!
  const hits = demoKnowledgeHits()
  const [what, cid] = seg.slice(3)
  if (what === 'candidates' && method === 'POST') {
    const action = (body as { action?: string } | undefined)?.action
    const c = cur.candidates.find((x) => x.id === cid)
    if (!c) return { ok: false, info: '这条候选已经不在了' }
    cur.candidates = cur.candidates.filter((x) => x !== c)
    return { ok: true, info: action === 'accept' ? `（演示）已收下：${c.title}` : '' }
  }
  if (what === 'distill' && method === 'POST') {
    const req = (body ?? {}) as DistillRequest
    if (req.target === 'hook') return { ok: false, info: '（演示）演示版不写钩子' }
    return distill(req.target, project?.name ?? '', project?.lessons ?? [], hits.lessons, cur.misses)
  }
  return {
    ...cur,
    suggestions: lessonSuggestions(project?.lessons ?? [], hits.lessons, hits.stale.lessons),
  }
}
