import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { AgentInput, type Agent, type Category, type Tag } from '../shared/schema.ts'
import { BUG_METHOD, BUILTIN_AGENTS } from '../shared/builtin/agents.ts'
import { LEGACY_AGENT_FIELDS, LEGACY_AGENT_FIELDS_MORE } from '../shared/builtin/legacy.ts'
import { renderTemplate } from '../shared/agent-role.ts'
import { ensureProjectAgents, upgradeBuiltinAgents } from '../shared/builtin/install.ts'
import {
  CORE_AGENTS,
  coreDefinition,
  findCore,
  isCoreAgent,
  syncCore,
  withProjectParams,
} from '../shared/builtin/core.ts'

/** 内存里的集合，模拟服务端的 agents / categories / tags */
function memory() {
  const agents: Agent[] = []
  const categories: Category[] = []
  const tags: Tag[] = []
  let n = 0
  const id = () => `id${++n}`
  const at = new Date(0).toISOString()
  return {
    agents,
    state: () => ({ agents: [...agents], categories: [...categories], tags: [...tags], workflows: [] as never[] }),
    ops: {
      async createAgent(input: AgentInput) {
        const a = { ...AgentInput.parse(input), id: id(), createdAt: at, updatedAt: at }
        agents.push(a)
        return a
      },
      async createCategory(name: string, scope: 'agent' | 'workflow') {
        const c = { id: id(), name, scope, createdAt: at, updatedAt: at }
        categories.push(c)
        return c
      },
      async createTag(input: { name: string }) {
        const x = {
          id: id(),
          name: input.name,
          color: 'violet' as const,
          description: '',
          createdAt: at,
          updatedAt: at,
        }
        tags.push(x)
        return x
      },
      async createWorkflow(): Promise<never> {
        throw new Error('不该建工作流')
      },
      async updateAgent(aid: string, input: AgentInput) {
        const i = agents.findIndex((a) => a.id === aid)
        agents[i] = { ...agents[i], ...AgentInput.parse(input) }
        return agents[i]
      },
    },
  }
}

test('必备角色：启动时七个都装好，重复启动不再改', async () => {
  const m = memory()
  const r = await ensureProjectAgents(m.state(), m.ops)
  for (const c of CORE_AGENTS) assert.ok(findCore(m.agents, c.key), `缺 ${c.key}`)
  assert.ok(r.created.length >= 7)
  const again = await ensureProjectAgents(m.state(), m.ops)
  assert.equal(again.created.length, 0)
  assert.equal(again.synced.length, 0, '没有变化时不写盘')
})

test('必备角色：「评审」也是必备，老项目里的普通副本升级后进必备分类、参数取值不丢', async () => {
  const m = memory()
  // 老项目：评审是随工作流装进来的普通副本，放在「通用」分类里
  const old = await m.ops.createAgent({
    ...coreDefinition('reviewer').agent,
    categoryId: 'c-generic',
    includes: [],
    tags: [],
    origin: 'builtin:reviewer',
    params: coreDefinition('reviewer').agent.params.map((p) =>
      p.key === 'target' ? { ...p, default: '方案或结论' } : p,
    ),
  })
  const r = await ensureProjectAgents(m.state(), m.ops)
  const now = findCore(m.agents, 'reviewer')!
  assert.equal(now.id, old.id, '不新建，直接升级已有的那个')
  assert.ok(
    r.synced.some((x) => x.origin === 'builtin:reviewer'),
    '评审这次被同步：分类换掉、参数取值保留',
  )
  const coreCat = m.state().categories.find((c) => c.name === '必备')!
  assert.equal(now.categoryId, coreCat.id, '分类换成必备')
  assert.equal(now.common, true, '别的角色能按名字派它')
  assert.ok(isCoreAgent(now), '来源还是 builtin:reviewer，删不掉')
  assert.equal(now.params.find((p) => p.key === 'target')?.default, '方案或结论', '用户填的参数值保留')
})

