import type { Project, Task } from '../../shared/schema.ts'

/**
 * 子对话的独立分支一律不推到远端（推送只由父对话在原分支上做），项目设置成「不推送」时整个项目都不推：
 * 提示词拦不住所有模型，用 git 的 pushInsteadOf 把所有远端地址的推送改写到一个不存在的协议，
 * CLI 里跑的 git push 都会失败，拉取不受影响
 */
export function noPushEnv(task: Task, gitPolicy?: Project['gitPolicy']): { key: string; value: string }[] {
  if (gitPolicy !== 'deny' && (!task.parentTaskId || task.worktree?.state !== 'active')) return []
  return [
    { key: 'GIT_CONFIG_COUNT', value: '1' },
    { key: 'GIT_CONFIG_KEY_0', value: 'url.agent-panel-no-push://.pushInsteadOf' },
    { key: 'GIT_CONFIG_VALUE_0', value: '' },
  ]
}
