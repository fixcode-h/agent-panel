/**
 * 耗时显示的唯一实现：界面、报告、后台命令推回的文案都走这里，不再各写一段。
 *
 * 一档一个单位，越往上越粗；小数只在最小的那一档出现，避免「4m 3.60s」这种噪声：
 *   0            → 0s
 *   0 < ms < 1 秒 → 38ms（整数毫秒：打开对话那几步就在这个量级，写成 <0.1s 分不出谁慢）
 *   < 60 秒      → 41.2s / 20s（秒，最多一位小数，整数不带 .0）
 *   < 60 分      → 4m 3.6s
 *   < 24 小时    → 2h 5m
 *   再长         → 1d 3h（超过 30 天也只写天，不拆成月，月份长度不固定没必要）
 *
 * 先按 0.1 秒取整再分档：59.96s 显示 1m 0s 而不是 60s，进位不会跨档漏掉。
 * 负数、NaN、Infinity 一律按 0：调用方拿到的多半是「起止时间不全」，不显示负数也不抛错。
 */
/** 0.1 秒为单位的整数转成秒的文字：41.2 / 20（整数不带 .0） */
const secText = (tenths: number) => (tenths % 10 ? (tenths / 10).toFixed(1) : String(tenths / 10))

export function fmtDuration(ms: number) {
  const total = Number.isFinite(ms) ? Math.max(0, ms) : 0
  // 一秒以内按毫秒写：0.1 秒的精度对加载日志来说太粗，38ms / 900ms 这样的差别要看得出。
  // 0 和 0.5 毫秒以内的零头都写 0s：四舍五入会得到「0ms」，看起来像没花时间又不像
  if (total < 0.5) return '0s'
  // 阈值取 999.5：四舍五入到 1000ms 的按 1s 写，不出现「1000ms」
  if (total < 999.5) return `${Math.round(total)}ms`
  // 用 0.1 秒的整数量算，避免浮点误差把 59.9 抬成 60.0
  const ds = Math.round(total / 100)
  // 秒和分都保留 0.1 秒的精度：分档的秒位要能写 4m 3.6s
  if (ds < 36_000) {
    const m = Math.floor(ds / 600)
    const rest = ds - m * 600
    return m ? `${m}m ${secText(rest)}s` : `${secText(ds)}s`
  }
  // 一小时以上只写到整分、整时，再小的零头看不出差别
  const mins = Math.round(ds / 600)
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`
  const hours = Math.round(mins / 60)
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
