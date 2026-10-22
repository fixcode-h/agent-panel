/**
 * 在线演示版的「AI 创建」：没有本机 CLI，按描述里的关键词拼一个示例结果，
 * 再走和真实版相同的校验（resolveProposal），让界面流程完整可用。
 */
import {
  agentToDraft,
  resolveProposal,
  workflowToDraft,
  type AgentDraft,
  type AssistContext,
  type AssistInput,
  type AssistJob,
  type WorkflowDraft,
} from '@shared/assist'
import type { Agent, TaskMessage } from '@shared/schema'

const ROLES: { re: RegExp; name: string; icon: string; desc: string; duty: string }[] = [
  {
    re: /测试|test|qa/i,
    name: '测试工程师',
    icon: 'test',
    desc: '编写并运行单元测试与端到端测试',
    duty: '为改动补充测试并运行，失败时给出日志和复现步骤',
  },
  {
    re: /审查|review|评审/i,
    name: '代码审查',
    icon: 'shield',
    desc: '检查改动的正确性、安全性与风格',
    duty: '逐个文件审查改动，列出必须修改和建议修改的问题',
  },
  {
    re: /前端|页面|react|vue|ui/i,
    name: '前端开发',
    icon: 'layout',
    desc: '实现页面与交互，保证视觉还原',
    duty: '实现页面和交互，处理加载、空状态和错误状态，适配移动端',
  },
  {
    re: /后端|接口|api|数据库|服务/i,
    name: '后端开发',
    icon: 'database',
    desc: '实现接口、数据层与校验',
    duty: '实现接口和数据层，补充参数校验和错误处理',
  },
  {
    re: /文档|readme|说明/i,
    name: '文档助手',
    icon: 'doc',
    desc: '整理 README、变更说明和接口文档',
    duty: '根据改动更新 README 和变更说明，保持示例可运行',
  },
  {
    re: /部署|运维|ci|发布|docker/i,
    name: '运维工程师',
    icon: 'wrench',
    desc: '维护构建、部署和 CI 配置',
    duty: '维护构建脚本和 CI 配置，保证部署可重复',
  },
  {
    re: /设计|视觉|交互稿/i,
    name: '设计助手',
    icon: 'palette',
    desc: '梳理界面结构和视觉规范',
    duty: '给出页面结构、组件和视觉规范，标注交互细节',
  },
  {
    re: /调研|研究|分析/i,
    name: '调研助手',
    icon: 'search',
    desc: '调研方案并给出对比和建议',
    duty: '调研可选方案，列出优缺点和推荐理由',
  },
]

const unique = (name: string, taken: string[]) => {
  if (!taken.includes(name)) return name
  for (let i = 2; ; i++) if (!taken.includes(`${name} ${i}`)) return `${name} ${i}`
}

function agentDraft(text: string, ctx: AssistContext): { draft: AgentDraft; note: string } {
  const target = ctx.target as Agent | undefined
  if (target) {
    const d = agentToDraft(target, ctx.categories)
    return {
      draft: {
        ...d,
        instructions: `${d.instructions.trim() ? d.instructions.trim() + '\n\n' : ''}## 补充要求\n- ${text.trim().replace(/\n+/g, '\n- ')}`,
      },
      note: `我保留了「${d.name}」原有的设定，把你的要求整理成「补充要求」一节加进角色设定。`,
    }
  }
  const role = ROLES.find((r) => r.re.test(text))
  const name = unique(
    role?.name ?? '通用助手',
    ctx.agents.map((a) => a.name),
  )
  const cat = ctx.categories.find((c) =>
    (role?.icon === 'test' || role?.icon === 'shield' ? /测试|质量/ : /开发/).test(c.name),
  )
  return {
    draft: {
      name,
      description: role?.desc ?? '按需求完成通用的开发任务',
      cli: '',
      model: role?.icon === 'doc' ? '@low' : '@medium',
      icon: role?.icon ?? 'bot',
      category: cat?.name ?? '',
      instructions: `## 职责\n${role?.duty ?? '按需求完成开发任务'}。\n\n## 用户的要求\n${text.trim()}\n\n## 工作方式\n- 先阅读相关代码，再动手修改\n- 只改和任务相关的文件\n\n## 交付标准\n- 说明改了哪些文件、为什么这样改\n- 有测试的项目运行测试并附上结果`,
    },
    note: `按你的描述设计了「${name}」，${role ? `职责是${role.desc}` : '是一个通用助手'}。`,
  }
}

