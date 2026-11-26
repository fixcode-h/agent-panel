/**
 * 一段操作前后版本管理里的改动对比（版本管理服务，ADR 0073）：跑之前记一次、跑完再记一次，
 * 相减得出「这次改了哪些文件、各加减多少行」，一次删掉大量行时告警。
 *
 * 起因（2026-11-26 复盘 P0-2）：自建的导表工具单表导出时把共享的 DBConfigIntermediate.lua 从 79866 行写成 7 行，
 * 工具照样退出码 0，Agent 和用户都不知道，是子任务碰巧 p4 diff 才发现。自建工具改成默认直接运行以后更看不见，
 * 所以由面板在运行后把改动摆出来。git 走 server/exec/git.ts，P4 走 p4Runner；别的版本管理不比。
 */
import { gitNumstat } from '../exec/git.ts'
import { p4Runner, type P4Run } from '../p4-split.ts'
import { detectVcs } from './detect.ts'

/** 文件 → 相对基线（git 的 HEAD、P4 库里的版本）增加 / 删除的行数 */
export type ChangeStat = Map<string, { add: number; del: number }>

/** 删掉这么多行以上、并且删的远多于加的，算「大量删除」要告警 */
const BIG_DELETE = 500

/** p4 diff -ds 的输出：==== //depot/a#3 - D:\p\a ==== 后面跟 add / deleted / changed 三行 */
export function parseP4DiffSummary(out: string): ChangeStat {
  const stat: ChangeStat = new Map()
  let cur: { add: number; del: number } | undefined
  for (const line of out.split(/\r?\n/)) {
    const head = /^==== .+? - (.+?) ====/.exec(line)
    if (head) {
      cur = { add: 0, del: 0 }
      stat.set(head[1].trim(), cur)
      continue
    }
    if (!cur) continue
    const add = /^add \d+ chunks? (\d+) lines?/.exec(line)
    const del = /^deleted \d+ chunks? (\d+) lines?/.exec(line)
    const chg = /^changed \d+ chunks? (\d+) \/ (\d+) lines?/.exec(line)
    if (add) cur.add += Number(add[1])
    if (del) cur.del += Number(del[1])
    if (chg) {
      cur.del += Number(chg[1])
      cur.add += Number(chg[2])
    }
  }
  return stat
}

/** 现在的改动；不是 git / P4 项目、或问不出来时返回 null（调用方就不比） */
export async function changeStat(root: string, run?: P4Run): Promise<ChangeStat | null> {
  const vcs = await detectVcs(root).catch(() => undefined)
  if (vcs?.vcs === 'git') {
    const n = await gitNumstat(root).catch(() => null)
    if (!n) return null
    return new Map(
      Object.entries(n).map(([f, v]) => {
        const [add, del] = v.split('/').map(Number)
        return [f, { add, del }]
      }),
    )
  }
  if (vcs?.vcs === 'p4') {
    // 只比当前 client 打开着的文件（签出后被改的）；没签出就被改的 P4 看不到，这类由改前签出钩子兜
    const r = await (run ?? p4Runner(root))(['diff', '-ds', `${root.replace(/[\\/]+$/, '')}/...`])
    if (!r.ok && !r.out.trim()) return null
    return parseP4DiffSummary(r.out)
  }
  return null
}

export interface ChangeDelta {
  file: string
  add: number
  del: number
}

/** 两次之间变了的文件：这一次的加减行数减去之前就有的 */
export function changeDelta(before: ChangeStat, after: ChangeStat): ChangeDelta[] {
  const out: ChangeDelta[] = []
  for (const [file, a] of after) {
    const b = before.get(file) ?? { add: 0, del: 0 }
    if (a.add === b.add && a.del === b.del) continue
    out.push({ file, add: Math.max(0, a.add - b.add), del: Math.max(0, a.del - b.del) })
  }
  return out.sort((x, y) => y.del + y.add - (x.del + x.add))
}

/** 删了很多、几乎没加回来的文件：整份被清空、被截断的典型样子 */
export const bigDeletes = (d: ChangeDelta[]) => d.filter((c) => c.del >= BIG_DELETE && c.del > c.add * 5)

/** 交给 Agent 的一段：改了几个文件、前几个各加减多少；有大量删除时写明先核对 */
export function changeSummary(d: ChangeDelta[], max = 8): string {
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
  return `这次运行改了：${list}${more}${warn}`
}
