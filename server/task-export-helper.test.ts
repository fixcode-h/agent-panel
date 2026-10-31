/**
 * 子任务范围的 AI 分析（子任务窗口里的「AI 分析」）：报告和提示词都只看那一步，
 * 不传 scope 时和原来的整体分析完全一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, Task } from '../shared/schema.ts'
import { DIAGNOSIS_LANG } from '../shared/diagnosis.ts'
import {
  analysisPrompt,
  analysisReport,
  EVOLUTION_LANG,
  exportTask,
  HELPER_SCOPE_MARK,
  taskReport,
} from '../shared/task-export.ts'

/** 报告里的开始/结束时间写的是本地时刻，期望值必须现算，写死会在别的时区挂 */
const localTime = (iso: string) => {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const at = '2026-10-19T09:00:00.000Z'
const later = '2026-10-19T09:02:00.000Z'
const helperAgent = Agent.parse({
  id: 'a-helper',
  name: '子任务',
  instructions: '你是子任务角色：只完成派给你的那件事，完成后用中文简要总结结果。',
  origin: 'builtin:helper',
  createdAt: at,
  updatedAt: at,
})
const coder = Agent.parse({ id: 'a1', name: '开发', instructions: '写代码', createdAt: at, updatedAt: at })

/** 一个对话派了两个子任务：h1 跑得久且改了文件，h2 还在跑；父对话自己也有消息 */
const task = Task.parse({
  id: 't1',
  projectId: 'p1',
  title: '改造某个功能',
  mode: 'chat',
  status: 'running',
  agentId: coder.id,
  runMs: 600_000,
  steps: [
    {
      id: '@chat/sub/h1',
      parentId: '@chat',
      slot: 'sub',
      title: '查组件',
      agentId: helperAgent.id,
      status: 'done',
      startedAt: at,
      endedAt: later,
      waitMs: 5_000,
      brief: '把角标相关的代码找出来，指出是哪一行没订阅 cart:changed。',
      output: '找到了，问题在 CartBadge.tsx',
      usage: { inputTokens: 2000, cacheReadTokens: 500, outputTokens: 300, costUsd: 0.02 },
      changes: [{ path: 'web/src/CartBadge.tsx', add: 3, del: 1 }],
    },
    {
      id: '@chat/sub/h2',
      parentId: '@chat',
      slot: 'sub',
      title: '补用例',
      agentId: helperAgent.id,
      status: 'running',
      startedAt: later,
      output: '',
      brief: '给角标补单元测试。',
    },
  ],
  messages: [
    { id: 'u1', role: 'user', text: '把角标修一下', at },
    {
      id: 's1',
      role: 'system',
      step: '',
      text: '「改造某个功能」派出 2 个子角色：查组件、补用例',
      spawned: ['@chat/sub/h1', '@chat/sub/h2'],
      at,
    },
    { id: 'm1', role: 'agent', agentId: coder.id, step: '@chat', text: '我派两个子任务去看看', at },
    // h1 自己的过程：先搜代码再读文件
    {
      id: 'h1-a',
      role: 'agent',
      agentId: helperAgent.id,
      step: '@chat/sub/h1',
      text: '先搜一下角标相关的代码',
      at,
      tools: [
        { kind: 'search', label: 'CartBadge', detail: '' },
        { kind: 'read', label: 'web/src/CartBadge.tsx', detail: '' },
      ],
    },
    {
      id: 'h1-b',
      role: 'agent',
      agentId: helperAgent.id,
      step: '@chat/sub/h1',
      text: '找到问题：没有订阅 cart:changed',
      at: later,
    },
    // h2 自己的过程（不该出现在 h1 的报告里）
    { id: 'h2-a', role: 'agent', agentId: helperAgent.id, step: '@chat/sub/h2', text: '写用例中', at: later },
  ],
  usage: { inputTokens: 3000, outputTokens: 400, cacheReadTokens: 600, costUsd: 0.03 },
  createdAt: at,
  updatedAt: later,
})

// 导出这一刻固定在 later：还在跑的子任务会按这一刻收尾（见 exportedBody），统计才不会跟着真实时间涨
const bundle = exportTask(task, [helperAgent, coder], '', new Date(later))

test('子任务报告：只带这一步的过程，父对话和兄弟子任务的消息不进来', () => {
  const md = taskReport(bundle, 4000, { stepId: '@chat/sub/h1' })
  assert.match(md, /^# 子任务记录：查组件（@chat\/sub\/h1）/)
  assert.match(md, /先搜一下角标相关的代码/)
  assert.match(md, /找到问题：没有订阅 cart:changed/)
  assert.ok(!md.includes('把我派两个子任务去看看'), '父对话自己的消息不该进子任务报告')
  assert.ok(!md.includes('写用例中'), '兄弟子任务的过程不该进子任务报告')
  assert.ok(!md.includes('把角标修一下'), '用户的要求不在这一步的过程里')
})

test('子任务报告：耗时、等待、用量、角色设定、派它的要求和交回的结果都在', () => {
  const md = taskReport(bundle, 4000, { stepId: '@chat/sub/h1' })
  assert.match(md, /耗时 2m 0s/)
  assert.match(md, /其中等用户确认\/提问 5s/)
  assert.match(md, /输入 2\.0k（缓存命中 500，25%）/)
  assert.match(md, /派给它的角色：子任务（agent id: a-helper）/)
  assert.match(md, /只完成派给你的那件事/, '角色设定原文要带上，才能判断有没有跑偏')
  assert.match(md, /## 派给它的要求（原文）/)
  assert.match(md, /把角标相关的代码找出来/, '要求原文要带上，不能拿标题列表冒充')
  assert.ok(!md.includes('没有派它时的要求原文'), '有原文时不该写兜底说明')
  assert.match(md, /## 它交回的结果[\s\S]*找到了，问题在 CartBadge\.tsx/)
  assert.match(md, /它改过的文件[\s\S]*web\/src\/CartBadge\.tsx \+3 -1/)
  assert.match(md, /同一批一起派出的兄弟子任务 1 个：.*补用例/)
})

test('子任务报告：角色设定是拼好的实际生效内容，引入的 Agent（通用约束）也在里面', () => {
  // 内置角色引入「通用约束」：只输出 instructions 字段的话，判断角色符合度时看不到那一整段要求
  const rules = Agent.parse({
    id: 'rules',
    name: '通用约束',
    instructions: '## 执行纪律\n每次改动都要有新鲜的验证证据。',
    createdAt: at,
    updatedAt: at,
  })
  const helper = Agent.parse({ ...helperAgent, includes: ['rules'] })
  const rec = Task.parse({
    ...task,
    steps: [{ ...task.steps[0], agentId: helper.id }],
  })
  const md = taskReport(exportTask(rec, [helper, rules, coder], '', new Date(later)), 4000, {
    stepId: '@chat/sub/h1',
  })
  assert.match(md, /角色设定（拼好的实际生效内容）：/)
  assert.match(md, /每次改动都要有新鲜的验证证据/, '引入的角色设定也要在报告里')
  assert.match(md, /## 引入的 Agent：通用约束/, '写清哪一段是引入的')
})

test('子任务报告：Skill 槽要透传，写 {{槽名}} 的 Skill 不能被漏掉', () => {
  // 实际执行是 composeRole(agent, agents, …, task.skillSlots)：不传槽位，{ skills: ['docs'] } 这种
  // 写 {{槽名}} 的 Skill 会被 fillSkills 过滤掉，报告里的 Skill 清单比 CLI 实际拿到的少
  const slotted = Agent.parse({ ...helperAgent, skills: ['{{docs}}'] })
  const rec = Task.parse({ ...task, skillSlots: { docs: 'project-documentation' } })
  const md = taskReport(exportTask(rec, [slotted, coder], '', new Date(later)), 4000, {
    stepId: '@chat/sub/h1',
  })
  assert.match(md, /project-documentation/, '按槽位换好的 Skill 名要出现在角色设定里')
  // 报告头「Skill：…」也要过 fillSkills：直接 join 原始 skills 会和角色设定里的清单不一致
  assert.match(md, /Skill：project-documentation/, '报告头的 Skill 清单同样按槽位换好')
  assert.ok(!md.includes('{{docs}}'), '报告头不能出现没换的槽位原文')
  // 引入的 Agent 带的技能也算：composeRole 拼角色设定时算了引入 Agent 的技能，报告头少列就还是两处对不上
  const common = Agent.parse({
    id: 'a-common',
    name: '通用约束',
    instructions: '约束',
    skills: ['coding-standards'],
    createdAt: at,
    updatedAt: at,
  })
  const withIncludes = Agent.parse({
    ...helperAgent,
    skills: ['project-documentation'],
    includes: [common.id],
  })
  const md2 = taskReport(
    exportTask(
      Task.parse({ ...rec, steps: [{ ...rec.steps[0], agentId: withIncludes.id }] }),
      [withIncludes, common, coder],
      '',
      new Date(later),
    ),
    4000,
    { stepId: '@chat/sub/h1' },
  )
  assert.match(md2, /Skill：project-documentation、coding-standards/, '引入 Agent 的技能也要出现在报告头')
})

test('子任务报告：没有要求原文时两种原因都写出来，不拿标题列表冒充要求', () => {
  // brief 为空既可能是旧记录没保存，也可能是派它时只写了标题（spawn_agents 允许只给 title）
  const rec = Task.parse({ ...task, steps: task.steps.map((s) => ({ ...s, brief: '' })) })
  const md = taskReport(exportTask(rec, [helperAgent, coder], '', new Date(later)), 4000, {
    stepId: '@chat/sub/h1',
  })
  assert.match(md, /旧记录没有保存/, '旧记录没保存要说')
  assert.match(md, /本来就只写了标题没写要求/, '派它时没写要求也要说，不能一律说成旧记录')
  assert.match(md, /不是发给它的要求/, '要写清下面那段标题列表不是要求')
  assert.ok(!md.includes('## 派给它的要求（原文）'), '没有原文时不该有原文小节')
})

test('子任务报告：演示版旧数据里没有 brief 字段时不报错（演示版任务不过 schema）', () => {
  // 演示版从 localStorage 读的旧任务没有 brief，直接 step.brief.trim() 会抛 TypeError，
  // 用户点「AI 分析」只看到一句 JS 报错。这里把字段整个删掉、再把任何运行期补默认值的入口堵住
  const b = exportTask(task, [helperAgent, coder], '', new Date(later))
  const raw = JSON.parse(JSON.stringify(b)) as typeof b
  delete (raw.task.steps[0] as { brief?: string }).brief
  const md = taskReport(raw, 4000, { stepId: '@chat/sub/h1' })
  assert.match(md, /子任务记录：查组件/)
  assert.doesNotThrow(() => analysisPrompt([raw], '', { stepId: '@chat/sub/h1' }))
})

test('子任务报告：还在跑的那一步也出得来，并写明是快照', () => {
  const md = taskReport(bundle, 4000, { stepId: '@chat/sub/h2' })
  assert.match(md, /子任务记录：补用例/)
  // 导出时还在跑的节点会按导出那一刻收尾（exportedBody）。开始时间是本地时刻，按本地时区现算期望值，
  // 写死 17:02 只在东八区成立，CI（TZ=UTC）会挂
  assert.ok(md.includes(`开始：${localTime(later)}`), '报告里的开始时间按本地时刻写')
  assert.match(md, /写用例中/)
  assert.ok(!md.includes('先搜一下角标相关的代码'))
})

test('子任务报告：记录里没有这一步时写清楚，不给一份空报告', () => {
  const md = taskReport(bundle, 4000, { stepId: '@chat/sub/gone' })
  assert.match(md, /找不到这个子任务/)
})

test('子任务提示词：四类问题，带「可能还没跑完」的说明，没有工作流修改块', () => {
  const prompt = analysisPrompt([bundle], '', { stepId: '@chat/sub/h1' })
  assert.match(prompt, /只分析这一个子任务/)
  assert.match(prompt, /1\. 耗时/)
  assert.match(prompt, /2\. 是否符合角色/)
  assert.match(prompt, /3\. 优化空间/)
  assert.match(prompt, /4\. 面板框架/)
  assert.ok(!prompt.includes('workflow-evolution'), '子任务分析不要求写修改建议块')
  assert.ok(!prompt.includes('## 可以修改的对象'), '子任务分析不给工作流修改对象')
  // 已结束的子任务不该加上「可能没跑完」那句
  assert.ok(!prompt.includes('还没有结束（或还在排队）'))
  // 标记只由代码写在开头：演示版假 Agent 靠它认范围，不能靠句子里可能被 focus 注入的某句话
  assert.ok(prompt.startsWith(HELPER_SCOPE_MARK), '子任务提示词要用只有代码能写的标记开头')

  const running = analysisPrompt([bundle], '为什么这么慢', { stepId: '@chat/sub/h2' })
  assert.match(running, /还没有结束（或还在排队）/)
  assert.match(running, /用户的问题：为什么这么慢/)
})

test('写了具体问题：只分析这个问题、找原因，不做整体分析，结论写成排查结论块', () => {
  const helper = analysisPrompt([bundle], '为什么这么慢', { stepId: '@chat/sub/h1' })
  assert.ok(helper.startsWith(HELPER_SCOPE_MARK), '子任务范围的标记照旧在最前面')
  assert.match(helper, /这次只回答这个问题/)
  assert.ok(!helper.includes('2. 是否符合角色'), '不再按四类分析整个子任务')
  assert.ok(helper.includes('```' + DIAGNOSIS_LANG))

  const whole = analysisPrompt([bundle], '  为什么验收不通过  ')
  assert.match(whole, /用户的问题：为什么验收不通过\n/)
  assert.ok(!whole.includes('### 1. 结果质量'), '不再按五类分析整个对话')
  assert.ok(!whole.includes('```' + EVOLUTION_LANG), '不带工作流修改块')
  assert.ok(whole.includes('```' + DIAGNOSIS_LANG))
  assert.ok(!whole.includes(HELPER_SCOPE_MARK))

  // 只写了空白：照旧整体分析
  assert.ok(analysisPrompt([bundle], '   ').includes('```' + EVOLUTION_LANG))
})

test('子任务提示词：整体分析的 focus 里写「派出的一个子任务」也不会被当成子任务范围', () => {
  // 演示版假 Agent 以前认 prompt.includes('派出的一个子任务')：用户在整体分析的 focus 里手写这句话，
  // 回复就被换成子任务四类结论，连 workflow-evolution 块都没了。标记只能由 helperPrompt 写，focus 进不去
  const overall = analysisPrompt([bundle], '帮我看派出的一个子任务为什么慢')
  assert.ok(!overall.includes(HELPER_SCOPE_MARK), '整体分析的提示词里不能有子任务标记')
  assert.ok(overall.includes('```' + DIAGNOSIS_LANG), '写了问题的整体分析按问题出结论块')
})

test('子任务报告：导出时还在跑的任务写明「统计到导出那一刻」，不说成已停止', () => {
  // exportTask 会把 running 收尾成 stopped、在跑的节点收尾成 pending（见 exportedBody）。
  // 直接写这两个状态会和提示词里「记录是快照」矛盾，AI 会报「父任务显示已停止但子任务还在跑」这种假发现
  const running = Task.parse({
    ...task,
    status: 'running',
    steps: task.steps.map((s) => ({ ...s, status: 'running' })),
  })
  const b = exportTask(running, [helperAgent, coder], '', new Date(later))
  const md = taskReport(b, 4000, { stepId: '@chat/sub/h1' })
  assert.match(md, /导出时还在跑/, '父任务状态后面要说明这是快照')
  assert.match(md, /状态：running（导出时就停在这一刻）/, '在跑的节点不能写成 pending（会被读成排队）')
  // 导出时给在跑的节点补了 endedAt，直接写「结束：…」会与同一行的 running 自相矛盾
  assert.match(md, /导出时还没结束/, '在跑的节点不写结束时间，改成导出时还没结束')
  assert.ok(!md.includes('结束：'), '在跑的节点不能出现结束时间')
  const prompt = analysisPrompt([b], '', { stepId: '@chat/sub/h1' })
  assert.match(prompt, /还没有结束（或还在排队）/, '提示词这边本来就说明了是快照')
})

test('子任务报告：被单独停下的节点（父对话还在跑）照旧写真实的结束时间', () => {
  // 引擎停下一个节点时走 pauseStep：status 置 pending、endedAt 写 now、startedAt 清空（shared/task.ts 的 pauseStep）。
  // 这种节点不是「导出时在跑」，不能因为同样是 pending 就被写成「导出时还没结束」而丢掉它何时停下
  const stopped = Task.parse({
    ...task,
    status: 'running',
    steps: [{ ...task.steps[0], status: 'pending', startedAt: '', endedAt: later, spentMs: 120_000 }],
  })
  const md = taskReport(exportTask(stopped, [helperAgent, coder], '', new Date(later)), 4000, {
    stepId: '@chat/sub/h1',
  })
  assert.match(md, new RegExp(`结束：${localTime(later)}`), '停下过的节点要写真实结束时间')
  assert.ok(!md.includes('导出时还没结束'), '不是导出时在跑的节点不能写这句')
})

test('子任务报告：等待不超过耗时（缺 endedAt 的旧记录不会写出「耗时 0s（其中等用户 3h）」）', () => {
  // docs/lessons/task-export.md：括号里是子集，一律按 min(子集, 主数) 写
  const rec = Task.parse({
    ...task,
    steps: [{ ...task.steps[0], endedAt: '', waitMs: 3 * 3600_000 }],
  })
  const md = taskReport(exportTask(rec, [helperAgent, coder], '', new Date(later)), 4000, { stepId: '@chat/sub/h1' })
  assert.ok(!md.includes('其中等用户确认/提问 3h'), '等待是耗时的子集，不能比耗时大')
})

test('不传 scope 时整体分析的报告和提示词和原来一致', () => {
  const md = analysisReport([bundle])
  assert.match(md, /^# 执行记录：改造某个功能/)
  assert.match(md, /把角标修一下/, '整体分析照旧带用户的要求')
  assert.ok(!md.includes('只是子任务'))
  const prompt = analysisPrompt([bundle])
  assert.match(prompt, /## 可以修改的对象/)
  assert.match(prompt, /workflow-evolution/)
})

test('报告头的 Skill：按当前映射换算，下线的技能换成接替它的，没有接替的标成已下线', () => {
  // 三种情况一次覆盖：技能名已映射（有接替）、已下线（没有接替，会被 fillSkills 滤掉）、正常
  const mixed = Agent.parse({
    ...coder,
    skills: ['test-driven-development', 'ue-multi-agent-coordination', 'project-documentation'],
  })
  const rec = Task.parse({ ...task, steps: [{ ...task.steps[0], agentId: mixed.id }] })
  const md = taskReport(exportTask(rec, [mixed], '', new Date(later)), 4000, { stepId: '@chat/sub/h1' })
  const head = md.split('\n').find((l) => l.includes('Skill：')) ?? ''
  // 已映射：显示接替它的当前技能名，不是安装时的旧名
  assert.match(head, /project-testing/, '已下线的技能要显示接替它的技能名')
  assert.ok(!head.includes('test-driven-development'), '不能显示已下线的旧技能名')
  // 正常：原样列出
  assert.match(head, /project-documentation/, '正常的技能原样列出')
  // 已下线且没有接替者：明确标出来，不静默丢掉
  assert.match(head, /ue-multi-agent-coordination（已下线，没有接替的技能）/, '没有接替的技能要明确标成已下线')
  // 和角色设定那段一致：报告头里的技能名都要是换算后的
  assert.ok(!head.includes('software-architecture-design'), '没配置的技能不该出现')
})
