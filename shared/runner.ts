/**
 * 任务执行。目前是「模拟执行」：按工作流步骤生成示例输出，用来把任务页面的交互跑通。
 * 本机服务和在线演示共用这份逻辑；之后接入真实 CLI 时，只需要替换 runTurn 的实现。
 */
import type { Agent, FileChange, NewTaskInput, Task, TaskData, TaskMessage, TaskStep, ToolUse, Workflow } from './schema.ts'

export interface RunContext {
  task: Task
  agents: Agent[]
  workflow?: Workflow
  /** 本轮的用户输入 */
  prompt: string
  /** 是否是任务的第一轮 */
  first: boolean
  sleep: (ms: number) => Promise<void>
  stopped: () => boolean
  /** task 被原地修改后调用；flush 表示到了值得落盘的节点 */
  changed: (flush?: boolean) => void
  newId: () => string
}

const strip = (s: string) => s.replace(/^\d+\s*[.、．]\s*/, '').replace(/@\S+/g, '').trim()

/** 从工作流文档的二级标题里拆出步骤；文档没写步骤时按团队生成默认步骤 */
export function planSteps(workflow: Workflow | undefined, agents: Agent[]): TaskStep[] {
  if (!workflow) return []
  const byId = new Map(agents.map((a) => [a.id, a]))
  const team = [workflow.mainAgentId, ...workflow.members.map((m) => m.agentId)]
    .map((id) => byId.get(id))
    .filter(Boolean) as Agent[]
  const main = workflow.mainAgentId
  const headings = [...workflow.document.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim())
  if (headings.length)
    return headings.map((h) => {
      const who = team.find((a) => h.includes(`@${a.name}`))
      return { title: strip(h) || h, agentId: who?.id ?? main, status: 'pending' }
    })
  return [
    { title: '分析需求、拆分任务', agentId: main, status: 'pending' },
    ...workflow.members.map((m) => ({
      title: m.responsibility || byId.get(m.agentId)?.description || byId.get(m.agentId)?.name || '执行',
      agentId: m.agentId,
      status: 'pending' as const,
    })),
    { title: '验收', agentId: main, status: 'pending' },
  ]
}

export function taskTitle(prompt: string) {
  const line = prompt.trim().split('\n')[0]
  return line.length > 32 ? line.slice(0, 32) + '…' : line
}

