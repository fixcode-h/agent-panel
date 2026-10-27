/**
 * 耗时写法：给 node 脚本（界面检查、端到端汇总）用的副本。
 * 规则和界面上的那一处实现 `shared/duration.ts` 完全一致，改这里必须同步改那边——
 * `shared/duration.test.ts` 会把两边对同一组边界值的结果逐条比对，改漏一边单测就红。
 * 脚本是 .mjs、界面代码是 .ts，Node 不能跨格式直接 import，所以只能留这一份镜像。
 */
const secText = (tenths) => (tenths % 10 ? (tenths / 10).toFixed(1) : String(tenths / 10))

export function fmtDuration(ms) {
  const total = Number.isFinite(ms) ? Math.max(0, ms) : 0
  if (total < 0.5) return '0s'
  if (total < 999.5) return `${Math.round(total)}ms`
  const ds = Math.round(total / 100)
  if (ds < 36_000) {
    const m = Math.floor(ds / 600)
    const rest = ds - m * 600
    return m ? `${m}m ${secText(rest)}s` : `${secText(ds)}s`
  }
  const mins = Math.round(ds / 600)
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`
  const hours = Math.round(mins / 60)
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
