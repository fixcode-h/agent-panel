import { splitAgentMode } from '../../shared/migrations/agent-mode.ts'
import type { Migration } from './index.ts'
import { liftTaskFiles } from './lift-tasks.ts'

/**
 * 对话分开存成两种：项目里的对话、子对话从 mode = chat 改成 agent，Chat 页的对话仍是 chat（转换见 shared/migrations/agent-mode.ts）。
 * 没有要改的不写盘
 */
export const agentMode: Migration = {
  version: 12,
  name: 'agent-mode',
  async run(ctx) {
    const n = await liftTaskFiles(ctx, splitAgentMode)
    if (n) ctx.log(`${n} 个项目里的对话、子对话改存成 Agent 模式（mode = agent）`)
  },
}
