/**
 * 端到端测试分片：旧格式转换、AI 创建 Agent/工作流、UI 提示词与风格库、UI 设计、浏览器扩展
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs），
 * 互不影响。总入口 scripts/e2e.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'
import path from 'node:path'
import { runShard } from './harness.mjs'

await runShard('AI 创建与 UI 设计', async (api) => {
  const { baseUrl: base, root, fake, dataDir, projectDir, call, sleep, calls, step, setupBase } = api
  const { project, A, B, settings, node, flow } = await setupBase()
  // 自定义 CLI：没有插话通道，用来测设计对话里「这一轮收不下、结束后自动接着处理」
  const customSpec = JSON.parse(readFileSync(path.join(root, 'scripts/e2e/fixtures/custom-cli.json'), 'utf8'))
  mkdirSync(path.join(dataDir, 'config/clis'), { recursive: true })
  writeFileSync(path.join(dataDir, 'config/clis/custom.json'), JSON.stringify({ ...customSpec, command: fake }))
  await call('POST', '/clis/specs/reload', {})
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

  // ---- UI 设计 ----
  {
    await call('PUT', '/settings', {
      ...settings,
      defaultCli: 'codex',
      imageGen: { cli: 'codex', model: '', effort: '' },
    })
    // UI 设计用自己的项目，和 Agent 的项目分开
    await assert.rejects(
      call('POST', '/designs', { projectId: project.id, kind: 'game', title: 'X' }),
      /项目不存在/,
      'Agent 的项目不能放设计',
    )
    const uiProject = await call('POST', '/designs/projects', { name: 'Game', path: projectDir })
    assert.deepEqual(
      (await call('GET', '/designs/projects')).map((p) => p.name),
      ['Game'],
    )
    // 项目提示词：只改名字时不会清掉提示词；AI 生成、翻译
    await call('PUT', `/designs/projects/${uiProject.id}`, {
      prompts: [
        { id: 'p1', category: 'style', zh: '暗黑奇幻', en: 'grim castle style', enabled: true },
        { id: 'p2', category: 'avoid', zh: '不要文字', en: 'no text', enabled: true },
        { id: 'p3', category: 'color', zh: '大红色', en: 'bright red', enabled: false },
      ],
    })
    await call('PUT', `/designs/projects/${uiProject.id}`, { name: 'Game' })
    assert.equal((await call('GET', '/designs/projects'))[0].prompts.length, 3, '改名不影响提示词')
    const gen = await call('POST', '/designs/prompts/ai', { mode: 'generate', text: '蒸汽朋克风' })
    assert.deepEqual(
      gen.prompts.map((p) => [p.category, p.zh, p.en]),
      [
        ['style', '蒸汽朋克', 'steampunk'],
        ['material', '黄铜齿轮', 'brass gears'],
      ],
    )
    const tr = await call('POST', '/designs/prompts/ai', {
      mode: 'translate',
      items: [{ category: 'light', zh: '柔和顶光' }],
    })
    assert.deepEqual(tr.prompts[0], { category: 'light', zh: '柔和顶光', en: 'EN:柔和顶光' })
    await assert.rejects(call('POST', '/designs/prompts/ai', { mode: 'generate', text: '' }), /没有要处理的内容/)
    step('UI 项目提示词：按分类保存，AI 生成和翻译')

    // 风格库：增删改；没定风格的设计，AI 的提示词里带上同类风格作为选项
    const st = await call('POST', '/designs/styles', {
      name: '暗黑奇幻',
      kind: 'game',
      summary: '石刻金边',
      en: 'dark fantasy STYLELIB',
      prompts: [{ category: 'style', zh: '暗黑奇幻', en: 'dark fantasy' }],
    })
    assert.equal(
      (await call('PUT', `/designs/styles/${st.id}`, { name: '暗黑奇幻·改' })).summary,
      '石刻金边',
      '只改传了的',
    )
    assert.equal((await call('GET', '/designs/styles')).find((x) => x.id === st.id).name, '暗黑奇幻·改')
    await call('DELETE', `/designs/styles/${st.id}`)
    assert.ok(!(await call('GET', '/designs/styles')).some((x) => x.id === st.id))
    // 内置风格：游戏和网页各一批，排在自己存的后面；只读，不能改也不能删
    const all = await call('GET', '/designs/styles')
    const builtin = all.filter((x) => x.builtin)
    assert.ok(
      builtin.filter((x) => x.kind === 'game').length >= 10 && builtin.filter((x) => x.kind === 'web').length >= 10,
    )
    assert.ok(all.findIndex((x) => x.builtin) > all.findLastIndex((x) => !x.builtin), '自己存的在前，内置的在后')
    await assert.rejects(call('PUT', `/designs/styles/${builtin[0].id}`, { name: '改' }), /内置风格不能修改/)
    await assert.rejects(call('DELETE', `/designs/styles/${builtin[0].id}`), /内置风格不能删除/)
    step('风格库：存、改、删；内置风格只读')
    const design = await call('POST', '/designs', {
      projectId: uiProject.id,
      kind: 'game',
      title: 'Main Menu',
      designSize: { X: 1920, Y: 1080 },
    })
    assert.equal(design.root.Type, 'CanvasPanel')
    assert.ok((await call('GET', '/designs')).some((d) => d.id === design.id))
    const tasksBefore = (await call('GET', '/tasks')).length
    const waitJob = async (id) => {
      for (let i = 0; ; i++) {
        const d = await call('GET', `/designs/${id}`)
        if (d.job?.status !== 'running') return d
        if (i > 200) throw new Error('设计任务超时')
        await sleep(100)
      }
    }
    const tree = {
      reply: '主菜单搭好了',
      style: 'dark fantasy',
      root: {
        Type: 'CanvasPanel',
        Name: 'Root',
        Children: [
          {
            Type: 'Image',
            Name: 'Bg',
            Slot: { LayoutData: { Anchors: { Minimum: { X: 0, Y: 0 }, Maximum: { X: 1, Y: 1 } } } },
            Properties: { Brush: { ResourceObject: 'img:bg', DrawAs: 'Image' } },
          },
          {
            Type: 'VerticalBox',
            Name: 'Buttons',
            Children: [
              { Type: 'UserWidget', Name: 'StartBtn', Class: 'WBP_MenuButton' },
              { Type: 'UserWidget', Name: 'QuitBtn', Class: 'WBP_MenuButton' },
            ],
          },
        ],
      },
      components: [
        {
          Name: 'WBP_MenuButton',
          DesignSize: { X: 320, Y: 72 },
          Root: {
            Type: 'Button',
            Name: 'Btn',
            Properties: { WidgetStyle: { Normal: { ResourceObject: 'img:frame', DrawAs: 'Box' } } },
            Children: [
              { Type: 'TextBlock', Name: 'Label', Properties: { Text: 'Start', ColorAndOpacity: '#FFD080FF' } },
            ],
          },
        },
      ],
      images: [
        { id: 'bg', name: 'MenuBg', prompt: 'castle at night', width: 1920, height: 1080, transparent: false },
        {
          id: 'frame',
          name: 'BtnFrame',
          prompt: 'golden frame',
          width: 320,
          height: 72,
          nineSlice: { Left: 0.2, Top: 0.3, Right: 0.2, Bottom: 0.3 },
        },
      ],
    }
    // 第一次输出写错了控件类型，自动修正一次
    const wrong = { ...tree, root: { ...tree.root, Children: [{ Type: 'Fancy', Name: 'X' }] } }
    await call('POST', `/designs/${design.id}/chat`, {
      text: `做主菜单 FAKE_DESIGN:${JSON.stringify(wrong)}\nFAKE_DESIGN2:${JSON.stringify(tree)}`,
      source: { kind: 'cli' },
      count: 2,
    })
    let d = await waitJob(design.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job))
    assert.equal(d.rev, 1)
    assert.equal(d.style, 'dark fantasy')
    assert.deepEqual(
      d.root.Children.map((w) => [w.Type, w.Name, !!w.Slot?.LayoutData]),
      [
        ['Image', 'Bg', true],
        ['VerticalBox', 'Buttons', true],
      ],
      '按父控件补上插槽',
    )
    assert.deepEqual(d.root.Children[0].Slot.LayoutData.Anchors.Maximum, { X: 1, Y: 1 }, 'AI 写的值盖过默认值')
    assert.equal(d.root.Children[1].Children[0].Slot.Size.SizeRule, 'Automatic')
    assert.equal(d.components[0].Root.Children[0].Slot.HorizontalAlignment, 'HAlign_Center')
    assert.deepEqual(
      d.images.map((i) => [i.id, i.status, i.variants.length, i.variants[0]?.source, i.variants[0]?.width]),
      [
        ['bg', 'idle', 2, 'cli', 1920],
        ['frame', 'idle', 2, 'cli', 320],
      ],
      '每张图生成两版：一版从 savedPath 读，一版从 base64 读；存下来的都是设计里要的精确宽度',
    )
    const agentMsg = d.messages.at(-1)
    assert.equal(agentMsg.role, 'agent')
    assert.equal(agentMsg.text, '主菜单搭好了')
    assert.deepEqual(agentMsg.images, ['bg', 'frame'])
    assert.equal(agentMsg.run.cli, 'codex')
    const prompts = calls().filter((c) => c.kind === 'codex' && /image_gen/.test(c.stdin ?? c.input ?? ''))
    assert.ok(prompts.length >= 2, '生图交给 Codex 的 image_gen')
    const imgInput = prompts.at(-1).stdin ?? prompts.at(-1).input
    assert.match(imgInput, /Art style: grim castle style/, '生图带上项目提示词的英文')
    assert.match(imgInput, /Avoid: no text/)
    assert.doesNotMatch(imgInput, /bright red/, '停用的提示词不带')
    assert.match(imgInput, /Additional style for this screen: dark fantasy/)
    const designInput = calls()
      .filter((c) => /你是游戏 UI 设计助手/.test(c.stdin ?? c.input ?? ''))
      .at(-1)
    assert.match(designInput.stdin ?? designInput.input, /暗黑奇幻（grim castle style）/, '设计 AI 看得到项目提示词')
    assert.deepEqual(
      d.job.images.map((i) => [i.id, i.status, i.got, i.want]),
      [
        ['bg', 'done', 2, 2],
        ['frame', 'done', 2, 2],
      ],
      '每张图的生成进度',
    )
    assert.equal(d.job.run.cli, 'codex')
    assert.equal((await call('GET', '/tasks')).length, tasksBefore, '设计不出现在任务列表里')

    // 图片文件能取到；生成失败把错误显示在图片上
    const file = await fetch(`${base}/designs/${design.id}/files/${d.images[0].variants[0].file}`)
    assert.equal(file.headers.get('content-type'), 'image/png')
    await call('POST', `/designs/${design.id}/images/bg/generate`, {
      source: { kind: 'cli' },
      count: 1,
      prompt: 'IMGFAIL castle',
    })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'failed')
    assert.equal(d.images[0].status, 'failed')
    assert.match(d.images[0].error, /内容不符合政策/)
    assert.equal(d.images[0].variants.length, 2, '失败不影响已有的版本')

    // 页面保存：改选中的版本和名字，生成结果以服务端为准
    const doc = { title: d.title, designSize: d.designSize, style: d.style, root: d.root, components: d.components }
    d = await call('PUT', `/designs/${design.id}`, {
      ...doc,
      images: d.images.map((i) => (i.id === 'frame' ? { ...i, selected: 1, name: 'ButtonFrame', variants: [] } : i)),
    })
    const frame = d.images.find((i) => i.id === 'frame')
    assert.deepEqual([frame.name, frame.selected, frame.variants.length], ['ButtonFrame', 1, 2])

    // 导出：单个 JSON 内嵌贴图；ZIP 带 JSON 和贴图文件；导出到项目目录
    const json = await (await fetch(`${base}/designs/${design.id}/export?format=json`)).json()
    assert.equal(json.Format, 'AgentPanel.UMG')
    assert.equal(json.Name, 'WBP_MainMenu')
    assert.deepEqual(
      json.Textures.map((x) => [x.Name, x.File, !!x.Data]),
      [
        ['T_MenuBg', 'Textures/T_MenuBg.png', true],
        ['T_ButtonFrame', 'Textures/T_ButtonFrame.png', true],
      ],
    )
    assert.deepEqual(json.Textures[1].NineSlice, { Left: 0.2, Top: 0.3, Right: 0.2, Bottom: 0.3 })
    assert.equal(json.Root.Children[0].Properties.Brush.ResourceObject, 'T_MenuBg')
    assert.equal(json.UserWidgets[0].Name, 'WBP_MenuButton')
    const label = json.UserWidgets[0].Root.Children[0]
    assert.equal(label.Slot.Type, 'ButtonSlot')
    assert.equal(label.Properties.ColorAndOpacity.Hex, '#FFD080FF')
    const zipRes = await fetch(`${base}/designs/${design.id}/export`)
    assert.equal(zipRes.headers.get('content-type'), 'application/zip')
    const zip = Buffer.from(await zipRes.arrayBuffer())
    assert.equal(zip.readUInt32LE(0), 0x04034b50)
    for (const n of ['WBP_MainMenu.umg.json', 'Textures/T_MenuBg.png', 'Textures/T_ButtonFrame.png'])
      assert.ok(zip.includes(Buffer.from(n)), `ZIP 里有 ${n}`)
    const { dir } = await call('POST', `/designs/${design.id}/export-to-project`)
    assert.ok(existsSync(path.join(dir, 'WBP_MainMenu.umg.json')))
    assert.ok(existsSync(path.join(dir, 'Textures/T_ButtonFrame.png')))
    rmSync(path.join(projectDir, 'UI'), { recursive: true, force: true })
    // 标注随消息发给 AI：编号、意思、范围、涉及的控件和说明
    await call('POST', `/designs/${design.id}/chat`, {
      text: '按标注改 FAKE_DESIGN:{"reply":"改好了"}',
      source: { kind: 'none' },
      annotations: [
        {
          id: 'a1',
          kind: 'change',
          shape: 'rect',
          points: [10, 20, 300, 100],
          note: '按钮换成金色',
          target: '',
          widgets: ['Buttons'],
        },
      ],
    })
    d = await waitJob(design.id)
    const asked = calls()
      .filter((c) => c.kind === 'codex' && c.input?.startsWith('你是游戏 UI 设计助手'))
      .at(-1).input
    assert.match(
      asked,
      /用户在效果图上的标注[\s\S]*1\.【修改】框选，范围 x=10 y=20 宽=300 高=100\n {3}涉及的控件：Buttons\n {3}说明：按钮换成金色/,
    )
    assert.equal(d.messages.at(-2).annotations[0].note, '按钮换成金色')
    assert.equal(d.messages.at(-1).text, '改好了')
    // AI 一步步改（ops）：改属性、加控件、改名、改子控件里的；写错的操作退回去让它改
    const revBefore = d.rev
    const badOps = { reply: 'x', ops: [{ op: 'set', target: 'Nope', path: 'Properties.Text', value: 'a' }] }
    const goodOps = {
      reply: '改了几处',
      ops: [
        { op: 'rename', target: 'Bg', name: 'Img_Bg' },
        {
          op: 'add',
          parent: 'Buttons',
          widget: { Type: 'TextBlock', Name: 'Txt_Ver', Properties: { Text: 'v1.0.3' } },
        },
        { op: 'set', in: 'WBP_MenuButton', target: 'Label', path: 'Properties.Text', value: '开始游戏' },
        { op: 'set', target: 'Buttons', path: 'Slot.LayoutData.Offsets', value: { Top: 500 } },
      ],
    }
    await call('POST', `/designs/${design.id}/chat`, {
      text: `改一下 FAKE_DESIGN:${JSON.stringify(badOps)}\nFAKE_DESIGN2:${JSON.stringify(goodOps)}`,
      source: { kind: 'none' },
    })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    assert.equal(d.rev, revBefore + 1)
    assert.deepEqual(
      d.root.Children.map((w) => w.Name),
      ['Img_Bg', 'Buttons'],
    )
    const ver = d.root.Children[1].Children.at(-1)
    assert.deepEqual([ver.Name, ver.Properties.Text, ver.Slot.Size.SizeRule], ['Txt_Ver', 'v1.0.3', 'Automatic'])
    assert.equal(d.components[0].Root.Children[0].Properties.Text, '开始游戏')
    assert.equal(d.root.Children[1].Slot.LayoutData.Offsets.Top, 500, '只改写到的字段')
    assert.ok(d.root.Children[1].Slot.LayoutData.Offsets.Right > 0, '没写到的字段保留')
    // 写错的操作当场把错误交还给 AI，它接着改；过程按顺序存在回复里
    const failedTool = d.messages
      .at(-1)
      .parts.flatMap((p) => p.tools)
      .find((x) => x.failed)
    assert.match(failedTool.output, /主界面里没有叫 Nope 的控件/)
    // 用设计工具（MCP）改：CLI 调加控件、改属性、改名、建子控件等工具，回复只写普通文字
    // 每个工具一次提交多条；控件写法宽松（属性直接写在控件上、插槽用简写），旧的单数工具名也认
    const mcpCalls = [
      ['rename_widget', { name: 'Txt_Ver', to: 'Txt_Version' }],
      ['update_widgets', { items: [{ name: 'Txt_Version', properties: { Text: 'v2.0.0' } }] }],
      [
        'add_widgets',
        {
          items: [
            { parent: 'Buttons', widget: { type: 'TextBlock', name: 'Txt_Tip', Text: '提示', slot: { padding: 8 } } },
            {
              parent: 'Root',
              widget: {
                Type: 'TextBlock',
                Name: 'Txt_Corner',
                Text: 'v',
                Slot: { anchor: 'bottom-right', x: -24, y: -16, w: 120, h: 30 },
              },
            },
          ],
        },
      ],
      [
        'create_components',
        { items: [{ name: 'WBP_Tag', size: { X: 64, Y: 32 }, root: { Type: 'Overlay', Name: 'Root' } }] },
      ],
      ['set_design', { style: 'clean' }],
    ]
    await call('POST', `/designs/${design.id}/chat`, {
      text: `用工具改 FAKE_MCP:${JSON.stringify(mcpCalls)}`,
      source: { kind: 'none' },
    })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    assert.match(d.messages.at(-1).text, /^工具改好了/, '回复是普通文字，不要求 JSON')
    const box = d.root.Children[1].Children
    assert.deepEqual(
      [box.at(-2).Name, box.at(-2).Properties.Text, box.at(-1).Name],
      ['Txt_Version', 'v2.0.0', 'Txt_Tip'],
      '工具里的改动存下来了',
    )
    assert.deepEqual(box.at(-1).Slot.Padding, { Left: 8, Top: 8, Right: 8, Bottom: 8 }, '插槽的简写')
    const corner = d.root.Children.find((w) => w.Name === 'Txt_Corner').Slot.LayoutData
    assert.deepEqual(
      [corner.Anchors.Minimum, corner.Alignment, corner.Offsets],
      [
        { X: 1, Y: 1 },
        { X: 1, Y: 1 },
        { Left: -24, Top: -16, Right: 120, Bottom: 30 },
      ],
      '画布位置的简写换成锚点和偏移',
    )
    assert.ok(d.components.some((c) => c.Name === 'WBP_Tag' && c.DesignSize.X === 64))
    assert.equal(d.style, 'clean')
    // 先出原画：开关打开时 AI 不能搭界面，只出整屏原画；原画按设计稿尺寸存成候选，确认模板后照着模板做、出切图。
    // 原画张数是 conceptCount（「原画」按钮右键菜单），count 只表示每张图生成几版
    const sketch = await call('POST', '/designs', { projectId: uiProject.id, kind: 'game', title: 'Bag' })
    await call('POST', `/designs/${sketch.id}/chat`, {
      text: `做背包 FAKE_MCP:${JSON.stringify([
        ['add_widgets', { items: [{ parent: 'RootCanvas', widget: { Type: 'TextBlock', Name: 'T', Text: 'x' } }] }],
        ['generate_concepts', { prompt: 'dark fantasy inventory screen', negative: 'cartoon', count: 4 }],
      ])}`,
      source: { kind: 'cli' },
      count: 2,
      conceptCount: 2,
      concept: true,
    })
    d = await waitJob(sketch.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    assert.match(d.messages.at(-1).text, /先出原画/, '先出原画阶段搭界面的工具被退回')
    assert.equal(d.root.Children?.length ?? 0, 0, '没有搭界面')
    assert.deepEqual(
      d.concept.images.map((i) => [i.round, i.width, i.height, i.prompt, i.negative]),
      [
        [1, 1920, 1080, 'dark fantasy inventory screen', 'cartoon'],
        [1, 1920, 1080, 'dark fantasy inventory screen', 'cartoon'],
      ],
      '按输入框选的张数出两张候选（AI 写的 count 不算），按设计稿尺寸存下',
    )
    assert.equal(d.concept.selected, d.concept.images[0].id)
    const conceptGen = calls()
      .filter((c) => /Game UI concept art/.test(c.stdin ?? c.input ?? ''))
      .at(-1)
    assert.match(conceptGen.stdin ?? conceptGen.input, /Negative prompt \(none of these may appear\):.*cartoon/)
    const tpl = d.concept.images[1].id
    d = await call('POST', `/designs/${sketch.id}/concept`, { action: 'approve', id: tpl })
    assert.equal(d.concept.approved, tpl)
    await call('POST', `/designs/${sketch.id}/chat`, {
      text: `照着模板做 FAKE_MCP:${JSON.stringify([
        [
          'add_images',
          { images: [{ id: 'gem', name: 'Gem', prompt: 'a red gem', negative: 'frame', width: 64, height: 64 }] },
        ],
        [
          'add_widgets',
          {
            items: [
              {
                parent: 'RootCanvas',
                widget: { Type: 'Image', Name: 'Img_Gem', Brush: { ResourceObject: 'img:gem' } },
              },
            ],
          },
        ],
      ])}`,
      source: { kind: 'cli' },
      concept: true,
    })
    d = await waitJob(sketch.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    const tplInput = calls()
      .filter((c) => /你是游戏 UI 设计助手/.test(c.stdin ?? c.input ?? ''))
      .at(-1)
    assert.match(tplInput.stdin ?? tplInput.input, new RegExp(`已确认的效果图模板[\\s\\S]*concept:${tpl}`))
    assert.equal(d.images.find((i) => i.id === 'gem').negative, 'frame')
    const gemGen = calls()
      .filter((c) => /a red gem/.test(c.stdin ?? c.input ?? ''))
      .at(-1)
    assert.match(gemGen.stdin ?? gemGen.input, /approved concept art/, '切图带着模板作为参考')
    assert.match(gemGen.stdin ?? gemGen.input, /Negative prompt.*frame/)
    d = await call('POST', `/designs/${sketch.id}/concept`, { action: 'remove', id: tpl })
    assert.deepEqual([d.concept.images.length, d.concept.approved], [1, ''], '删掉模板就回到挑图')
    step('先出原画：不能先搭界面，出候选、确认模板后照着模板出切图')
    // 没在改设计时发消息：直接开新一轮（以前只回 steered: false，由页面自己维护排队）。
    // 用一个空的 UI 项目：项目里其他设计已有的图片描述会进设计提示词，里面带 FAIL 会让假 CLI 判成失败
    const probeProject = await call('POST', '/designs/projects', { name: 'Steer Probe', path: projectDir })
    const probe = await call('POST', '/designs', { projectId: probeProject.id, kind: 'game', title: '设计补充测试' })
    const direct = await call('POST', `/designs/${probe.id}/steer`, { text: '再大一点', source: { kind: 'none' } })
    assert.deepEqual([direct.steered, direct.queued], [false, false], '没在跑时直接开始一轮')
    assert.equal(direct.messages.at(-1).text, '再大一点', '消息直接进对话')
    let probeNow = await waitJob(probe.id)
    assert.equal(probeNow.job.status, 'done', JSON.stringify(probeNow.job.error))
    // 正在改设计时发消息：整条消息补充给这一轮，消息上记下去了哪里。
    // 用 Command Code（常驻 RPC 有 turn/steer），能真正插进正在跑的这一轮
    const probeRun = { cli: 'commandcode', model: '', effort: '' }
    await call('POST', `/designs/${probe.id}/chat`, {
      text: 'SLOW 先搭一版',
      source: { kind: 'none' },
      run: probeRun,
    })
    for (let i = 0; !calls().some((c) => (c.input ?? c.stdin ?? '').includes('SLOW 先搭一版')); i++) {
      if (i > 100) throw new Error('设计对话没有开始执行')
      await sleep(50)
    }
    await sleep(300)
    const steered = await call('POST', `/designs/${probe.id}/steer`, {
      text: '左下角再大一点',
      source: { kind: 'none' },
      run: probeRun,
    })
    assert.equal(steered.steered, true, '正在跑时补充给这一轮')
    assert.equal(steered.messages.at(-1).delivery?.how, 'steer', '消息记下插进了这一轮')
    assert.ok(Date.parse(steered.messages.at(-1).delivery.at) > 0, '交付时间也记上')
    probeNow = await waitJob(probe.id)
    assert.equal(probeNow.job.status, 'done', JSON.stringify(probeNow.job.error))
    await call('DELETE', `/designs/${probe.id}`)
    // 收不下的（CLI 没有插话通道）：消息进对话，这一轮结束后自动接着处理，不用用户再发一次
    const probe2 = await call('POST', '/designs', { projectId: probeProject.id, kind: 'game', title: '设计接续测试' })
    const customRun = { cli: 'custom', model: '', effort: '' }
    await call('POST', `/designs/${probe2.id}/chat`, {
      text: 'SLOW 先画一版',
      source: { kind: 'none' },
      run: customRun,
    })
    for (let i = 0; !calls().some((c) => (c.input ?? c.stdin ?? '').includes('SLOW 先画一版')); i++) {
      if (i > 100) throw new Error('设计对话没有开始执行')
      await sleep(50)
    }
    const held = await call('POST', `/designs/${probe2.id}/steer`, {
      text: '接续处理这句',
      source: { kind: 'none' },
      run: customRun,
    })
    assert.equal(held.steered, false, '没有插话通道时分不到这一轮')
    assert.equal(held.messages.at(-1).delivery?.how, 'held', '记成这一轮结束后自动处理')
    for (let i = 0; !calls().some((c) => (c.input ?? c.stdin ?? '').includes('接续处理这句')); i++) {
      if (i > 200) throw new Error('这一轮结束后没有自动接着处理')
      await sleep(100)
    }
    d = await waitJob(probe2.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    assert.ok(
      d.messages.some((m) => m.role === 'user' && m.text === '接续处理这句'),
      '排队的消息留在对话里',
    )
    await call('DELETE', `/designs/${probe2.id}`)
    // 停止后马上再发：排队的消息标成没送出去（lost），新消息不会卡在「结束后自动处理」，会接着开始新一轮
    const probe3 = await call('POST', '/designs', { projectId: probeProject.id, kind: 'game', title: '设计停止测试' })
    await call('POST', `/designs/${probe3.id}/chat`, {
      text: 'SLOW 先画一版三',
      source: { kind: 'none' },
      run: customRun,
    })
    for (let i = 0; !calls().some((c) => (c.input ?? c.stdin ?? '').includes('SLOW 先画一版三')); i++) {
      if (i > 100) throw new Error('设计对话没有开始执行')
      await sleep(50)
    }
    const queuedBeforeStop = await call('POST', `/designs/${probe3.id}/steer`, {
      text: '停止前排队这句',
      source: { kind: 'none' },
      run: customRun,
    })
    assert.equal(queuedBeforeStop.messages.at(-1).delivery?.how, 'held')
    await call('POST', `/designs/${probe3.id}/stop`)
    const stopped = await call('GET', `/designs/${probe3.id}`)
    assert.equal(
      stopped.messages.find((m) => m.text === '停止前排队这句')?.delivery?.how,
      'lost',
      '停止时排队的消息标明没送出去',
    )
    await call('POST', `/designs/${probe3.id}/steer`, {
      text: '停止后再发这句',
      source: { kind: 'none' },
      run: customRun,
    })
    for (let i = 0; !calls().some((c) => (c.input ?? c.stdin ?? '').includes('停止后再发这句')); i++) {
      if (i > 200) throw new Error('停止后发的消息没有被接着处理')
      await sleep(100)
    }
    d = await waitJob(probe3.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    await call('DELETE', `/designs/${probe3.id}`)
    await call('DELETE', `/designs/projects/${probeProject.id}`)
    // 看图量尺寸：inspect_image 量尺寸和颜色，view_image 画坐标格、放大一块，存成文件给 AI 读图
    const pngOf = (w, h, pix) => {
      const raw = Buffer.alloc((w * 3 + 1) * h)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pix(x, y), y * (w * 3 + 1) + 1 + x * 3)
      const chunk = (type, body) => {
        const head = Buffer.alloc(8)
        head.writeUInt32BE(body.length, 0)
        head.write(type, 4, 'ascii')
        const crc = Buffer.alloc(4)
        crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
        return Buffer.concat([head, body, crc])
      }
      const ihdr = Buffer.alloc(13)
      ihdr.writeUInt32BE(w, 0)
      ihdr.writeUInt32BE(h, 4)
      ihdr[8] = 8
      ihdr[9] = 2
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ])
    }
    const ref = await call('POST', '/uploads', {
      name: '参考图.png',
      mime: 'image/png',
      data: pngOf(100, 60, (x) => (x < 50 ? [255, 0, 0] : [0, 0, 255])).toString('base64'),
    })
    await call('POST', `/designs/${design.id}/chat`, {
      text: `量一下参考图 FAKE_MCP:${JSON.stringify([
        [
          'inspect_image',
          {
            source: 'attachment:1',
            points: [
              { x: 10, y: 10 },
              { x: 90, y: 10 },
            ],
          },
        ],
        ['view_image', { source: 'attachment:1', region: { x: 0, y: 0, w: 50, h: 30 } }],
        ['inspect_image', { source: 'attachment:9' }],
      ])}`,
      source: { kind: 'none' },
      attachments: [ref],
    })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    const looked = d.messages.at(-1).text
    assert.match(looked, /"size":"100×60"/, '量出精确尺寸')
    assert.match(looked, /"color":"#FF0000"[\s\S]*"color":"#0000FF"/, '取到指定位置的颜色')
    assert.match(looked, /views[\\/]view-1\.png/, '放大的图存成文件交给 AI 读')
    assert.match(looked, /没有这个附件/, '附件序号不对时说明原因')
    assert.match(
      calls()
        .filter((c) => c.kind === 'codex' && c.input?.startsWith('你是游戏 UI 设计助手'))
        .at(-1).input,
      /附件 1「参考图\.png」：100×60 像素/,
      '附件的精确尺寸写进了要求',
    )

    // 图标表：同一个 sheet 的图标一次生成再切开，每个都是各自精确的尺寸；漏画的单独补
    const callsBefore = calls().length
    const icon = (id, n, extra = '') => ({
      id,
      name: `Ico_${n}`,
      prompt: `${extra}item ${n}`,
      width: 48,
      height: 48,
      sheet: 'items',
    })
    const icons = [icon('ico_a', 'A'), icon('ico_b', 'B'), icon('ico_c', 'C', 'MISS3 ')]
    await call('POST', `/designs/${design.id}/chat`, {
      text: `做三个物品图标 FAKE_MCP:${JSON.stringify([
        ['add_images', { images: icons }],
        [
          'add_widgets',
          {
            items: icons.map((x, i) => ({
              parent: 'Root',
              widget: {
                Type: 'Image',
                Name: x.name,
                Brush: { ResourceObject: `img:${x.id}` },
                Slot: { anchor: 'top-left', x: 10 + i * 60, y: 10, w: 48, h: 48 },
              },
            })),
          },
        ],
      ])}`,
      source: { kind: 'cli' },
      count: 1,
    })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done', JSON.stringify(d.job.error))
    const pngSize = async (file) => {
      const b = Buffer.from(await (await fetch(`${base}/designs/${design.id}/files/${file}`)).arrayBuffer())
      return [b.readUInt32BE(16), b.readUInt32BE(20)]
    }
    for (const id of ['ico_a', 'ico_b', 'ico_c']) {
      const im = d.images.find((x) => x.id === id)
      assert.equal(im.variants.length, 1, `${id} 有图`)
      assert.deepEqual(await pngSize(im.variants[0].file), [48, 48], `${id} 是要求的精确尺寸`)
    }
    const sheetGen = calls()
      .slice(callsBefore)
      .filter((c) => c.kind === 'codex' && (c.stdin ?? c.input ?? '').startsWith('请用内置的 image_gen'))
    assert.equal(sheetGen.length, 2, '三个图标一次出图，漏画的第三个单独补一张')
    assert.match(
      sheetGen[0].stdin ?? sheetGen[0].input,
      /3 separate, individual icons of the same size, laid out one after another in a strict, evenly spaced grid of 2 columns × 2 rows/,
    )
    assert.match(sheetGen[0].stdin ?? sheetGen[0].input, /1\. item A\n2\. item B\n3\. MISS3 item C/)
    assert.doesNotMatch(sheetGen[1].stdin ?? sheetGen[1].input, /sprite sheet/)

    const mcpAsk = calls()
      .filter((c) => c.kind === 'codex' && c.input?.startsWith('你是游戏 UI 设计助手'))
      .at(-1)
    assert.match(mcpAsk.input, /用 design 工具改设计/, '有工具时提示词让 AI 优先用工具')
    assert.ok(
      (mcpAsk.args ?? []).some((x) => /^mcp_servers\.design\.url=/.test(x)),
      '把工具地址传给 Codex',
    )
    step(
      'UI 设计：AI 搭控件树（自动修正一次）、一步步改（ops 和设计工具）、Codex 生图、保存、导出成 UMG 的 JSON 和贴图，和任务分开',
    )

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
    assert.equal(
      (
        await call('POST', `/designs/${design.id}/images/bg/generate`, {
          source: { kind: 'browser', tabId: '7' },
          count: 1,
        })
      ).job.status,
      'running',
    )
    d = await waitJob(design.id)
    assert.match(d.images[0].error, /扩展没有连上/)
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
    await call('POST', `/designs/${design.id}/images/frame/generate`, {
      source: { kind: 'browser', tabId: '7' },
      count: 2,
    })
    const cmd = (await (await bridge('GET', '/poll')).json()).cmd
    assert.deepEqual([cmd.type, cmd.tabId, cmd.count, cmd.chroma, cmd.newChat], ['generate', '7', 2, true, true])
    assert.match(cmd.prompt, /#00FF00/, '透明图让网页画纯绿底，扩展再抠掉')
    await bridge('POST', '/progress', { id: cmd.id, text: '等待生成' })
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
    // 新版扩展取到一张就先交一张：还在生成时设计里已经有这一版
    await bridge('POST', '/image', { id: cmd.id, data: png })
    for (let i = 0; i < 50; i++) {
      const cur = await call('GET', `/designs/${design.id}`)
      if (cur.images.find((x) => x.id === 'frame').variants.length === 3) break
      await sleep(50)
    }
    const mid = await call('GET', `/designs/${design.id}`)
    assert.equal(mid.job.status, 'running')
    assert.equal(mid.images.find((x) => x.id === 'frame').variants.length, 3, '先交的一张马上放进设计')
    assert.equal(mid.images.find((x) => x.id === 'frame').selected, 2, '第一张到了就选中')
    assert.equal(mid.job.images[0].text, '等待生成')
    await bridge('POST', '/result', { id: cmd.id, ok: true, images: [{ data: png }], streamed: 1 })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done')
    const f2 = d.images.find((i) => i.id === 'frame')
    assert.deepEqual(
      f2.variants.map((v) => v.source),
      ['cli', 'cli', 'browser', 'browser'],
    )
    assert.equal(f2.selected, 2, '新生成的一版自动选中')
    await call('POST', `/designs/${design.id}/images/frame/generate`, {
      source: { kind: 'browser', tabId: '8' },
      count: 1,
    })
    const cmd2 = (await (await bridge('GET', '/poll')).json()).cmd
    await bridge('POST', '/result', { id: cmd2.id, ok: false, error: '没有找到输入框' })
    d = await waitJob(design.id)
    assert.match(d.images.find((i) => i.id === 'frame').error, /没有找到输入框/)
    // 失败的图点重试：没有在生成时单独生成这一张，成功后错误清掉
    assert.equal(d.job.images[0].status, 'failed')
    const retried = await call('POST', `/designs/${design.id}/images/frame/retry`, {
      source: { kind: 'browser', tabId: '8' },
      count: 1,
    })
    assert.equal(retried.job.status, 'running')
    const cmd3 = (await (await bridge('GET', '/poll')).json()).cmd
    assert.equal(cmd3.tabId, '8')
    await bridge('POST', '/image', { id: cmd3.id, data: png })
    await bridge('POST', '/result', { id: cmd3.id, ok: true, images: [], streamed: 1 })
    d = await waitJob(design.id)
    assert.equal(d.job.status, 'done')
    assert.equal(d.images.find((i) => i.id === 'frame').status, 'idle')
    assert.equal(d.images.find((i) => i.id === 'frame').variants.length, 5)
    step('浏览器扩展：只列出 Gemini、ChatGPT 标签页，取指令、交回图片，错误显示在图片上、能重试；网站不能调用')

    await assert.rejects(
      call('POST', `/designs/${design.id}/images/generate`, {
        ids: ['nope'],
        source: { kind: 'browser', tabId: '8' },
        count: 1,
      }),
      /没有要生成的图片/,
    )
    // 网页 UI：根控件是占满整页的 Frame，AI 用 Frame / Text / WebButton 搭，导出成 HTML
    const webD = await call('POST', '/designs', {
      projectId: uiProject.id,
      kind: 'web',
      title: 'Landing Page',
      designSize: { X: 1440, Y: 900 },
    })
    assert.deepEqual([webD.kind, webD.root.Type, webD.root.Properties.Width], ['web', 'Frame', 'fill'])
    const webTree = {
      reply: '首页好了',
      ops: [
        {
          op: 'add',
          parent: 'Page',
          widget: { Type: 'Text', Name: 'Title', Properties: { Text: '欢迎来到 Flowboard', Tag: 'h1' } },
        },
        {
          op: 'add',
          parent: 'Page',
          widget: {
            Type: 'Frame',
            Name: 'Actions',
            Properties: { Direction: 'row', Gap: 12, Mobile: { Direction: 'column' } },
            Children: [
              {
                Type: 'WebButton',
                Name: 'Btn_Go',
                Properties: { Text: '开始使用', Href: '/start', Hover: { Background: '#1D4ED8FF' } },
              },
              {
                Type: 'Text',
                Name: 'Badge',
                Slot: { Position: 'absolute', Pin: 'top-right', X: 4, Y: 4 },
                Properties: { Text: 'NEW' },
              },
            ],
          },
        },
      ],
    }
    await call('POST', `/designs/${webD.id}/chat`, {
      text: `做首页 FAKE_DESIGN:${JSON.stringify(webTree)}`,
      source: { kind: 'none' },
    })
    let wd = await waitJob(webD.id)
    assert.equal(wd.job.status, 'done', JSON.stringify(wd.job.error))
    assert.deepEqual(
      wd.root.Children.map((w) => [w.Type, w.Name, w.Slot?.AlignSelf]),
      [
        ['Text', 'Title', 'auto'],
        ['Frame', 'Actions', 'auto'],
      ],
    )
    const webAsk = calls()
      .filter((c) => c.kind === 'codex' && /你是网页 UI 设计助手/.test(c.input ?? ''))
      .at(-1)
    assert.ok(webAsk, '网页设计用网页的提示词')
    assert.doesNotMatch(webAsk.input, /CanvasPanelSlot/, '网页的提示词里没有 UMG 的插槽')
    const html = await (await fetch(`${base}/designs/${webD.id}/export?format=json`)).text()
    assert.match(html, /<h1 class="Title">欢迎来到 Flowboard<\/h1>/)
    assert.match(html, /\.Actions \{[^}]*flex-direction: row;[^}]*gap: 12px;/)
    assert.match(html, /<a class="Btn_Go" href="\/start">开始使用<\/a>/, '写了 Href 就是链接')
    assert.match(html, /\.Btn_Go:hover \{ background-color: rgba\(29,78,216,1\); \}/, '悬停样式')
    assert.match(html, /@media \(max-width: 767px\) \{\n {2}\.Actions \{ flex-direction: column; \}/, '手机上改竖排')
    assert.match(html, /\.Badge \{[^}]*position: absolute;[^}]*top: 4px;[^}]*right: 4px;/, '绝对定位贴在右上角')
    const reactZip = Buffer.from(await (await fetch(`${base}/designs/${webD.id}/export?format=react`)).arrayBuffer())
    assert.ok(reactZip.includes(Buffer.from('LandingPage.tsx')), JSON.stringify(reactZip.subarray(30, 80).toString()))
    assert.ok(reactZip.includes(Buffer.from('max-md:flex-col')), 'React 组件里手机用 max-md:')
    const webZip = Buffer.from(await (await fetch(`${base}/designs/${webD.id}/export?format=zip`)).arrayBuffer())
    assert.ok(webZip.includes(Buffer.from('index.html')))
    // 版本：AI 改之前自动存了一个；手动存一个；恢复到 AI 改之前，恢复前的样子也存下来
    let vers = await call('GET', `/designs/${webD.id}/versions`)
    assert.equal(vers.length, 1)
    assert.ok(vers[0].auto && /AI 修改前/.test(vers[0].name))
    const named = await call('POST', `/designs/${webD.id}/versions`, { name: '第一稿' })
    assert.equal(named.auto, false)
    const full = await call('GET', `/designs/${webD.id}/versions/${named.id}`)
    assert.equal(full.snapshot.root.Children.length, 2, '版本里有完整的控件树')
    const restored = await call('POST', `/designs/${webD.id}/versions/${vers[0].id}/restore`)
    assert.equal(restored.root.Children.length, 0, '恢复到 AI 改之前（空页面）')
    vers = await call('GET', `/designs/${webD.id}/versions`)
    assert.deepEqual(
      vers.map((v) => v.auto),
      [true, false, true],
    )
    assert.match(vers[0].name, /^恢复「AI 修改前：做首页.*」之前$/)
    assert.equal(vers[1].name, '第一稿')
    await call('DELETE', `/designs/${webD.id}/versions/${named.id}`)
    assert.equal((await call('GET', `/designs/${webD.id}/versions`)).length, 2)
    await call('DELETE', `/designs/${webD.id}`)
    step('UI 设计：网页 UI（自动布局的控件、网页的提示词、导出 HTML）')

    // 「控件」列表：项目里别的设计的子控件能连同图片加进来
    const other2 = await call('POST', '/designs', { projectId: uiProject.id, kind: 'game', title: 'Shop' })
    const pc = await call('GET', `/designs/projects/${uiProject.id}/components`)
    const fromMenu = pc.find((x) => x.designId === design.id)
    assert.deepEqual(
      fromMenu.components.map((c) => c.Name),
      ['WBP_MenuButton', 'WBP_Tag'],
    )
    assert.ok(fromMenu.images.some((i) => i.id === 'frame'))
    const imported = await call('POST', `/designs/${other2.id}/components/import`, {
      from: design.id,
      name: 'WBP_MenuButton',
    })
    assert.deepEqual(
      imported.components.map((c) => c.Name),
      ['WBP_MenuButton'],
    )
    const copiedFrame = imported.images.find((i) => i.id === 'frame')
    assert.ok(copiedFrame?.variants.length, '用到的图片一起带过来')
    const fileRes = await fetch(`${base}/designs/${other2.id}/files/${copiedFrame.variants[0].file}`)
    assert.equal(fileRes.status, 200, '图片文件也复制过来了')
    await assert.rejects(
      call('POST', `/designs/${other2.id}/components/import`, { from: design.id, name: 'WBP_MenuButton' }),
      /已经有/,
    )
    await call('DELETE', `/designs/${other2.id}`)
    step('UI 设计：「控件」列表列出项目里的子控件，能连同图片加进别的设计')

    await call('DELETE', `/designs/${design.id}`)
    assert.ok(!(await call('GET', '/designs')).some((x) => x.id === design.id))
    assert.ok(!existsSync(path.join(dataDir, 'designs', design.id)))
    // 删除 UI 项目时连同里面的设计一起删
    const d2 = await call('POST', '/designs', { projectId: uiProject.id, kind: 'game', title: 'HUD' })
    // 创建副本和移到别的项目
    const copy = await call('POST', `/designs/${d2.id}/copy`, {})
    assert.notEqual(copy.id, d2.id)
    assert.match(copy.title, /HUD/)
    const other = await call('POST', '/designs/projects', { name: 'Other', path: '' })
    assert.equal((await call('POST', `/designs/${copy.id}/move`, { projectId: other.id })).projectId, other.id)
    await assert.rejects(call('POST', `/designs/${copy.id}/move`, { projectId: 'nope' }), /项目不存在/)
    await call('DELETE', `/designs/projects/${other.id}`)
    assert.ok(!(await call('GET', '/designs')).some((x) => x.id === copy.id))
    await call('PUT', `/designs/projects/${uiProject.id}`, { name: 'Game 2', path: '' })
    assert.equal((await call('GET', '/designs/projects'))[0].name, 'Game 2')
    await call('DELETE', `/designs/projects/${uiProject.id}`)
    assert.deepEqual(await call('GET', '/designs/projects'), [])
    assert.ok(!(await call('GET', '/designs')).some((x) => x.id === d2.id))
    await call('PUT', '/settings', settings)
  }
})