type DraftFlow = WorkflowDraft['flows'][number]
type DraftNode = DraftFlow['nodes'][number]
const dn = (
  key: string,
  title: string,
  agent: string,
  instructions: string,
  o: Partial<DraftNode> = {},
): DraftNode => ({
  key,
  title,
  agent,
  flow: '',
  instructions,
  start: '',
  review: '',
  end: '',
  maxRounds: 3,
  confirm: false,
  steps: [],
  ...o,
})
const reviewFlow = (agent: string): DraftFlow => ({
  name: '代码审查',
  main: false,
  description: '检查改动的正确性、可读性和测试覆盖，给出通过或不通过',
  nodes: [dn('check', '审查改动', agent, '逐个查看改动的文件，列出必须修改的问题。')],
  edges: [
    ['start', 'check'],
    ['check', 'end'],
  ],
})

function workflowDraft(text: string, ctx: AssistContext): { draft: WorkflowDraft; note: string } {
  if (ctx.target) {
    const d = workflowToDraft(ctx.target as never, ctx.agents, ctx.workflows)
    const reviewer = ctx.agents.find((a) => /审查/.test(a.name))
    const wantsReview = /审查|review/i.test(text)
    const main = d.flows.find((f) => f.main) ?? d.flows[0]
    if (wantsReview) {
      const has = d.flows.some((f) => f.name === '代码审查')
      const targets = main.nodes.filter((n) => n.agent && !/测试/.test(n.agent))
      const pick = targets.length ? targets : main.nodes.slice(0, -1)
      const flows = [
        ...d.flows.map((f) =>
          f === main
            ? { ...f, nodes: f.nodes.map((n) => (pick.includes(n) ? { ...n, review: '代码审查', maxRounds: 2 } : n)) }
            : f,
        ),
        ...(has ? [] : [reviewFlow(reviewer?.name ?? '')]),
      ]
      return {
        draft: {
          ...d,
          members:
            reviewer && !d.members.some((m) => m.agent === reviewer.name) && reviewer.name !== d.mainAgent
              ? [...d.members, { agent: reviewer.name, responsibility: '代码审查' }]
              : d.members,
          flows,
        },
        note: `加了「代码审查」子流程，挂在${pick.map((n) => `「${n.title}」`).join('、')}的验收上：审查不通过会把意见交回节点修改，最多 2 轮。`,
      }
    }
    const last = main.nodes.at(-1)
    return {
      draft: {
        ...d,
        flows: d.flows.map((f) =>
          f === main
            ? {
                ...f,
                nodes: f.nodes.map((n) =>
                  n === last ? { ...n, instructions: `${n.instructions}\n\n另外：${text.trim()}`.trim() } : n,
                ),
              }
            : f,
        ),
      },
      note: last ? `把你的要求加进了「${last.title}」节点的说明。` : '流程里还没有节点，没有改动。',
    }
  }
  const enabled = ctx.agents.filter((a) => a.enabled)
  const main = enabled.find((a) => a.icon === 'brain' || /架构|主/.test(a.name)) ?? enabled[0]
  const others = enabled.filter((a) => a !== main)
  const builders = others.filter((a) => !/test|shield|doc/.test(a.icon)).slice(0, 3)
  const testers = others.filter((a) => a.icon === 'test').slice(0, 1)
  const bug = /bug|修复|缺陷|问题/i.test(text)
  const name = unique(
    bug ? 'Bug 修复流程' : '功能开发流程',
    ctx.workflows.map((w) => w.name),
  )
  const newAgents: AgentDraft[] = []
  if (!main) {
    newAgents.push({
      name: '架构师',
      description: '拆分任务并验收',
      cli: 'claude',
      model: 'claude-opus-5-5',
      icon: 'brain',
      category: '',
      instructions: '## 职责\n分析需求、拆分任务、验收结果。',
    })
  }
  const mainName = main?.name ?? '架构师'
  const build = builders.length
    ? builders.map((a, i) =>
        dn(
          `b${i}`,
          a.description.split('，')[0] || a.name,
          a.name,
          `负责${a.description || '自己擅长的部分'}，只改自己负责的文件。`,
          {
            review: '代码审查',
          },
        ),
      )
    : [dn('b0', '实现', '', '按分析阶段的结论完成改动。', { review: '代码审查' })]
  const test = testers.map((a) => dn('test', '运行测试', a.name, '补充并运行测试，失败时附上日志。'))
  const nodes = [
    dn('plan', bug ? '复现并定位问题' : '分析需求、拆分任务', '', '阅读需求和相关代码，写出分工和验收标准。'),
    ...build,
    ...test,
    dn('check', '验收', '', '逐条对照验收标准检查结果。'),
  ]
  const after = test.length ? 'test' : 'check'
  const edges: [string, string][] = [
    ['start', 'plan'],
    ...build.flatMap((b): [string, string][] => [
      ['plan', b.key],
      [b.key, after],
    ]),
    ...(test.length ? ([['test', 'check']] as [string, string][]) : []),
    ['check', 'end'],
  ]
  return {
    draft: {
      name,
      description: (bug ? '复现、修复并回归验证缺陷：' : '按需求开发：') + text.trim().slice(0, 40),
      mainAgent: mainName,
      members: [...builders, ...testers].map((a) => ({ agent: a.name, responsibility: a.description })),
      newAgents,
      flows: [{ name: '主流程', main: true, description: '', nodes, edges }, reviewFlow('')],
      document: `# 目标\n${text.trim()}\n\n# 规范\n- 只改和任务相关的文件\n- 改动后运行已有测试\n\n# 完成标准\n- 验收标准逐条满足\n- 测试全部通过\n`,
    },
    note: `设计了「${name}」：${mainName} 先分析，${builders.length > 1 ? `${builders.map((a) => a.name).join('、')} 同时开发` : '然后实现'}，每个开发节点完成后走「代码审查」子流程验收${testers.length ? '，再测试' : ''}，最后验收。`,
  }
}

