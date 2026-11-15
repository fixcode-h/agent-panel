/**
 * 全局技能生效方式的接口契约（写法见 ./define.ts，说明见 shared/skills/activation.ts）。
 * 技能库的其他接口（/library/*）还是手写的 request，以后整理时一起挪进来
 */
import { z } from 'zod'
import { SkillActivationInput, type SkillActivationResult } from '../skills/activation.ts'
import { endpoint, shaped } from './define.ts'

export const skillsContract = {
  /** 把一个技能（按名字，自带的和各 CLI 目录里同名的一起）切成全局或按项目 */
  setActivation: endpoint({
    method: 'PUT',
    path: '/library/skill-activation',
    body: SkillActivationInput,
    res: shaped<SkillActivationResult>(
      z.looseObject({
        name: z.string(),
        activation: z.enum(['global', 'project']),
        moved: z.array(z.string()),
        removed: z.array(z.string()),
        kept: z.array(z.string()),
      }),
    ),
  }),
}
