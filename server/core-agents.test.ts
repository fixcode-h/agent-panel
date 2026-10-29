import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { AgentInput, type Agent, type Category, type Tag } from '../shared/schema.ts'
import { REVIEW_READ_BUDGET, REVIEW_SOFT_LIMIT_MIN } from '../shared/review-limits.ts'
import {
  BUG_METHOD,
  BUG_REPORT_TEXT,
  BUILTIN_AGENTS,
  CODING_TEXT,
  DESIGN_BRIEF_TEXT,
  IMPL_PLAN_TEXT,
  SELF_CHECK_TEXT,
} from '../shared/builtin/agents.ts'
import { isTestAgent } from '../shared/test-steps.ts'
import { LEGACY_AGENT_FIELDS, LEGACY_AGENT_FIELDS_MORE } from '../shared/builtin/legacy.ts'
import { renderTemplate } from '../shared/agent-role.ts'
import { ensureProjectAgents, upgradeBuiltinAgents } from '../shared/builtin/install.ts'
import {
  CORE_AGENTS,
  coreDefinition,
  findCore,
  isCoreAgent,
  isHelperAgent,
  listableAgents,
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

test('必备角色：启动时八个都装好，重复启动不再改', async () => {
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
    mounts: [],
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

test('派单纪律：事务性动作合并派一次、纯执行给低档、标题与正文各写各的范围', () => {
  // 一次运行里 7 个节点标题全是同一句、正文是复制粘贴的同一段：每个子任务都要从零探项目结构
  const orch = BUILTIN_AGENTS.find((a) => a.key === 'orchestrator')!.agent.instructions
  assert.match(orch, /## 派单的粒度/)
  assert.match(orch, /事务性小动作攒到一起/, '删临时文件、提交几个文件不需要各开一次会话')
  // 角色分层后主理能就地做护栏内的微改动：小动作要么自己做完、要么攒成一次派单，不一个动作开一个子对话
  assert.match(orch, /够得上就地微改动的就自己做/, '微改动就地做，不为它开子对话')
  assert.match(orch, /Bug 不走就地微改动/, '就地改动不是父对话自己排查修 Bug 的口子')
  assert.match(orch, /合并只限同类角色能做的动作/, '提交这一类仍交给负责版本管理的角色')
  assert.match(orch, /tier: "low"/, '纯执行类子任务要显式给低档')
  assert.match(orch, /同一批派单里不能出现两个相同的标题/)
  assert.match(orch, /message \/ instructions 各写各的范围/)
  assert.match(
    orch,
    /把子对话已经查实的根因、修复内容和验证证据逐条摘进 message（用 spawn_agents 派时写进 instructions/,
    '文档角色不该为了找依据重做一遍排查',
  )
})

test('调研、评审：可见进度压成一句话、同一批工具一起发出，与全局约束一致', () => {
  const role = (key: string) => BUILTIN_AGENTS.find((a) => a.key === key)!.agent.instructions
  // 全局约束那条要留：它防的是「只回一句我先看一下就结束回合」和「一整轮只剩工具调用」
  assert.match(role('rules'), /连续做两次以上工具操作前先用一句话说明当前目标/)
  // 调研不能说「过程里不吭声」也不能一条进度一个回合：压成一句话、每批工具一起发
  assert.match(role('explorer'), /可见进度压成一句话/)
  assert.match(role('explorer'), /每批工具发出前那一句目标照旧要说/)
  assert.match(role('explorer'), /同一批工具一起发出去/)
  assert.match(role('explorer'), /不要只回一句「我先读取…」就结束回合/)
  assert.doesNotMatch(role('reviewer'), /过程里不要逐条播报/)
  assert.match(role('reviewer'), /不要为一句「我先读一下」单独占一轮/)
})

test('Bug：统筹只定位到模块，执行和开发从模块逐层定位，找到就停', () => {
  const role = (key: string) => BUILTIN_AGENTS.find((a) => a.key === key)!.agent.instructions
  // 只写「找到根因」时 Agent 会一路挖到底层：起点、往下一层的条件、停止和深度上限都要写成能照做的规则
  assert.match(BUG_METHOD, /用户点名的模块或部分 → 父对话交来的模块/)
  assert.match(BUG_METHOD, /这一层排除了才往下一层/)
  assert.match(BUG_METHOD, /不要再往更底层找「更根本」的问题/)
  assert.match(BUG_METHOD, /不改代码去猜，先加临时日志或写针对性的测试复现/)
  assert.match(BUG_METHOD, /下到第三层还没找到/)
  // 用户要求：先模块文档 → 模块代码 → 调用栈，最后才看日志；日志要先在代码里找到出处；
  // 结论要三环证据链，推不通就复现或加日志等用户，不猜；摸清的模块回写文档
  assert.match(BUG_METHOD, /模块文档 → 模块代码 → 调用栈 → 日志（不能跳）/)
  assert.match(BUG_METHOD, /先拿它的原文在代码里搜到打印它的位置/)
  assert.match(BUG_METHOD, /现象 ← 日志原文.*← 代码 path:line/)
  assert.match(BUG_METHOD, /然后停下等用户（计划里这一步标等待中）/)
  assert.match(BUG_METHOD, /交给「文档」写进 `modules\/<模块>\/README\.md`/)
  const analyzer = role('analyzer')
  assert.match(analyzer, /## 排查报错和日志：先代码后日志/)
  assert.match(analyzer, /先拿原文在代码里搜到打印它的位置/)
  assert.match(analyzer, /单列一条「补模块文档」/)

  const orch = role('orchestrator')
  assert.match(orch, /## Bug 怎么交/)
  assert.match(orch, /不去读实现找具体是哪一行/)
  assert.match(orch, /不要为同一个 Bug 开几个子对话同时找/)
  assert.match(orch, /原文整段附进 message/)
  assert.match(orch, /调用栈、证据链（日志原文或测试输出 \+ path:line）、验证结果。缺了就交回让它补/)

  const worker = role('worker')
  assert.ok(renderTemplate(worker, { mode: '自动' }).includes(BUG_METHOD))
  assert.match(renderTemplate(worker, { mode: '自动' }), /Bug：不启动工作流/)
  assert.match(renderTemplate(worker, { mode: '总是按工作流' }), /按可用工作流里的「Bug 修复」执行/)

  const dev = role('developer')
  assert.ok(renderTemplate(dev, { task: '修 Bug' }).includes(BUG_METHOD))
  assert.ok(!renderTemplate(dev, { task: '实现' }).includes(BUG_METHOD))
  assert.ok(!renderTemplate(dev, { task: '性能问题' }).includes(BUG_METHOD), '性能问题按基线走，不套 Bug 的逐层定位')

  // 2026-10-29 加强（ADR 0029）：读代码之前先钉住现象、复现一次，回归先看最近改动；
  // 修复要有改前失败、改后通过的测试，修根因不修症状，再查同类隐患；主理派 Bug 按现象卡写、交回时核对回归测试
  assert.match(BUG_METHOD, /### 第 0 步：钉住现象，再去读代码/)
  assert.match(BUG_METHOD, /复现一次抵得上读一小时代码/)
  assert.match(BUG_METHOD, /「以前好过」的是回归：先看最近的改动/)
  assert.match(BUG_METHOD, /差异法/)
  assert.match(BUG_METHOD, /先有能复现的失败测试（改前失败、改后通过）/)
  assert.match(BUG_METHOD, /把报错 try\/catch 掉、加判空绕过、加重试让它「不报了」都不算修/)
  assert.match(BUG_METHOD, /同类隐患/)
  assert.match(orch, /Bug 派单的「现象」按现象卡写/)
  assert.match(orch, /修复能写自动化测试却没有「改前失败、改后通过」的回归用例，也交回补/)
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
  assert.match(code, /同一回合一起读/, '评审合并读取，少来回')
  assert.match(code, /面板取好的文件列表和差异/, '用面板附的改动')
  // 用户 2026-10-25（ADR 0013）：评审只评改动的代码，材料由对话整理成交接单，有读代码次数和时限
  assert.match(code, /没改的代码不评/, '评审边界：没改的代码不评')
  assert.match(code, /以 \+ \/ - 开头的行/, '只评改动的行')
  assert.match(code, /不读 `MODULE-MAP\.md`、模块文档、`bugs\.md`，不全局搜索，不通读文件/, '不自己去项目里找')
  assert.match(code, new RegExp(`最多 ${REVIEW_READ_BUDGET} 次`), '读代码有次数上限')
  assert.match(code, new RegExp(`${REVIEW_SOFT_LIMIT_MIN} 分钟内交卷`), '有时限')
  assert.match(code, /评审交接单/, '用对话交来的交接单')
  assert.doesNotMatch(code, /MODULE-MAP\.md`（本项目即/, '评审代码不走模块定位')
  // ADR 0029：按改动类型过清单，修 Bug 的改动多看根因 / 症状和回归测试
  assert.match(code, /修的是根因还是症状/)
  assert.match(code, /有没有能拦住它的回归测试/)
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
  assert.match(section, /面板会把这次的改动（文件列表 \+ 每处改动前后几行的差异/, '改动由面板一次附给评审')
  assert.match(section, /带上交接单 review（第一次评审 goal、checks 必填/, '派评审时对话整理交接单')
  assert.match(section, /🔴 高级（必须改，有它评审就写不通过）、🟠 中级/, '四级意见')
  assert.match(section, /最多复看 2 轮/, '复看有上限')
  assert.match(section, /review_triage/, 'submit_merge 带处置')
  assert.match(section, /模块文档/, '收尾前同步模块文档')
  // 评审提速（2026-10-24 那次三轮评审 20 分钟）：通过后不为改变行为的 💭 再评审一轮；局部修复靠断言不复看；交检查命令给评审复用
  assert.match(section, /会改变行为、布局或逻辑的低级和建议都不在这一轮落/, '通过后不为建议再开一轮')
  assert.match(section, /亲手确认改前失败改后通过的，不复看/, '局部修复不复看')
  assert.match(section, /checks 写已经跑过的检查「命令 \+ 结果」/, '把跑过的检查交给评审当证据')
  assert.match(section, /submit_merge/, '最后才 submit_merge')
})

test('必备角色：停在旧指纹的旧副本升级时，也不冲掉用户填的参数值', async () => {
  const m = memory()
  const legacy = LEGACY_AGENT_FIELDS.reviewer ?? LEGACY_AGENT_FIELDS_MORE.reviewer?.[0]
  assert.ok(legacy, '评审有旧指纹可用')
  // 老项目：副本还是「评审员」那一版的设定，用户改过 target 的取值
  const old = await m.ops.createAgent({
    mounts: [],
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

test('「子任务」是派子任务时的默认角色：不作为可选角色展示，也停用不了、删不掉', async () => {
  const m = memory()
  await ensureProjectAgents(m.state(), m.ops)
  const helper = findCore(m.agents, 'helper')!
  assert.ok(isHelperAgent(helper), '来源是 builtin:helper：引擎靠它给 spawn_agents 兜底')
  // 停用它所有子任务就没有默认角色了：保存时按必备角色强制恢复（server/index.ts 的 PUT /agents/:id 走 syncCore）
  const off = syncCore(AgentInput.parse({ ...helper, enabled: false }), coreDefinition('helper'), {
    categoryId: helper.categoryId,
    includes: helper.includes,
  })
  assert.equal(off.enabled, true)
  // 删除保护：删除接口按 isCoreAgent 拦（server/index.ts 返回 409）
  assert.ok(isCoreAgent(helper))
  // 角色页、内置角色弹窗、选择器列的是 listableAgents：只有它被去掉
  assert.deepEqual(listableAgents(m.agents).filter(isHelperAgent), [])
  assert.equal(listableAgents(m.agents).length, m.agents.length - 1)
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
  assert.match(p4, /一行、不超过 25 个字/)
  assert.match(p4, /不写实现细节、函数名、文件列表/)
  assert.match(p4, /正例/)
  assert.match(p4, /反例/)
  const vcs = BUILTIN_AGENTS.find((b) => b.key === 'vcs')!.agent.instructions
  assert.match(vcs, /25 字以内/, '角色提示词和技能口径一致')
  assert.match(vcs, /不写实现细节、函数名和文件列表/)
  const git = readFileSync(new URL('../skills/vcs/project-vcs/git.md', import.meta.url), 'utf8')
  assert.match(git, /标题一行短句/, 'Git 提交说明也别把细节塞进标题')
})

test('交付契约：方案摘要、实现计划、排查报告、自测清单在角色之间串起来（ADR 0029）', () => {
  const role = (key: string) => BUILTIN_AGENTS.find((a) => a.key === key)!.agent.instructions
  // 方案设计交「方案摘要」：验收标准要可执行、标测试层级；开发按它的实现顺序展开，测试验收逐条对照
  for (const s of ['目标 / 非目标', '改动清单', '实现顺序', '验收标准', '风险与回滚', '待确认'])
    assert.ok(DESIGN_BRIEF_TEXT.includes(s), `方案摘要缺「${s}」`)
  assert.match(DESIGN_BRIEF_TEXT, /标测试层级（单测 \/ 集成 \/ 端到端 \/ 界面走查 \/ 手测）/)
  assert.ok(renderTemplate(role('analyst'), { scale: 'bounded' }).includes(DESIGN_BRIEF_TEXT))
  assert.match(role('analyst'), /「功能正常」「体验更好」这类不算/, '验收标准要能执行')
  // 执行接单先复述再写实现计划；开发的「实现」「重构」也先写计划，「修 Bug」不用（它走排查报告）
  const worker = renderTemplate(role('worker'), { mode: '自动' })
  assert.match(worker, /## 接单：先复述，再计划/)
  assert.match(worker, /用 message_parent（question 设为 true）问清再动手/)
  assert.ok(worker.includes(IMPL_PLAN_TEXT))
  assert.ok(worker.includes(SELF_CHECK_TEXT))
  assert.match(IMPL_PLAN_TEXT, /验收标准在实现中途不能偷偷放宽/)
  const dev = role('developer')
  assert.ok(renderTemplate(dev, { task: '实现' }).includes(IMPL_PLAN_TEXT))
  assert.ok(renderTemplate(dev, { task: '重构' }).includes(IMPL_PLAN_TEXT))
  assert.ok(!renderTemplate(dev, { task: '修 Bug' }).includes(IMPL_PLAN_TEXT))
  assert.ok(renderTemplate(dev, { task: '实现' }).includes('方案摘要'), '开发按方案摘要的实现顺序展开')
  for (const task of ['实现', '修 Bug', '性能问题', '重构'])
    assert.ok(renderTemplate(dev, { task }).includes(SELF_CHECK_TEXT), `开发（${task}）交付前自测`)
  assert.match(SELF_CHECK_TEXT, /复现用例改前失败、改后通过的输出都要有/)
  assert.match(SELF_CHECK_TEXT, /`\[排查-…\]` 临时日志/)
  // 排查报告：交回按固定小节，主理按同一张表核对
  for (const s of ['现象', '复现', '调用栈', '证据链', '根因', '修复', '验证', '回归与隐患', '文档'])
    assert.ok(BUG_REPORT_TEXT.includes(`${s}：`), `排查报告缺「${s}」`)
  assert.ok(BUG_METHOD.includes(BUG_REPORT_TEXT), 'Bug 方法的交回按排查报告写')
  assert.match(role('orchestrator'), /按「排查报告」的小节核对/)
  assert.match(role('orchestrator'), /派单正文按固定小节写/)
  assert.match(role('analyzer'), /排查部分按「排查报告」的小节组织/)
  // 写代码的硬规则同批加的两条：接口先读定义再写，边界先想再写
  assert.match(CODING_TEXT, /不凭记忆写接口/)
  assert.match(CODING_TEXT, /边界先想再写/)
})

test('测试验收：多了「设计用例」「补测试」两种做法，默认仍是跑验收，仍是唯一的测试角色', () => {
  const def = coreDefinition('tester')
  const task = def.agent.params.find((p) => p.key === 'task')!
  assert.deepEqual(task.options, ['跑验收', '设计用例', '补测试'])
  assert.equal(task.default, '跑验收')
  // 识别测试角色靠 scope / env 两个参数（shared/test-steps.ts 的 isTestAgent），加参数不能动它们
  assert.ok(isTestAgent({ params: def.agent.params }))
  const run = renderTemplate(def.agent.instructions, {
    task: '跑验收',
    scope: '本次改动',
    env: '自动',
    onFail: '只报告',
  })
  assert.match(run, /## 先读项目配置的测试步骤/)
  assert.match(run, /验收结论：通过/)
  assert.doesNotMatch(run, /测试矩阵/)
  const design = renderTemplate(def.agent.instructions, { task: '设计用例' })
  assert.match(design, /## 这次只设计用例：不写代码、不跑整套测试/)
  assert.match(design, /正常路径 → 边界/)
  assert.match(design, /历史 Bug 是最好的回归用例来源/)
  assert.doesNotMatch(design, /## 先读项目配置的测试步骤/, '设计用例不跑项目测试步骤')
  const write = renderTemplate(def.agent.instructions, { task: '补测试' })
  assert.match(write, /只改测试文件和测试夹具，不改产品代码/)
  assert.match(write, /不写永远通过的测试/)
  assert.match(write, /验收结论：通过/)
  // 执行角色知道什么时候派它设计用例
  const worker = renderTemplate(BUILTIN_AGENTS.find((a) => a.key === 'worker')!.agent.instructions, { mode: '自动' })
  assert.match(worker, /用「设计用例」独立列一遍测试矩阵/)
})