const jobs = new Map<string, AssistJob>()

/** Skill：按描述写一份示例；优化时在原文后面补一段 */
function skillDraft(text: string, ctx: AssistContext) {
  const sub = ctx.subject ?? {}
  if (sub.content)
    return {
      draft: { name: sub.name, content: `${sub.content.trimEnd()}\n\n## 补充\n- ${text.trim()}\n` },
      note: '把你的要求补进了 Skill 的末尾。',
    }
  const name = /提交|commit/i.test(text)
    ? 'commit-message'
    : /审查|review/i.test(text)
      ? 'code-review'
      : /文档|方案/.test(text)
        ? 'design-doc'
        : 'my-skill'
  return {
    draft: {
      name,
      content: `---\nname: ${name}\ndescription: ${text.trim().slice(0, 60)}。在用户提出相关要求时使用。\n---\n\n# ${name}\n\n1. 先了解相关的代码和背景。\n2. 按要求完成，并说明做了什么。\n3. 拿不准的地方先问用户。\n`,
    },
    note: `按你的描述写了 Skill「${name}」。`,
  }
}

/** MCP 工具排查：npx 缺 -y 的补上；其余不改，只说明要自己检查什么 */
function mcpDraft(_text: string, ctx: AssistContext) {
  const sv = JSON.parse(ctx.subject?.server ?? '{}')
  if (sv.command === 'npx' && !(sv.args ?? []).includes('-y'))
    return {
      draft: { ...sv, args: ['-y', ...(sv.args ?? [])] },
      note: 'npx 第一次运行要确认安装，没有 -y 会一直等待。给参数加上了 -y。',
    }
  return { draft: sv, note: '检查了命令和地址的格式，没有发现能确定的问题；请确认命令在 PATH 里、需要的密钥已经填写。' }
}

