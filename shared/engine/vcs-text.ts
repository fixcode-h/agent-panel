import type { EngineHost } from './host.ts'

/**
 * 提示词里和版本管理有关的命令按项目现在用的版本管理写（policy.vcs，server/exec/real-turn.ts 探的）：
 * 以前一律写 git，P4 项目里的 Agent 照着跑 git add / git diff，跑不通或者干脆乱用（2026-11-12 用户反馈）。
 * 不知道是哪种时（模拟执行、没有项目目录）按 Git 写，和以前一样
 */
const vcsOf = (host: EngineHost) => host.policy?.vcs ?? 'git'

/** 父对话只读排查时可以跑的命令举例 */
export function vcsReadCmds(host: EngineHost) {
  const v = vcsOf(host)
  if (v === 'p4') return 'p4 opened -c、p4 describe -s、p4 filelog <文件>'
  if (v === 'svn') return 'svn log、svn diff <文件>'
  if (v === 'none') return '查看文件、搜索'
  return 'git log、git diff'
}

/** 共用目录的子对话：只动自己改的文件，不把别人的改动一起带上 */
export function vcsOwnOnly(host: EngineHost) {
  const v = vcsOf(host)
  if (v === 'p4')
    return '只 p4 edit / add 你自己改的文件（限定到具体文件），不对目录跑 reconcile，也不把别人打开的文件挪进你的 changelist。'
  if (v === 'svn') return '只 svn add / delete 你自己的文件（限定到具体文件），不对目录跑 svn add --force。'
  if (v === 'none') return ''
  return '提交时只 git add 你自己改的文件，不用 -A。'
}
