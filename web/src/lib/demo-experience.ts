import { ProjectExperience, experienceProblems, newExperienceId, type ExperienceEdit } from '@shared/experience'

/**
 * 演示版的项目经验（对应 server/experience-routes.ts）：每个项目一份内存里的列表，带几条示例；
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
