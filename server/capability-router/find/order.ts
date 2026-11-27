/**
 * 按查找类别的走法（shared/capability-router/find/categories.ts 的 order）把几条路排好、挑出这次要走的：
 * 路由（../router.ts）只按 rank 依次走，这里给每条路一个这次用的 rank 和 accepts，不改插件登记的那份
 */
import type { FindOrder } from '../../../shared/capability-router/find/categories.ts'
import type { ExternalFindSource, FindOutcome, FindRequest } from '../../../shared/capability-router/find/types.ts'
import type { RouteSource } from '../router.ts'

type Src = RouteSource<FindRequest, FindOutcome>

export function orderSources(
  order: FindOrder,
  external: { spec: ExternalFindSource; src: Src }[],
  text: Src,
  req: FindRequest,
): Src[] {
  if (order === 'panel') return [text]
  if (order === 'specialist') return [...external.map((x) => x.src), text]
  // panel-first：类型看不出，外部服务按种类能接就问（语言对不上的查不到就是空，不算错），排在面板后面
  const after = external
    .filter((x) => x.spec.kinds.includes(req.kind) && x.spec.args(req) !== null)
    .map((x) => ({ ...x.src, accepts: () => true, rank: text.rank + 1 + x.src.rank }))
  return [text, ...after]
}