/** 全局教训提取：演示里把「所有改动都适用」、又不带项目文件名的条目当作通用的 */
function lessonsDraft(_text: string, ctx: AssistContext) {
  const own = (ctx.projectLessons ?? []).filter((l) => l.enabled && !l.paths.length && !/src\/|\.ts\b/.test(l.rule))
  const globals = ctx.globalLessons ?? []
  const changes = own
    .filter((l) => !globals.some((g) => g.title === l.title))
    .map((l) => ({ op: 'add', id: '', title: l.title, rule: l.rule, cause: l.cause, paths: [], sources: [l.id] }))
  return {
    draft: { changes },
    note: changes.length
      ? `从 ${ctx.projectLessons?.length ?? 0} 条项目教训里挑出 ${changes.length} 条换个项目也适用的；按文件生效、或写着这个项目的文件和字段的没有提。`
      : '这个项目的教训都和它自己的文件、业务有关，没有适合提成全局教训的。',
  }
}

export function startDemoAssist(input: AssistInput, ctx: AssistContext): AssistJob {
  const text = [...input.messages].reverse().find((m) => m.role === 'user')?.text ?? ''
  const job: AssistJob = {
    id: crypto.randomUUID(),
    kind: input.kind,
    targetId: input.targetId,
    status: 'running',
    text: '',
    attempt: 1,
    startedAt: Date.now(),
  }
  jobs.set(job.id, job)
  const gen =
    input.kind === 'agent'
      ? agentDraft(text, ctx)
      : input.kind === 'skill'
        ? skillDraft(text, ctx)
        : input.kind === 'mcp'
          ? mcpDraft(text, ctx)
          : input.kind === 'lessons'
            ? lessonsDraft(text, ctx)
            : workflowDraft(text, ctx)
  const full = `（在线演示：没有调用真实 CLI，下面是按关键词生成的示例。）\n\n${gen.note}`
  // 先演示一段「思考」，再逐字输出说明，最后是 JSON
  const think = `用户想要：${text.slice(0, 40)}。先看看现有的 Agent 和分类，确定需要哪些角色、谁先谁后、哪里需要验收…`
  // 消息流和真实 CLI 一样：一段思考 + 一次读取工具，然后是说明文字
  const at = new Date().toISOString()
  const tool = {
    kind: 'read' as const,
    label: '读取现有的 Agent 和分类',
    detail: '',
    input: 'agents.json · categories.json',
    output: ctx.agents.map((a) => `- ${a.name}`).join('\n') || '（还没有 Agent）',
  }
  const msg = (id: string, o: Partial<TaskMessage>): TaskMessage => ({
    id,
    role: 'agent',
    agentId: '',
    step: '',
    text: '',
    tools: [],
    at,
    ...o,
  })
  let i = 0
  let k = 0
  const tick = () => {
    if (job.status !== 'running') return
    if (k < think.length) {
      k += 3
      job.thinking = think.slice(0, k)
      job.messages = [msg('m1', { thinking: job.thinking })]
      return void setTimeout(tick, 30)
    }
    i += 4
    job.text = full.slice(0, i)
    job.outChars = i
    job.messages = [msg('m1', { thinking: think, tools: [tool] }), msg('m2', { text: job.text })]
    if (i < full.length) return void setTimeout(tick, 30)
    const r = resolveProposal(input.kind, gen.draft, ctx)
    if (r.proposal) {
      job.proposal = r.proposal
      job.raw = JSON.stringify(gen.draft, null, 2)
      job.status = 'done'
    } else {
      job.status = 'failed'
      job.error = r.error
    }
  }
  setTimeout(tick, 400)
  return job
}

export const demoAssistJob = (id: string) => jobs.get(id)

export function stopDemoAssist(id: string) {
  const j = jobs.get(id)
  if (j && j.status === 'running') {
    j.status = 'failed'
    j.error = '已停止'
  }
  return j
}
