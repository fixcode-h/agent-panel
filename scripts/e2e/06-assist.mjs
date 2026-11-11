/**
 * 端到端测试分片：旧格式转换、AI 创建 Agent/工作流、风格库、浏览器扩展（UI 设计在 UI 设计插件的仓库里测）
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs），
 * 互不影响。总入口 scripts/e2e.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { runShard } from './harness.mjs'

await runShard('AI 创建与风格库', async (api) => {
  const { baseUrl: base, dataDir, projectDir, call, sleep, calls, step, setupBase } = api
  const { A, B, node, flow } = await setupBase()
  // AI 创建的工作流会引用一个已有的工作流「小流程」：这个分片自己建一个，
  // 不去依赖别的分片跑过什么
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
  // 旧格式（阶段）的工作流自动转换成连线
  const old = await call('POST', '/workflows', {
    name: '旧格式',
    mainAgentId: A.id,
    members: [],
    document: '',
    stages: [
      { id: 's1', title: '', nodes: [{ id: 'o1', title: '一' }] },
      {
        id: 's2',
        title: '',
        nodes: [
          { id: 'o2', title: '二' },
          { id: 'o3', title: '三' },
        ],
      },
    ],
  })
  assert.equal(old.flows.length, 1)
  assert.deepEqual(old.flows[0].edges.map((e) => `${e.from}>${e.to}`).sort(), [
    'o1>o2',
    'o1>o3',
    'o2>end',
    'o3>end',
    'start>o1',
  ])
  step('系统默认 CLI 和模型档位：执行时换成设置里的 CLI 和对应模型和思考强度；Agent 权限覆盖设置；旧格式工作流自动转换')

  // ---- AI 创建 / 优化 ----
  async function assistDone(job) {
    for (let i = 0; job.status === 'running'; i++) {
      if (i > 100) throw new Error('AI 创建超时')
      await sleep(100)
      job = await call('GET', `/assist/${job.id}`)
    }
    return job
  }
  const assist = (kind, text, extra = {}) =>
    call('POST', '/assist', {
      kind,
      targetId: '',
      cli: 'claude',
      model: '',
      messages: [{ role: 'user', text }],
      ...extra,
    }).then(assistDone)
  const draftAgent = {
    name: '审查员',
    description: '审查改动',
    cli: 'codex',
    model: 'gpt-5.6',
    icon: 'shield',
    // 启动时会装上内置项目工作流，用的 Agent 已经建出了「质量」分类；这里用一个肯定不会有的
    category: '自定义分类',
    instructions: '## 职责\n审查',
  }
  let job = await assist('agent', `要一个审查员\nFAKE_JSON:${JSON.stringify(draftAgent)}`)
  assert.equal(job.status, 'done', job.error)
  assert.equal(job.text, '这是按你的要求生成的配置。')
  assert.equal(job.proposal.agent.cli, 'codex')
  assert.equal(job.proposal.newCategory, '自定义分类', '不存在的分类标记为新建')
  const c = calls().at(-1)
  assert.match(c.input, /配置助手[\s\S]*## 已有的 Agent[\s\S]*甲（claude[\s\S]*## 创建规则[\s\S]*## 输出格式/)
  // 权限按设置里的；Claude Code 的审批交给面板（弹出卡片），不再一律拒绝
  if (c.kind === 'claude') assert.ok(c.args.includes('--permission-prompt-tool'), '审批交给面板')
  assert.notEqual(c.cwd, projectDir, '不在项目目录里运行')
  // 第一次格式不对，自动让 CLI 修正
  job = await assist(
    'agent',
    `FAKE_JSON:${JSON.stringify({ ...draftAgent, cli: 'nope' })}\nFAKE_JSON2:${JSON.stringify(draftAgent)}`,
  )
  assert.equal(job.status, 'done', job.error)
  assert.equal(job.attempt, 2)
  assert.match(calls().at(-1).input, /不符合要求[\s\S]*nope/)
  // Pi 的工具调用开始时就标成运行中：结果回来后要收掉，不然 AI 创建 / 分析里的工具行一直转圈
  job = await assist('agent', `FAKE_JSON:${JSON.stringify(draftAgent)}`, { cli: 'pi' })
  assert.equal(job.status, 'done', job.error)
  const piTools = job.messages.flatMap((m) => m.tools)
  assert.ok(piTools.length >= 2, '工具调用显示出来')
  assert.deepEqual(
    piTools.filter((x) => x.running).map((x) => x.label),
    [],
    '工具结束后不再显示运行中',
  )
  // 两次都不对时失败并说明原因
  job = await assist('agent', `FAKE_JSON:${JSON.stringify({ ...draftAgent, name: '甲' })}`)
  assert.equal(job.status, 'failed')
  assert.match(job.error, /两次都没有按格式输出[\s\S]*已经有叫「甲」/)
  // 优化已有 Agent：把当前配置给 CLI
  job = await assist('agent', `FAKE_JSON:${JSON.stringify({ ...draftAgent, name: '甲' })}`, { targetId: A.id })
  assert.equal(job.status, 'done', job.error)
  assert.match(calls().at(-1).input, /优化一个已有的Agent[\s\S]*## 当前的Agent[\s\S]*你是甲，负责规划/)
  // 工作流：引用已有 Agent 和新建的 Agent，校验阶段和节点
  const draftWf = {
    name: 'AI 流程',
    description: '',
    mainAgent: '甲',
    members: [{ agent: '乙', responsibility: '实现' }],
    newAgents: [draftAgent],
    flows: [
      {
        name: '主流程',
        main: true,
        nodes: [
          { key: 'a', title: '实现', agent: '乙', instructions: '写代码', review: '复核' },
          { key: 'b', title: '审查', agent: '审查员', instructions: '审查' },
          { key: 'c', title: '验收', agent: '', instructions: '' },
          { key: 'd', title: '跑小流程', flow: '小流程' },
        ],
        edges: [
          ['start', 'a'],
          ['start', 'b'],
          ['a', 'c'],
          ['b', 'c'],
          ['c', 'd'],
          ['d', 'end'],
        ],
      },
      {
        name: '复核',
        nodes: [{ key: 'r', title: '复核', agent: '甲' }],
        edges: [
          ['start', 'r'],
          ['r', 'end'],
        ],
      },
    ],
    document: '# 目标',
  }
  job = await assist('workflow', `FAKE_JSON:${JSON.stringify(draftWf)}`, { cli: 'codex' })
  assert.equal(job.status, 'done', job.error)
  const w = job.proposal.workflow
  assert.equal(w.mainAgentId, A.id)
  assert.equal(w.flows.length, 2)
  assert.equal(w.entryFlowId, w.flows[0].id)
  const mf = w.flows[0]
  assert.deepEqual(
    mf.nodes.map((n) => n.agentId),
    [B.id, 'new:审查员', '', ''],
  )
  assert.deepEqual(mf.nodes[0].hooks.review, { kind: 'sub', id: w.flows[1].id })
  assert.deepEqual(mf.nodes[3].flow, { kind: 'workflow', id: small.id })
  assert.equal(mf.edges.length, 6)
  assert.ok(mf.nodes[2].x > mf.nodes[0].x, '自动排列：下游节点在右边')
  assert.ok(
    w.members.some((m) => m.agentId === 'new:审查员'),
    '节点用到的 Agent 自动加入团队',
  )
  assert.equal(job.proposal.newAgents[0].ref, 'new:审查员')
  job = await assist('workflow', `FAKE_JSON:${JSON.stringify({ ...draftWf, mainAgent: '不存在' })}`)
  assert.equal(job.status, 'failed')
  assert.match(job.error, /不存在/)
  const badFlow = {
    ...draftWf,
    flows: [
      {
        ...draftWf.flows[0],
        edges: [
          ['start', 'a'],
          ['a', 'c'],
          ['c', 'a'],
        ],
      },
    ],
  }
  job = await assist('workflow', `FAKE_JSON:${JSON.stringify(badFlow)}`)
  assert.equal(job.status, 'failed')
  assert.match(job.error, /形成了环[\s\S]*没有从 start 连过来|没有从 start 连过来[\s\S]*形成了环|形成了环/)
  step('AI 创建：按格式生成、校验、自动修正一次，优化时带上当前配置，工作流解析 Agent 引用')

  // Skill 的 AI 创建 / 优化、MCP 工具的 AI 排查：同一套对话，当前内容由页面带来
  {
    const skillMd = '---\nname: demo-skill\ndescription: 做示例。在用户要示例时使用。\n---\n\n步骤\n'
    job = await assist('skill', `FAKE_JSON:${JSON.stringify({ name: 'demo-skill', content: skillMd })}`)
    assert.equal(job.status, 'done', job.error)
    assert.deepEqual(job.proposal, { kind: 'skill', name: 'demo-skill', content: skillMd })
    // front matter 里的 name 和文件夹名对不上：自动让 CLI 修正一次
    job = await assist(
      'skill',
      `FAKE_JSON:${JSON.stringify({ name: 'demo-skill', content: skillMd.replace('name: demo-skill', 'name: other') })} FAKE_JSON2:${JSON.stringify({ name: 'demo-skill', content: skillMd })}`,
    )
    assert.equal(job.status, 'done', job.error)
    assert.equal(job.attempt, 2)
    // 优化：提示词带上当前的 SKILL.md，文件夹名不能被改
    const before = calls().length
    job = await assist('skill', `FAKE_JSON:${JSON.stringify({ name: 'renamed', content: skillMd })}`, {
      subject: { cli: 'claude', name: 'demo-skill', content: skillMd },
    })
    assert.equal(job.status, 'done', job.error)
    assert.equal(job.proposal.name, 'demo-skill')
    assert.ok(calls().slice(before).at(-1).input.includes('文件夹名 demo-skill'))
    // MCP：提示词带上配置和测试连接的报错，名字不变
    const server = {
      name: 'mini',
      transport: 'stdio',
      command: 'npx',
      args: ['docs-mcp'],
      env: {},
      url: '',
      headers: {},
    }
    const fixed = { ...server, args: ['-y', 'docs-mcp'] }
    job = await assist('mcp', `FAKE_JSON:${JSON.stringify({ ...fixed, name: 'x' })}`, {
      subject: { name: 'mini', server: JSON.stringify(server), error: 'spawn npx ENOENT', clis: 'Claude Code' },
    })
    assert.equal(job.status, 'done', job.error)
    assert.deepEqual(job.proposal, { kind: 'mcp', server: fixed })
    const prompt = calls().at(-1).input
    assert.ok(prompt.includes('spawn npx ENOENT') && prompt.includes('docs-mcp'))
    job = await assist('mcp', `FAKE_JSON:${JSON.stringify({ transport: 'http', url: 'ftp://x' })}`, {
      subject: { name: 'mini', server: '{}' },
    })
    assert.equal(job.status, 'failed')
  }
  step('Skill 的 AI 创建 / 优化、MCP 工具的 AI 排查：校验格式、自动修正、文件夹名和工具名不被改')

  // ---- 风格库、浏览器扩展（UI 设计本身搬进了 UI 设计插件，它的测试在插件仓库 fixcode-h/agent-plugins 的 ui-design） ----
  {
    // 风格库：增删改（风格库留在面板：设置里管理，对话出图和 UI 设计插件都用）
    const st = await call('POST', '/styles', {
      name: '暗黑奇幻',
      kind: 'game',
      summary: '石刻金边',
      en: 'dark fantasy STYLELIB',
      prompts: [{ category: 'style', zh: '暗黑奇幻', en: 'dark fantasy' }],
    })
    assert.equal((await call('PUT', `/styles/${st.id}`, { name: '暗黑奇幻·改' })).summary, '石刻金边', '只改传了的')
    assert.equal((await call('GET', '/styles')).find((x) => x.id === st.id).name, '暗黑奇幻·改')
    await call('DELETE', `/styles/${st.id}`)
    assert.ok(!(await call('GET', '/styles')).some((x) => x.id === st.id))
    // 内置风格：游戏和网页各一批，排在自己存的后面；只读，不能改也不能删
    const all = await call('GET', '/styles')
    const builtin = all.filter((x) => x.builtin)
    assert.ok(
      builtin.filter((x) => x.kind === 'game').length >= 10 && builtin.filter((x) => x.kind === 'web').length >= 10,
    )
    assert.ok(all.findIndex((x) => x.builtin) > all.findLastIndex((x) => !x.builtin), '自己存的在前，内置的在后')
    await assert.rejects(call('PUT', `/styles/${builtin[0].id}`, { name: '改' }), /内置风格不能修改/)
    await assert.rejects(call('DELETE', `/styles/${builtin[0].id}`), /内置风格不能删除/)
    step('风格库：存、改、删；内置风格只读')

    // 浏览器扩展：只认 Gemini 和 ChatGPT 的标签页，只有扩展能调 /bridge
    // 配对令牌：面板第一次用时才读数据目录里的 bridge-token，这里先写好一个已知值
    writeFileSync(path.join(dataDir, 'bridge-token'), 'e2e-bridge-token')
    const unpaired = { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnop' }
    const ext = { ...unpaired, 'x-panel-bridge': 'e2e-bridge-token' }
    const bridge = (method, url, body, headers = ext) =>
      fetch(`${base}/bridge${url}`, { method, headers, body: body && JSON.stringify(body) })
    // 只凭 Origin 冒充扩展不行：没带配对令牌取不到指令，报到也只会被要求重新加载、不改任何状态
    assert.equal((await bridge('GET', '/poll', undefined, unpaired)).status, 401, '没配对的扩展取不到指令')
    const stale = await (
      await bridge('POST', '/hello', { tabs: [{ id: 1, url: 'https://gemini.google.com/' }] }, unpaired)
    ).json()
    assert.equal(stale.reload, true, '旧扩展被要求重新加载')
    assert.equal(stale.paired, false)
    // 经过反代（带转发头）来的扩展请求一律不认
    assert.equal(
      (await bridge('POST', '/hello', { tabs: [] }, { ...ext, 'x-forwarded-for': '1.2.3.4' })).status,
      403,
      '扩展只能从本机连',
    )
    assert.equal(
      (
        await bridge(
          'POST',
          '/hello',
          { tabs: [] },
          { 'content-type': 'application/json', origin: 'https://evil.example' },
        )
      ).status,
      403,
      '网站不能冒充扩展',
    )
    const hello = await bridge('POST', '/hello', {
      version: '1.3.0',
      tabs: [
        { id: 7, url: 'https://gemini.google.com/app/abc', title: 'Gemini' },
        { id: 8, url: 'https://chatgpt.com/c/1', title: 'ChatGPT' },
        { id: 9, url: 'https://www.google.com/', title: 'Google' },
      ],
    })
    // 扩展靠这个版本号判断要不要自己重新加载
    assert.equal(typeof (await hello.json()).latestVersion, 'string')
    // 一键刷新扩展：1.3 起的扩展在下次报到时收到一次重新加载的要求
    assert.deepEqual(await call('POST', '/designs/browser/reload', {}), { auto: true })
    const helloAgain = () =>
      bridge('POST', '/hello', {
        version: '1.3.0',
        tabs: [
          { id: 7, url: 'https://gemini.google.com/app/abc' },
          { id: 8, url: 'https://chatgpt.com/c/1' },
        ],
      }).then((r) => r.json())
    assert.equal((await helloAgain()).reload, true)
    assert.equal((await helloAgain()).reload, false, '刷新要求只带一次')
    const status = await call('GET', '/designs/browser')
    assert.equal(status.connected, true)
    assert.equal(typeof status.latestVersion, 'string')
    assert.ok(Array.isArray(status.browsers))
    // 测试的程序目录里没有扩展（打包时才会把扩展写进 server.mjs）
    await assert.rejects(call('POST', '/designs/browser/install', { browser: 'nope' }), /没有找到/)
    assert.deepEqual(
      status.tabs.map((x) => [x.id, x.site]),
      [
        ['7', 'gemini'],
        ['8', 'chatgpt'],
      ],
    )
    step('浏览器扩展：只列出 Gemini、ChatGPT 标签页，刷新要求只带一次；网站和没配对的扩展不能调用')
  }
})
