/**
 * 模拟执行：按工作流节点生成示例输出，不调用 CLI。
 * 只给在线演示用，正式版不会打包进去。真实执行见 server/exec/runner.ts。
 */
import type {
  Agent,
  FileChange,
  NewTaskInput,
  Task,
  TaskData,
  TaskMessage,
  TaskStep,
  ToolUse,
  Workflow,
} from './schema.ts'
import { runEngineTurn, system, type AgentCall, type AgentResult } from './engine.ts'

export interface RunContext {
  task: Task
  agents: Agent[]
  workflows: Workflow[]
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

function stepOutput(step: TaskStep, task: Task, prompt: string, agents: Agent[], reviewing: boolean): Output {
  if (reviewing) return reviewOutput(step)
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? '未知 Agent'
  const origin = task.messages.find((m) => m.role === 'user')?.text ?? prompt
  const need = origin.length > 60 ? origin.slice(0, 60) + '…' : origin
  switch (kindOf(step.title)) {
    case 'plan': {
      const rest = task.steps.filter((s) => s.parentId === step.parentId && s.id !== step.id && s.status === 'pending')
      return {
        tools: [
          { kind: 'read', label: 'README.md', detail: '' },
          {
            kind: 'search',
            label: '搜索相关代码',
            detail: '找到 6 个相关文件',
            input: 'rg -l "feature" --type ts',
            output:
              'server/routes/index.ts\nserver/routes/feature.ts\nshared/schema.ts\nweb/src/pages/Detail.tsx\nweb/src/lib/api.ts\ntests/feature.test.ts',
          },
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
          {
            kind: 'edit',
            label: 'shared/schema.ts',
            detail: '+4 -1',
            input:
              '@@ -12,6 +12,9 @@ export const TaskInput = z.object({\n   title: z.string().trim().min(1),\n-  note: z.string().optional(),\n+  note: z.string().max(500).optional(),\n+  /** 新功能的开关 */\n+  feature: z.boolean().default(false),\n+  tags: z.array(z.string()).max(10).default([]),\n })\n \n export type TaskInput = z.infer<typeof TaskInput>',
          },
          {
            kind: 'run',
            label: 'npm run typecheck',
            detail: '通过',
            input: 'npm run typecheck',
            output: '> app@1.0.0 typecheck\n> tsc --noEmit',
          },
        ],
        changes: [
          { path: 'server/routes/feature.ts', add: 48, del: 3 },
          { path: 'shared/schema.ts', add: 4, del: 1 },
        ],
        text: "接口已经实现：新增路由并在 `shared/schema.ts` 里补了入参校验，非法参数会返回 `400` 和具体原因。类型检查通过。\n\n```ts\napp.post('/api/feature', async (c) => {\n  const input = TaskInput.parse(await c.req.json())\n  return c.json(await createFeature(input), 201)\n})\n```\n\n```mermaid\nflowchart LR\n  A[页面] -->|POST /api/feature| B[路由]\n  B --> C{校验}\n  C -->|通过| D[(数据)]\n  C -->|失败| E[400]\n```",
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
          {
            kind: 'run',
            label: 'npm test',
            detail: '24 passed',
            input: 'npm test',
            output:
              ' ✓ tests/schema.test.ts (8)\n ✓ tests/routes.test.ts (11)\n ✓ tests/feature.test.ts (5)\n\n Test Files  3 passed (3)\n      Tests  24 passed (24)\n   Duration  1.82s',
          },
        ],
        changes: [{ path: 'tests/feature.test.ts', add: 40, del: 0 }],
        text: '补了 5 个测试用例，全部 24 个测试通过：\n\n| 用例 | 覆盖的情况 |\n| --- | --- |\n| 正常提交 | 返回 201 和新记录 |\n| 重复提交 | 返回 409 |\n| 参数错误 | 返回 400 和字段说明 |\n\n运行方式：\n\n```bash\nnpm test -- tests/feature.test.ts\n```',
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

/** 模拟验收：第一轮不通过，之后通过，用来演示退回完善的过程 */
function reviewOutput(step: TaskStep): Output {
  const fail = step.round === 1
  return {
    tools: [
      { kind: 'run', label: 'git diff --stat', detail: '3 个文件' },
      { kind: 'run', label: 'npm test', detail: fail ? '1 failed, 23 passed' : '24 passed' },
    ],
    changes: [],
    text: fail
      ? '检查了改动和测试结果：\n\n- 主要功能已实现 ✓\n- 重复提交时没有给出提示 ✗\n- 新增逻辑缺少失败场景的测试 ✗\n\n验收结论：不通过'
      : '复查了上一轮提出的问题：\n\n- 重复提交已有提示 ✓\n- 补上了失败场景的测试 ✓\n\n验收结论：通过',
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

/** 模拟的思考过程，按输出内容挑一句 */
function thoughtFor(out: Output) {
  if (out.tools.some((t) => t.kind === 'edit'))
    return '先读一下相关文件，确认现有的写法和命名，再按同样的风格改。改完跑一遍检查，确认没有影响其他地方。'
  if (/验收结论/.test(out.text)) return '对照验收标准逐条检查：先看改动范围，再跑测试，最后确认有没有遗漏的场景。'
  return '先搞清楚需求和项目结构，找到相关的代码，再决定怎么拆分和回答。'
}

/** 模拟用量：每次调用读一遍上下文（大部分命中缓存），输出按字数估算 */
function fakeUsage(ctx: RunContext, agentId: string, text: string) {
  const u = ctx.task.usage
  const input = 14000 + Math.round(Math.random() * 6000) + ctx.task.messages.length * 400
  const read = Math.round(input * (0.72 + Math.random() * 0.18))
  const out = Math.round(text.length * 0.9) + 120
  u.inputTokens += input
  u.cacheReadTokens = (u.cacheReadTokens ?? 0) + read
  u.cacheWriteTokens = (u.cacheWriteTokens ?? 0) + Math.round((input - read) * 0.6)
  u.outputTokens += out
  const a = agent(ctx, agentId)
  a.context = input + out
  a.outputTokens += out
}

const agent = (ctx: RunContext, id: string) =>
  (ctx.task.usage.agents[id] ??= { context: 0, window: 200_000, model: '', tps: 0, outputTokens: 0, genMs: 0 })

/** 一条 Agent 消息：先思考，再逐个出现工具调用，最后逐段输出文字；输出时显示模拟的速度 */
async function speak(ctx: RunContext, agentId: string, step: string, out: Output) {
  const msg: TaskMessage = {
    id: ctx.newId(),
    role: 'agent',
    agentId,
    step,
    text: '',
    tools: [],
    thinking: '',
    at: new Date().toISOString(),
  }
  ctx.task.messages.push(msg)
  ctx.changed()
  const a = agent(ctx, agentId)
  const stream = async (text: string, put: (s: string) => void) => {
    for (let i = 0; i < text.length; i += 4) {
      await ctx.sleep(40)
      if (ctx.stopped()) return false
      put(text.slice(0, i + 4))
      a.tps = Math.round((38 + Math.random() * 30) * 10) / 10
      a.genMs += 40
      ctx.changed()
    }
    a.tps = 0
    return true
  }
  if (!(await stream(thoughtFor(out), (s) => (msg.thinking = s)))) return false
  for (const t of out.tools) {
    await ctx.sleep(450)
    if (ctx.stopped()) return false
    msg.tools.push(t)
    ctx.changed()
  }
  mergeChanges(ctx.task.changes, out.changes)
  if (!(await stream(out.text, (s) => (msg.text = s)))) return false
  fakeUsage(ctx, agentId, out.text)
  ctx.changed(true)
  return true
}

/** 模拟调用一个 Agent */
async function fakeAgent(ctx: RunContext, call: AgentCall): Promise<AgentResult> {
  const { task } = ctx
  await ctx.sleep(300 + Math.random() * 500)
  if (ctx.stopped()) return { ok: false, stopped: true, error: '已停止' }
  let out: Output
  if (call.step) {
    const fixing = call.prompt.startsWith('验收没有通过')
    out = fixing
      ? {
          tools: [
            { kind: 'edit', label: 'web/src/components/FeatureButton.tsx', detail: '+12 -2' },
            { kind: 'edit', label: 'tests/feature.test.ts', detail: '+18' },
            { kind: 'run', label: 'npm test', detail: '24 passed' },
          ],
          changes: [
            { path: 'web/src/components/FeatureButton.tsx', add: 12, del: 2 },
            { path: 'tests/feature.test.ts', add: 18, del: 0 },
          ],
          text: '按验收意见修改：重复提交时按钮进入禁用状态并提示「正在提交」，补了失败场景的测试，全部测试通过。',
        }
      : stepOutput(call.step, task, ctx.prompt, ctx.agents, !!call.reviewing)
  } else {
    const need = ctx.prompt.length > 80 ? ctx.prompt.slice(0, 80) + '…' : ctx.prompt
    const last = [...task.changes].reverse().find((c) => !/test/.test(c.path))?.path ?? task.changes.at(-1)?.path
    out = ctx.first
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
  }
  // 演示权限请求：对话里提到「安装」时，先请你确认一条命令，确认后才接着输出
  if (!call.step && /安装|install/i.test(ctx.prompt)) {
    const id = ctx.newId()
    ;(task.requests ??= []).push({
      id,
      step: '',
      agentId: call.agentId,
      kind: 'command',
      title: '运行命令：npm install --save dayjs',
      detail: '安装日期处理库（在线演示，不会真的执行）',
      options: [],
      at: new Date().toISOString(),
    })
    ctx.changed(true)
    while (task.requests.some((r) => r.id === id)) {
      if (ctx.stopped()) {
        task.requests = task.requests.filter((r) => r.id !== id)
        return { ok: false, stopped: true, error: '已停止' }
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  if (!call.step && ctx.first)
    task.todos = [
      { text: '搜索相关代码', status: 'done', agentId: call.agentId },
      { text: '阅读实现', status: 'done', agentId: call.agentId },
      { text: '整理回答', status: 'running', agentId: call.agentId },
    ]
  const ok = await speak(ctx, call.agentId, call.step?.id ?? '', out)
  if (ok && !call.step) task.todos = (task.todos ?? []).map((t) => ({ ...t, status: 'done' as const }))
  return ok ? { ok: true, text: out.text } : { ok: false, stopped: true, error: '已停止' }
}

/** 执行一轮（模拟） */
export async function runTurn(ctx: RunContext) {
  const host = {
    task: ctx.task,
    agents: ctx.agents,
    workflows: ctx.workflows,
    workflow: ctx.workflow,
    prompt: ctx.prompt,
    changed: ctx.changed,
    newId: ctx.newId,
    runAgent: (call: AgentCall) => fakeAgent(ctx, call),
  }
  if (ctx.first) system(host, '模拟执行：还没有真正调用 CLI，下面是示例输出，用来预览任务的执行过程。')
  await runEngineTurn(host)
}
