import type { Task } from '@shared/schema'
import { t } from '@shared/i18n'

// CLI 存活的提示：只认服务端按真实进程算的 cliAlive / childrenCli，CLI 关了就绝不显示

/** 「等待你的下一条消息」后面的动态点：依次亮起（样式见 index.css 的 .wait-dots） */
export function WaitDots() {
  return (
    <span className="wait-dots inline-flex items-center" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  )
}

/** 这个对话（自己或名下的子对话）有没有活着的 CLI：标题流光用它 */
export const cliTreeAlive = (task: Pick<Task, 'cliAlive' | 'childrenCli'>) => !!task.cliAlive || !!task.childrenCli

/** 标题上的悬浮说明：哪些 CLI 还开着 */
export function cliAliveHint(task: Pick<Task, 'cliAlive' | 'childrenCli'>) {
  const kids = task.childrenCli ?? 0
  if (task.cliAlive && kids) return t('CLI 存活：本对话和 {n} 个子对话', { n: kids })
  if (task.cliAlive) return t('CLI 存活')
  if (kids) return t('CLI 存活：{n} 个子对话', { n: kids })
  return ''
}