/** 新建任务的初始数据 */
export function newTask(input: NewTaskInput, workflow: Workflow | undefined, agents: Agent[], now: string, id: string): TaskData {
  return {
    projectId: input.projectId,
    title: taskTitle(input.prompt),
    mode: input.mode,
    workflowId: input.mode === 'workflow' ? (workflow?.id ?? '') : '',
    agentId: input.mode === 'chat' ? input.agentId : '',
    status: 'running',
    steps: input.mode === 'workflow' ? planSteps(workflow, agents) : [],
    messages: [{ id, role: 'user', agentId: '', step: -1, text: input.prompt.trim(), tools: [], at: now }],
    changes: [],
    simulated: true,
    sessions: {},
    usage: { agents: {}, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    baseline: {},
  }
}

// ---- 模拟输出 ----

type Kind = 'plan' | 'backend' | 'frontend' | 'test' | 'review' | 'other'
function kindOf(title: string): Kind {
  if (/分析|拆分|需求|规划|设计|定位/.test(title)) return 'plan'
  if (/接口|API|后端|数据|服务/i.test(title)) return 'backend'
  if (/页面|前端|交互|界面|UI|样式/i.test(title)) return 'frontend'
  if (/测试|复现|验证/.test(title)) return 'test'
  if (/验收|审查|检查|评审|review/i.test(title)) return 'review'
  return 'other'
}

interface Output {
  tools: ToolUse[]
  changes: FileChange[]
  text: string
}

function stepOutput(step: TaskStep, index: number, task: Task, prompt: string, agents: Agent[]): Output {
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? '未知 Agent'
  const origin = task.messages.find((m) => m.role === 'user')?.text ?? prompt
  const need = origin.length > 60 ? origin.slice(0, 60) + '…' : origin
  switch (kindOf(step.title)) {
    case 'plan': {
      const rest = task.steps.slice(index + 1)
      return {
        tools: [
          { kind: 'read', label: 'README.md', detail: '' },
          { kind: 'search', label: '搜索相关代码', detail: '找到 6 个相关文件' },
        ],
        changes: [],
        text:
          `需求：${need}\n\n已经读过项目结构和相关代码，拆分如下：\n\n` +
          (rest.length
            ? rest.map((s, i) => `${i + 1}. **${s.title}**，交给 @${name(s.agentId)}`).join('\n')
            : '1. 直接实现并自测') +
          `\n\n验收标准：功能可用、已有测试不回归、新增逻辑有测试覆盖。`,
      }
    }
    case 'backend':
      return {
        tools: [
          { kind: 'read', label: 'server/routes/index.ts', detail: '' },
          { kind: 'edit', label: 'server/routes/feature.ts', detail: '+48 -3' },
          { kind: 'edit', label: 'shared/schema.ts', detail: '+12' },
          { kind: 'run', label: 'npm run typecheck', detail: '通过' },
        ],
        changes: [
          { path: 'server/routes/feature.ts', add: 48, del: 3 },
          { path: 'shared/schema.ts', add: 12, del: 0 },
        ],
        text: '接口已经实现：新增路由并在 `shared/schema.ts` 里补了入参校验，非法参数会返回 400 和具体原因。类型检查通过。',
      }
    case 'frontend':
      return {
        tools: [
          { kind: 'read', label: 'web/src/pages/Detail.tsx', detail: '' },
          { kind: 'edit', label: 'web/src/components/FeatureButton.tsx', detail: '+86' },
          { kind: 'edit', label: 'web/src/pages/Detail.tsx', detail: '+14 -2' },
        ],
        changes: [
          { path: 'web/src/components/FeatureButton.tsx', add: 86, del: 0 },
          { path: 'web/src/pages/Detail.tsx', add: 14, del: 2 },
        ],
        text: '页面已对接上一步的接口：新增按钮组件，处理了加载中、成功和失败三种状态，移动端宽度下也检查过布局。',
      }
    case 'test':
      return {
        tools: [
          { kind: 'edit', label: 'tests/feature.test.ts', detail: '+40' },
          { kind: 'run', label: 'npm test', detail: '24 passed' },
        ],
        changes: [{ path: 'tests/feature.test.ts', add: 40, del: 0 }],
        text: '补了 5 个测试用例，覆盖正常提交、重复提交和参数错误。全部 24 个测试通过。',
      }
    case 'review':
      return {
        tools: [{ kind: 'run', label: 'git diff --stat', detail: `${task.changes.length} 个文件` }],
        changes: [],
        text: '逐条对照验收标准检查：\n\n- 功能可用 ✓\n- 已有测试没有回归 ✓\n- 新增逻辑有测试覆盖 ✓\n\n可以交付。',
      }
    default:
      return {
        tools: [
          { kind: 'read', label: 'src/index.ts', detail: '' },
          { kind: 'edit', label: 'src/index.ts', detail: '+20 -4' },
        ],
        changes: [{ path: 'src/index.ts', add: 20, del: 4 }],
        text: `「${step.title}」已完成。`,
      }
  }
}

function mergeChanges(into: FileChange[], add: FileChange[]) {
  for (const c of add) {
    const old = into.find((x) => x.path === c.path)
    if (old) {
      old.add += c.add
      old.del += c.del
    } else into.push({ ...c })
  }
}

/** 一条 Agent 消息：先逐个出现工具调用，再逐段输出文字 */
async function speak(ctx: RunContext, agentId: string, step: number, out: Output) {
  const msg: TaskMessage = { id: ctx.newId(), role: 'agent', agentId, step, text: '', tools: [], at: new Date().toISOString() }
  ctx.task.messages.push(msg)
  ctx.changed()
  for (const t of out.tools) {
    await ctx.sleep(450)
    if (ctx.stopped()) return false
    msg.tools.push(t)
    ctx.changed()
  }
  mergeChanges(ctx.task.changes, out.changes)
  for (let i = 0; i < out.text.length; i += 6) {
    await ctx.sleep(35)
    if (ctx.stopped()) return false
    msg.text = out.text.slice(0, i + 6)
    ctx.changed()
  }
  ctx.changed(true)
  return true
}

function system(ctx: RunContext, text: string) {
  ctx.task.messages.push({ id: ctx.newId(), role: 'system', agentId: '', step: -1, text, tools: [], at: new Date().toISOString() })
}

/** 执行一轮：第一轮按步骤跑完整个工作流；之后的追问由主 Agent（或对话的 Agent）回答 */
export async function runTurn(ctx: RunContext) {
  const { task } = ctx
  task.status = 'running'
  if (ctx.first) system(ctx, '模拟执行：还没有真正调用 CLI，下面是示例输出，用来预览任务的执行过程。')
  ctx.changed(true)

  if (task.mode === 'workflow' && task.steps.some((s) => s.status !== 'done')) {
    // 工作流还没跑完（第一轮，或上次被停止）：从没完成的步骤继续
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i]
      if (step.status === 'done') continue
      step.status = 'running'
      ctx.changed(true)
      await ctx.sleep(300)
      const ok = !ctx.stopped() && (await speak(ctx, step.agentId, i, stepOutput(step, i, task, ctx.prompt, ctx.agents)))
      if (!ok) return finishStopped(ctx)
      step.status = 'done'
      ctx.changed(true)
    }
  } else {
    const who = task.mode === 'chat' ? task.agentId : (ctx.workflow?.mainAgentId ?? task.steps[0]?.agentId ?? '')
    const need = ctx.prompt.length > 80 ? ctx.prompt.slice(0, 80) + '…' : ctx.prompt
    const last = [...task.changes].reverse().find((c) => !/test/.test(c.path))?.path ?? task.changes.at(-1)?.path
    const out: Output = ctx.first
      ? {
          tools: [
            { kind: 'search', label: '搜索相关代码', detail: '找到 4 个相关文件' },
            { kind: 'read', label: 'src/store/cart.ts', detail: '' },
          ],
          changes: [],
          text: `关于「${need}」：\n\n我先看了相关代码。真实执行时，这里会是 Agent 基于项目代码给出的完整回答；你可以在下面继续追问，或者让它直接动手修改。`,
        }
      : {
          tools: [{ kind: 'edit', label: last ?? 'src/index.ts', detail: '+6 -4' }],
          changes: [{ path: last ?? 'src/index.ts', add: 6, del: 4 }],
          text: `收到：「${need}」\n\n已经按要求调整，改动在 \`${last ?? 'src/index.ts'}\`。还有需要修改的地方可以继续说。`,
        }
    await ctx.sleep(300)
    if (ctx.stopped() || !(await speak(ctx, who, -1, out))) return finishStopped(ctx)
  }
  task.status = 'done'
  ctx.changed(true)
}

function finishStopped(ctx: RunContext) {
  for (const s of ctx.task.steps) if (s.status === 'running') s.status = 'pending'
  system(ctx, '已停止。可以在下面输入新的要求继续。')
  ctx.task.status = 'stopped'
  ctx.changed(true)
}
