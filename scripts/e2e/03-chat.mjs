/**
 * 端到端测试分片：对话任务、Gemini / Pi、空回合、命令与导入、停止、插话、额度、压缩、审查、执行中发消息
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs），
 * 互不影响。总入口 scripts/e2e.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'

import path from 'node:path'
import { runShard } from './harness.mjs'

await runShard('对话与续接', async (api) => {
  const {
    baseUrl: base,
    root,
    fake,
    dataDir,
    log,
    call,
    sleep,
    waitFor,
    waitDone,
    calls,
    readLog,
    step,
    cli,
    setupBase,
  } = api
  const { project, B, C, settings } = await setupBase()
  // ---- 对话任务 ----
  let chat = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: C.id,
    prompt: '解释一下项目结构',
  })
  chat = await waitDone(chat.id)
  assert.equal(chat.status, 'done')
  // 对话提示由「用户这次的消息」和授权、工作流、执行方式等几段拼成，任务描述在最前面
  assert.match(calls().at(-1).input, /^## 用户这次的消息\n解释一下项目结构\n\n/, '任务描述在对话提示的开头')
  await call('POST', `/tasks/${chat.id}/messages`, { text: '继续' })
  chat = await waitDone(chat.id)
  let c = calls().at(-1)
  assert.ok(c.args.includes('--resume') && c.args.includes(chat.sessions[C.id]))
  step('对话任务：直接发给选中的 Agent，继续对话会续接会话')

  // ---- 不用角色：直接用默认 CLI（以前的「默认 Agent」去掉了） ----
  const allAgents = await call('GET', '/agents')
  assert.ok(!allAgents.some((x) => x.id === 'default-agent'), '不再有自带的默认 Agent')
  const def = { id: '' }
  let dc = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: def.id, prompt: '默认' })
  dc = await waitDone(dc.id)
  c = calls().at(-1)
  assert.equal(c.kind, 'claude')
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'sonnet', '用默认 CLI 的默认模型')
  assert.ok(dc.runMs > 0 && !dc.runStartedAt, '记下执行时间')
  dc = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    model: 'claude-opus-5-5',
    effort: 'high',
    prompt: '换模型',
  })
  dc = await waitDone(dc.id)
  c = calls().at(-1)
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'claude-opus-5-5', '对话时临时换的模型')
  assert.equal(c.args[c.args.indexOf('--effort') + 1], 'high')
  await call('POST', `/tasks/${dc.id}/messages`, { text: '继续' })
  await waitDone(dc.id)
  c = calls().at(-1)
  assert.equal(c.args[c.args.indexOf('--model') + 1], 'claude-opus-5-5', '继续对话也用临时换的模型')
  // 对话时选别的 CLI：默认 Agent 换成那个 CLI 执行，继续对话也用它
  dc = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'codex',
    prompt: '换 CLI',
  })
  assert.equal(dc.cli, 'codex')
  dc = await waitDone(dc.id)
  assert.equal(dc.status, 'done', dc.messages.at(-1)?.text)
  assert.equal(calls().at(-1).kind, 'codex', '对话时选的 CLI')
  await call('POST', `/tasks/${dc.id}/messages`, { text: '继续' })
  await waitDone(dc.id)
  assert.equal(calls().at(-1).kind, 'codex', '继续对话也用选的 CLI')
  // Gemini CLI：按配置文件（shared/clis/gemini.json）拼参数、解析 stream-json
  let gm = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'gemini',
    prompt: '用 Gemini',
  })
  gm = await waitDone(gm.id)
  assert.equal(gm.status, 'done', gm.messages.at(-1)?.text)
  c = calls().at(-1)
  assert.equal(c.kind, 'gemini')
  assert.ok(c.args.includes('--approval-mode') && c.args.includes('auto_edit'), c.args.join(' '))
  assert.match(c.input, /^## 用户这次的消息\n用 Gemini\n\n/, '任务描述从 stdin 传入')
  const gReply = gm.messages.filter((m) => m.role === 'agent').at(-1)
  assert.match(gReply.text, /这是 gemini 的回复/)
  assert.deepEqual(
    gReply.tools.map((x) => x.kind),
    ['read', 'edit'],
    '工具调用按名字认出读文件、改文件',
  )
  assert.equal(gm.usage.inputTokens, 5000, JSON.stringify(gm.usage))
  await call('POST', `/tasks/${gm.id}/messages`, { text: '继续' })
  await waitDone(gm.id)
  c = calls().at(-1)
  assert.equal(c.args[c.args.indexOf('--resume') + 1], gm.sessions[gm.agentId], '继续时续接会话')
  // Gemini 没有系统提示词参数，角色只在会话第一轮带：续接时角色没变不重发，变了（内置角色随版本更新、用户改了）补发新版
  const gRole = await call('POST', '/agents', {
    name: '戊',
    cli: 'gemini',
    description: '',
    model: '',
    icon: 'bot',
    categoryId: '',
    extraArgs: [],
    enabled: true,
    instructions: '你是戊，旧版设定。',
  })
  let gr = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: gRole.id, prompt: '第一轮' })
  gr = await waitDone(gr.id)
  assert.match(calls().at(-1).input, /## 你的角色\n你是戊，旧版设定。/, '第一轮带角色设定')
  await call('POST', `/tasks/${gr.id}/messages`, { text: '第二轮' })
  await waitDone(gr.id)
  assert.ok(!calls().at(-1).input.includes('你的角色'), '角色没变时续接不重发')
  await call('PUT', `/agents/${gRole.id}`, { ...gRole, instructions: '你是戊，新版设定。' })
  await call('POST', `/tasks/${gr.id}/messages`, { text: '第三轮' })
  await waitDone(gr.id)
  c = calls().at(-1)
  assert.ok(c.args.includes('--resume'), '仍然续接原会话')
  assert.match(c.input, /## 你的角色（已更新[^\n]*\n你是戊，新版设定。/, '角色变了：续接时补发新版')
  await call('DELETE', `/tasks/${gr.id}`)
  // 空回合：模型只回一句「我先…」就收尾（零工具、零改动），面板要先把这件事写进对话再自动接一轮；
  // 接上之后模型正常交结果，那条报错卡片要收成普通说明，不能一直挂成失败
  let emp = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'claude',
    prompt: 'FAKE_EMPTY 看一下这个项目',
  })
  emp = await waitDone(emp.id)
  assert.equal(emp.status, 'done', emp.messages.at(-1)?.text)
  const empNotes = emp.messages.filter((m) => m.role === 'system' && !m.step)
  const empNote = empNotes.find((m) => /只回了一句话就结束了/.test(m.text))
  assert.ok(
    empNote,
    `自动接一轮要可见；现有消息：${JSON.stringify(
      emp.messages.map((x) => [x.role, x.step, x.transient ?? false, x.error ?? false, x.text.slice(0, 30)]),
    )}`,
  )
  assert.ok(!empNote.error, '接上之后不能还挂着红色错误卡片')
  assert.match(empNote.text, /已自动接一轮，这一轮继续做完了/, '写明已经接一轮做完了')
  const empAgent = emp.messages.filter((m) => m.role === 'agent')
  assert.equal(empAgent.length, 2, '第一轮只说了一句 + 催促后的一轮')
  assert.match(empAgent[0].text, /我先把工作区更新到最新/)
  assert.match(empAgent[1].text, /这是 claude 的回复/, '被催之后正常交了结果')

  // 同一件事走常驻保活的 CLI（Command Code）：回复完会先进入 keepAlive 等下一句，
  // 一挂起 runAgent 就不返回，收尾处的空回合兜底没机会跑。必须在保活前判定，命中就不保活。
  let empKeep = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'commandcode',
    askUser: false,
    prompt: 'FAKE_EMPTY 确认一下保活下的空回合',
  })
  await call('POST', `/tasks/${empKeep.id}/seen`, {})
  await call('POST', `/tasks/${empKeep.id}/presence`, { viewerId: 'e2e-empty', active: true })
  // 这个 CLI 回复完会停在等下一句上（保活），任务状态一直算执行中，不能等 status；按消息判断
  const empKeepDone = () =>
    empKeep.messages.some((m) => m.role === 'system' && /只回了一句话就结束了/.test(m.text)) &&
    empKeep.messages.filter((m) => m.role === 'agent').length >= 2
  for (let i = 0; i < 200 && !empKeepDone(); i++) {
    await sleep(150)
    empKeep = await call('GET', `/tasks/${empKeep.id}`)
  }
  assert.ok(
    empKeep.messages.some((m) => m.role === 'system' && /只回了一句话就结束了/.test(m.text)),
    `保活路径下也要自动接一轮；现有消息：${JSON.stringify(
      empKeep.messages.map((x) => [x.role, x.error ?? false, x.text.slice(0, 40)]),
    )}`,
  )
  assert.equal(empKeep.messages.filter((m) => m.role === 'agent').length, 2, '第一轮只说了一句 + 催促后的一轮')
  // 收尾：页面切走，让还挂着等下一句的 CLI 结束这一轮
  await call('POST', `/tasks/${empKeep.id}/presence`, { viewerId: 'e2e-empty', active: false })
  empKeep = await waitDone(empKeep.id, 20000)
  assert.equal(empKeep.status, 'done')

  // 一个字都没回的一轮（CLI 报成功、但没有正文也没有用量）：不能算完成。
  // 真实现场是带图请求被网关吞掉：那一轮被标成已完成并保活等下一句，用户之后发来的消息全落进死回合，既没回复也没报错
  step('一个字都没回的一轮不算完成：留下说明并自动接一轮')
  let sil = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'claude',
    prompt: 'FAKE_SILENT 分析一下这个对话',
  })
  sil = await waitDone(sil.id, 20000)
  assert.equal(sil.status, 'done', sil.messages.at(-1)?.text)
  const silNote = sil.messages.find((m) => m.role === 'system' && /没有返回任何内容/.test(m.text))
  assert.ok(
    silNote,
    `空成功的一轮必须留下可见说明，不能静默收尾；现有消息：${JSON.stringify(
      sil.messages.map((x) => [x.role, x.error ?? false, x.text.slice(0, 40)]),
    )}`,
  )
  assert.equal(sil.messages.filter((m) => m.role === 'agent' && m.text.trim()).length, 1, '自动接一轮之后正常给出回复')
  assert.match(sil.messages.find((m) => m.role === 'agent' && m.text.trim()).text, /这是 claude 的回复/)

  // 保活时第二句才空：同一个进程里前一轮有正文，空回合判定不能把它算进来，
  // 否则这条消息被标成已完成、进程接着保活，用户的话落进死回合（真实现场：17:54、17:55 两条消息都没回应）
  step('保活中的第二句一个字都没回：同样留下说明并重发这一句')
  {
    let sk = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: def.id,
      cli: 'commandcode',
      askUser: false,
      prompt: '先看代码',
    })
    await call('POST', `/tasks/${sk.id}/seen`, {})
    await call('POST', `/tasks/${sk.id}/presence`, { viewerId: 'e2e-silent-keep', active: true })
    for (let i = 0; i < 120 && !sk.awaitingUser; i++) {
      await sleep(100)
      sk = await call('GET', `/tasks/${sk.id}`)
    }
    assert.ok(sk.awaitingUser, '第一轮正常回复完停在等下一句上')
    await call('POST', `/tasks/${sk.id}/messages`, { text: 'FAKE_SILENT 第二句' })
    const retried = () =>
      sk.messages.some((m) => m.role === 'system' && /没有返回任何内容/.test(m.text)) &&
      sk.messages
        .slice(sk.messages.findIndex((m) => m.text === 'FAKE_SILENT 第二句') + 1)
        .some((m) => m.role === 'agent' && m.text.trim())
    for (let i = 0; i < 200 && !retried(); i++) {
      await sleep(150)
      sk = await call('GET', `/tasks/${sk.id}`)
    }
    assert.ok(
      retried(),
      `第二句空回合要留下说明并重发；现有消息：${JSON.stringify(
        sk.messages.map((x) => [x.role, x.error ?? false, x.text.slice(0, 40)]),
      )}`,
    )
    await call('POST', `/tasks/${sk.id}/presence`, { viewerId: 'e2e-silent-keep', active: false })
    sk = await waitDone(sk.id, 20000)
    assert.equal(sk.status, 'done', sk.messages.at(-1)?.text)
  }

  // Pi：按配置文件（shared/clis/pi.json）拼参数、走 --mode rpc（get_state / prompt / agent_settled）
  let pm = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'pi',
    prompt: '用 Pi',
  })
  pm = await waitDone(pm.id)
  assert.equal(pm.status, 'done', pm.messages.at(-1)?.text)
  c = calls().at(-1)
  assert.equal(c.kind, 'pi')
  assert.deepEqual(c.args.slice(0, 2), ['--mode', 'rpc'])
  assert.equal(
    c.args[c.args.indexOf('--tools') + 1],
    '+grep,+find,+ls,+codemode,+tool_search',
    '全部工具：在 Pi 默认工具上补搜索，codemode 默认开着并进同一个 --tools',
  )
  assert.ok(!c.args.includes('--exclude-tools'), '全部工具时不去掉任何工具')
  assert.equal(c.args[c.args.indexOf('--name') + 1], pm.title, '对话标题交给 Pi 当会话名')
  assert.match(c.input, /^## 用户这次的消息\n用 Pi\n\n/, '任务描述走 RPC 的 prompt 命令')
  const pReply = pm.messages.filter((m) => m.role === 'agent').at(-1)
  assert.match(pReply.text, /这是 pi 的回复/)
  assert.deepEqual(
    pReply.tools.map((x) => x.kind),
    ['read', 'edit'],
  )
  assert.equal(pm.usage.inputTokens, 4000, JSON.stringify(pm.usage))
  await call('POST', `/tasks/${pm.id}/messages`, { text: '继续' })
  await waitDone(pm.id)
  c = calls().at(-1)
  assert.equal(c.args[c.args.indexOf('--session') + 1], pm.sessions[pm.agentId], '继续时用 --session 续接会话')
  pm = await call('GET', `/tasks/${pm.id}`)
  assert.equal(pm.usage.agents[pm.agentId].context, 4321, '上下文占用以 get_session_stats 为准')
  // 压缩走 Pi 的 compact 命令，原地压缩会话；下一轮仍然续接同一个会话，不用写摘要开新会话
  const piSession = pm.sessions[pm.agentId]
  await call('POST', `/tasks/${pm.id}/compact`)
  pm = await waitDone(pm.id)
  c = calls().at(-1)
  assert.equal(c.op, 'compact', 'Pi 用 RPC 的 compact')
  assert.equal(c.args[c.args.indexOf('--session') + 1], piSession, '压缩的是当前会话')
  const piCompact = pm.messages.flatMap((m) => (m.role === 'agent' ? m.tools : [])).find((x) => x.kind === 'compact')
  assert.ok(piCompact, '压缩显示成回复里的一次工具调用（来自 compaction_end）')
  await call('POST', `/tasks/${pm.id}/messages`, { text: '压缩后继续' })
  pm = await waitDone(pm.id)
  c = calls().at(-1)
  assert.equal(c.args[c.args.indexOf('--session') + 1], piSession, '压缩后仍然续接原来的会话')
  assert.ok(!c.input.includes('之前对话的摘要'), '不用带摘要')
  // 撤回到某条消息：Pi 用 RPC 的 fork 截到那条消息之前，不用带上之前的对话开新会话
  pm = await call('GET', `/tasks/${pm.id}`)
  const piUsers = pm.messages.filter((m) => m.role === 'user' && !m.step)
  const piCut = piUsers.at(-1)
  assert.ok(piCut.turn?.id, `每一轮记下这一轮用户消息的 entryId：${JSON.stringify(piCut.turn)}`)
  assert.notEqual(piCut.turn.id, piUsers.at(-2).turn?.id, '每一轮的 entryId 不一样')
  await call('POST', `/tasks/${pm.id}/rewind`, { messageId: piCut.id })
  await call('POST', `/tasks/${pm.id}/messages`, { text: '换个做法' })
  pm = await waitDone(pm.id)
  assert.equal(pm.status, 'done', pm.messages.at(-1)?.text)
  c = calls().at(-1)
  assert.equal(c.forkAt, piCut.turn.id, '分叉到撤回的那条消息之前')
  assert.equal(c.args[c.args.indexOf('--session') + 1], piSession, '先打开原来的会话再分叉')
  assert.ok(!c.args.includes('--fork'))
  assert.ok(!c.input.includes('之前的对话'), '不用把之前的对话塞进提示词')
  assert.notEqual(pm.sessions[pm.agentId], piSession, '分叉出来的是新会话')
  // Pi 出错时退出码也是 0，按最后的 agent_settled 和 assistant 的 stopReason 判断失败
  let pf = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'pi',
    prompt: 'FAIL',
  })
  pf = await waitDone(pf.id)
  assert.equal(pf.status, 'failed')
  assert.match(JSON.stringify(pf.messages), /模拟的失败/)
  // 用户自己加的 CLI：数据目录 config/clis/ 下放一份配置，重新读取后就能用，不用改代码
  const gemSpec = JSON.parse(readFileSync(path.join(root, 'shared/clis/gemini.json'), 'utf8'))
  mkdirSync(path.join(dataDir, 'config/clis'), { recursive: true })
  writeFileSync(
    path.join(dataDir, 'config/clis/my-cli.json'),
    JSON.stringify({ ...gemSpec, id: 'my-cli', name: 'My CLI', command: fake, color: '#123456' }),
  )
  writeFileSync(path.join(dataDir, 'config/clis/broken.json'), JSON.stringify({ id: 'broken', name: 'x' }))
  const us = await call('POST', '/clis/specs/reload', {})
  assert.deepEqual(
    us.specs.map((x) => x.id),
    ['my-cli'],
  )
  assert.ok(
    us.errors.some((e) => /^broken\.json 已跳过：缺少字段 command/.test(e)),
    '写错的配置报出文件名和缺的字段：' + us.errors.join('\n'),
  )
  assert.ok((await call('GET', '/clis')).some((x) => x.id === 'my-cli' && x.installed))
  let mine = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'my-cli',
    prompt: '自己加的',
  })
  mine = await waitDone(mine.id)
  assert.equal(mine.status, 'done', mine.messages.at(-1)?.text)
  assert.match(calls().at(-1).input, /^## 用户这次的消息\n自己加的\n\n/)
  rmSync(path.join(dataDir, 'config/clis'), { recursive: true })
  assert.ok(!(await call('POST', '/clis/specs/reload', {})).specs.length, '删掉配置后不再有')
  step('Gemini CLI 按配置执行；数据目录里加一份配置就能接入新的 CLI')

  // 「/」命令：列出 CLI 自己的命令和 Skill；Claude Code 原样发，其他 CLI 展开成普通要求
  mkdirSync(path.join(project.path, '.claude/commands'), { recursive: true })
  writeFileSync(
    path.join(project.path, '.claude/commands/hello.md'),
    '---\ndescription: 打个招呼\nargument-hint: <名字>\n---\n跟 $ARGUMENTS 打个招呼',
  )
  mkdirSync(path.join(project.path, '.agents/skills/demo-skill'), { recursive: true })
  writeFileSync(
    path.join(project.path, '.agents/skills/demo-skill/SKILL.md'),
    '---\nname: demo-skill\ndescription: 演示用的 Skill\n---\n按演示的步骤做事',
  )
  const cmds = await call('GET', `/clis/claude/commands?projectId=${project.id}`)
  const hello = cmds.find((x) => x.name === 'hello')
  assert.equal(hello?.kind, 'command')
  assert.equal(hello?.hint, '<名字>')
  assert.equal(hello?.description, '打个招呼')
  assert.ok(
    (await call('GET', `/clis/commandcode/commands?projectId=${project.id}`)).some((x) => x.name === 'demo-skill'),
  )
  let sc = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: def.id, prompt: '/hello 小明' })
  await waitDone(sc.id)
  assert.match(calls().at(-1).input, /^## 用户这次的消息\n\/hello 小明/, 'Claude Code 自己认得命令，原样发')
  sc = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: def.id,
    cli: 'commandcode',
    prompt: '/demo-skill 做点事',
  })
  await waitDone(sc.id)
  c = calls().at(-1)
  assert.ok(c.input.includes('Skill「demo-skill」') && c.input.includes('按演示的步骤做事'), 'Skill 展开成要求')
  assert.ok(c.input.includes('做点事'))
  // 引入会话：整理成一份 Markdown 附件
  const ref = await call('POST', `/tasks/${sc.id}/transcript`, {})
  assert.ok(ref.name.endsWith('.md'))
  const refText = readFileSync(ref.path, 'utf8')
  assert.ok(refText.includes('# 参考会话') && refText.includes('/demo-skill 做点事'), refText)
  step('「/」命令和 Skill 按 CLI 列出、展开，会话能整理成附件引入')
  // 导入别人导出的任务：只读，密钥再去一遍，不能继续执行
  const at = new Date().toISOString()
  const bundle = {
    format: 'agent-panel/task',
    version: 1,
    exportedAt: at,
    app: '0.0.0',
    task: {
      title: '别人的任务',
      mode: 'chat',
      agentId: 'their-agent',
      status: 'done',
      messages: [
        { id: 'm1', role: 'user', text: '帮我看看', at },
        { id: 'm2', role: 'agent', agentId: 'their-agent', text: '用 sk-xxxxxxxxxxxxxxxxxxxxxxxx 调接口', at },
      ],
      createdAt: at,
      updatedAt: at,
    },
    agents: [{ id: 'their-agent', name: '他们的 Agent', createdAt: at, updatedAt: at }],
  }
  // 导入返回整棵树（父任务在前）：包里没有子对话时只有一个
  const [imp] = await call('POST', '/tasks/import', { projectId: project.id, bundle })
  assert.equal(imp.projectId, project.id)
  assert.equal(imp.imported.agents[0].name, '他们的 Agent')
  assert.ok(!JSON.stringify(imp).includes('sk-xxxxxxxx'), '导入时去掉密钥')
  await assert.rejects(call('POST', `/tasks/${imp.id}/messages`, { text: '继续' }), /导入的任务/)
  await assert.rejects(call('POST', `/tasks/${imp.id}/fork`, { messageId: 'm1' }), /导入的任务/)
  await assert.rejects(call('PATCH', `/tasks/${imp.id}`, { askUser: true }), /导入的任务/)
  assert.equal((await call('PATCH', `/tasks/${imp.id}`, { title: '改个名' })).title, '改个名', '能改名')
  await assert.rejects(call('POST', '/tasks/import', { bundle: { format: 'x' } }), /不是 Agent 面板导出的任务/)
  // 导出父对话会带上子对话：children 一起导入，父子关系指向本机新分配的父任务
  const tree = await call('POST', '/tasks/import', {
    projectId: project.id,
    bundle: {
      ...bundle,
      children: [{ ...bundle.task, id: 'their-child', title: '他们的子对话', messages: [] }],
    },
  })
  assert.equal(tree.length, 2, '父任务和子对话一起导入')
  assert.equal(tree[1].parentTaskId, tree[0].id, '子对话挂在新分配的父任务下')
  assert.equal(tree[1].rootTaskId, tree[0].id)
  const kids = await call('GET', `/tasks/${tree[0].id}/children`)
  assert.deepEqual(
    kids.map((x) => x.id),
    [tree[1].id],
    '子对话栏能看到导入的子对话',
  )
  // 再导出这个父对话：子对话跟着走，包里还有它的父子关系
  const exported = await call('GET', `/tasks/${tree[0].id}/export`)
  assert.equal(exported.bundle.children.length, 1, '导出父对话会带上它的子对话')
  assert.equal(exported.bundle.children[0].parentTaskId, '', '直接挂在父任务下的子对话写成空')
  assert.ok(exported.bytes > 0, '给出包的体积')
  // 删父对话会连带删掉它的子对话（见 DELETE /tasks/:id）
  for (const tk of [tree[0], imp]) await call('DELETE', `/tasks/${tk.id}`)
  step('导入别人导出的任务：连同子对话建成只读的整棵树，去掉密钥，不能继续执行')
  const other = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: C.id,
    model: 'x',
    prompt: '别的',
  })
  assert.equal(other.model, '', '其他 Agent 不接受临时模型')
  await waitDone(other.id)
  // Chat 模式：不属于项目的聊天，在数据目录里单独的工作目录执行
  // 旧客户端还会传以前默认 Agent 的 id：按不用角色处理
  let free = await call('POST', '/tasks', { mode: 'chat', agentId: 'default-agent', prompt: '随便聊聊' })
  assert.equal(free.projectId, '')
  assert.equal(free.agentId, '', '旧的默认 Agent id 当成不用角色')
  free = await waitDone(free.id)
  assert.equal(free.status, 'done')
  c = calls().at(-1)
  assert.equal(c.cwd, path.join(dataDir, 'chats', free.id), '聊天不在任何项目目录里执行')
  await call('POST', `/tasks/${free.id}/messages`, { text: '再说说' })
  free = await waitDone(free.id)
  assert.ok(calls().at(-1).args.includes('--resume'), '聊天继续时续接会话')
  assert.equal(
    (
      await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'workflow', prompt: 'x' }),
      })
    ).status,
    400,
    '工作流必须选项目',
  )
  await fetch(`${base}/tasks/${free.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })
  assert.ok(!existsSync(path.join(dataDir, 'chats', free.id)), '删除聊天时工作目录一起删掉')
  step(
    '不用角色：直接用默认 CLI，对话时可以临时换模型和思考强度，旧的默认 Agent id 当成不用角色；任务记录执行时间；Chat 模式的聊天不属于项目',
  )

  // ---- 停止 ----
  let slow = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: 'SLOW 慢慢来' })
  // 等 CLI 真的起来再停：慢回合会持续一段时间，条件一到就继续，不用固定等满
  await waitFor(() => calls().some((c) => c.input.includes('SLOW 慢慢来')), { label: '任务开始执行' })
  const t0 = Date.now()
  await call('POST', `/tasks/${slow.id}/stop`)
  slow = await waitDone(slow.id, 8000)
  assert.equal(slow.status, 'stopped')
  assert.ok(Date.now() - t0 < 5000, '停止应该很快生效')
  step('停止：进程被结束，任务标记为已停止')

  // ---- 强制停止：任务停下，CLI 进程一起结束（不留给下一句、后台命令也不留在后面）----
  const forcedTask = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: B.id,
    prompt: 'SLOW 强制停止',
  })
  await waitFor(() => calls().some((c) => c.input.includes('SLOW 强制停止')), { label: '任务开始执行' })
  const forcedPid = calls().at(-1)?.pid
  await call('POST', `/tasks/${forcedTask.id}/stop?force=1`)
  const forcedDone = await waitDone(forcedTask.id, 8000)
  assert.equal(forcedDone.status, 'stopped')
  let forcedEnd = null
  for (let i = 0; i < 40 && !forcedEnd; i++) {
    forcedEnd = calls().find((c) => c.pid === forcedPid)?.end
    if (!forcedEnd) await sleep(150)
  }
  assert.ok(forcedPid && forcedEnd, '强制停止后 CLI 进程结束了')
  step('强制停止：任务停下，CLI 进程一起结束')

  // ---- 插话：Codex 用 turn/steer、Claude Code 写进 stdin、Command Code 用常驻 RPC 的 turn/steer，交给正在跑的这一轮 ----
  {
    const steerLog = () => readLog(`${log}.steer`)
    const chatWith = (extra, prompt) =>
      call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: '', prompt, ...extra })
    let a = await chatWith({ cli: 'codex' }, 'SLOW 插话 codex')
    let b = await chatWith({ cli: 'claude' }, 'SLOW 插话 claude')
    let q = await chatWith({ cli: 'commandcode' }, 'SLOW 插话 cmd')
    // 三个都开始跑之后再插话：插话是交给正在跑的这一轮，不用固定等满
    await waitFor(
      () =>
        ['SLOW 插话 codex', 'SLOW 插话 claude', 'SLOW 插话 cmd'].every((t) => calls().some((c) => c.input.includes(t))),
      { label: '三个 CLI 都开始执行' },
    )
    a = await call('POST', `/tasks/${a.id}/messages`, { text: '顺便看看测试' })
    b = await call('POST', `/tasks/${b.id}/messages`, { text: '也看看文档' })
    q = await call('POST', `/tasks/${q.id}/messages`, { text: '插话给命令行' })
    assert.ok(
      a.messages.some((m) => m.role === 'user' && m.text === '顺便看看测试'),
      '插话的内容马上出现在对话里',
    )
    assert.ok(
      q.messages.some((m) => m.role === 'user' && m.text === '插话给命令行'),
      'Command Code 的插话也立刻进对话',
    )
    a = await waitDone(a.id)
    b = await waitDone(b.id)
    q = await waitDone(q.id)
    assert.equal(a.status, 'done')
    assert.equal(b.status, 'done')
    const sl = steerLog()
    assert.ok(
      sl.some((x) => x.kind === 'codex' && x.steered.some((s) => s.includes('顺便看看测试'))),
      'Codex 收到了插话',
    )
    assert.ok(
      sl.some((x) => x.kind === 'claude' && x.steered.some((s) => s.includes('也看看文档'))),
      'Claude Code 收到了插话',
    )
    assert.ok(
      sl.some((x) => x.kind === 'commandcode' && x.steered.some((s) => s.includes('插话给命令行'))),
      'Command Code 收到了插话',
    )
    const at = a.messages.findIndex((m) => m.text === '顺便看看测试')
    assert.ok(
      a.messages.slice(at + 1).some((m) => m.role === 'agent' && m.text.includes('codex 的回复')),
      '插话之后的输出排在插话后面',
    )
    // 命令的输出边跑边显示，完成后不再是执行中
    const run = a.messages.flatMap((m) => m.tools).find((x) => x.kind === 'run')
    assert.equal(run.output, 'total 8\nREADME.md\n')
    assert.ok(!run.running)
    assert.equal(typeof run.ms, 'number', '跑完的命令记下了耗时')
    step('插话：Codex、Claude Code、Command Code 都交给正在跑的这一轮；命令输出边跑边显示')

    // Pi 的插话要等这一批工具跑完才取：模型在前台 sleep 等 CI 时，面板停下命令，把插话作为新的一句交给它
    let pz = await chatWith({ cli: 'pi' }, 'FAKE_PI_SLEEP 等 CI')
    for (let i = 0; i < 40; i++) {
      pz = await call('GET', `/tasks/${pz.id}`)
      if (pz.messages.some((m) => m.tools.some((x) => x.kind === 'run'))) break
      await sleep(150)
    }
    await call('POST', `/tasks/${pz.id}/messages`, { text: '推送远端' })
    pz = await waitDone(pz.id)
    assert.equal(pz.status, 'done', '停下命令不算这一轮失败')
    const redirected = readLog(`${log}.redirect`)
    assert.ok(
      redirected.some((x) => x.text.includes('推送远端') && x.text.includes('面板说明')),
      'Pi 收到的新一句是插话加上命令被停下的说明',
    )
    const said = pz.messages.findIndex((m) => m.role === 'user' && m.text === '推送远端')
    const after = pz.messages.slice(said + 1)
    assert.ok(
      pz.messages.some((m) => m.tools.some((x) => x.label === '为了马上处理新消息，停下了正在执行的命令')),
      '回复里标出停下了命令',
    )
    assert.ok(
      after.some((m) => m.role === 'agent' && m.text.includes('好的，马上推送')),
      '回复排在插话后面',
    )
    step('插话被长命令挡着（Pi）：停下命令，插话马上交给 Pi，这一轮照常完成')

    // ---- 额度：Codex 主动查，Claude Code 用执行时收到的 ----
    const cl = await call('GET', '/clis/codex/limits')
    assert.deepEqual(
      cl.windows.map((w) => [w.id, w.usedPercent]),
      [
        ['five_hour', 42],
        ['seven_day', 7],
      ],
    )
    assert.equal(cl.plan, 'plus')
    const al = await call('GET', '/clis/claude/limits')
    assert.deepEqual(
      al.windows.map((w) => [w.id, w.usedPercent]),
      [
        ['five_hour', 25],
        ['seven_day', 50],
      ],
    )
    const sk = await call('GET', `/clis/codex/skills?projectId=${project.id}`)
    assert.deepEqual(
      sk.map((x) => x.name),
      ['fake-skill'],
    )
    assert.ok(Array.isArray(await call('GET', '/clis/claude/skills')))
    step('额度：Codex 读 account/rateLimits，Claude Code 用 rate_limit_event；Skill 列表')

    // ---- 压缩上下文 ----
    await call('POST', `/tasks/${a.id}/compact`)
    a = await waitDone(a.id)
    assert.equal(calls().at(-1).op, 'compact', 'Codex 用 thread/compact/start')
    const compactTool = (x) =>
      x.messages.flatMap((m) => (m.role === 'agent' ? m.tools : [])).find((t) => t.kind === 'compact')
    assert.ok(compactTool(a), '压缩显示成回复里的一次工具调用')
    assert.ok(!a.messages.some((m) => m.role === 'system' && m.text === '已压缩上下文'), '不插系统消息把回复切开')
    await call('POST', `/tasks/${b.id}/compact`)
    b = await waitDone(b.id)
    assert.equal(calls().at(-1).input, '/compact', 'Claude Code 用 /compact')
    assert.match(compactTool(b).label, /9\.0k/, '写明压缩前的大小（compact_boundary 的 pre_tokens）')
    let cc = await chatWith({ cli: 'commandcode' }, '第一件事')
    cc = await waitDone(cc.id)
    await call('POST', `/tasks/${cc.id}/compact`)
    cc = await waitDone(cc.id)
    assert.ok(calls().at(-1).input.includes('整理成一份摘要'), 'Command Code 写摘要')
    await call('POST', `/tasks/${cc.id}/messages`, { text: '接着做' })
    cc = await waitDone(cc.id)
    let c = calls().at(-1)
    assert.ok(!c.args.includes('--resume'), '压缩后开新会话')
    assert.ok(c.input.includes('之前对话的摘要') && c.input.includes('接着做'), '新会话带上摘要')
    step('压缩上下文：Codex 用 thread/compact/start，Claude Code 用 /compact，Command Code 写摘要后开新会话')

    // ---- CLI 收下消息后一直没有输出 ----
    // 先在对话里写一行「CLI 没有响应」的警告；再发消息时不再插进卡住的这一轮，而是停掉它、接回会话重开，
    // 没被处理的那条和新消息一起交过去
    let st = await chatWith({ cli: 'commandcode' }, 'STALL_ONCE 先做这件')
    const stallAlert = (x) => x.messages.find((m) => m.alert?.kind === 'no_response')
    st = await waitFor(
      async () => {
        const x = await call('GET', `/tasks/${st.id}`)
        return stallAlert(x) ? x : null
      },
      { label: '没有响应的警告', timeout: 15000 },
    )
    assert.equal(st.status, 'running', '只是警告，不自动停')
    assert.equal(stallAlert(st).alert.level, 'warn')
    assert.match(stallAlert(st).alert.detail, /STALL_ONCE 先做这件/, '原始信息里写着交给它的那条')
    const stalledSession = Object.values(st.sessions ?? {})[0]
    assert.ok(stalledSession, '卡住前已经拿到会话')
    const sentAt = Date.now()
    await call('POST', `/tasks/${st.id}/messages`, { text: '还在吗' })
    // 卡住的 CLI 不理会中断：直接结束进程，不等中断的宽限时间
    assert.ok(Date.now() - sentAt < 4000, `发消息不用等卡住的 CLI 收尾（用了 ${Date.now() - sentAt}ms）`)
    st = await waitDone(st.id)
    assert.equal(st.status, 'done')
    c = calls().at(-1)
    assert.equal(c.args[c.args.indexOf('--resume') + 1], stalledSession, '接回原来的会话')
    assert.ok(
      c.input.includes('一直没有回应') && c.input.includes('STALL_ONCE 先做这件') && c.input.includes('还在吗'),
      '没被处理的那条和新消息一起交过去',
    )
    assert.equal(st.messages.filter((m) => m.role === 'user' && m.text === '还在吗').length, 1, '对话里只显示新消息')
    assert.match(stallAlert(st).alert.resolved ?? '', /停掉了卡住的 CLI/, '警告那一行记下面板重启了它')
    assert.notEqual(st.stopReason, 'user', '不说成用户暂停')
    assert.ok(st.messages.at(-1).role === 'agent', '重开后有回复')
    step('CLI 收下消息后没有输出：先警告，下一条消息停掉它、接回会话重开并带上没处理的那条')

    // ---- 审查改动 ----
    await call('POST', `/tasks/${a.id}/review`)
    a = await waitDone(a.id)
    c = calls().at(-1)
    assert.equal(c.op, 'review')
    assert.deepEqual(c.reviewTarget, { type: 'uncommittedChanges' })
    assert.equal(a.messages.at(-1).text, '审查结论：没有发现问题。', '只显示审查结论')
    await call('POST', `/tasks/${b.id}/review`, { base: 'main' })
    b = await waitDone(b.id)
    assert.ok(calls().at(-1).input.includes('请审查当前分支相对 main 的改动'))
    step('审查改动：Codex 用审查模式，其他 CLI 按审查的要求跑一轮')

    // ---- 分叉、撤回 ----
    let f = await chatWith({ cli: 'claude' }, '第一问')
    f = await waitDone(f.id)
    await call('POST', `/tasks/${f.id}/messages`, { text: '第二问' })
    f = await waitDone(f.id)
    const [u1, u2] = f.messages.filter((m) => m.role === 'user')
    assert.ok(u1.turn?.end && u2.turn?.end, 'Claude Code 的每一轮记下最后一条回复的 uuid')
    let fk = await call('POST', `/tasks/${f.id}/fork`, { messageId: u1.id })
    assert.deepEqual(
      fk.messages.filter((m) => m.role === 'user').map((m) => m.text),
      ['第一问'],
      '分叉只带到这条消息和它的回复',
    )
    await call('POST', `/tasks/${fk.id}/messages`, { text: '分叉后' })
    fk = await waitDone(fk.id)
    c = calls().at(-1)
    const argAt = (k) => c.args[c.args.indexOf(k) + 1]
    assert.equal(argAt('--resume'), u1.turn.session)
    assert.ok(c.args.includes('--fork-session'))
    assert.equal(argAt('--resume-session-at'), u1.turn.end, '从第一轮的最后一条回复截断')
    assert.ok(!fk.rewind, '分叉后接上了新会话')
    const rw = await call('POST', `/tasks/${f.id}/rewind`, { messageId: u2.id })
    assert.equal(rw.text, '第二问', '撤回的内容交回去方便改')
    assert.deepEqual(
      rw.task.messages.filter((m) => m.role === 'user').map((m) => m.text),
      ['第一问'],
    )
    await call('POST', `/tasks/${f.id}/messages`, { text: '改过的第二问' })
    await waitDone(f.id)
    c = calls().at(-1)
    assert.equal(argAt('--resume-session-at'), u1.turn.end)
    // Codex：thread/fork 带上那一轮的 turn id
    let g = await chatWith({ cli: 'codex' }, '问 codex')
    g = await waitDone(g.id)
    const gu = g.messages.find((m) => m.role === 'user')
    assert.equal(gu.turn.id, 't1')
    const gk = await call('POST', `/tasks/${g.id}/fork`, { messageId: gu.id })
    await call('POST', `/tasks/${gk.id}/messages`, { text: '分叉后' })
    await waitDone(gk.id)
    assert.deepEqual(calls().at(-1).fork, { from: gu.turn.session, lastTurnId: 't1' })
    // Command Code：截在中间时开新会话，把留下的对话带上
    let h = await chatWith({ cli: 'commandcode' }, '甲问题')
    h = await waitDone(h.id)
    await call('POST', `/tasks/${h.id}/messages`, { text: '乙问题' })
    h = await waitDone(h.id)
    const hu = h.messages.filter((m) => m.role === 'user')
    await call('POST', `/tasks/${h.id}/rewind`, { messageId: hu[1].id })
    await call('POST', `/tasks/${h.id}/messages`, { text: '丙问题' })
    await waitDone(h.id)
    c = calls().at(-1)
    assert.ok(!c.args.includes('--resume'))
    assert.ok(c.input.includes('之前的对话') && c.input.includes('甲问题') && !c.input.includes('乙问题'))
    // 从最后一轮分叉可以直接用 --fork-session
    const hk = await call('POST', `/tasks/${h.id}/fork`, {
      messageId: (await call('GET', `/tasks/${h.id}`)).messages.filter((m) => m.role === 'user').at(-1).id,
    })
    await call('POST', `/tasks/${hk.id}/messages`, { text: '丁问题' })
    await waitDone(hk.id)
    c = calls().at(-1)
    assert.ok(c.args.includes('--resume') && c.args.includes('--fork-session'))
    step(
      '对话分叉、撤回：Claude Code 用 --resume-session-at，Codex 用 thread/fork，Command Code 截不了时带上之前的对话',
    )

    // ---- 自动压缩阈值：Claude Code 用环境变量，Codex 换算成 token 数 ----
    await call('PUT', '/settings', {
      ...settings,
      clis: {
        ...settings.clis,
        claude: cli({ defaultModel: 'sonnet', autoCompact: 70 }),
        codex: cli({ autoCompact: 50 }),
      },
    })
    let z1 = await chatWith({ cli: 'claude' }, '自动压缩')
    await waitDone(z1.id)
    assert.equal(calls().at(-1).compactPct, '70')
    let z2 = await chatWith({ cli: 'codex' }, '自动压缩')
    await waitDone(z2.id)
    assert.ok(
      calls()
        .at(-1)
        .args.some((x) => /^model_auto_compact_token_limit=\d+$/.test(x)),
    )
    await call('PUT', '/settings', settings)
    step('自动压缩阈值：Claude Code 用 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE，Codex 用 model_auto_compact_token_limit')
  }

  // ---- 执行中发消息：立刻进对话，能交给 CLI 就实时送达；交不出去时这一轮结束后马上接着处理 ----
  {
    // Claude Code 能在执行中插话：发出去立刻是正常消息，并被交给正在跑的这一轮
    let q = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      cli: 'claude',
      prompt: 'SLOW 执行中发消息',
    })
    await waitFor(() => calls().some((c) => c.input.includes('SLOW 执行中发消息')), { label: '任务开始执行' })
    const before = q.messages.length
    q = await call('POST', `/tasks/${q.id}/messages`, { text: '执行中补一句' })
    assert.equal('queue' in q, false, '不再有排队字段')
    assert.equal(q.messages.length, before + 1, '消息马上进对话')
    assert.equal(q.messages.at(-1).text, '执行中补一句')
    // 交付方式回传给前端：能插进当前这一轮就说清楚，不是只存个内部枚举值
    assert.equal(q.messages.at(-1).delivery?.how, 'steer', '插进当前这一轮的消息记下交付方式')
    assert.ok(Date.parse(q.messages.at(-1).delivery.at) > 0, '交付时间也记上')
    assert.equal(q.status, 'running', '这一轮还在跑')
    // Command Code 用常驻 RPC 的 turn/steer，同样立刻进对话
    let c = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      prompt: 'SLOW 执行中发给命令行',
    })
    await waitFor(() => calls().some((c) => c.input.includes('SLOW 执行中发给命令行')), {
      label: '任务开始执行',
    })
    c = await call('POST', `/tasks/${c.id}/messages`, { text: '命令行也来一句' })
    assert.ok(
      c.messages.some((m) => m.role === 'user' && m.text === '命令行也来一句'),
      'Command Code 的消息也立刻进对话',
    )
    assert.equal(
      c.messages.find((m) => m.text === '命令行也来一句')?.delivery?.how,
      'steer',
      'Command Code 用 turn/steer 插进这一轮，交付方式也回传',
    )
    q = await waitDone(q.id)
    c = await waitDone(c.id)
    assert.equal(q.status, 'done')
    assert.equal(c.status, 'done')
    assert.ok(
      readLog(`${log}.steer`).some((x) => x.steered.some((s) => s.includes('执行中补一句'))),
      'Claude Code 收到了执行中发的消息',
    )
    // 既不能插话、也不用面板工具取补充的 CLI（Gemini CLI）：消息照样立刻进对话，
    // 这一轮完全结束后马上开始新一轮接着处理，不用用户再发一次
    let g = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'gemini',
      prompt: 'SLOW 交不出去的消息',
    })
    const g0 = calls().filter((c) => c.kind === 'gemini').length
    await waitFor(() => calls().filter((c) => c.kind === 'gemini').length > g0, { label: 'Gemini 开始执行' })
    // CLI 正在跑长命令时连发两条：两条各自记下「这一轮结束后自动处理」，都会交给 CLI 处理
    const h1 = await call('POST', `/tasks/${g.id}/messages`, { text: '这一轮结束后处理这条' })
    const h2 = await call('POST', `/tasks/${g.id}/messages`, { text: '这一轮结束后处理另一条' })
    assert.equal(h1.messages.at(-1).text, '这一轮结束后处理这条', '交不出去的消息也立刻进对话')
    assert.equal(h1.messages.at(-1).delivery?.how, 'held', '这一轮收不下的记成「结束后自动处理」')
    assert.equal(h2.messages.at(-1).text, '这一轮结束后处理另一条')
    assert.equal(h2.messages.at(-1).delivery?.how, 'held', '第二条也一样记下交付方式')
    assert.equal(h2.status, 'running', '第一轮还没结束')
    // 第一轮结束后自动逐条开新一轮：等三轮都跑完（中间会短暂停在 done）
    const t1 = Date.now()
    for (;;) {
      g = await call('GET', `/tasks/${g.id}`)
      const users = g.messages.filter((m) => m.role === 'user').length
      const finished =
        g.status !== 'running' && users >= 3 && calls().filter((c) => c.kind === 'gemini').length >= g0 + 3
      if (finished) break
      if (Date.now() - t1 > 40000) throw new Error('执行中收到的消息没有在下一轮接着处理')
      await sleep(100)
    }
    assert.equal(g.status, 'done')
    const texts = g.messages.filter((m) => m.role === 'user').map((m) => m.text)
    assert.deepEqual(
      texts,
      ['SLOW 交不出去的消息', '这一轮结束后处理这条', '这一轮结束后处理另一条'],
      '两条排队的消息都接着处理了，不重复记消息',
    )
    // 两条都被真的交给了 CLI：不是只记在对话里
    const seen = calls()
      .filter((c) => c.kind === 'gemini')
      .map((c) => c.input)
      .join('\n')
    assert.ok(seen.includes('这一轮结束后处理这条'), '第一条排队的消息交给了 CLI')
    assert.ok(seen.includes('这一轮结束后处理另一条'), '第二条排队的消息也交给了 CLI')
    assert.deepEqual(
      g.messages.filter((m) => m.role === 'user').map((m) => m.delivery?.how),
      [undefined, 'next', 'next'],
      '排队消息被取走后，状态从「结束后自动处理」改成实际发生的事（按新的一轮处理）',
    )
    // 这一轮收不下的消息，用户又点了停止：标成「没送出去」，让用户知道要重发
    let x = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'gemini',
      prompt: 'SLOW 停下前排队的消息',
    })
    const x0 = calls().filter((c) => c.kind === 'gemini').length
    await waitFor(() => calls().filter((c) => c.kind === 'gemini').length > x0, { label: 'Gemini 开始执行' })
    x = await call('POST', `/tasks/${x.id}/messages`, { text: '停止后要重发的这条' })
    assert.equal(x.messages.at(-1).delivery?.how, 'held', '先记成「结束后自动处理」')
    await call('POST', `/tasks/${x.id}/stop`)
    await waitFor(
      async () => {
        const now = await call('GET', `/tasks/${x.id}`)
        return now.messages.find((m) => m.text === '停止后要重发的这条')?.delivery?.how === 'lost' ? now : undefined
      },
      { timeout: 20000, label: '停止后排队消息标成没送出去' },
    )
    // 打断：停下当前这一轮马上处理
    let r = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      prompt: 'SLOW 打断测试',
    })
    await waitFor(() => calls().some((c) => c.input.includes('SLOW 打断测试')), { label: '任务开始执行' })
    const t0 = Date.now()
    r = await call('POST', `/tasks/${r.id}/messages`, { text: '马上改做这个', interrupt: true })
    r = await waitDone(r.id, 10000)
    assert.ok(Date.now() - t0 < 8000, '打断后很快处理新的要求')
    assert.equal(r.status, 'done')
    assert.equal(r.messages.filter((m) => m.role === 'user').at(-1).text, '马上改做这个')
  }
  step('执行中发消息：立刻进对话并实时交给 CLI，不再有排队；也可以打断马上处理')
})
