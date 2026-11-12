/**
 * 工作总结的代码改动材料（ADR 0056）：报告里的 Bug 要贴关键修改代码，CLI 只能从这里给的真实改动里挑。
 *
 * 只给可能在修 Bug 的对话（用户报了问题，或写了「修复」总结卡）：需求不贴代码，全给只会把提示词撑大。
 * 改动从每轮记下的 git 快照区间取（和对话里「已更改 N 个文件」同一份），测试、文档、锁文件不放；
 * 每个对话、全部对话各有字数上限，超出的写明截断了。取不到（快照被清理、目录没了）就不给，记日志，报告照常生成。
 */
import { spansDiff } from '../exec/git.ts'
import { log } from '../log.ts'
import { SUMMARY_DIFF_TASK_CHARS, SUMMARY_DIFF_TOTAL_CHARS, type DayProject } from '../../shared/summary.ts'

/** 不放进材料的文件：测试、文档、锁文件、快照和样本，这些不是「修复的关键代码」 */
const SKIP_FILE =
  /(?:\.test\.|\.spec\.|(?:^|\/)(?:tests?|__tests__|fixtures|__snapshots__)\/|\.md$|\.lock$|package-lock\.json$|pnpm-lock\.yaml$|\.snap$)/i

/** 一段统一差异按文件拆开，去掉不放的文件 */
function keepFiles(diff: string) {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((part) => {
      const m = /^diff --git a\/(.+?) b\//.exec(part)
      return m && !SKIP_FILE.test(m[1]) && !/^Binary files /m.test(part)
    })
    .join('')
}

/** 截到 max 字：在行尾断开，写明后面还有多少字没放 */
function cut(text: string, max: number) {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const at = head.lastIndexOf('\n')
  const kept = at > 0 ? head.slice(0, at) : head
  return `${kept}\n…（后面还有 ${text.length - kept.length} 字的改动没有放进来）`
}

/**
 * 给可能在修 Bug 的对话填上 code（就地改 projects）。dirOf 按项目 id 给出跑 git 的目录：
 * 快照树存在项目仓库的对象库里，独立分支（worktree）和项目目录共用，用项目目录就能读到
 */
export async function attachCode(projects: DayProject[], dirOf: (projectId: string) => string) {
  let left = SUMMARY_DIFF_TOTAL_CHARS
  for (const p of projects) {
    const dir = dirOf(p.projectId)
    if (!dir) continue
    for (const task of p.tasks) {
      if (left <= 0) return
      if (!(task.userBug || task.fixCard) || !task.spans.length) continue
      // 快照被清理、目录没了时读不出来：这个对话就不给代码，报告照常生成（Bug 条目没有关键代码）
      const diff = keepFiles(
        await spansDiff(dir, task.spans).catch((e) => {
          log.warn('summary', '取对话的代码改动失败', { task: task.id, error: (e as Error).message })
          return ''
        }),
      ).trim()
      if (!diff) continue
      task.code = cut(diff, Math.min(SUMMARY_DIFF_TASK_CHARS, left))
      left -= task.code.length
    }
  }
}
