import { z } from 'zod'
import type { Project } from '../../shared/schema.ts'
import { ActionError, defineAction, type ActionCtx } from './registry.ts'
import { pushUi } from './ui.ts'

/** 项目这一组：列项目、打开项目设置、AI 初始化项目 */

async function project(id: string | undefined, ctx: ActionCtx) {
  const pid = id || ctx.caller?.projectId
  if (!pid) throw new ActionError('要写 id：没有对话上下文时得指明是哪个项目')
  const list = (await ctx.api('GET', '/projects')) as Project[]
  const p = list.find((x) => x.id === pid)
  if (!p) throw new ActionError(`项目不存在：${pid}`)
  return p
}

const ID = z.string().optional().describe('项目 id；不写就是你所在的项目')

export const projectActions = [
  defineAction({
    name: 'project.list',
    title: '列出项目',
    description: '列出面板里的项目：id、名字、目录、是否初始化过。',
    level: 'read',
    input: z.object({}),
    run: async (_a, ctx) =>
      ((await ctx.api('GET', '/projects')) as Project[]).map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        initialized: !!p.initializedAt,
      })),
  }),
  defineAction({
    name: 'project.open_settings',
    title: '打开项目设置',
    description:
      '在页面上打开一个项目的设置弹窗。section 可选：general、init（AI 初始化）、roles、workflows、tests、lessons、skills、mcp、doc。',
    level: 'write',
    input: z.object({ id: ID, section: z.string().optional() }),
    run: async (a, ctx) => {
      const p = await project(a.id, ctx)
      return { project: p.name, ...pushUi(ctx, 'open_project', { id: p.id, section: a.section }) }
    },
  }),
  defineAction({
    name: 'project.init',
    title: 'AI 初始化项目',
    description:
      '在页面上打开项目设置并开始「AI 初始化项目」（写 AGENTS.md 和文档框架、推荐工作流和设置）。初始化在页面里的 AI 对话中进行，推荐的设置由用户在弹窗里应用。',
    level: 'write',
    input: z.object({ id: ID }),
    run: async (a, ctx) => {
      const p = await project(a.id, ctx)
      return { project: p.name, ...pushUi(ctx, 'open_project', { id: p.id, section: 'init', item: 'start' }) }
    },
  }),
]
