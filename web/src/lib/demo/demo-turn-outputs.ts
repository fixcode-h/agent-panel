import type { FileChange, Task } from '@shared/schema'
import { turnOutputCandidates, type TurnOutput } from '@shared/turn-outputs/pick'

/**
 * 演示：最后一轮除了改代码，还做了一个示例网页、一张 archify 架构图、一份排查记录和一张截图，
 * 对话停下后完成依据上面挂「本轮产出」（设计稿 6.7，效果图 8）。演示里没有真的目录，新建还是修改、大小照这张表给
 */
const DEMO_OUTPUTS: (FileChange & Omit<TurnOutput, 'path'>)[] = [
  { path: 'demo/cart-badge.html', add: 214, del: 0, status: 'added', size: 18_400 },
  { path: '.archify/cart/rag-pipeline.html', add: 1_820, del: 0, status: 'added', size: 851_000 },
  { path: 'docs/角标刷新问题-排查记录.md', add: 86, del: 0, status: 'added', size: 4_100 },
  { path: 'ui-shots/cart-badge-after.png', add: 0, del: 0, status: 'added', size: 98_300 },
]

/** 挂到最后一轮的改动记录上的文件（演示数据造好时调用） */
export const demoOutputChanges = (): FileChange[] => DEMO_OUTPUTS.map(({ path, add, del }) => ({ path, add, del }))

/** POST /tasks/:id/turn-outputs：按同一份挑选规则核对候选，只回这一轮记下过的 */
export function demoTurnOutputs(task: Task, body: { msgs: string[]; paths: string[] }) {
  const mine = turnOutputCandidates(task.messages.filter((m) => body.msgs.includes(m.id)))
  const files = body.paths
    .filter((p) => mine.paths.includes(p))
    .map((p): TurnOutput => {
      const known = DEMO_OUTPUTS.find((x) => x.path === p)
      return { path: p, status: known?.status ?? 'modified', size: known?.size ?? 2_048 }
    })
  return { files }
}
