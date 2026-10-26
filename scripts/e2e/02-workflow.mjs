/**
 * 端到端测试分片：按连线执行、输出/工具/改动/用量、列表推送、调用参数、节点交接、追加要求
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs），
 * 互不影响。总入口 scripts/e2e.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

import path from 'node:path'
import { runShard } from './harness.mjs'

await runShard('工作流任务', async (api) => {
  const { baseUrl: base, projectDir, call, sleep, waitDone, calls, step, setupBase } = api
  const { project, wf, A, B, C } = await setupBase()
  // ---- 工作流任务 ----
  let t = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: '做一个新功能' })
  assert.equal(t.status, 'running')
  t = await waitDone(t.id)
  assert.equal(t.status, 'done', JSON.stringify(t.messages.filter((m) => m.role === 'system')))
  assert.equal(t.simulated, false)
  assert.deepEqual(
    t.steps.map((s) => [s.id, s.status]),
    [
      ['n1', 'done'],
      ['n2', 'done'],
      ['n3', 'done'],
      ['n4', 'done'],
    ],
    '没连到开始的节点不执行',
  )
  assert.ok(t.steps.every((s) => s.startedAt && s.endedAt))
  for (const who of [A, B, C])
    assert.ok(
      t.messages.some((m) => m.agentId === who.id && m.text.includes('的回复')),
      `${who.name} 没有输出文字`,
    )
  const kinds = new Set(t.messages.flatMap((m) => m.tools.map((x) => x.kind)))
  for (const k of ['read', 'edit', 'run']) assert.ok(kinds.has(k), `缺少工具类型 ${k}`)
  // 工作流的节点都用默认 CLI（Claude Code）的档位执行，不看 Agent 自己选的 CLI
  const changed = t.changes.map((c) => c.path).sort()
  assert.deepEqual(changed, ['claude-output.txt'])
  assert.deepEqual(Object.keys(t.sessions).sort(), ['n1', 'n2', 'n3', 'n4'], '每个节点各有自己的会话')
  assert.equal(Object.keys(t.usage.agents).length, 3)
  assert.equal(t.usage.agents[A.id].context, 13020)
  assert.ok(Math.abs(t.usage.costUsd - 0.0123 * 4) < 1e-9)
  // 用量：输入含缓存，缓存命中单独记；流式过程中计入的和最后的总数不重复。四个节点各 25530 输入（25000 命中、500 写入）
  assert.equal(t.usage.inputTokens, 25530 * 4)
  assert.equal(t.usage.cacheReadTokens, 25000 * 4)
  assert.equal(t.usage.cacheWriteTokens, 500 * 4)
  assert.equal(t.usage.outputTokens, 120 * 4)
  assert.equal(t.usage.agents[B.id].window, 500000, 'Claude Code 在 result.modelUsage 里报告的上下文窗口')
  // 每个节点自己的用量和改动：加起来等于任务的
  assert.equal(
    t.steps.reduce((n, s) => n + (s.usage?.inputTokens ?? 0), 0),
    t.usage.inputTokens,
  )
  const codexStep = t.steps.find((s) => s.agentId === B.id)
  assert.equal(codexStep.usage.context, 13020)
  // 节点的命令：默认 CLI、Agent 档位对应的模型；固定了别的 CLI 的 Agent，它的额外参数不带过去
  assert.ok(
    t.steps.every((s) => s.command.includes('--model') && s.command[s.command.indexOf('--model') + 1] === 'sonnet'),
  )
  assert.ok(
    !t.steps.find((s) => s.agentId === C.id).command.includes('low'),
    '丙的 Command Code 参数不带给 Claude Code',
  )
  assert.ok(
    Object.values(t.usage.agents).every((u) => u.tps === 0),
    '结束后速度归零',
  )
  // 思考过程记在回复上
  for (const who of [A, B, C])
    assert.ok(
      t.messages.some((m) => m.agentId === who.id && m.thinking),
      `${who.name} 的思考没有记录`,
    )
  // 待办：Claude 的 TodoWrite
  assert.deepEqual(
    t.todos.filter((x) => x.agentId === A.id).map((x) => [x.text, x.status]),
    [
      ['读代码', 'done'],
      ['正在写文件', 'running'],
    ],
  )
  step('工作流任务：按连线执行，输出、工具、改动（排除任务前的改动）、用量都正确')

  // 列表只给摘要；任务页靠推送（SSE）拿增量，合起来和完整任务一致
  const summary = (await call('GET', '/tasks')).find((x) => x.id === t.id)
  assert.equal(summary.messages.length, 1, '列表里只有第一条要求')
  assert.ok(
    summary.steps.every((s) => s.output === '' && s.command.length === 0),
    '列表里不带节点输出',
  )
  {
    const live = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: '推送测试' })
    const res = await fetch(`${base}/tasks/${live.id}/events`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let view = null
    let patches = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 20000) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const ev = /^event: (.*)$/m.exec(block)?.[1]
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n')
        if (ev === 'full') view = JSON.parse(data)
        else if (ev === 'patch') {
          patches++
          const p = JSON.parse(data)
          const msgs = view.messages.slice()
          for (const m of p.messages) {
            const k = msgs.findIndex((x) => x.id === m.id)
            if (k >= 0) msgs[k] = m
            else msgs.push(m)
          }
          view = { ...p.meta, messages: msgs }
          assert.equal(msgs.length, p.total)
        }
      }
      if (view && view.status !== 'running') break
    }
    await reader.cancel()
    assert.ok(patches > 0, '执行过程中推送了增量')
    const final = await call('GET', `/tasks/${live.id}`)
    assert.equal(view.status, final.status)
    assert.deepEqual(
      view.messages.map((m) => [m.id, m.text]),
      final.messages.map((m) => [m.id, m.text]),
      '增量合起来和完整任务一致',
    )
  }
  // 归档：只是打个标记，列表里带着，取消归档后恢复
  const arch = await call('PATCH', `/tasks/${t.id}`, { archived: true })
  assert.equal(arch.archived, true)
  assert.equal((await call('GET', '/tasks')).find((x) => x.id === t.id).archived, true)
  await call('PATCH', `/tasks/${t.id}`, { archived: false })
  step('任务列表只给摘要，任务页通过推送拿增量；可以归档')

  // 任务存下创建时的工作流：之后改了工作流，老任务的记录不变；继续执行时可以选择改用新的
  {
    assert.equal(t.workflows[0]?.id, wf.id, '任务存下了工作流')
    assert.equal(summary.workflowName, wf.name, '列表里有工作流名字')
    const cur = await call('GET', `/workflows`).then((l) => l.find((x) => x.id === wf.id))
    const { id, createdAt, updatedAt, ...input } = cur
    const renamed = {
      ...input,
      flows: input.flows.map((f) => ({ ...f, nodes: f.nodes.map((n) => ({ ...n, title: `${n.title}（新）` })) })),
    }
    await call('PUT', `/workflows/${wf.id}`, renamed)
    const again = await call('GET', `/tasks/${t.id}`)
    assert.ok(!again.workflows[0].flows[0].nodes.some((n) => n.title.endsWith('（新）')), '老任务的工作流不跟着改')
    await call('PUT', `/workflows/${wf.id}`, input)
  }
  step('任务存下创建时的工作流，之后改工作流不影响老任务')

  let c = calls()
  const [c1, cp1, cp2, c4] = c
  assert.equal(c1.kind, 'claude')
  assert.equal(c1.cwd, projectDir)
  assert.ok(c1.args.includes('--append-system-prompt'))
  const system = c1.args[c1.args.indexOf('--append-system-prompt') + 1] ?? ''
  assert.match(system, /你是甲，负责规划。/)
  // 回复语言规则跟角色说明一起进系统提示词（放在任务描述里时模型不一定遵守）
  assert.match(system, /## 回复语言/)
  assert.ok(c1.args.includes('--model') && c1.args.includes('sonnet'), 'Agent 没写模型时应使用设置里的默认模型')
  assert.ok(c1.args.includes('--permission-mode') && c1.args.includes('acceptEdits'))
  assert.match(c1.input, /流程「主流程」的节点：分析/)
  assert.match(c1.input, /## 本节点要做的事\n先分析。/)
  // 末尾再提醒一次语言（长提示词里中间的规则容易被忽略）：面板工具那行说明插在它前面
  assert.match(c1.input, /回复正文和思考过程继续用中文；代码、命令、日志和报错原文不翻译。$/)
  assert.match(c1.input, /（面板工具）[\s\S]*回复正文和思考过程继续用中文/)
  assert.doesNotMatch(c1.input, /同时进行的节点/)
  // 节点都用默认 CLI：乙（固定 Codex）、丙（固定 Command Code）的节点也交给 Claude Code
  const c2 = [cp1, cp2].find((x) => x.input.includes('节点：实现'))
  const c3 = [cp1, cp2].find((x) => x.input.includes('节点：文档'))
  assert.ok(c2 && c3 && c2.kind === 'claude' && c3.kind === 'claude', '节点固定用默认 CLI')
  // 并发和先后都看引擎记的「节点执行窗口」（step.startedAt/endedAt：startedAt 在 spawn 之前记、endedAt 在节点结束时记），
  // 不看假 CLI 进程的 start/end：那是「进程存活窗口」，CI 上 10 个分片并行时，第二个节点的 node 进程
  // 可能晚到第一个 exit 之后才写日志，两个区间就不重叠了，但引擎确实把两个节点同时放进了 running
  // （shared/engine.ts 的 runFlow：同一阶段 for (const n of ready()) 顺序塞进 running，再 race 等先完成的）。
  // 用节点时间既不会把进程启动慢半拍误判成串行，也能拦住真的串行（串行时下游的 startedAt 会晚于上游的 endedAt）
  const win = (id) => {
    const s = t.steps.find((x) => x.id === id)
    assert.ok(s && s.startedAt && s.endedAt, `节点 ${id} 应该有开始和结束时间`)
    return { start: Date.parse(s.startedAt), end: Date.parse(s.endedAt) }
  }
  const [w1, w2, w3, w4] = ['n1', 'n2', 'n3', 'n4'].map(win)
  // 失败时把引擎节点时间和进程存活窗口一起打出来：下次失败能直接看出是调度真的串行，还是进程启动慢
  const windows =
    `引擎节点窗口：n2 ${w2.start}~${w2.end}，n3 ${w3.start}~${w3.end}，n1 ${w1.start}~${w1.end}，n4 ${w4.start}~${w4.end}` +
    `；进程存活窗口：实现 ${c2.start}~${c2.end}，文档 ${c3.start}~${c3.end}，分析 ${c1.start}~${c1.end}，验收 ${c4.start}~${c4.end}`
  // 要求严格有正重叠（不是端点点触）：真的并发时两个节点同步塞进 running，startedAt 几乎相同，必然重叠；
  // 串行时下游的 startedAt 紧接在上游 endedAt 之后，就只剩点触，这一条会拦住它
  assert.ok(w2.start < w3.end && w3.start < w2.end, `同一阶段的两个节点应该同时运行（${windows}）`)
  assert.ok(Math.min(w2.start, w3.start) >= w1.end, `下游节点要等上游结束（${windows}）`)
  assert.ok(w4.start >= Math.max(w2.end, w3.end), `有两个上游的节点要等两个都结束（${windows}）`)
  assert.ok(c2.args.includes('--append-system-prompt'))
  assert.match(
    c2.args[c2.args.indexOf('--append-system-prompt') + 1] ?? '',
    /你是乙，负责实现。/,
    '角色设定照样交给默认 CLI',
  )
  assert.match(c2.input, /上游节点的结果[\s\S]*### 分析/)
  assert.match(c2.input, /同时进行的节点[\s\S]*文档（丙）/)
  assert.match(c3.input, /同时进行的节点[\s\S]*实现（乙）/)
  assert.ok(!c3.args.includes('low'), '丙写给 Command Code 的额外参数不带给 Claude Code')
  assert.equal(c4.kind, 'claude')
  assert.match(c4.input, /上游节点的结果[\s\S]*### 实现[\s\S]*### 文档/)
  assert.ok(!c4.args.includes('--resume'), '不同节点用各自的新会话')
  // 对话还是用 Agent 自己的 CLI：乙用 Codex，丙用 Command Code
  {
    const n0 = calls().length
    let ct = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: '看看代码' })
    ct = await waitDone(ct.id)
    assert.equal(ct.status, 'done')
    const cx = calls()
      .slice(n0)
      .find((x) => x.kind === 'codex')
    assert.ok(cx, '对话用 Agent 自己的 CLI')
    assert.match(cx.developer, /你是乙，负责实现。/, 'Codex 的角色说明通过 developerInstructions 传入')
    // 回复语言规则也跟角色说明一起交给 Codex
    assert.match(cx.developer, /## 回复语言/)
    assert.ok(!cx.input.includes('## 你的角色'))
    // AI 第一次回复后按对话内容自动起标题（换掉从消息截的那段），只起一次
    let named = ''
    for (let i = 0; i < 100 && !named; i++) {
      const x = await call('GET', `/tasks/${ct.id}`)
      if (x.title !== '看看代码') named = x.title
      else await sleep(100)
    }
    assert.equal(named, '看看代码·AI', 'AI 回复后自动起了标题')
    assert.equal((await call('GET', `/tasks/${ct.id}`)).autoTitle, false, '一个对话只起一次标题')
    assert.equal(cx.args[0], 'app-server', 'Codex 用 app-server 执行才有流式输出')
    assert.ok(cx.args.includes('model="gpt-5.6"'))
    assert.ok(cx.args.includes('approval_policy="on-request"'), '参数里的确认方式和 thread/start 一致')
    assert.deepEqual(
      [cx.approval, cx.sandbox],
      ['on-request', 'workspace-write'],
      '可写项目目录：沙箱内运行，越过沙箱时确认',
    )
    await call('DELETE', `/tasks/${ct.id}`)
    const n1 = calls().length
    let cc = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: C.id, prompt: '写文档' })
    cc = await waitDone(cc.id)
    const cm = calls()
      .slice(n1)
      .find((x) => x.kind === 'commandcode')
    assert.ok(cm && cm.args.includes('--effort') && cm.args.includes('low'))
    await call('DELETE', `/tasks/${cc.id}`)
  }
  step('调用参数：模型、权限、角色设定、上游结果、同时进行的节点、工作目录都对；没有依赖的节点同时运行')

  // 上游的结果太长：交给下游的只放开头，完整内容存成文件，下游的 CLI 能读到那个目录
  const nLong = calls().length
  let tLong = await call('POST', '/tasks', { projectId: project.id, mode: 'workflow', prompt: 'LONGOUT 写个详细方案' })
  tLong = await waitDone(tLong.id)
  assert.equal(tLong.status, 'done')
  const down = calls()
    .slice(nLong)
    .find((x) => x.input.includes('节点：实现'))
  const handoff = /完整内容在文件 (\S+?\.md)/.exec(down.input)?.[1]
  assert.ok(handoff && existsSync(handoff), '下游拿到完整结果的文件路径 ' + down.input.slice(-300))
  assert.ok(readFileSync(handoff, 'utf8').includes('很长的方案。'.repeat(1000) + '结尾'), '文件里是完整结果')
  assert.ok(!down.input.includes('结尾'), '提示里只放开头')
  const cLong = calls()
    .slice(nLong)
    .find((x) => x.kind === 'claude' && x.input.includes('上游节点的结果'))
  assert.ok(cLong.args.includes(path.dirname(handoff)), 'Claude Code 能读交接文件的目录')
  await call('DELETE', `/tasks/${tLong.id}`)
  assert.ok(!existsSync(path.dirname(handoff)), '删除任务时删掉交接文件')
  step('节点交接：上游结果太长时完整内容存成文件，下游按路径去读')

  // ---- 追加要求：主 Agent 续接会话 ----
  await call('POST', `/tasks/${t.id}/messages`, { text: '按钮改成红色' })
  t = await waitDone(t.id)
  assert.equal(t.status, 'done')
  c = calls().at(-1)
  assert.equal(c.kind, 'claude')
  assert.ok(
    c.args.includes('--resume') && c.args.includes(t.sessions.n4),
    '追加要求应该续接主 Agent 最后执行的节点的会话',
  )
  assert.equal(t.sessions[A.id], t.sessions.n4)
  assert.match(c.input, /按钮改成红色/)
  step('追加要求：由主 Agent 续接会话处理')
})
