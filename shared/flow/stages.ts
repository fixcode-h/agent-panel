import { END, START } from '../schema.ts'
import { t } from '../i18n.ts'

const rid = () => Math.random().toString(36).slice(2, 10)

/**
 * 「阶段」写法（阶段依次执行、阶段内并行）转换成连线：每个阶段的节点连到下一阶段的所有节点，位置按阶段排成列。
 * 两处用：从 Markdown 文档生成流程（shared/flow/index.ts）；数据迁移 0011 把旧版存的阶段流程换成连线
 */
export function stagesToFlow(stages: { title?: string; nodes?: Record<string, unknown>[] }[]) {
  const cols = stages.filter((s) => s.nodes?.length)
  const nodes: Record<string, unknown>[] = []
  const edges: { id: string; from: string; to: string }[] = []
  let prev: string[] = [START]
  const COL = 300
  const ROW = 150
  cols.forEach((c, ci) => {
    const ids: string[] = []
    c.nodes!.forEach((n, ni) => {
      const id = String(n.id ?? `nd_${rid()}`)
      ids.push(id)
      nodes.push({
        ...n,
        id,
        x: 240 + ci * COL,
        y: (ni - (c.nodes!.length - 1) / 2) * ROW,
      })
      for (const p of prev) edges.push({ id: `e_${rid()}`, from: p, to: id })
    })
    prev = ids
  })
  for (const p of prev) if (p !== START || !cols.length) edges.push({ id: `e_${rid()}`, from: p, to: END })
  return {
    id: 'main',
    name: t('主流程'),
    nodes,
    edges: cols.length ? edges : [],
    startPos: { x: 0, y: 0 },
    endPos: { x: 240 + cols.length * COL, y: 0 },
    description: '',
  }
}
