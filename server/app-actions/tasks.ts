import { z } from 'zod'
import type { Task } from '../../shared/schema.ts'
import { ActionError, defineAction, type ActionCtx } from './registry.ts'

/** 对话（任务）这一组：查看、新建、发消息，以及用户明确要求时的停止和删除 */

const ID = z.string().trim().min(1).optional().describe('对话 id；不写就是你自己这个对话')
const ONLY_ASKED = '只在用户明确要求时用：用户说了就直接执行，不要再问一遍。'

/** 不写 id 就是调用者自己的对话；HTTP 入口没有调用者，必须写 */
function target(id: string | undefined, ctx: ActionCtx) {
  const v = id || ctx.caller?.taskId
  if (!v) throw new ActionError('要写 id：没有对话上下文时得指明是哪个对话')
  return v
}

/** 自己这一轮所在的对话和它的父对话不能停、不能删：会把自己连根拔掉，用户要停有停止按钮 */
function notSelf(id: string, ctx: ActionCtx, what: string) {
  const c = ctx.caller
  if (!c) return
  if (id === c.taskId) throw new ActionError(`不能${what}你自己所在的这个对话：要停下来就结束这一轮，用户有停止按钮`)
  if (id === c.parentTaskId) throw new ActionError(`不能${what}你的父对话`)
}

const enc = encodeURIComponent

/** 列表、详情里给模型看的几项：对话内容不带，太长 */
function brief(t: Task) {
  return {
    id: t.id,
    title: t.title,
    projectId: t.projectId,
    parentTaskId: t.parentTaskId ?? '',
    mode: t.mode,
    status: t.status,
    working: !!t.working,
    archived: !!t.archived,
    childrenWorking: t.childrenWorking ?? 0,
    updatedAt: t.updatedAt,
  }
}

