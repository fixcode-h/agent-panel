/**
 * 从父对话这一轮的 input 里取出所有【收尾请求】的子对话 id。
 *
 * 以前 fake-cli 用非全局的 exec 只取了第一个：父对话一轮里同时收到几个子对话的收尾请求时（几个子对话
 * 前后脚交回），后面那些永远不会被 finish_child 处理，对应子对话只能等到超时——排障时看起来像合并卡住。
 * 现在按 id 去重后逐个处理。
 */
// 正文形如：`【收尾请求】子对话「标题」（id xxxxx）只剩合回了：……`
const WRAP_REQUEST = /【收尾请求】[^\n]*（id ([^）\s]+)）/g

/** 这一轮 input 里的收尾请求 id，按出现顺序去重 */
export function wrapRequestIds(input) {
  const ids = []
  for (const m of input.matchAll(WRAP_REQUEST)) if (!ids.includes(m[1])) ids.push(m[1])
  return ids
}
