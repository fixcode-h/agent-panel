/**
 * 侧栏一行收起时的悬停提示：名字 + 圆点提示 + chip 文案，没有的那个不留分隔符。
 *
 * 单拎出来是为了能单测「部署差异」和「有新版本」同时存在时两条都还在——演示版里
 * 应用更新恒为不显示，界面检查构造不出两个都有的场景。
 */
export function rowTip(label: string, dot?: string, badge?: string) {
  return [label, dot, badge].filter(Boolean).join(' · ')
}
