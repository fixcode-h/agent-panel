/**
 * 设置页右侧「本页小节」菜单的判定逻辑（纯函数，`section-nav.tsx` 只负责 DOM 和状态）。
 * 分开是为了能直接测：滚到哪算哪个小节、跳到某个小节该滚到多少，都有容易写错的边界。
 */

/** 跳转时在目标小节上方留的空：标题不贴着容器顶部 */
export const SCROLL_GAP = 12
/** 距底部这么近就算滚到底了：最后一段内容很短时，不高亮最后一个小节会让人以为没生效 */
export const BOTTOM_SLACK = 2

/** `compareDocumentPosition` 里「后者在文档中靠后」的位 */
const DOCUMENT_POSITION_FOLLOWING = 4

/**
 * 按页面里的实际位置排序，不信挂载顺序。
 * 登记是小节挂载时 append 的，所以条件渲染的组（「外部访问」里的「环境检测」）卸载后重新挂载
 * 会被挤到末尾，菜单顺序就和页面实际顺序对不上；`label` 变化时 React 也是先卸再挂，同样错位。
 * `isConnected` 用来滤掉开发时热更新留在表里、节点已经不在文档中的死项。
 */
export function sortByDocument<T extends { el: Pick<Node, 'isConnected' | 'compareDocumentPosition'> }>(
  list: T[],
): T[] {
  const kept = list.filter((x) => x.el.isConnected)
  return kept.sort((a, b) => {
    if (a.el === b.el) return 0
    // compareDocumentPosition 返回值的 FOLLOWING 位表示后者在文档里靠后，那就排到后面
    // compareDocumentPosition 返回 FOLLOWING 位时，b 在 a 之后，所以 a 应该排前面（返回 -1）
    return a.el.compareDocumentPosition(b.el as Node) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  })
}

/**
 * 当前在哪个小节：取「顶部已经越过容差线」的最后一个，都没越过时算第一个。
 * tops 是各小节顶部相对容器视口顶部的距离（getBoundingClientRect 的差值，单位 px），按页面上出现的顺序传：
 * 已经滚过去的小节是负数，还没到的是正数。bottom 为 true 时直接算最后一个小节。
 */
export function activeIndex(tops: number[], bottom = false, gap = SCROLL_GAP) {
  if (!tops.length) return -1
  if (bottom) return tops.length - 1
  let cur = 0
  for (let i = 0; i < tops.length; i++) if (tops[i] <= gap) cur = i
  return cur
}

/** 滚到底了吗：内容比可视区还短时也算到底（这时只能看到最后那段） */
export function atBottom(
  view: { scrollTop: number; clientHeight: number; scrollHeight: number },
  slack = BOTTOM_SLACK,
) {
  return view.scrollTop + view.clientHeight >= view.scrollHeight - slack
}

/** 跳到某个小节该滚到多少：小节在内容里的偏移减掉要留的空，不滚成负数 */
export function jumpTop(offset: number, gap = SCROLL_GAP) {
  return Math.max(0, offset - gap)
}
