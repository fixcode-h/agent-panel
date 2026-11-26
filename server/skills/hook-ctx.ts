/**
 * 钩子里推技能要的东西（ADR 0083）：这个项目的技能目录（自带 + 这个项目能用的插件技能 + 用户改动）、推送上限，
 * 推了之后记进这个角色的会话用量（会话栏「环境 → 技能」那一行），并告诉页面对话改了
 */
import type { HooksData } from '../../shared/hooks/defs.ts'
import type { Project, Task } from '../../shared/schema.ts'
import { noteSkillUsage } from '../../shared/skills/usage.ts'
import { pluginSkillsFor } from './plugin-skills.ts'
import { catalogFor, skillPushBudget, type PushCtx } from './push.ts'

export async function skillHookCtx(
  data: HooksData,
  task: Task,
  agentId: string,
  project: Project,
  changed?: () => void,
): Promise<Omit<PushCtx, 'taskId'>> {
  return {
    budget: skillPushBudget(data),
    catalog: catalogFor(data, await pluginSkillsFor(project).catch(() => [])),
    onPushed: (name) => {
      if (noteSkillUsage(task.usage.agents[agentId], { pushed: [name] })) changed?.()
    },
  }
}