export const taskActions = [
  defineAction({
    name: 'task.list',
    title: '列出对话',
    description:
      '列出项目里的对话（不含子对话；写 parentId 列某个对话的子对话）。默认只列没归档的，最多 limit 条，最新的在前。',
    level: 'read',
    input: z.object({
      projectId: z.string().optional().describe('只列这个项目的；不写就是你所在的项目，写空字符串列全部'),
      parentId: z.string().optional().describe('列这个对话的子对话'),
      archived: z.boolean().default(false).describe('true 时也列出已归档的'),
      limit: z.number().int().min(1).max(200).default(30),
    }),
    run: async (a, ctx) => {
      const pid = a.projectId ?? ctx.caller?.projectId ?? ''
      const q = new URLSearchParams()
      if (pid) q.set('projectId', pid)
      if (a.parentId) q.set('parentId', a.parentId)
      const list = (await ctx.api('GET', `/tasks?${q}`)) as Task[]
      return list
        .filter((t) => a.archived || !t.archived)
        .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
        .slice(0, a.limit)
        .map(brief)
    },
  }),
  defineAction({
    name: 'task.get',
    title: '查看一个对话',
    description: '一个对话的状态、子任务、还在跑的后台命令和子对话数。',
    level: 'read',
    input: z.object({ id: ID }),
    run: async (a, ctx) => {
      const id = target(a.id, ctx)
      const t = (await ctx.api('GET', `/tasks/${enc(id)}`)) as Task
      const kids = (await ctx.api('GET', `/tasks?parentId=${enc(id)}`)) as Task[]
      return {
        ...brief(t),
        subtasks: t.steps.filter((s) => s.slot === 'sub').map((s) => ({ id: s.id, title: s.title, status: s.status })),
        background: (t.jobs ?? []).map((j) => ({ id: j.id, name: j.name, state: j.state })),
        children: kids.map((k) => ({ id: k.id, title: k.title, status: k.status, working: !!k.working })),
      }
    },
  }),
  defineAction({
    name: 'task.children',
    title: '列出子对话',
    description: '一个对话的全部子对话和各自的状态（等什么、有没有在跑、是否已解决）。',
    level: 'read',
    input: z.object({ id: ID }),
    run: async (a, ctx) => ctx.api('GET', `/tasks/${enc(target(a.id, ctx))}/children`),
  }),
  defineAction({
    name: 'task.create',
    title: '新建对话',
    description:
      '在项目里新建一个独立的对话并发出第一条消息（不是你的子对话：要分派子对话用编排工具 create_conversation）。用户让你「开一个新对话做某事」时用。',
    level: 'write',
    input: z.object({
      projectId: z.string().optional().describe('项目 id；不写就是你所在的项目'),
      message: z.string().trim().min(1).max(20000).describe('第一条消息'),
      agentId: z.string().optional().describe('对话用的 Agent；不写用默认'),
    }),
    run: async (a, ctx) => {
      const projectId = a.projectId ?? ctx.caller?.projectId ?? ''
      if (!projectId) throw new ActionError('要写 projectId')
      const t = (await ctx.api('POST', '/tasks', {
        projectId,
        mode: 'chat',
        prompt: a.message,
        ...(a.agentId ? { agentId: a.agentId } : {}),
      })) as Task
      return brief(t)
    },
  }),
  defineAction({
    name: 'task.send',
    title: '给对话发消息',
    description: '以用户的身份给另一个对话发一条消息（它在跑时交给正在跑的 CLI）。不能发给你自己。',
    level: 'write',
    input: z.object({ id: z.string().trim().min(1), text: z.string().trim().min(1).max(20000) }),
    run: async (a, ctx) => {
      if (a.id === ctx.caller?.taskId) throw new ActionError('不能给你自己这个对话发消息')
      const t = (await ctx.api('POST', `/tasks/${enc(a.id)}/messages`, { text: a.text })) as Task
      return brief(t)
    },
  }),
  defineAction({
    name: 'task.rename',
    title: '改对话标题',
    description: '改一个对话的标题。',
    level: 'write',
    input: z.object({ id: ID, title: z.string().trim().min(1).max(80) }),
    run: async (a, ctx) =>
      brief((await ctx.api('PATCH', `/tasks/${enc(target(a.id, ctx))}`, { title: a.title })) as Task),
  }),
  defineAction({
    name: 'task.stop',
    title: '停止一个对话',
    description: `${ONLY_ASKED}停止一个对话，和用户点停止按钮一样：它附属的子对话、子任务、后台命令、待回复的提问一起停。不能停你自己和你的父对话。`,
    level: 'danger',
    input: z.object({
      id: z.string().trim().min(1),
      force: z.boolean().default(false).describe('连等下一句的 CLI 进程一起结束'),
    }),
    run: async (a, ctx) => {
      notSelf(a.id, ctx, '停止')
      return brief((await ctx.api('POST', `/tasks/${enc(a.id)}/stop${a.force ? '?force=1' : ''}`)) as Task)
    },
  }),
  defineAction({
    name: 'task.stop_children',
    title: '停止全部子对话',
    description: `${ONLY_ASKED}停止一个对话名下的全部子对话（默认你自己的）：执行中的停下，输出和状态保留；它们的后台命令一起停。`,
    level: 'danger',
    input: z.object({ id: ID }),
    run: async (a, ctx) => ctx.api('POST', `/tasks/${enc(target(a.id, ctx))}/children/stop`),
  }),
  defineAction({
    name: 'task.stop_subtasks',
    title: '终止全部子任务',
    description: `${ONLY_ASKED}终止一个对话派出的全部子任务（默认你自己的）：还在跑的结束，排队的不再开始，按「已终止」交回。`,
    level: 'danger',
    input: z.object({ id: ID }),
    run: async (a, ctx) => ctx.api('POST', `/tasks/${enc(target(a.id, ctx))}/subtasks/stop`, { all: true }),
  }),
  defineAction({
    name: 'task.stop_background',
    title: '停止全部后台命令',
    description: `${ONLY_ASKED}停止一个对话和它子对话的全部后台命令（默认你自己的），排队的不再执行；对话本身不停。`,
    level: 'danger',
    input: z.object({ id: ID }),
    run: async (a, ctx) => ctx.api('POST', `/tasks/${enc(target(a.id, ctx))}/background/stop`),
  }),
  defineAction({
    name: 'task.delete',
    title: '删除对话',
    description: `${ONLY_ASKED}删除一个对话，连同它的子对话、独立分支和附件，不能恢复。不能删你自己和你的父对话。`,
    level: 'danger',
    input: z.object({ id: z.string().trim().min(1) }),
    run: async (a, ctx) => {
      notSelf(a.id, ctx, '删除')
      await ctx.api('DELETE', `/tasks/${enc(a.id)}`)
      return { deleted: a.id }
    },
  }),
]