test('通用约束：连续工具操作时要报告可见进度', () => {
  const rules = BUILTIN_AGENTS.find((a) => a.key === 'rules')!.agent.instructions
  assert.match(rules, /连续做两次以上工具操作前先用一句话说明当前目标/)
  assert.match(rules, /模型没有返回思考内容时不要编造内部思考/)
})

test('通用约束：等待要有死的数字上限，超时判阻塞，不靠轮询耗时间', () => {
  const rules = BUILTIN_AGENTS.find((a) => a.key === 'rules')!.agent.instructions
  // 只写「不要轮询」拦不住：实际发生过连发 sleep 90/100/120/150/180 共 640 秒
  assert.match(rules, /单次不超过 30 秒/)
  assert.match(rules, /同一件事累计不超过 2 分钟/)
  assert.match(rules, /超过 2 分钟没有新进展就判定阻塞/)
  assert.match(rules, /不要自己写 `sleep` 循环轮询/)
  // 自己验证过的结论不要再等子任务重复验证（那次空等 307 秒就属于这类）
  assert.match(rules, /已经自己验证过结论时，不要再等子任务重复验证/)
})

test('通用约束：已授权的操作照做；统筹不再另立一份授权规则', () => {
  const rules = BUILTIN_AGENTS.find((a) => a.key === 'rules')!.agent.instructions
  assert.match(rules, /用户已经明确授权的操作照授权的做/)
  assert.match(rules, /不要自行换成更保守的做法（改走 PR、只提交不推送）/)
  const orch = BUILTIN_AGENTS.find((a) => a.key === 'orchestrator')!.agent.instructions
  assert.doesNotMatch(orch, /推送、PR、submit 要用户明确授权/, '授权规则只在通用约束里写一份')
})

