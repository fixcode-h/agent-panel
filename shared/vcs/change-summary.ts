/**
 * 改动统计交给 Agent 的那一段（2026-11-26 复盘 P0-2、§5-3）：改了几个文件、各加减多少行，一次删掉大量行时告警。
 * 自建工具（server/custom-tools/run.ts）、子任务交回结果（shared/engine/helpers.ts）、后台命令都用这一份，
 * 所以放 shared：引擎拼子任务结果时也要用，取改动的那一半（问 git / P4）在 server/vcs/change-stat.ts
 */

export interface ChangeDelta {
  file: string
  add: number
  del: number
}

/** 删掉这么多行以上、并且删的远多于加的，算「大量删除」要告警 */
const BIG_DELETE = 500

/** 删了很多、几乎没加回来的文件：整份被清空、被截断的典型样子 */
export const bigDeletes = (d: ChangeDelta[]) => d.filter((c) => c.del >= BIG_DELETE && c.del > c.add * 5)

/** 交给 Agent 的一段：改了几个文件、前几个各加减多少；有大量删除时写明先核对 */
export function changeSummary(d: ChangeDelta[], max = 8, lead = '这次运行改了'): string {
  if (!d.length) return ''
  const list = d
    .slice(0, max)
    .map((c) => `${c.file}（+${c.add} −${c.del}）`)
    .join('、')
  const more = d.length > max ? ` 等 ${d.length} 个文件` : ''
  const big = bigDeletes(d)
  const warn = big.length
    ? `\n【注意】${big.map((c) => c.file).join('、')} 一次删掉了大量内容：先用版本管理看差异，确认是这次本该有的改动；不是的话还原它并告诉用户，不要接着往下做。`
    : ''
  return `${lead}：${list}${more}${warn}`
}
