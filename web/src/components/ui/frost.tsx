/**
 * 吸顶毛玻璃通栏的底（照 Claude Code 网页版顶栏）：放在带 `frost-bar` 的吸顶元素里当第一个孩子。
 * 底色左右铺满整个滚动区（滚动区要 overflow-x 隐藏，多出去的部分被裁掉），文字留在原来的对齐线上；
 * 单独一个元素而不用 ::before，是为了按「吸住没有」（scroll-state 容器查询）给它加底边细线。样式见 index.css
 */
export function FrostBarBg() {
  return <span aria-hidden className="frost-bar-bg" />
}
