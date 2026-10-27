/**
 * 跳到某条消息：命令面板和侧栏的对话内容搜索点到一条命中时用。
 *
 * 消息可能收在「展开过程」的折叠段里（那一段只画最后一条回复），这时先点开那一段再滚过去。
 * 只按 DOM 上的标记找，不改消息组件的状态：折叠状态本来就按段记着，点一下开关就会展开。
 */

/** 消息根节点上的标记：值就是消息 id（见 Messages.tsx 的 MessageBody、ChatMessage 的 UserMessage） */
const MSG_ATTR = 'data-msg'
/** 折叠开关上的标记：值是这一段收起来的消息 id（空格分隔），用来判断目标是不是藏在里面 */
const FOLD_ATTR = 'data-fold-msgs'
/** 一次跳转最多试几次：打开对话后消息是异步来的，折叠段展开也要等下一帧 */
export const ANCHOR_TRIES = 8
export const ANCHOR_RETRY_MS = 80

/**
 * 定位到一条消息：找到就滚到中间，返回 true；
 * 没找到但它在某个折叠段里时，点开那一段并返回 false（调用方隔一会儿再试一次）
 */
export function jumpToMessage(id: string, root: ParentNode = document): boolean {
  if (!id) return false
  const el = root.querySelector<HTMLElement>(`[${MSG_ATTR}="${CSS.escape(id)}"]`)
  if (el) {
    el.scrollIntoView({ block: 'center' })
    return true
  }
  // 目标被收进了折叠段（那一段只画最后一条回复）：只点开包含它的那一段，下一次重试时再找。
  // 不能盲点前面几段——那会把用户没要看的「过程」全部摊开，而且找不到目标时会把整篇对话摊平
  root.querySelector<HTMLElement>(`[${FOLD_ATTR}~="${CSS.escape(id)}"]`)?.click()
  return false
}