test('Bug：统筹只定位到模块，执行和开发从模块逐层定位，找到就停', () => {
  const role = (key: string) => BUILTIN_AGENTS.find((a) => a.key === key)!.agent.instructions
  // 只写「找到根因」时 Agent 会一路挖到底层：起点、往下一层的条件、停止和深度上限都要写成能照做的规则
  assert.match(BUG_METHOD, /用户点名的模块或部分 → 父对话交来的模块/)
  assert.match(BUG_METHOD, /这一层排除了才往下一层/)
  assert.match(BUG_METHOD, /不要再往更底层找「更根本」的问题/)
  assert.match(BUG_METHOD, /不改代码去猜，先加临时日志或写针对性的测试复现/)
  assert.match(BUG_METHOD, /下到第三层还没找到/)

  const orch = role('orchestrator')
  assert.match(orch, /## Bug 怎么交/)
  assert.match(orch, /不去读实现找具体是哪一行/)
  assert.match(orch, /不要为同一个 Bug 开几个子对话同时找/)

  const worker = role('worker')
  assert.ok(renderTemplate(worker, { mode: '自动' }).includes(BUG_METHOD))
  assert.match(renderTemplate(worker, { mode: '自动' }), /Bug：不启动工作流/)
  assert.match(renderTemplate(worker, { mode: '总是按工作流' }), /按可用工作流里的「Bug 修复」执行/)

  const dev = role('developer')
  assert.ok(renderTemplate(dev, { task: '修 Bug' }).includes(BUG_METHOD))
  assert.ok(!renderTemplate(dev, { task: '实现' }).includes(BUG_METHOD))
  assert.ok(!renderTemplate(dev, { task: '性能问题' }).includes(BUG_METHOD), '性能问题按基线走，不套 Bug 的逐层定位')
})

test('评审：仍是必备角色，收尾时要按代码改动给分级意见和验收结论', () => {
  assert.ok(
    CORE_AGENTS.some((c) => c.key === 'reviewer'),
    '评审在必备角色里',
  )
  const def = coreDefinition('reviewer')
  assert.equal(def.category, '必备')
  assert.equal(def.agent.common, true, '别的角色能按名字派它')
  const code = renderTemplate(def.agent.instructions, { target: '代码改动' })
  // 用户 2026-10-24：意见分高级、中级、低级、建议四级；高级判不通过，高级和中级要执行角色逐条处置
  for (const s of [
    '🔴 高级（必须改）',
    '🟠 中级（应该改）',
    '🟡 低级（可以改）',
    '💡 建议',
    '验收结论：通过',
    '验收结论：不通过',
    'Verdict: pass',
    '必须处置：R1',
    '需要先定的口径',
    '文档要更新',
  ])
    assert.ok(code.includes(s), `评审（代码改动）要写明「${s}」`)
  assert.match(code, /有高级就判不通过/)
  assert.match(code, /只看面板附的增量和上一轮每条意见的处置/)
  // 参照 Claude Code 的代码审查：先找候选、再逐条复核，每条写失败场景，推不出的不报
  assert.match(code, /第一遍找候选问题/)
  assert.match(code, /第二遍逐条复核候选/)
  assert.match(code, /失败场景：具体输入或状态 → 错误结果/)
  // 用户 2026-10-24：评审只做代码层面的审查，不跑测试、不搭测试环境、不写测试代码
  assert.match(code, /只做代码层面的审查：不跑测试/, '评审只看代码')
  assert.match(code, /不写临时的测试或复现脚本/, '评审不写测试脚本')
  assert.match(code, /同一回合里一起读/, '评审合并读取，少来回')
  assert.match(code, /面板取好的文件列表和带整个函数的差异/, '用面板附的改动')
  // 参数被改成「方案或结论」时也要给结论：否则收尾门禁（shared/review-gate.ts）会一直拦着合不回去
  const plan = renderTemplate(def.agent.instructions, { target: '方案或结论' })
  assert.ok(plan.includes('验收结论：通过'), '评审（方案或结论）同样要给验收结论')
})

test('执行角色：评审写进计划单独成步，收尾顺序是改完→快速检查→评审→按意见改→完整测试→submit_merge', () => {
  const worker = renderTemplate(BUILTIN_AGENTS.find((a) => a.key === 'worker')!.agent.instructions, { mode: '自动' })
  const at = worker.indexOf('## 收尾前评审（计划里的独立步骤）')
  assert.ok(at > 0, '有「收尾前评审」一节')
  const section = worker.slice(at, worker.indexOf('\n## ', at + 1))
  assert.match(section, /快速检查/, '先跑快速检查')
  assert.match(
    section,
    /单独一条主步骤（标题写清是评审，例如「评审本次改动」），并标 review: true/,
    '评审要单独写进计划并标 review',
  )
  assert.match(section, /派的时候把计划里那一步标成等待中/, '派评审时计划里那一步标等待中')
  // ADR 0009：评审只出意见，执行角色逐条核实再处置；不能再写「不要自己把 🛑 判成不重要」
  assert.doesNotMatch(section, /不要自己把 🛑 判成不重要/, '不能要求照单全收')
  assert.match(section, /采不采纳由你核实之后决定/, '采不采纳由执行角色定')
  // 用户 2026-10-24：评审只看代码、结论不一定准，每条要改的意见当前对话都要重新评估真假、级别和改法再动手
  assert.match(section, /凡是要你改代码的意见（任何级别），动手前都先自己评估三件事/)
  assert.match(section, /它给的改法只是参考/)
  assert.match(section, /自己跑一下或复现确认，不靠它的推导下结论/)
  for (const d of ['fix', 'reject', 'defer']) assert.match(section, new RegExp(`- ${d}：`), `处置里有 ${d}`)
  assert.match(section, /resume 接着上一次评审/, '复看接着上一次评审的会话')
  assert.match(section, /面板只附增量/, '复看只给增量')
  assert.match(
    section,
    /面板会把这次的改动（文件列表 \+ 带整个函数的差异）一次附进评审的提示词/,
    '改动由面板一次附给评审',
  )
  assert.match(section, /🔴 高级（必须改，有它评审就写不通过）、🟠 中级/, '四级意见')
  assert.match(section, /最多复看 2 轮/, '复看有上限')
  assert.match(section, /review_triage/, 'submit_merge 带处置')
  assert.match(section, /模块文档/, '收尾前同步模块文档')
  // 评审提速（2026-10-24 那次三轮评审 20 分钟）：通过后不为改变行为的 💭 再评审一轮；局部修复靠断言不复看；交检查命令给评审复用
  assert.match(section, /会改变行为、布局或逻辑的低级和建议都不在这一轮落/, '通过后不为建议再开一轮')
  assert.match(section, /亲手确认改前失败改后通过的，不复看/, '局部修复不复看')
  assert.match(section, /已经跑过的检查写成「命令 \+ 结果」/, '把跑过的检查交给评审当证据')
  assert.match(section, /submit_merge/, '最后才 submit_merge')
})

test('必备角色：停在旧指纹的旧副本升级时，也不冲掉用户填的参数值', async () => {
  const m = memory()
  const legacy = LEGACY_AGENT_FIELDS.reviewer ?? LEGACY_AGENT_FIELDS_MORE.reviewer?.[0]
  assert.ok(legacy, '评审有旧指纹可用')
  // 老项目：副本还是「评审员」那一版的设定，用户改过 target 的取值
  const old = await m.ops.createAgent({
    ...coreDefinition('reviewer').agent,
    name: legacy.name,
    description: legacy.description,
    instructions: legacy.instructions,
    categoryId: 'c-generic',
    includes: [],
    tags: [],
    origin: 'builtin:reviewer',
    params: coreDefinition('reviewer').agent.params.map((p) =>
      p.key === 'target' ? { ...p, default: '方案或结论' } : p,
    ),
  })
  // 启动顺序：先按旧指纹升级定义（upgradeBuiltinAgents），再按必备角色同步（ensureProjectAgents）
  await upgradeBuiltinAgents(m.state(), m.ops)
  await ensureProjectAgents(m.state(), m.ops)
  const now = findCore(m.agents, 'reviewer')!
  assert.equal(now.id, old.id)
  assert.equal(now.name, '评审', '设定升级成新的')
  assert.equal(
    now.params.find((p) => p.key === 'target')?.default,
    '方案或结论',
    '升级旧指纹时也要把用户填的参数取值带过去',
  )
})

test('必备角色：改了设定会被同步回内置定义，参数取值和运行配置保留', async () => {
  const m = memory()
  await ensureProjectAgents(m.state(), m.ops)
  const docs = findCore(m.agents, 'docsync')!
  const i = m.agents.indexOf(docs)
  m.agents[i] = {
    ...docs,
    name: '随便改的名字',
    instructions: '被改成了别的角色',
    canDelegate: true,
    enabled: false,
    model: '@high',
    params: docs.params.map((p) => (p.key === 'docRoot' ? { ...p, default: 'doc/' } : p)),
  }
  const r = await ensureProjectAgents(m.state(), m.ops)
  assert.equal(r.synced.length, 1)
  const now = findCore(m.agents, 'docsync')!
  const def = coreDefinition('docsync').agent
  assert.equal(now.name, def.name)
  assert.equal(now.instructions, def.instructions)
  assert.equal(now.canDelegate, false)
  assert.equal(now.enabled, true, '必备角色不能停用')
  assert.equal(now.model, '@high', '模型是运行配置，保留')
  assert.equal(now.params.find((p) => p.key === 'docRoot')?.default, 'doc/', '参数取值保留')
})

test('必备角色：不合法的参数值退回内置默认，定义里没有的参数去掉', () => {
  const def = coreDefinition('worker')
  const cur = AgentInput.parse({
    ...def.agent,
    params: [
      { key: 'mode', label: 'x', type: 'select', options: ['乱写'], default: '乱写' },
      { key: 'batch', label: 'x', type: 'select', options: [], default: '中' },
      { key: 'extra', label: 'x', type: 'text', default: '多出来的' },
    ],
    origin: 'builtin:worker',
  })
  const next = syncCore(cur, def, { categoryId: 'c', includes: [] })
  assert.equal(next.params.find((p) => p.key === 'mode')?.default, '自动')
  assert.equal(next.params.find((p) => p.key === 'batch')?.default, '中')
  assert.ok(!next.params.some((p) => p.key === 'extra'))
  assert.ok(isCoreAgent(next))
})

test('项目里给必备角色填的参数当作这个项目里的默认值，别的角色不受影响', async () => {
  const m = memory()
  await ensureProjectAgents(m.state(), m.ops)
  const tester = findCore(m.agents, 'tester')!
  const other = m.agents.find((a) => !isCoreAgent(a) && a.params.length)!
  const out = withProjectParams(m.agents, {
    agentParams: { [tester.id]: { scope: '整体', bogus: 1 }, [other.id]: { [other.params[0].key]: 'x' } },
  })
  assert.equal(out.find((a) => a.id === tester.id)!.params.find((p) => p.key === 'scope')?.default, '整体')
  assert.deepEqual(
    out.find((a) => a.id === other.id),
    other,
  )
})

test('「写 Bug 记录」只在文档角色里定义一次，版本控制角色不再顺手写文档', () => {
  const agents = BUILTIN_AGENTS.map((b) => b.agent)
  const vcs = BUILTIN_AGENTS.find((b) => b.key === 'vcs')!.agent
  // 文档落盘只有一个出口：版本控制角色只做提交 / pending 收尾，不再有「同步文档」「写 Bug 记录」两个开关
  assert.deepEqual(
    vcs.params.map((p) => p.key),
    ['vcs', 'branch', 'merge', 'mergeReview', 'commit'],
  )
  assert.match(vcs.instructions, /不改文档/, '版本控制角色要写清自己不写文档')
  assert.match(vcs.instructions, /派「文档」角色/, '需要写 ADR / 模块文档 / bugs.md 时交给文档角色')
  assert.equal(vcs.instructions.includes('{{#if docs}}') || vcs.instructions.includes('{{#if bug}}'), false)
  const bugParams = BUILTIN_AGENTS.filter((b) => b.agent.params.some((p) => p.key === 'bug')).map((b) => b.key)
  assert.deepEqual(bugParams, ['docsync'], '「写 Bug 记录」只在文档角色上')
  assert.ok(agents.length > 0)
})

test('Bug 记录只记用户报的 Bug，AI 自己写代码、评审发现的问题不写', () => {
  // 用户要求：bug 文档是用户提出的 bug 分析解决后才写的，开发和评审中自己发现并修掉的问题不进 bugs.md
  const docsync = coreDefinition('docsync').agent
  const rendered = renderTemplate(docsync.instructions, { bug: true })
  assert.match(rendered, /用户报的 Bug/)
  assert.match(rendered, /评审或跑测试时发现并当场修掉的问题.*不写进 bugs\.md/)
  assert.match(docsync.params.find((p) => p.key === 'bug')!.description ?? '', /用户报的 Bug/)
  for (const f of ['skills/coding/systematic-debugging/SKILL.md', 'skills/docs/project-documentation/SKILL.md']) {
    assert.match(readFileSync(f, 'utf8'), /Bug 记录只记用户报的 Bug/, f)
  }
  assert.doesNotMatch(
    readFileSync('skills/workflow/openspec/SKILL.md', 'utf8'),
    /发现新的易错点时，先记录到模块 Bug 文档/,
  )
})

test('P4 的 changelist 描述只写一行短句，细节留在文档里', () => {
  // 实际出现过长描述（把根因、函数名、步骤全写进 pending），P4V 列表里根本看不完
  const p4 = readFileSync(new URL('../skills/vcs/project-vcs/p4.md', import.meta.url), 'utf8')
  assert.match(p4, /一行、不超过约 40 个字符/)
  assert.match(p4, /不写实现细节、函数名、文件列表/)
  assert.match(p4, /正例/)
  assert.match(p4, /反例/)
  const vcs = BUILTIN_AGENTS.find((b) => b.key === 'vcs')!.agent.instructions
  assert.match(vcs, /约 40 字以内/, '角色提示词和技能口径一致')
  assert.match(vcs, /不写实现细节、函数名和文件列表/)
  const git = readFileSync(new URL('../skills/vcs/project-vcs/git.md', import.meta.url), 'utf8')
  assert.match(git, /标题一行短句/, 'Git 提交说明也别把细节塞进标题')
})
