/**
 * 端到端测试分片：中断恢复、补充信息、换 CLI、权限与提问、条件连线、预算、失败、卡住、节点入口、默认 CLI、附件、文件、数据目录
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs），
 * 互不影响。总入口 scripts/e2e.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'

import path from 'node:path'
import { clearCliOutputs, cliOutputFile } from '../fake-cli/outputs.mjs'
import { runShard } from './harness.mjs'

await runShard('工作流条件与失败', async (api) => {
  const {
    baseUrl: base,
    tmp,
    dataDir,
    projectDir,
    appDir,
    log,
    PNG_1PX,
    git,
    gitIn,
    call,
    sleep,
    waitFor,
    waitDone,
    waitTask,
    mergeTask,
    calls,
    readLog,
    step,
    cli,
    setupBase,
  } = api
  const { project, A, B, C, agent, settings, node, flow, wf } = await setupBase()
  // 这个分片有几处要一个已经跑完的工作流任务（换 CLI 被拒、消息文件按项目分目录），
  // 这里单独建一个，不依赖别的分片跑过什么
  let t = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: '做一个新功能' })
  t = await waitDone(t.id)
  // ---- 中断恢复：执行到一半停止，继续执行时续接那个节点的会话，从中断的地方接着做 ----
  let half = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: 'SLOW 中断恢复' })
  // 等节点真的跑起来再停，慢回合会持续一段时间
  await waitFor(() => calls().some((c) => c.input.includes('SLOW 中断恢复')), { label: '工作流开始执行' })
  await call('POST', `/tasks/${half.id}/stop`)
  half = await waitDone(half.id, 8000)
  assert.equal(half.status, 'stopped')
  const cut = half.steps.find((s) => s.interrupted)
  assert.ok(
    cut,
    '正在跑的节点记为被打断 ' + JSON.stringify([half.steps.map((s) => [s.id, s.status, s.interrupted]), half.sessions]),
  )
  assert.ok(half.sessions[cut.id], '被打断的节点留着会话')
  assert.equal(half.messages.at(-1).transient, true, '结束时写的暂停说明是临时的')
  const beforeResume = calls().length
  await call('POST', `/tasks/${half.id}/resume`)
  half = await waitDone(half.id, 20000)
  assert.equal(half.status, 'done', JSON.stringify(half.messages.filter((m) => m.role === 'system')))
  const cont = calls().slice(beforeResume)[0]
  assert.match(cont.input, /从中断的地方接着完成本节点/)
  assert.ok(!half.steps.some((s) => s.interrupted))
  assert.ok(!half.messages.some((m) => m.transient), '继续执行后去掉暂停说明，输出接在同一个节点里')
  step('中断恢复：停止后继续执行，被打断的节点续接会话接着做')

  // ---- 工作流执行中补充信息：交给正在跑的节点（收不了时留给下一个节点），不算新要求 ----
  {
    let w = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: 'SLOW 工作流补充' })
    await waitFor(() => calls().some((c) => c.input.includes('SLOW 工作流补充')), { label: '工作流开始执行' })
    const before = calls().length
    w = await call('POST', `/tasks/${w.id}/messages`, { text: '接口要兼容旧版' })
    const note = w.messages.find((m) => m.text === '接口要兼容旧版')
    assert.ok(note?.step, '补充记在正在跑的节点上')
    w = await waitDone(w.id, 20000)
    assert.equal(w.status, 'done')
    const got =
      readLog(`${log}.steer`).some((x) => x.steered.some((s) => s.includes('接口要兼容旧版'))) ||
      calls()
        .slice(before)
        .some((c) => c.input.includes('用户在执行中补充的信息') && c.input.includes('接口要兼容旧版'))
    assert.ok(got, 'Agent 收到了补充的信息')
  }
  step('工作流执行中补充信息：交给正在跑的节点，接着当前的任务做')

  // ---- 对话中途换 CLI 和模型：下一轮生效；换了 CLI 开新会话，把之前的对话带过去；每条回复记下自己用的 CLI ----
  {
    let c = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'codex',
      prompt: '记住暗号是蓝鲸',
    })
    c = await waitDone(c.id)
    assert.equal(c.messages.findLast((m) => m.role === 'agent').run?.cli, 'codex')
    c = await call('PATCH', `/tasks/${c.id}`, { cli: 'claude', model: '', effort: '' })
    assert.equal(c.cli, 'claude')
    const before = calls().length
    await call('POST', `/tasks/${c.id}/messages`, { text: '暗号是什么' })
    c = await waitDone(c.id)
    assert.equal(c.status, 'done')
    const next = calls().slice(before)[0]
    assert.equal(next.kind, 'claude', '换了 CLI 后下一轮用新的 CLI')
    assert.ok(!next.args.includes('--resume'), '换了 CLI 开新会话')
    assert.match(next.input, /之前的对话[\s\S]*蓝鲸/, '把之前的对话带给新会话')
    assert.equal(c.messages.findLast((m) => m.role === 'agent').run?.cli, 'claude')
    const bad = await fetch(`${base}/tasks/${t.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cli: 'claude' }),
    })
    assert.equal(bad.status, 400, '工作流任务不能换 CLI')
  }
  step('对话中途换 CLI：下一轮生效，开新会话并带上之前的对话')

  // ---- 权限请求：Claude Code 要确认的命令和问题显示在任务上，用户回答后交回 CLI ----
  let ask = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: A.id,
    prompt: 'ASK 需要确认',
    askUser: true,
  })
  const waitReq = async () => {
    for (let i = 0; i < 100; i++) {
      const t = await call('GET', `/tasks/${ask.id}`)
      if (t.requests.length) return t.requests[0]
      await sleep(100)
    }
    throw new Error('没有等到请求')
  }
  const r1 = await waitReq()
  assert.equal(r1.kind, 'command')
  assert.match(r1.title, /rm -rf build/)
  await call('POST', `/tasks/${ask.id}/requests/${r1.id}`, { allow: true })
  const r2 = await waitReq()
  assert.equal(r2.kind, 'question')
  assert.deepEqual(r2.options, ['SQLite', 'MySQL'])
  assert.deepEqual(
    r2.questions.map((q) => [q.header, q.options.length]),
    [
      ['数据库', 2],
      ['缓存', 2],
    ],
    '一次问的几个问题都带上',
  )
  await call('POST', `/tasks/${ask.id}/requests/${r2.id}`, { allow: true, answers: ['SQLite', '用 Redis'] })
  await assert.rejects(call('POST', `/tasks/${ask.id}/requests/${r2.id}`, { allow: true }), /已经结束/)
  ask = await waitDone(ask.id)
  assert.equal(ask.status, 'done')
  assert.equal(ask.requests.length, 0)
  const [a1, a2] = readLog(log + '.ask').at(-1)
  assert.equal(a1.behavior, 'allow')
  assert.equal(a1.updatedInput.command, 'rm -rf build')
  assert.equal(a2.updatedInput.answers['用哪个数据库？'], 'SQLite')
  assert.equal(a2.updatedInput.answers['要不要加缓存？'], '用 Redis', '几个问题的回答一起交回去')
  assert.ok(ask.messages.some((m) => m.role === 'system' && /你允许了：运行命令：rm -rf build/.test(m.text)))
  // 回答带上每个问题和答案，页面在对话正文里显示
  assert.deepEqual(ask.messages.find((m) => m.answers)?.answers, [
    { question: '用哪个数据库？', answer: 'SQLite' },
    { question: '要不要加缓存？', answer: '用 Redis' },
  ])
  step('权限请求：命令和问题在任务上等用户确认，回答后交回 CLI')

  // 「提问」开关关着：审批照样等用户，问题不交给用户，让 CLI 自己选
  ask = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: 'ASK 自己选' })
  assert.equal(ask.askUser, false)
  const r3 = await waitReq()
  assert.equal(r3.kind, 'command')
  await call('POST', `/tasks/${ask.id}/requests/${r3.id}`, { allow: false })
  ask = await waitDone(ask.id)
  assert.equal(ask.status, 'done')
  const [d1, d2] = readLog(log + '.ask').at(-1)
  assert.equal(d1.behavior, 'deny')
  assert.equal(d2.behavior, 'deny')
  assert.match(d2.message, /自己的判断|不要再提问/, '问题让 CLI 自己选')
  step('提问开关关着：审批照样等用户，问题让 CLI 自己选最合适的做法')

  // 提问窗口右上角的关闭就是停止：CLI 还卡在等回答，停止接口返回的任务里也不能再带着提问，不然窗口关不掉
  ask = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: A.id,
    prompt: 'ASK 关掉',
    askUser: true,
  })
  const r4 = await waitReq()
  await call('POST', `/tasks/${ask.id}/requests/${r4.id}`, { allow: true })
  const r5 = await waitReq()
  assert.equal(r5.kind, 'question')
  const stopped = await call('POST', `/tasks/${ask.id}/stop`)
  assert.equal(stopped.requests.length, 0, '停止后马上没有在等的提问')
  assert.equal((await call('GET', `/tasks/${ask.id}`)).requests.length, 0)
  await assert.rejects(call('POST', `/tasks/${ask.id}/requests/${r5.id}`, { allow: true }), /已经结束/)
  ask = await waitDone(ask.id)
  assert.equal(ask.requests.length, 0)
  step('关掉提问（停止）：在等回答的提问马上作废，提问窗口收起')

  // ---- 工作流的条件连线、完成后等我确认、预算上限 ----
  const wfBranch = await call('POST', '/workflows', {
    name: '条件分支',
    description: '',
    mainAgentId: A.id,
    members: [],
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [
          node('t', '测试', '', '跑测试。', { hooks: { confirm: true } }),
          node('ok', '发布', '', '发布。'),
          node('fix', '修复', '', '修复失败的测试。'),
          node('after', '收尾', '', '收尾。'),
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't' },
          { id: 'e2', from: 't', to: 'ok', when: 'pass' },
          { id: 'e3', from: 't', to: 'fix', when: 'fail' },
          { id: 'e4', from: 'ok', to: 'after' },
          { id: 'e5', from: 'fix', to: 'end' },
          { id: 'e6', from: 'after', to: 'end' },
        ],
      },
    ],
    entryFlowId: 'main',
    document: '',
  })
  const nBranch = calls().length
  let br = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'workflow',
    workflowId: wfBranch.id,
    prompt: 'BRANCHNO 跑一遍',
  })
  const waitConfirm = async (id) => {
    for (let i = 0; i < 100; i++) {
      const tk = await call('GET', `/tasks/${id}`)
      if (tk.requests.length) return tk.requests[0]
      await sleep(100)
    }
    throw new Error('没有等到确认')
  }
  const cf1 = await waitConfirm(br.id)
  assert.equal(cf1.kind, 'confirm')
  assert.match(cf1.title, /「测试」完成了/)
  assert.match(cf1.detail, /结论：不通过/, '确认卡片上是节点的结果')
  await call('POST', `/tasks/${br.id}/requests/${cf1.id}`, { allow: false, answer: '多跑一遍集成测试 BRANCHNO' })
  const cf2 = await waitConfirm(br.id)
  const redo = calls().slice(nBranch).at(-1)
  assert.match(redo.input, /用户看了结果，要求修改：\n多跑一遍集成测试 BRANCHNO/, '退回的意见交回节点')
  assert.match(redo.input, /结论：通过」或「结论：不通过/, '返工后同样要给出结论')
  await call('POST', `/tasks/${br.id}/requests/${cf2.id}`, { allow: true })
  br = await waitDone(br.id)
  assert.equal(br.status, 'done', JSON.stringify(br.messages.filter((m) => m.role === 'system')))
  const byNode = (id) => br.steps.find((s) => s.nodeId === id)
  assert.equal(byNode('t').branch, 'fail')
  assert.equal(byNode('fix').status, 'done', '结论不通过：走修复')
  assert.equal(byNode('ok').status, 'skipped', '没走到的分支跳过')
  assert.equal(byNode('after').status, 'skipped', '跳过的节点后面的也跳过')
  const first = calls()[nBranch]
  assert.match(first.input, /通过时接着做「发布」；不通过时接着做「修复」/)
  assert.ok(br.messages.some((m) => /你退回了「测试」：多跑一遍集成测试 BRANCHNO/.test(m.text)))
  assert.ok(br.messages.some((m) => /你确认了「测试」的结果/.test(m.text)))

  // 流程停在门禁上（结论不通过、只有「通过」的线）：追加要求交给主 Agent 处理，处理完从门禁重新检查、接着走流程
  {
    const wfGate = await call('POST', '/workflows', {
      name: '门禁',
      description: '',
      mainAgentId: A.id,
      members: [],
      flows: [
        {
          id: 'main',
          name: '主流程',
          nodes: [node('g', '前置检查', '', '检查环境。'), node('go', '设计', '', '出设计。')],
          edges: [
            { id: 'e1', from: 'start', to: 'g' },
            { id: 'e2', from: 'g', to: 'go', when: 'pass' },
            { id: 'e3', from: 'go', to: 'end' },
          ],
        },
      ],
      entryFlowId: 'main',
      document: '',
    })
    const gateOf = (tk, id) => tk.steps.find((s) => s.nodeId === id)
    let gt = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'workflow',
          workflowId: wfGate.id,
          prompt: 'BRANCHNO 门禁',
        })
      ).id,
    )
    assert.equal(gateOf(gt, 'g').branch, 'fail')
    assert.equal(gateOf(gt, 'go').status, 'skipped')
    assert.ok(
      gt.messages.some((m) => /流程停在「前置检查」/.test(m.text)),
      '停在门禁时说明怎么继续',
    )
    const nGate = calls().length
    gt = await call('POST', `/tasks/${gt.id}/messages`, { text: 'GATEFIXED 帮我修好门禁' })
    gt = await waitDone(gt.id)
    const fixCall = calls()[nGate]
    assert.match(fixCall.input, /工作流停在了节点「前置检查」/, '追加要求先交给主 Agent 处理停住的问题')
    assert.equal(gateOf(gt, 'g').branch, 'pass', '处理完从门禁重新检查')
    assert.equal(gateOf(gt, 'go').status, 'done', '门禁通过后接着走后面的流程')
    assert.equal(gt.status, 'done')

    // 「继续流程」：不加新要求，从门禁重新检查；「结束流程」：没完成的节点不再执行
    let g2 = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'workflow',
          workflowId: wfGate.id,
          prompt: 'BRANCHNO 再来',
        })
      ).id,
    )
    const nResume = calls().length
    g2 = await waitDone((await call('POST', `/tasks/${g2.id}/resume`)).id)
    assert.ok(calls().length > nResume, '继续流程时重新执行门禁')
    assert.equal(gateOf(g2, 'g').branch, 'fail')
    g2 = await call('POST', `/tasks/${g2.id}/end-flow`)
    assert.equal(g2.flowClosed, true)
    assert.equal(gateOf(g2, 'go').status, 'skipped')
    // 409：和「子对话已经不在停下了」同一个判定（界面靠这个状态码给「它已经不在停下了」的提示）
    await assert.rejects(call('POST', `/tasks/${g2.id}/resume`), /409/, '结束的流程不能再继续')
    // 工作流的输入框也能用「/命令」：按默认 CLI 展开成普通的要求，对话里显示原文
    const nInit = calls().length
    g2 = await waitDone((await call('POST', `/tasks/${g2.id}/messages`, { text: '/init' })).id)
    const um = g2.messages.filter((m) => m.role === 'user').at(-1)
    assert.equal(um.text, '/init')
    assert.match(um.prompt, /AGENTS\.md/)
    assert.match(calls()[nInit].input, /用户已经结束了工作流/)
    assert.match(calls()[nInit].input, /请分析这个项目/)
    assert.equal(gateOf(g2, 'g').branch, 'fail', '结束流程后追加要求不再重跑门禁')
    step('流程停在门禁：追加要求处理完自动接着走；可以继续流程、结束流程；工作流支持「/命令」')
  }

  // 预算：第一个节点用掉的 token 超过上限，第二个节点开始前暂停；继续执行再给一份额度
  const wfBudget = await call('POST', '/workflows', {
    name: '有预算',
    description: '',
    mainAgentId: A.id,
    members: [],
    budgetTokens: 1,
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [node('a', '一', '', '做一。'), node('b', '二', '', '做二。')],
        edges: [
          { id: 'e1', from: 'start', to: 'a' },
          { id: 'e2', from: 'a', to: 'b' },
          { id: 'e3', from: 'b', to: 'end' },
        ],
      },
    ],
    entryFlowId: 'main',
    document: '',
  })
  let bud = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'workflow',
    workflowId: wfBudget.id,
    prompt: '省着点',
  })
  bud = await waitDone(bud.id)
  assert.equal(bud.status, 'stopped')
  assert.match(bud.messages.at(-1).text, /达到工作流设定的上限 1，已暂停/)
  assert.equal(bud.steps.find((s) => s.nodeId === 'a').status, 'done')
  assert.notEqual(bud.steps.find((s) => s.nodeId === 'b')?.status, 'done')
  await call('POST', `/tasks/${bud.id}/resume`, {})
  bud = await waitDone(bud.id)
  assert.equal(bud.status, 'done', '继续执行时重新给一份额度')
  assert.ok(!bud.messages.some((m) => m.transient), '继续执行后去掉达到上限的暂停说明')
  await call('DELETE', `/tasks/${br.id}`)
  await call('DELETE', `/tasks/${bud.id}`)
  await call('DELETE', `/workflows/${wfBranch.id}`)
  await call('DELETE', `/workflows/${wfBudget.id}`)
  step('工作流：条件连线按结论选路，完成后等我确认（可以退回），超过预算上限暂停')

  // ---- 工作流不再有常驻编排器：节点直接执行，条件分支看节点自己的结论 ----
  {
    const wfMain = await call('POST', '/workflows', {
      name: '没有编排器的工作流',
      description: '',
      mainAgentId: A.id,
      // 旧字段，升级后也不会再生成 @main
      dispatch: true,
      flows: [
        {
          id: 'main',
          name: '主流程',
          nodes: [
            node('d1', '实现', B.id, 'MAINREWORK 写代码。'),
            node('d2', '自己看一眼', '', '看一眼。'),
            node('d3', '测试', C.id, 'BRANCHNO 跑测试。'),
            node('ok', '发布', '', '发布。'),
            node('fix', '修复', B.id, '修复。'),
          ],
          edges: [
            { id: 'e1', from: 'start', to: 'd1' },
            { id: 'e2', from: 'd1', to: 'd2' },
            { id: 'e3', from: 'd2', to: 'd3' },
            { id: 'e4', from: 'd3', to: 'ok', when: 'pass' },
            { id: 'e5', from: 'd3', to: 'fix', when: 'fail' },
            { id: 'e6', from: 'ok', to: 'end' },
            { id: 'e7', from: 'fix', to: 'end' },
          ],
        },
      ],
      entryFlowId: 'main',
      document: '',
    })
    const n0 = calls().length
    let dm = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'workflow',
      workflowId: wfMain.id,
      prompt: '没有编排器跑一遍',
    })
    assert.equal(dm.steps[0].id, 'd1', '不再生成 @main，直接是第一个节点')
    dm = await waitDone(dm.id)
    assert.equal(dm.status, 'done', JSON.stringify(dm.messages.filter((m) => m.role === 'system')))
    const by = (id) => dm.steps.find((s) => s.id === id)
    assert.ok(!dm.steps.some((s) => s.kind === 'main'), '没有常驻编排器')
    assert.equal(by('d3').branch, 'fail', '分支由节点自己的结论决定')
    assert.equal(by('fix').status, 'done')
    assert.equal(by('ok').status, 'skipped')
    assert.ok(!by('d3/call.1/c1'), '不再有主 Agent 委派')
    const mine = calls().slice(n0)
    assert.ok(!mine.some((c) => /## 事件：/.test(c.input)), '节点之间不经过主 Agent')
    assert.ok(!mine.some((c) => /常驻编排器/.test(c.input)), '提示词里没有编排器')
    assert.equal(mine.filter((c) => /本节点「实现」|继续完善本节点「实现」/.test(c.input)).length, 1, '节点只执行一次')
    // 节点仍然带编排工具，可以派子 Agent、传话、读写共享状态
    assert.ok(
      mine.every((c) => c.args.some((x) => x.includes('/api/mcp/ask/'))),
      '节点都接上编排工具',
    )
    assert.match(mine.find((c) => /节点：修复/.test(c.input)).input, /spawn_agents 派子任务/)
    // 追加要求交给工作流的默认执行 Agent（不再有 @main 会话）
    const n1 = calls().length
    await call('POST', `/tasks/${dm.id}/messages`, { text: '再改一下' })
    dm = await waitDone(dm.id)
    const follow = calls()[n1]
    assert.match(follow.input, /再改一下/)
    await call('DELETE', `/workflows/${wfMain.id}`)
  }
  step('工作流没有再常驻编排器：节点直接执行、自己的结论决定分支，追加要求交给默认执行 Agent')

  // ---- 节点之间传话（send_message）：记成一次工具调用，不把整段正文铺成居中的系统块 ----
  {
    const wfTalk = await call('POST', '/workflows', {
      name: '节点之间传话',
      description: '',
      mainAgentId: A.id,
      flows: [
        {
          id: 'main',
          name: '主流程',
          nodes: [node('t1', '实现', B.id, 'SEND_MSG 给「测一下」写代码。'), node('t2', '测一下', B.id, '跑测试。')],
          edges: [
            { id: 'e1', from: 'start', to: 't1' },
            { id: 'e2', from: 't1', to: 't2' },
            { id: 'e3', from: 't2', to: 'end' },
          ],
        },
      ],
      entryFlowId: 'main',
      document: '',
    })
    let talk = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'workflow',
      workflowId: wfTalk.id,
      prompt: '节点之间传话',
    })
    talk = await waitDone(talk.id)
    assert.equal(talk.status, 'done', JSON.stringify(talk.messages.filter((m) => m.role === 'system')))
    // 假 CLI 直接调面板的 MCP，不产生 CLI 的 tool_use 事件：工具行的渲染由单测和界面检查覆盖，
    // 这里检查服务端记下的运行记录，以及不再往对话流里铺居中的系统块
    const sent = talk.runs?.at(-1)?.messages?.find((m) => /接口改名了/.test(m.text))
    assert.ok(sent, '传话记进这次运行的消息记录')
    assert.equal(sent.to, 't2', '收件方是「测一下」那个节点')
    assert.ok(
      !talk.messages.some((m) => m.role === 'system' && !m.panel && /」→「/.test(m.text)),
      '传话不再铺成居中的系统块',
    )
    await call('DELETE', `/tasks/${talk.id}`)
    await call('DELETE', `/workflows/${wfTalk.id}`)
    step('节点之间传话：画成发送消息的工具调用，不再铺成居中的系统块')
  }

  // ---- 失败 ----
  let bad = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: 'FAIL 请失败' })
  bad = await waitDone(bad.id)
  assert.equal(bad.status, 'failed')
  assert.match(bad.messages.at(-1).text, /Claude Code 执行失败[\s\S]*模拟的失败/)
  let badWf = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: 'FAIL 工作流' })
  badWf = await waitDone(badWf.id)
  assert.equal(badWf.status, 'failed')
  assert.deepEqual(
    badWf.steps.map((s) => s.status),
    ['failed', 'pending', 'pending', 'pending'],
  )
  const failedStep = badWf.steps.find((s) => s.status === 'failed')
  const stepErr = badWf.messages.find((m) => m.step === failedStep.id && m.role === 'system')
  assert.ok(stepErr?.error && /模拟的失败/.test(stepErr.text), '错误写进失败的节点里')
  const tail = badWf.messages.at(-1)
  assert.ok(
    tail.error && /原因见节点里的错误/.test(tail.text) && !/模拟的失败/.test(tail.text),
    '结尾只提一句，不重复整段',
  )
  // 连接中途断开：有会话就自动续接；一直断就给出能照着做的说明
  let net = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: C.id,
    prompt: 'NETFAIL 写个大文件',
  })
  net = await waitDone(net.id)
  assert.equal(net.status, 'done', '断开后自动续接完成')
  const c = calls().at(-1)
  assert.ok(c.args.includes('--resume') && /连接中断了/.test(c.input) && /分几次写/.test(c.input))
  // 续接成功后，断开时的报错收成普通说明：这一轮实际没有失败，不能一直挂着一张红色错误
  const shown = net.messages.find((m) => m.role === 'system' && /已自动续接会话（第 1 次）/.test(m.text))
  assert.ok(shown && /Unable to connect to the API/.test(shown.text), '断开的原因要留着能查')
  assert.ok(!shown.error && shown.transient, '续接成功后不再显示成错误')
  net = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: C.id,
    prompt: 'NETDOWN 写个大文件',
  })
  net = await waitDone(net.id)
  assert.equal(net.status, 'failed')
  const netErr = net.messages.at(-1)
  assert.ok(netErr.error)
  assert.match(netErr.text, /已自动续接 2 次，仍然失败/)
  assert.equal(
    net.messages.filter((m) => m.error && /正在自动续接会话重试/.test(m.text)).length,
    2,
    '每次续接前的报错都显示',
  )
  assert.match(netErr.text, /走的是 Command Code 官方服务[\s\S]*me\/fake\/flash/)
  assert.match(netErr.text, /连接中途断开/)
  // 运行日志：程序目录的 logs/ 里，这次启动一个文件，记下了启动、CLI 的命令和断开重试
  const logUsage = await call('GET', '/data')
  assert.ok(
    logUsage.logs?.current && logUsage.logs.current.startsWith(path.join(appDir, 'logs')),
    '日志在单独的文件夹里',
  )
  const logText = readFileSync(logUsage.logs.current, 'utf8')
  assert.match(logText, /INFO  \[server\] 启动/)
  assert.match(logText, /\[agent\] 启动 Command Code[\s\S]*command: /)
  assert.match(logText, /WARN  \[agent\] Command Code 连接中断，自动续接第 1 次/)
  assert.match(logText, /ERROR \[agent\] Command Code 执行失败/)
  step('失败：显示 CLI 报告的错误，工作流停在失败的节点')
  // 卡住的 CLI：没有输出先提醒一次，再过同样的时间自动停止；输出里看出是没登录，给出登录的方法
  await call('PUT', '/settings', { ...settings, idleTimeoutMinutes: 1 })
  let hang = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: 'HANG' })
  hang = await waitDone(hang.id)
  await call('PUT', '/settings', settings)
  assert.equal(hang.status, 'failed')
  assert.ok(
    hang.messages.some((m) => m.role === 'system' && /已经 1 分钟没有任何输出/.test(m.text)),
    '先提醒一次',
  )
  assert.match(hang.messages.at(-1).text, /连续 2 分钟没有任何输出，已停止/)
  assert.match(hang.messages.at(-1).text, /没有登录[\s\S]*\/login/)
  step('卡住的 CLI：长时间没有输出先提醒、再自动停止，看出没登录时说明怎么登录')

  // ---- 节点入口：开始 / 验收 / 结束，流程节点，引用其他工作流 ----
  const small = await call('POST', '/workflows', {
    name: '小流程',
    mainAgentId: A.id,
    members: [],
    entryFlowId: 'main',
    document: '',
    flows: [
      flow(
        'main',
        '',
        [node('s', '小流程节点', '', '小流程要做的事。')],
        [
          ['start', 's'],
          ['s', 'end'],
        ],
      ),
    ],
  })
  const hooked = await call('POST', '/workflows', {
    name: '带入口',
    mainAgentId: A.id,
    members: [
      { agentId: B.id, responsibility: '' },
      { agentId: C.id, responsibility: '' },
    ],
    entryFlowId: 'main',
    document: '',
    flows: [
      flow(
        'main',
        '主流程',
        [
          node('x', '实现功能', B.id, '实现它。', {
            hooks: {
              start: { kind: 'sub', id: 'prep' },
              review: { kind: 'sub', id: 'rv' },
              end: { kind: 'sub', id: 'post' },
              maxRounds: 3,
            },
          }),
          node('y', '跑小流程', '', '', { kind: 'flow', flow: { kind: 'workflow', id: small.id } }),
        ],
        [
          ['start', 'x'],
          ['x', 'y'],
          ['y', 'end'],
        ],
      ),
      flow(
        'prep',
        '准备',
        [node('p', '收集资料', C.id, '收集资料。')],
        [
          ['start', 'p'],
          ['p', 'end'],
        ],
      ),
      flow(
        'rv',
        '验收',
        [node('r', '审查', '', '审查改动。')],
        [
          ['start', 'r'],
          ['r', 'end'],
        ],
      ),
      flow(
        'post',
        '收尾',
        [node('q', '写说明', C.id, '写变更说明。')],
        [
          ['start', 'q'],
          ['q', 'end'],
        ],
      ),
    ],
  })
  await call('PUT', `/projects/${project.id}`, { ...project, workflowId: hooked.id })
  const before2 = calls().length
  let h = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: '带入口的任务' })
  h = await waitDone(h.id)
  assert.equal(h.status, 'done', JSON.stringify(h.messages.filter((m) => m.role === 'system')))
  assert.deepEqual(
    h.steps.map((s) => [s.id, s.status]),
    [
      ['x', 'done'],
      ['y', 'done'],
      ['x/start/p', 'done'],
      ['x/review.1/r', 'done'],
      ['x/review.2/r', 'done'],
      ['x/end/q', 'done'],
      ['y/body/s', 'done'],
    ],
  )
  const x = h.steps.find((s) => s.id === 'x')
  assert.equal(x.rounds, 2)
  assert.equal(x.verdict, 'pass')
  assert.match(x.output, /结束流程的结果/)
  const hc = calls().slice(before2)
  assert.deepEqual(
    hc.map((k) => k.kind),
    // 节点都用默认 CLI（claude）执行
    Array(7).fill('claude'),
  )
  assert.match(hc[1].input, /开始流程的结果[\s\S]*的回复/)
  assert.match(hc[2].input, /实现功能」的验收流程（第 1 轮验收）[\s\S]*验收结论/)
  assert.ok(hc[3].args.includes('--resume'), '验收不通过后续接节点的会话继续完善')
  assert.match(hc[3].input, /验收没有通过（第 1 轮）[\s\S]*验收结论：不通过/)
  assert.match(hc[4].input, /第 2 轮验收/)
  // 第 2 轮验收续接第 1 轮验收的会话，只交修改后的结果，不再重复整段需求
  assert.equal(hc[4].args[hc[4].args.indexOf('--resume') + 1], h.sessions['x/review.1/r'], '验收续接上一轮的会话')
  assert.ok(!/## 用户需求/.test(hc[4].input) && /修改后的结果/.test(hc[4].input))
  assert.match(hc[6].input, /工作流「小流程」[\s\S]*上游节点的结果|工作流「小流程」[\s\S]*## 输入/)
  assert.ok(h.messages.some((m) => m.role === 'system' && /第 1 轮验收未通过/.test(m.text)))
  assert.ok(
    h.messages.some((m) => m.step === 'x/review.1/r'),
    '子节点的消息记在子节点上',
  )
  // 验收轮数用完仍不通过时节点失败
  await call('PUT', `/workflows/${hooked.id}`, {
    ...hooked,
    flows: hooked.flows.map((f) =>
      f.id !== 'main'
        ? f
        : {
            ...f,
            nodes: f.nodes.map((n) =>
              n.id === 'x' ? { ...n, hooks: { ...n.hooks, start: null, end: null, maxRounds: 1 } } : n,
            ),
          },
    ),
  })
  let h2 = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: '只验收一轮' })
  h2 = await waitDone(h2.id)
  assert.equal(h2.status, 'failed')
  assert.match(
    h2.messages
      .filter((m) => m.error)
      .map((m) => m.text)
      .join('\n'),
    /验收 1 轮仍未通过/,
  )
  assert.deepEqual(
    h2.steps.filter((s) => !s.parentId).map((s) => s.status),
    ['failed', 'pending'],
  )
  // 保存时拦下有问题的流程图：自己调用自己、节点连成环
  await assert.rejects(
    call('POST', '/workflows', {
      name: '自引用',
      mainAgentId: A.id,
      members: [],
      entryFlowId: 'main',
      document: '',
      flows: [
        flow(
          'main',
          '',
          [node('z', '套娃', '', '', { kind: 'flow', flow: { kind: 'sub', id: 'main' } })],
          [
            ['start', 'z'],
            ['z', 'end'],
          ],
        ),
      ],
    }),
    /循环调用/,
  )
  await assert.rejects(
    call('POST', '/workflows', {
      name: '成环',
      mainAgentId: A.id,
      members: [],
      entryFlowId: 'main',
      document: '',
      flows: [
        flow(
          'main',
          '',
          [node('p', '甲', ''), node('q', '乙', '')],
          [
            ['start', 'p'],
            ['p', 'q'],
            ['q', 'p'],
          ],
        ),
      ],
    }),
    /连成了环/,
  )
  await call('PUT', `/projects/${project.id}`, { ...project, workflowId: wf.id })
  step('节点入口：开始流程的结果交给节点，验收不通过退回完善、轮数用完失败，结束流程、流程节点、引用其他工作流都能执行')

  // ---- 系统默认 CLI 和模型档位 ----
  await call('PUT', '/settings', {
    ...settings,
    defaultCli: 'codex',
    clis: { ...settings.clis, codex: cli({ tiers: { high: 'gpt-top', medium: '', low: '' } }) },
  })
  const D = await agent({ name: '默认', cli: '', model: '@high' })
  const L = await agent({ name: '低档', cli: 'claude', model: '@low' })
  assert.equal((await call('GET', '/clis')).find((x) => x.isDefault).id, 'codex')
  for (const [ag, kind, flag, model] of [
    [D, 'codex', '-c', 'model="gpt-top"'],
    // Claude 设置了默认模型 sonnet，低档没填就跟随默认模型
    [L, 'claude', '--model', 'sonnet'],
  ]) {
    let t2 = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: ag.id, prompt: '档位' })
    t2 = await waitDone(t2.id)
    assert.equal(t2.status, 'done', JSON.stringify(t2.messages.at(-1)))
    const k = calls().at(-1)
    assert.equal(k.kind, kind)
    assert.equal(k.args[k.args.indexOf(flag) + 1], model)
    if (kind === 'codex') assert.ok(k.args.includes('model_reasoning_effort="high"'), '档位带上思考强度')
    else assert.equal(k.args[k.args.indexOf('--effort') + 1], 'low')
  }
  // 中档没填时用内置建议值
  await call('PUT', '/agents/' + D.id, { ...D, model: '@medium' })
  let t3 = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: D.id, prompt: '档位' })
  t3 = await waitDone(t3.id)
  assert.ok(calls().at(-1).args.includes('model="gpt-6.1-sol"'))
  // 跟随默认 CLI 的 Agent：默认 CLI 换成 Command Code 后跟着换，档位换成它的模型，它不支持的思考强度改用档位的
  await call('PUT', '/agents/' + D.id, { ...D, model: '@high', effort: 'xhigh' })
  await call('PUT', '/settings', {
    ...settings,
    defaultCli: 'commandcode',
    clis: {
      ...settings.clis,
      commandcode: cli({ tiers: { high: { model: 'fake/pro', effort: 'high' }, medium: '', low: '' } }),
    },
  })
  await waitDone(
    (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: D.id, prompt: '跟随' })).id,
  )
  const kf = calls().at(-1)
  assert.equal(kf.kind, 'commandcode')
  assert.equal(kf.args[kf.args.indexOf('-m') + 1], 'fake/pro')
  assert.equal(kf.args[kf.args.indexOf('--effort') + 1], 'high', '不支持的思考强度改用档位的')
  // Command Code 没有系统提示词参数：语言规则靠 --mod 生成的 mod 进系统提示词
  assert.ok(kf.args.includes('--mod'), 'Command Code 用 --mod 追加回复语言规则')
  const modFile = kf.args[kf.args.indexOf('--mod') + 1]
  assert.match(readFileSync(modFile, 'utf8'), /## 回复语言/)
  // 提醒在提示词后半段（invoke 还会在这之后追加 read_user_notes / wait_user_message 的用法）
  const remindAt = kf.input.indexOf('回复正文和思考过程继续用中文；代码、命令、日志和报错原文不翻译。')
  assert.ok(remindAt > kf.input.lastIndexOf('## 执行方式'), '提示词后半段带语言提醒')
  // 设置了具体的默认模型后，没填的档位跟随默认模型
  await call('PUT', '/agents/' + D.id, { ...D, model: '@medium', effort: '' })
  await call('PUT', '/settings', {
    ...settings,
    defaultCli: 'codex',
    clis: {
      ...settings.clis,
      codex: cli({ defaultModel: 'gpt-def', tiers: { high: 'gpt-top', medium: '', low: '' } }),
    },
  })
  t3 = await waitDone(
    (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: D.id, prompt: '档位' })).id,
  )
  assert.ok(calls().at(-1).args.includes('model="gpt-def"'), '空档位跟随默认模型')
  // Agent 自己的权限覆盖 CLI 设置；换了 CLI 不认的旧值时跟随设置
  await call('PUT', '/agents/' + L.id, { ...L, permission: 'plan' })
  await waitDone(
    (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: L.id, prompt: '权限' })).id,
  )
  let pk = calls().at(-1).args
  assert.equal(pk[pk.indexOf('--permission-mode') + 1], 'plan', 'Agent 指定的权限')
  await call('PUT', '/agents/' + L.id, { ...L, permission: 'read-only' })
  await waitDone(
    (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: L.id, prompt: '权限' })).id,
  )
  pk = calls().at(-1).args
  assert.equal(pk[pk.indexOf('--permission-mode') + 1], 'acceptEdits', 'CLI 不支持的权限跟随设置')
  const runWith = async (ag, permission) => {
    await call('PUT', '/agents/' + ag.id, { ...ag, permission })
    await waitDone(
      (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: ag.id, prompt: '权限' })).id,
    )
    return calls().at(-1)
  }
  pk = (await runWith(L, 'default')).args
  assert.equal(pk[pk.indexOf('--permission-mode') + 1], 'default', '逐项确认明确传 default，不沿用 Claude 自己的设置')
  assert.ok(pk.includes('--permission-prompt-tool'), '需要确认的操作交给面板')
  pk = (await runWith(L, 'bypassPermissions')).args
  assert.ok(pk.includes('--dangerously-skip-permissions'), '跳过所有确认')
  // 跳过确认不等于关掉提问：少了 --permission-prompt-tool，Claude Code 不把 AskUserQuestion 放进工具列表，
  // 模型的提问只能变成纯文本。fake-cli 照这个行为模拟，所以下面这轮等不到卡片就说明参数又丢了
  assert.ok(pk.includes('--permission-prompt-tool'), '跳过确认也要保留提问通道')
  ask = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: L.id,
    prompt: 'ASK 跳过确认也提问',
    askUser: true,
  })
  const rSkip = await waitReq()
  assert.equal(rSkip.kind, 'question', '跳过确认时提问照样弹出卡片')
  await call('POST', `/tasks/${ask.id}/requests/${rSkip.id}`, { allow: true, answers: ['SQLite', '加'] })
  assert.equal((await waitDone(ask.id)).status, 'done')
  step('跳过所有确认时提问通道还在：提问照样弹出卡片')
  await call('PUT', '/agents/' + L.id, { ...L, permission: '' })
  let ck = await runWith(B, 'danger-full-access')
  assert.deepEqual([ck.approval, ck.sandbox], ['never', 'danger-full-access'], 'Codex 完全访问：不用沙箱、不确认')
  assert.ok(ck.args.includes('approval_policy="never"') && ck.args.includes('sandbox_mode="danger-full-access"'))
  ck = await runWith(B, 'read-only')
  assert.deepEqual([ck.approval, ck.sandbox], ['on-request', 'read-only'], 'Codex 只读')
  await call('PUT', '/agents/' + B.id, { ...B, permission: '' })
  await call('PUT', '/settings', settings)

  // ---- 附件和 @ 引用项目文件 ----
  const att = await call('POST', '/uploads', {
    name: '截图.png',
    mime: 'image/png',
    data: Buffer.from('png!').toString('base64'),
  })
  assert.equal(att.size, 4)
  assert.ok(att.path.startsWith(path.join(dataDir, 'uploads')), '附件存在数据目录里')
  const rawRes = await fetch(`${base}/uploads/raw?path=${encodeURIComponent(att.path)}`)
  assert.equal(rawRes.headers.get('content-type'), 'image/png')
  assert.equal(await rawRes.text(), 'png!')
  assert.equal(
    (await fetch(`${base}/uploads/raw?path=${encodeURIComponent(path.join(projectDir, 'README.md'))}`)).status,
    400,
    '不能读附件目录以外的文件',
  )
  let tAtt = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: L.id,
    prompt: '看看这张图',
    attachments: [att],
  })
  tAtt = await waitDone(tAtt.id)
  assert.deepEqual(
    tAtt.messages[0].attachments.map((a) => a.name),
    ['截图.png'],
  )
  assert.equal(tAtt.messages[0].text, '看看这张图', '附件不写进消息正文')
  const kAtt = calls().at(-1)
  assert.match(
    kAtt.input,
    /## 附件[\s\S]*截图\.png：截图\.png（对话目录里的图片，相对路径）/,
    '图片给的是对话目录里的相对文件名',
  )
  assert.ok(existsSync(path.join(projectDir, '截图.png')), '图片直接拷在对话目录根下')
  assert.equal(kAtt.args[kAtt.args.indexOf('--add-dir') + 1], path.join(dataDir, 'uploads'))
  assert.deepEqual(await call('GET', `/projects/${project.id}/files?q=read`), ['README.md'])
  // 非图片的文件不再拷进对话目录：只在 uploads 里有一份，交给 Agent 的是原来的绝对路径
  const doc = await call('POST', '/uploads', {
    name: '需求.txt',
    mime: 'text/plain',
    data: Buffer.from('需求内容').toString('base64'),
  })
  let tDoc = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: L.id,
    prompt: '按这个改',
    attachments: [doc],
  })
  tDoc = await waitDone(tDoc.id)
  const kDoc = calls().at(-1)
  const docSection = kDoc.input.slice(kDoc.input.indexOf('## 附件'))
  assert.ok(docSection.includes(`- 需求.txt：${doc.path}`), `交给 Agent 的是原来的绝对路径：${docSection}`)
  assert.ok(!docSection.includes('attachments/需求.txt'), '不给相对路径')
  assert.ok(!existsSync(path.join(projectDir, '需求.txt')), '文本文件不拷进对话目录')
  // 文件浏览：根信息不带全量文件，列一层才读一层，名称搜索能搜到还没展开的深层文件
  {
    mkdirSync(path.join(projectDir, 'src/api'), { recursive: true })
    writeFileSync(path.join(projectDir, 'src/api/deep-cart.ts'), 'export {}\n')
    const info = await call('GET', `/project-files/${project.id}`)
    assert.deepEqual(Object.keys(info).sort(), ['branch', 'dir', 'isGit'], '根信息不再返回全量文件')
    const root = await call('GET', `/project-files/${project.id}/list`)
    assert.ok(
      root.entries.some((e) => e.name === 'src' && e.kind === 'dir'),
      JSON.stringify(root.entries),
    )
    assert.ok(root.entries.some((e) => e.name === 'README.md' && e.kind === 'file'))
    assert.ok(!root.entries.some((e) => e.path.includes('/')), '第一层不展开子目录')
    // 未展开的深层文件也能按名字搜到
    const found = await call('GET', `/project-files/${project.id}/search?mode=name&q=deep-cart`)
    assert.deepEqual(
      found.files.map((f) => f.path),
      ['src/api/deep-cart.ts'],
    )
    // 未跟踪的文件带 ? 状态；越权路径按错误返回
    assert.equal(found.files[0].status, '?')
    const level = await call('GET', `/project-files/${project.id}/list?path=src`)
    assert.equal(level.entries.find((e) => e.path === 'src/api').kind, 'dir')
    const escaped = await fetch(`${base}/project-files/${project.id}/list?path=${encodeURIComponent('../..')}`)
    assert.equal(escaped.status, 404, '不能列到项目目录外面')
    // 任务目录同样按层读
    const tLevel = await call('GET', `/tasks/${tAtt.id}/files/list`)
    assert.ok(tLevel.entries.some((e) => e.name === 'README.md'))
    const tInfo = await call('GET', `/tasks/${tAtt.id}/files`)
    assert.deepEqual(Object.keys(tInfo).sort(), ['branch', 'dir', 'isGit'])
    // 在系统里打开：文件、目录、空路径（项目目录）都接受，越权路径被拒绝
    // 机器上没有文件管理器（WSL 默认没有 xdg-open）时必须回带原因的失败，不能静默回 ok
    const revealPost = async (url, body = {}) => {
      const r = await fetch(base + url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: r.status, ...(await r.json()) }
    }
    const revealOk = (r) =>
      r.ok === true || ((r.status === 400 || r.status === 404) && /没能打开|没能在文件夹中显示/.test(r.error ?? ''))
    const fileReveal = await revealPost(`/project-files/${project.id}/reveal?path=README.md`)
    assert.ok(revealOk(fileReveal), JSON.stringify(fileReveal))
    const dirReveal = await revealPost(`/project-files/${project.id}/reveal?path=src`)
    assert.ok(revealOk(dirReveal), JSON.stringify(dirReveal))
    const rootReveal = await revealPost(`/project-files/${project.id}/reveal`)
    assert.ok(revealOk(rootReveal), JSON.stringify(rootReveal))
    // 越权路径要带 JSON 请求体：不带 content-type 的写请求会先被全局中间件以 415 拒掉
    const badReveal = await fetch(`${base}/project-files/${project.id}/reveal?path=${encodeURIComponent('../..')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(badReveal.status, 404, '不能打开项目目录外面的路径')
    assert.match((await badReveal.json()).error, /只能查看项目目录里的文件/)
    const tReveal = await revealPost(`/tasks/${tAtt.id}/reveal`, { path: 'README.md' })
    assert.ok(revealOk(tReveal), JSON.stringify(tReveal))
    const tRootReveal = await revealPost(`/tasks/${tAtt.id}/reveal`)
    assert.ok(revealOk(tRootReveal), `任务目录也能整体打开：${JSON.stringify(tRootReveal)}`)
  }
  step('文件浏览：只列一层、深层名称搜索、越权路径、任务目录同样按层、在系统里打开')
  // Agent 自己提交了改动：仍然算在任务的更改里（和任务开始时的提交比）
  let tCommit = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: A.id,
    prompt: 'COMMIT 改完提交',
  })
  tCommit = await waitDone(tCommit.id)
  assert.ok(tCommit.baseRef, '记下任务开始时的提交')
  assert.deepEqual(
    tCommit.changes.find((c) => c.path === 'committed.txt'),
    { path: 'committed.txt', add: 3, del: 0 },
    '提交了的改动仍然统计在内 ' + JSON.stringify(tCommit.changes),
  )
  // 看一个文件的差异，撤销它的改动（恢复成任务开始时的样子）
  const d = await call('GET', `/tasks/${tCommit.id}/diff?path=committed.txt`)
  assert.ok(d.git && /\+one\n\+two\n\+three/.test(d.diff), '差异里有新增的行 ' + d.diff)
  // 任务记录已经停下，CLI 进程可能还被保活着（live 里还在，随后才释放）：等它释放后再撤销，
  // 不然会撞上 409「任务正在执行」；这不是固定等待，条件一到就继续
  const reverted = await waitFor(
    async () => {
      try {
        return await call('POST', `/tasks/${tCommit.id}/revert`, { path: 'committed.txt' })
      } catch (e) {
        if (/正在执行/.test(String(e))) return null
        throw e
      }
    },
    { label: '任务停下后撤销改动' },
  )
  assert.ok(!existsSync(path.join(projectDir, 'committed.txt')), '任务里新建的文件撤销后删掉')
  assert.ok(!reverted.changes.some((c) => c.path === 'committed.txt'), '撤销后不再算在改动里')
  assert.match(
    await fetch(`${base}/tasks/${tCommit.id}/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '../outside.txt' }),
    }).then((r) => r.text()),
    /不在任务的改动里/,
  )
  // 独立分支：在任务自己的 git worktree 里改，项目目录不动；合并后改动才进项目，丢弃则什么都不留
  // 先退掉上面 Agent 自己做的提交，让项目回到干净的起点（committed.txt 已经撤销掉了）
  git('reset', '-q', '--keep', 'HEAD~1')
  let tIso = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: A.id,
    prompt: 'COMMIT BEGIN_EDIT 在独立分支上改',
    isolate: true,
  })
  assert.equal(tIso.worktree?.state, 'active', '创建对话时就开好独立分支')
  tIso = await waitTask(tIso.id, (t) => existsSync(path.join(t.worktree?.path ?? '/nope', 'committed.txt')))
  assert.equal(tIso.worktree?.state, 'active', '建了独立分支')
  assert.ok(existsSync(path.join(tIso.worktree.path, 'committed.txt')), 'Agent 在独立目录里改')
  assert.ok(!existsSync(path.join(projectDir, 'committed.txt')), '项目目录没被改动')
  assert.ok(
    tIso.changes.some((c) => c.path === 'committed.txt'),
    '改动按独立目录统计',
  )
  assert.match((await call('GET', `/tasks/${tIso.id}/diff?path=committed.txt`)).diff, /\+one/)
  writeFileSync(path.join(tIso.worktree.path, 'later.txt'), 'not committed yet\n')
  // 项目里有个没跟踪的同名文件挡着：合并失败，项目和独立分支都保持原样。
  // 残留自己造，不依赖前面用例写过什么：假 CLI 的输出文件正好就是这个场景
  const blocker = path.join(projectDir, cliOutputFile('claude'))
  clearCliOutputs(projectDir)
  writeFileSync(blocker, 'stale claude output\n')
  const blocked = await fetch(`${base}/tasks/${tIso.id}/worktree/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(blocked.status, 409)
  assert.match((await blocked.json()).error, /claude-output\.txt/, '说明是哪个文件挡住了')
  assert.equal((await call('GET', `/tasks/${tIso.id}`)).worktree.state, 'active', '合并失败时独立分支还在')
  assert.ok(!existsSync(path.join(projectDir, 'committed.txt')), '合并失败时项目目录没被改动')
  rmSync(blocker)
  const merged = await mergeTask(tIso.id, { label: '清掉挡着的残留后合并' })
  assert.equal(merged.task.worktree.state, 'active', '合并后分支和目录留着')
  assert.ok(existsSync(tIso.worktree.path), '合并后独立目录还在')
  const status = (await call('GET', `/tasks/${tIso.id}/worktrees`)).items[0]
  assert.ok(status.merged && status.ahead === 0 && status.dirty === 0, '合并后标成已合并')
  assert.ok(existsSync(path.join(projectDir, 'committed.txt')), '合并后改动进了项目目录')
  assert.ok(existsSync(path.join(projectDir, 'later.txt')), '没提交的改动合并前先提交')
  assert.equal(
    readFileSync(path.join(projectDir, 'pre.txt'), 'utf8'),
    'changed before the task\n',
    '项目里原有的改动保留',
  )
  const removed = await call('POST', `/tasks/${tIso.id}/worktree/discard`)
  assert.equal(removed.worktree.state, 'merged', '合并过的分支删除后记成已合并')
  assert.ok(!existsSync(tIso.worktree.path), '删除后独立目录没了')
  assert.equal(git('branch', '--list', tIso.worktree.branch).toString().trim(), '', '删除后任务分支没了')
  // 退回合并前，免得影响后面的测试（--keep 保留 pre.txt 的未提交改动）
  git('reset', '-q', '--keep', 'HEAD~1')
  let tDrop = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: A.id,
    prompt: 'COMMIT BEGIN_EDIT 这个不要了',
    isolate: true,
  })
  tDrop = await waitTask(tDrop.id, (t) => existsSync(path.join(t.worktree?.path ?? '/nope', 'committed.txt')))
  // 状态变成完成的一瞬间，服务端还没把任务从执行中的列表里放掉：等一下再丢弃
  let dropped
  for (let i = 0; ; i++) {
    try {
      dropped = await call('POST', `/tasks/${tDrop.id}/worktree/discard`)
      break
    } catch (e) {
      if (i >= 30 || !/正在执行/.test(e.message)) throw e
      await sleep(100)
    }
  }
  assert.equal(dropped.worktree.state, 'discarded')
  // 删除分支只写 store 的话，列表接口（读内存里那份任务）还会说 active：侧栏计数、运行区判定跟着错，
  // 下一次 PATCH 还会拿旧 worktree 把 discarded 写回去
  const listedAfterDrop = (await call('GET', '/tasks')).find((x) => x.id === tDrop.id)
  assert.equal(listedAfterDrop?.worktree?.state, 'discarded', '删除独立分支后列表接口读到的也是已删除')
  assert.ok(!existsSync(tDrop.worktree.path) && !existsSync(path.join(projectDir, 'committed.txt')), '丢弃后什么都不留')
  assert.equal(git('branch', '--list', tDrop.worktree.branch).toString().trim(), '', '丢弃时删掉任务分支')
  await call('DELETE', `/tasks/${tIso.id}`)
  await call('DELETE', `/tasks/${tDrop.id}`)
  step('独立分支：任务在 git worktree 里执行，合并或丢弃后清理分支和目录')
  // ---- 合并审查：冲突和「git 自动合上但两边改过同一文件」都要把双方的提交记录交回，能看懂各自为什么这么改 ----
  {
    const before = git('rev-parse', 'HEAD').toString().trim()
    // 假 CLI 在前面用例里往项目目录写了输出文件（未跟踪），独立分支里也有同名的，会挡住合并：先清掉。
    // 清完不用恢复：这些文件是测试留下的垃圾，不属于这个仓库
    clearCliOutputs(projectDir)
    const commit = (...a) => git('-c', 'user.name=t', '-c', 'user.email=t@t', ...a)
    const commitIn = (dir, ...a) => gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a)
    // 专门的多行文件：README 只有一行，两边改动会挤进同一个 hunk，构不出「改不同位置」的场景
    const notePath = path.join(projectDir, 'merge-note.md')
    writeFileSync(notePath, '# 标题\n\n正文\n\n结尾\n')
    commit('add', 'merge-note.md')
    commit('commit', '-qm', '原目录：加一份合并审查用的说明')
    // 场景里改了 merge-note.md、合并提交也进了项目：测完退回原样，后面的用例不受影响
    const restore = () => {
      git('checkout', '-q', '--', 'merge-note.md')
      git('reset', '-q', '--keep', before)
      rmSync(notePath, { force: true })
      rmSync(path.join(projectDir, 'committed.txt'), { force: true })
    }
    let tOverlap
    let tConflict
    try {
      // 重叠不冲突：两边改同一个文件的不同位置，git 会自动合上不报冲突
      tOverlap = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: A.id,
        prompt: 'COMMIT BEGIN_EDIT 重叠合并',
        isolate: true,
      })
      tOverlap = await waitTask(tOverlap.id, (t) => existsSync(path.join(t.worktree?.path ?? '/nope', 'committed.txt')))
      writeFileSync(path.join(tOverlap.worktree.path, 'merge-note.md'), '# 分支改的标题\n\n正文\n\n结尾\n')
      commitIn(tOverlap.worktree.path, 'commit', '-qam', '分支：把标题改成新写法')
      writeFileSync(notePath, '# 标题\n\n原目录改的正文\n\n结尾\n')
      commit('commit', '-qam', '原目录：正文补一段说明')
      const merged = await mergeTask(tOverlap.id, { label: '重叠不冲突时合并' })
      assert.deepEqual(merged.overlap, ['merge-note.md'], '两边都改过的文件要交出来：自动合上也可能互相盖掉')
      assert.ok(
        merged.sides?.into?.commits?.some((c) => c.includes('原目录：正文补一段说明')),
        '带上原分支的提交记录 ' + JSON.stringify(merged.sides),
      )
      assert.ok(
        merged.sides?.by?.commits?.some((c) => c.includes('分支：把标题改成新写法')),
        '带上独立分支的提交记录 ' + JSON.stringify(merged.sides),
      )
      const note = (await call('GET', `/tasks/${tOverlap.id}`)).messages.filter((m) => m.role === 'system').at(-1)
      assert.match(note.text, /必须逐文件核对/, '重叠不冲突也要求核对有没有盖掉对方的改动')
      assert.match(note.text, /双方的提交记录/, '核对要有双方的提交记录作依据')
      const text = readFileSync(notePath, 'utf8')
      assert.match(text, /分支改的标题[\s\S]*原目录改的正文/, '两边改动都在，没有互相盖掉')

      // 真冲突：两边改 merge-note.md 的同一行（标题那行）
      tConflict = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: A.id,
        prompt: 'COMMIT BEGIN_EDIT 冲突合并',
        isolate: true,
      })
      tConflict = await waitTask(tConflict.id, (t) =>
        existsSync(path.join(t.worktree?.path ?? '/nope', 'committed.txt')),
      )
      writeFileSync(path.join(tConflict.worktree.path, 'merge-note.md'), '# 分支版本\n\n正文\n\n结尾\n')
      commitIn(tConflict.worktree.path, 'commit', '-qam', '分支：标题换成分支版本')
      writeFileSync(notePath, '# 原目录版本\n\n正文\n\n结尾\n')
      commit('commit', '-qam', '原目录：标题换成原目录版本')
      const conflict = await call('POST', `/tasks/${tConflict.id}/worktree/merge`).catch((e) => e)
      assert.ok(conflict instanceof Error, '冲突时合并失败')
      assert.match(conflict.message, /双方的提交记录/, '冲突时也要交出双方的提交记录')
      assert.match(conflict.message, /原目录：标题换成原目录版本/, '列出原分支的提交说明')
      assert.match(conflict.message, /分支：标题换成分支版本/, '列出独立分支的提交说明')
      assert.match(conflict.message, /必须逐文件核对/, '会冲突的文件也要逐处核对')
      assert.equal(readFileSync(notePath, 'utf8'), '# 原目录版本\n\n正文\n\n结尾\n', '冲突撤回，项目目录没被改')
    } finally {
      restore()
      for (const x of [tOverlap, tConflict]) {
        if (!x) continue
        await call('POST', `/tasks/${x.id}/worktree/discard`).catch(() => {})
        await call('DELETE', `/tasks/${x.id}`).catch(() => {})
      }
    }
    step('合并审查：冲突和自动合上的重叠文件都把双方提交记录交回，要求逐文件核对')
  }
  // Agent 输出里提到的文件可以点开看：只能读项目目录里的
  const rd = await call('GET', `/tasks/${tCommit.id}/file?path=README.md`)
  assert.equal(rd.content, '# demo\n')
  assert.equal((await call('GET', `/tasks/${tCommit.id}/file?path=nope.ts`)).exists, false)
  assert.equal((await fetch(`${base}/tasks/${tCommit.id}/file?path=../../etc/passwd`)).status, 400)
  // 读到的文件是图片时按原图查看，同样只能读项目目录里的
  writeFileSync(path.join(projectDir, 'shot.png'), PNG_1PX)
  const img = await fetch(`${base}/tasks/${tCommit.id}/file/raw?path=shot.png`)
  assert.equal(img.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG_1PX)
  assert.equal((await fetch(`${base}/tasks/${tCommit.id}/file/raw?path=README.md`)).status, 400, '不是图片不能当图片读')
  assert.equal((await fetch(`${base}/tasks/${tCommit.id}/file/raw?path=../../etc/passwd`)).status, 400)
  // 删除先进回收站：附件也留着（恢复后还要用）；永久删除时才一起删掉
  const attDir = path.dirname(att.path)
  await call('DELETE', `/tasks/${tAtt.id}`)
  assert.ok(existsSync(attDir), '进回收站时它的附件还留着')
  await call('DELETE', `/tasks/${tAtt.id}/permanent`)
  assert.ok(!existsSync(attDir), '永久删除时删掉它的附件')
  // 还在用的附件不会因为时间久了被清理
  // 再传一个还没发出去的附件，后面数据目录的统计要用
  await call('POST', '/uploads', {
    name: '草稿.txt',
    mime: 'text/plain',
    data: Buffer.from('draft').toString('base64'),
  })
  step('附件：上传到数据目录、交给 Agent 读取；@ 能搜到项目里的文件；删除任务时一起删掉')
  // 用户数据目录：旧的平铺文件搬进子目录，按类查看占用、清理缓存，导出再导入原样恢复
  assert.ok(existsSync(path.join(dataDir, 'config/project-categories.json')), '旧的平铺文件搬进 config/')
  assert.ok(!existsSync(path.join(dataDir, 'project-categories.json')))
  // 项目分类：新装/升级时补齐一组内置分类，删内置的会被拒绝；自建分类还是能删
  const cats = await call('GET', '/project-categories')
  assert.equal(cats.filter((c) => c.builtin).length, 5, '自带一组内置项目分类')
  const delBuiltin = await fetch(`${base}/project-categories/${cats.find((c) => c.builtin).id}`, {
    method: 'DELETE',
    // 服务端要求非 GET 请求带 JSON 的 content-type，不带会被中间件当成 415
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(delBuiltin.status, 409, '内置分类不能删')
  assert.match((await delBuiltin.json()).error, /内置分类不能删除/)
  const mine = await call('POST', '/project-categories', { name: '临时分类', description: '', workflowId: '' })
  assert.equal(mine.builtin, false, '自建分类不带内置标记')
  await call('DELETE', `/project-categories/${mine.id}`)
  assert.ok(!(await call('GET', '/project-categories')).some((c) => c.id === mine.id), '自建分类删得掉')
  // 任务按项目分目录，任务文件里只有用户的消息，完整对话在 .messages.json 里，打开任务时才读
  const legacyFile = path.join(dataDir, 'tasks/projects/legacy-project/legacy-1.json')
  assert.ok(existsSync(legacyFile), '旧的 tasks.json 拆成按项目分目录的任务文件')
  assert.ok(existsSync(path.join(dataDir, 'tasks/projects/legacy-project/legacy-1.messages.json')))
  assert.ok(!existsSync(path.join(dataDir, 'tasks/tasks.json')))
  assert.equal((await call('GET', '/tasks/legacy-1')).messages[0].text, '旧的要求')
  assert.ok(!existsSync(path.join(dataDir, 'tasks/items')), '上一版的 items 目录转换后删掉')
  const chatMeta = JSON.parse(readFileSync(path.join(dataDir, 'tasks/chats/legacy-2.json'), 'utf8'))
  assert.deepEqual(
    chatMeta.messages.map((m) => m.text),
    ['旧的聊天'],
    '任务文件里只放用户消息',
  )
  assert.deepEqual(
    (await call('GET', '/tasks/legacy-2')).messages.map((m) => m.text),
    ['旧的聊天', '旧的回答'],
  )
  assert.equal((await call('GET', '/tasks')).find((x) => x.id === 'legacy-2').messages[0].text, '旧的聊天')
  // 刚跑完的任务：对话在 .messages.json 里
  const wfFile = path.join(dataDir, `tasks/projects/${project.id}/${t.id}.messages.json`)
  assert.ok(JSON.parse(readFileSync(wfFile, 'utf8')).some((m) => m.role === 'agent'))
  const usage = await call('GET', '/data')
  assert.equal(usage.dir, dataDir)
  const kindOf = (u, k) => u.kinds.find((x) => x.id === k)
  assert.ok(kindOf(usage, 'tasks').bytes > 0 && kindOf(usage, 'uploads').files >= 1 && usage.memory.rss > 0)
  // 拆分旧任务文件时，原文件备份在缓存里
  assert.ok(kindOf(usage, 'cache').files >= 1, '旧的 tasks.json 备份在缓存里')
  const cacheBefore = kindOf(usage, 'cache').bytes
  mkdirSync(path.join(dataDir, 'cache/junk'), { recursive: true })
  writeFileSync(path.join(dataDir, 'cache/junk/x.bin'), 'x'.repeat(100))
  assert.equal(kindOf(await call('GET', '/data'), 'cache').bytes, cacheBefore + 100)
  await call('POST', '/data/clear', { kind: 'cache' })
  assert.equal(kindOf(await call('GET', '/data'), 'cache').files, 0, '缓存清理掉了')
  assert.equal(
    (
      await fetch(`${base}/data/clear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"kind":"config"}',
      })
    ).status,
    400,
    '配置不能清理',
  )
  const backup = await call('GET', '/data/export?kinds=config,projects,tasks')
  assert.ok(
    backup.files['config/agents.json'] &&
      backup.files['tasks/projects/legacy-project/legacy-1.json'] &&
      !backup.files['uploads'],
  )
  const agentsBefore = await call('GET', '/agents')
  const tasksBefore = (await call('GET', '/tasks')).length
  await call('DELETE', `/agents/${agentsBefore.at(-1).id}`).catch(() => {})
  await call('POST', '/data/clear', { kind: 'tasks' })
  assert.equal((await call('GET', '/tasks')).length, 0, '清理任务记录后马上生效')
  const imported = await call('POST', '/data/import', backup)
  assert.equal(imported.files, Object.keys(backup.files).length)
  assert.deepEqual(
    (await call('GET', '/agents')).map((a) => a.id),
    agentsBefore.map((a) => a.id),
    '导入后 Agent 恢复',
  )
  assert.equal((await call('GET', '/tasks')).length, tasksBefore, '导入后任务记录恢复')
  const evil = { ...backup, kinds: ['tasks'], files: { '../escape.json': 'e30=' } }
  assert.equal(
    (
      await fetch(`${base}/data/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(evil),
      })
    ).status,
    400,
    '不能写到数据目录外',
  )
  assert.ok(!existsSync(path.join(tmp, 'escape.json')))
  step('数据目录：旧文件迁移、占用统计、清理、导出导入')
})
