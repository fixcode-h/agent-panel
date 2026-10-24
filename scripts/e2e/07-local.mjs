/**
 * 端到端测试分片：找不到命令、模型列表、目录浏览、真实执行、安装与版本更新、项目说明、本机请求与令牌、保活、Skills/MCP、项目分组
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs），
 * 互不影响。总入口 scripts/e2e.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'

import http from 'node:http'
import path from 'node:path'
import { runShard } from './harness.mjs'

await runShard('本机请求与设置', async (api) => {
  const {
    baseUrl: base,
    root,
    tmp,
    dataDir,
    homeDir,
    projectDir,
    appDir,
    relPort,
    log,
    call,
    sleep,
    waitFor,
    waitDone,
    calls,
    readLog,
    step,
    onExit,
    freePort,
    cli,
    setupBase,
  } = api
  const { project, A, B, C, settings, wf } = await setupBase()
  // ---- 找不到命令 / 停用 ----
  await call('PUT', '/settings', {
    ...settings,
    clis: {
      ...settings.clis,
      commandcode: cli({ command: path.join(tmp, 'nope', 'cmdc') }),
      codex: cli({ enabled: false }),
    },
  })
  const clis2 = await call('GET', '/clis?refresh=1')
  assert.equal(clis2.find((x) => x.id === 'commandcode').installed, false)
  let missing = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: C.id, prompt: 'hi' })
  missing = await waitDone(missing.id)
  assert.equal(missing.status, 'failed')
  assert.match(
    missing.messages
      .filter((m) => m.error)
      .map((m) => m.text)
      .join('\n'),
    /找不到命令[\s\S]*npm install -g command-code/,
  )
  let disabled = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: 'hi' })
  disabled = await waitDone(disabled.id)
  assert.equal(disabled.status, 'failed')
  assert.match(
    disabled.messages
      .filter((m) => m.error)
      .map((m) => m.text)
      .join('\n'),
    /停用/,
  )
  step('找不到命令、CLI 被停用时给出明确提示')

  // 从本机 CLI 读取模型列表
  await call('PUT', '/settings', settings)
  const cm = await call('GET', '/clis/codex/models?refresh=1')
  assert.equal(cm.source, 'cli')
  assert.deepEqual(
    cm.models.map((m) => m.id),
    ['fake-pro', 'fake-mini'],
    '隐藏的模型不列出',
  )
  assert.deepEqual(cm.efforts, ['low', 'high', 'ultra'])
  const mm = await call('GET', '/clis/commandcode/models?refresh=1')
  assert.deepEqual(
    mm.models.map((m) => [m.id, m.group]),
    [
      ['fake/flash', 'Open Source'],
      ['fake/pro', 'Open Source'],
      ['gpt-fake', 'OpenAI'],
    ],
  )
  assert.equal(mm.models[0].isDefault, true)
  const pim = await call('GET', '/clis/pi/models?refresh=1')
  assert.equal(pim.source, 'cli')
  assert.deepEqual(
    pim.models.map((m) => [m.id, m.contextWindow, m.efforts.length > 0]),
    [
      ['anthropic/claude-fake', 200000, true],
      ['ollama/qwen-fake:7b', 128000, false],
    ],
  )
  const cl = await call('GET', '/clis/claude/models')
  assert.equal(cl.source, 'builtin')
  assert.ok(cl.models.some((m) => m.id === 'claude-opus-5-5'))
  assert.ok(!cl.models.some((m) => m.id === 'opus'), '不列别名')
  step('从本机 CLI 读取模型列表：Codex 走 app-server，Command Code、Pi 走 --list-models')

  // 目录浏览带上快速入口（Windows 上是各个盘符）
  const listing = await call('GET', `/fs/list?path=${encodeURIComponent(tmp)}`)
  assert.ok(listing.roots.length >= 2 && listing.roots[0].name === '主目录')
  const made = await call('POST', '/fs/mkdir', { parent: tmp, name: 'new-folder' })
  assert.equal(made.path, path.join(tmp, 'new-folder'))
  assert.ok((await call('GET', `/fs/list?path=${encodeURIComponent(tmp)}`)).dirs.some((d) => d.name === 'new-folder'))
  await assert.rejects(call('POST', '/fs/mkdir', { parent: tmp, name: 'new-folder' }), /已经存在/)
  await assert.rejects(call('POST', '/fs/mkdir', { parent: tmp, name: '../escape' }), /不能包含/)
  await assert.rejects(call('POST', '/fs/mkdir', { parent: path.join(tmp, 'nope'), name: 'x' }), /新建文件夹失败/)
  step('目录浏览列出主目录和磁盘，可以新建文件夹（不重名、不能带路径、父目录要存在）')

  // ---- 正式版没有模拟执行：旧设置里的 execution 会被忽略，任务一律真实调用 CLI ----
  await call('PUT', '/settings', { ...settings, execution: 'simulate' })
  assert.equal((await call('GET', '/settings')).execution, undefined)
  assert.equal((await call('GET', '/settings')).openBrowser, true, '默认启动后打开浏览器')
  let sim = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: '真实执行' })
  const before = calls().length
  sim = await waitDone(sim.id)
  assert.equal(sim.status, 'done')
  assert.equal(sim.simulated, false)
  assert.ok(calls().length > before, '任务应当调用 CLI')
  step('没有模拟执行：任务总是调用本机 CLI')

  // 重命名；停止后继续执行
  assert.equal((await call('PATCH', `/tasks/${sim.id}`, { title: '新标题' })).title, '新标题')
  let rs = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: '停一下再继续' })
  await call('POST', `/tasks/${rs.id}/stop`)
  rs = await waitDone(rs.id)
  assert.equal(rs.status, 'stopped')
  await call('POST', `/tasks/${rs.id}/resume`)
  rs = await waitDone(rs.id)
  assert.equal(rs.status, 'done')
  assert.equal(rs.messages.filter((m) => m.role === 'user').length, 1, '继续执行不会新增用户消息')
  await assert.rejects(call('POST', `/tasks/${rs.id}/resume`), /只有失败或停止/)
  step('重命名任务；停止后继续执行')

  // ---- 在设置里安装 / 卸载 CLI ----
  const waitJob = async (id) => {
    for (;;) {
      const j = await call('GET', `/clis/jobs/${id}`)
      if (j.status !== 'running') return j
      await sleep(100)
    }
  }
  let ij = await call('POST', '/clis/claude/install')
  assert.equal(ij.command, 'npm install -g @anthropic-ai/claude-code@latest')
  ij = await waitJob(ij.id)
  assert.equal(ij.status, 'done', ij.error)
  assert.match(ij.log, /added 1 package/)
  assert.match(ij.log, /npm warn/, 'stderr 也记进输出')
  assert.equal(ij.cliStatus.installed, true)
  assert.equal(ij.update, true, '已经装了，这次是更新')
  assert.match(ij.cliStatus.version, /9\.9\.9/, '更新后版本号变了')
  let uj = await waitJob((await call('POST', '/clis/codex/uninstall')).id)
  // 假 CLI 不是 npm 装的，卸载后还能找到：要提示用其他方式卸载
  assert.equal(uj.status, 'failed')
  assert.match(uj.error, /手动删除/)
  assert.deepEqual(
    readLog(log + '.npm')
      .filter((a) => a[0] !== 'prefix' && a[0] !== 'view')
      .map((a) => a.slice(0, 3)),
    [
      ['install', '-g', '@anthropic-ai/claude-code@latest'],
      ['uninstall', '-g', '@openai/codex'],
    ],
  )
  await assert.rejects(call('POST', '/clis/nope/install'), /未知的 Agent/)
  // Pi 改过包名：装新包前先卸掉旧的，否则两个包提供同一个 pi 命令时 npm 会报 EEXIST
  const pj = await waitJob((await call('POST', '/clis/pi/install')).id)
  assert.equal(pj.status, 'done', pj.error)
  assert.equal(pj.command, 'npm install -g @earendil-works/pi-coding-agent@latest')
  assert.deepEqual(
    readLog(log + '.npm')
      .filter((a) => a[0] === 'install' || a[0] === 'uninstall')
      .map((a) => a.slice(0, 3))
      .slice(-2),
    [
      ['uninstall', '-g', '@mariozechner/pi-coding-agent'],
      ['install', '-g', '@earendil-works/pi-coding-agent@latest'],
    ],
  )
  // 切走再回来能找到最近一次操作
  assert.deepEqual(
    (await call('GET', '/clis/jobs')).map((j) => [j.cli, j.status]),
    [
      ['claude', 'done'],
      ['codex', 'failed'],
      ['pi', 'done'],
    ],
  )
  // 有新版本才显示更新：假 npm 说最新是 9.9.9，假 CLI 回到 0.0.1
  rmSync(log + '.ver', { force: true })
  await call('GET', '/clis?refresh=1')
  const up = await call('GET', '/clis/claude/update?refresh=1')
  assert.deepEqual([up.current, up.latest, up.available], ['0.0.1', '9.9.9', true])
  // CLI 的顺序按设置排
  await call('PUT', '/settings', { ...settings, cliOrder: ['commandcode', 'claude'] })
  assert.deepEqual(
    (await call('GET', '/clis')).map((c) => c.id),
    ['commandcode', 'claude', 'codex', 'gemini', 'pi'],
  )
  await call('PUT', '/settings', settings)
  step('设置里安装 / 卸载 CLI：调用 npm、记录输出、完成后重新检测')

  // ---- 版本更新 ----
  const rels = await call('GET', '/app/releases?refresh=1')
  assert.equal(rels.current, '0.11.5')
  assert.equal(rels.packaged, true)
  assert.deepEqual(
    rels.releases.map((r) => [r.tag, r.prerelease]),
    [
      ['v0.11.9-dev', true],
      ['v0.11.8', false],
      ['v0.11.4', false],
    ],
  )
  assert.equal(rels.update.tag, 'v0.11.8', '正式版只提示更新的正式版')
  // 检查的时间和结果记在缓存目录里；不带 refresh 的自动检查 6 小时内直接用上次的结果
  assert.ok(rels.checkedAt, '返回上次检查的时间')
  assert.ok(existsSync(path.join(dataDir, 'cache/updates/releases.json')), '检查结果存到缓存目录')
  assert.equal((await call('GET', '/app/releases')).checkedAt, rels.checkedAt, '6 小时内不重新检查')
  await assert.rejects(call('POST', '/app/install', { tag: 'v9.9.9' }), /找不到版本/)
  const installJob = async (tag) => {
    let j = await call('POST', '/app/install', { tag })
    for (let i = 0; j.status === 'running' && i < 150; i++) {
      await sleep(100)
      j = await call('GET', `/app/install/${j.id}`)
    }
    return j
  }
  // 哈希对不上：不装，程序文件不动
  let aj = await installJob('v0.11.4')
  assert.equal(aj.status, 'failed')
  assert.match(aj.error, /校验不通过/)
  assert.equal(readFileSync(path.join(appDir, 'server.mjs'), 'utf8'), '// old\n')
  // 新的服务端加载不了：自动换回原来的文件
  aj = await installJob('v0.11.8')
  assert.equal(aj.status, 'failed')
  assert.match(aj.error, /退回原来的版本/)
  assert.equal(readFileSync(path.join(appDir, 'server.mjs'), 'utf8'), '// old\n')
  assert.ok(existsSync(path.join(appDir, 'dist/old.html')), '前端也换回来')
  // 有任务在执行：先下载，任务结束前不替换程序
  const busyTask = await call('POST', '/tasks', { mode: 'chat', agentId: B.id, prompt: 'SLOW 更新等待' })
  let wj = await call('POST', '/app/install', { tag: 'v0.11.9-dev' })
  assert.equal(wj.status, 'running', '任务执行中也能开始下载')
  for (let i = 0; i < 100 && !/等待任务结束/.test(wj.phase); i++) {
    await sleep(100)
    wj = await call('GET', `/app/install/${wj.id}`)
  }
  assert.match(wj.phase, /等待任务结束/, '下载完等任务结束')
  assert.equal(readFileSync(path.join(appDir, 'server.mjs'), 'utf8'), '// old\n', '任务结束前不替换程序')
  await call('POST', `/tasks/${busyTask.id}/stop`)
  await waitDone(busyTask.id)
  for (let i = 0; i < 150 && wj.status === 'running'; i++) {
    await sleep(100)
    wj = await call('GET', `/app/install/${wj.id}`)
  }
  aj = wj
  assert.equal(aj.status, 'done', aj.error)
  assert.equal(readFileSync(path.join(appDir, 'server.mjs'), 'utf8'), '// new 0.11.9-dev\n')
  assert.ok(existsSync(path.join(appDir, 'dist/index.html')) && !existsSync(path.join(appDir, 'dist/old.html')))
  assert.equal(readFileSync(path.join(appDir, 'data/keep.json'), 'utf8'), '{"keep":true}', '数据不能动')
  assert.equal(readFileSync(path.join(appDir, 'AgentPanel.exe'), 'utf8'), 'tray-0.11.9-dev', '托盘程序换成新的')
  assert.ok(
    readdirSync(appDir).some((n) => n.startsWith('AgentPanel.exe.old-')),
    '上次挪开的旧托盘程序还被占用时，挪到新名字',
  )
  assert.ok(!existsSync(path.join(appDir, 'dist.old')) && !existsSync(path.join(appDir, 'dist.next')))
  // 回到上一个版本：和当前版本互换，换完还能再换回来
  assert.equal((await call('GET', '/app/version')).previous, '0.11.5')
  assert.deepEqual(await call('POST', '/app/rollback'), { version: '0.11.5' })
  assert.equal(readFileSync(path.join(appDir, 'server.mjs'), 'utf8'), '// old\n')
  assert.ok(existsSync(path.join(appDir, 'dist/old.html')))
  assert.equal(readFileSync(path.join(dataDir, 'cache/updates/previous/server.mjs'), 'utf8'), '// new 0.11.9-dev\n')
  step('版本更新：读取 GitHub 上的包、校验哈希，替换程序文件、保留数据；新版本加载不了自动退回，也能手动回到上一个版本')

  // ---- 项目说明文件：读、写（只认白名单里的文件名）、AI 优化 ----
  {
    let docs = await call('GET', `/project-docs/${project.id}`)
    assert.equal(docs.dir, projectDir)
    assert.ok(docs.files.some((f) => f.path === 'AGENTS.md' && !f.exists))
    const saved = await call('PUT', `/project-docs/${project.id}`, { path: '.claude/CLAUDE.md', content: '# 约定\n' })
    assert.equal(saved.exists, true)
    assert.equal(readFileSync(path.join(projectDir, '.claude/CLAUDE.md'), 'utf8'), '# 约定\n')
    await assert.rejects(call('PUT', `/project-docs/${project.id}`, { path: '../x.md', content: 'x' }), /400/)
    assert.ok(!existsSync(path.join(projectDir, '../x.md')), '不能写到白名单外')
    let job = await call('POST', `/project-docs/${project.id}/optimize`, {
      path: 'AGENTS.md',
      content: '# 项目\n',
      cli: 'commandcode',
    })
    for (let i = 0; job.status === 'running' && i < 100; i++) {
      await sleep(100)
      job = await call('GET', `/doc-jobs/${job.id}`)
    }
    assert.equal(job.status, 'done', job.error)
    assert.equal(job.text, '补上了常用命令。')
    assert.ok(
      job.result.startsWith('# 项目\n') && job.result.includes('## 常用命令\n\n```bash\nnpm test\n```'),
      job.result,
    )
    docs = await call('GET', `/project-docs/${project.id}`)
    assert.ok(!docs.files.find((f) => f.path === 'AGENTS.md').exists, '优化不直接写文件')
    rmSync(path.join(projectDir, '.claude'), { recursive: true })
    step('项目说明文件：读写、拒绝白名单外的路径、AI 优化')
  }

  // ---- AI 处理报错：整理成第一句话（带上相关的安装情况），在聊天里新建一个对话去排查 ----
  {
    const base = await call('GET', '/settings')
    await call('PUT', '/settings', { ...base, assist: { ...base.assist, cli: 'commandcode' } })
    await assert.rejects(call('POST', '/ai-fix', { title: '' }), /400/)
    const s = await call('POST', '/ai-fix', {
      title: 'Pi：卸载没有成功',
      error: '还能找到 pi.cmd',
      command: 'npm uninstall -g @mariozechner/pi-coding-agent',
      output: 'up to date in 364ms',
      // 对话里的报错会带上项目路径和出错前后的对话
      conversation: '用户：帮我把 Pi 卸载干净\n\nAI：好的，先看安装位置\n\n报错：还能找到 pi.cmd',
      cwd: 'F:\\Project\\demo',
      topic: 'cli:pi',
    })
    assert.equal(s.cli, 'commandcode')
    for (const part of [
      '出了什么问题：Pi：卸载没有成功',
      '还能找到 pi.cmd',
      'npm uninstall -g',
      'up to date in 364ms',
      '相关的 CLI：Pi',
      '报错前后的对话：',
      'AI：好的，先看安装位置',
      '相关目录（项目路径）：F:\\Project\\demo',
    ])
      assert.ok(s.prompt.includes(part), part)
    let task = await call('POST', '/tasks', {
      projectId: '',
      mode: 'chat',
      agentId: '',
      cli: s.cli,
      model: s.model,
      prompt: s.prompt,
      askUser: true,
    })
    task = await waitDone(task.id)
    assert.equal(task.status, 'done')
    assert.ok(
      (await call('GET', '/tasks')).some((x) => x.id === task.id),
      '排查的对话留在聊天列表里',
    )
    await call('DELETE', `/tasks/${task.id}`)
    await call('PUT', '/settings', base)
    step('AI 处理报错：整理报错、命令、输出和相关的安装情况，在聊天里新建对话排查')
  }

  // ---- 账号和 API：登录、保存、切换、登出；用 API 时把地址和密钥交给 CLI，模型只列这个 API 的 ----
  {
    const base0 = await call('GET', '/settings')
    const withAuth = (extra = {}) => ({
      ...base0,
      ...extra,
      clis: Object.fromEntries(
        ['claude', 'codex', 'commandcode', 'gemini', 'pi'].map((id) => [
          id,
          { ...base0.clis[id], env: [{ key: 'FAKE_AUTH', value: id }], ...(extra.clis?.[id] ?? {}) },
        ]),
      ),
    })
    await call('PUT', '/settings', withAuth())
    const list = async (cli) => (await call('GET', '/accounts')).find((x) => x.cli === cli)
    const waitLogin = async (cli) => {
      for (let i = 0; i < 100; i++) {
        const j = await call('GET', `/accounts/${cli}/login`)
        if (j && j.status !== 'running') return j
        await sleep(150)
      }
      throw new Error('登录没有结束')
    }
    assert.deepEqual(
      (await call('GET', '/accounts')).map((x) => [x.cli, x.live.loggedIn, x.accounts.length]),
      [
        ['claude', false, 0],
        ['codex', false, 0],
        ['commandcode', false, 0],
        ['gemini', false, 0],
        ['pi', false, 0],
      ],
      '一开始都没登录',
    )
    // Codex：登录两个账号，凭据文件换成新的，之前的自动存下来
    const authFile = path.join(homeDir, '.codex', 'auth.json')
    const emailOf = () =>
      JSON.parse(Buffer.from(JSON.parse(readFileSync(authFile, 'utf8')).tokens.id_token.split('.')[1], 'base64url'))
        .email
    let j = await call('POST', '/accounts/codex/login')
    assert.equal(j.status, 'running')
    j = await waitLogin('codex')
    assert.equal(j.status, 'done', JSON.stringify(j))
    assert.match(j.url, /^https:\/\/example\.com\/oauth\/authorize/, '登录网址（localhost 的回调地址不算）')
    let c = await list('codex')
    assert.deepEqual(
      [c.live.loggedIn, c.live.email, c.unsaved, c.accounts.map((a) => [a.email, a.active])],
      [true, 'fake1@example.com', false, [['fake1@example.com', true]]],
    )
    await call('POST', '/accounts/codex/login')
    assert.equal((await waitLogin('codex')).status, 'done')
    c = await list('codex')
    assert.deepEqual(
      c.accounts.map((a) => [a.email, a.active]),
      [
        ['fake1@example.com', false],
        ['fake2@example.com', true],
      ],
      '登录第二个账号：第一个还在，第二个是现在用的',
    )
    assert.equal(emailOf(), 'fake2@example.com')
    // 切换回第一个：凭据文件换回去
    const first = c.accounts[0]
    c = await call('POST', '/accounts/codex/switch', { id: first.id })
    assert.equal(emailOf(), 'fake1@example.com')
    assert.deepEqual(
      c.accounts.map((a) => a.active),
      [true, false],
    )
    // 改名、登出（凭据文件没了，账号还在）、再切回来
    c = await call('PATCH', `/accounts/codex/accounts/${first.id}`, { name: '工作号' })
    assert.equal(c.accounts[0].name, '工作号')
    c = await call('POST', '/accounts/codex/logout')
    assert.deepEqual([c.live.loggedIn, c.accounts.length, existsSync(authFile)], [false, 2, false])
    c = await call('POST', '/accounts/codex/switch', { id: first.id })
    assert.deepEqual([c.live.loggedIn, c.live.email, emailOf()], [true, 'fake1@example.com', 'fake1@example.com'])
    c = await call('DELETE', `/accounts/codex/accounts/${c.accounts[1].id}`)
    assert.equal(c.accounts.length, 1)
    // Claude Code：除了凭据文件，账号信息在 .claude.json 的 oauthAccount 里，别的内容不动；登出后只去掉它
    const claudeJson = path.join(homeDir, '.claude.json')
    writeFileSync(claudeJson, JSON.stringify({ userID: 'u-1', theme: 'dark' }))
    await call('POST', '/accounts/claude/login')
    assert.equal((await waitLogin('claude')).status, 'done')
    c = await list('claude')
    assert.deepEqual([c.live.email, c.accounts.length], ['fake3@example.com', 1])
    assert.equal(JSON.parse(readFileSync(claudeJson, 'utf8')).userID, 'u-1', '.claude.json 里别的内容原样保留')
    await call('POST', '/accounts/claude/logout')
    const left = JSON.parse(readFileSync(claudeJson, 'utf8'))
    assert.deepEqual(
      [left.oauthAccount, left.theme, existsSync(path.join(homeDir, '.claude', '.credentials.json'))],
      [undefined, 'dark', false],
    )
    // Gemini CLI：登录后 CLI 不退出，凭据一变面板就算登录成功并停掉它；登录前先写好登录方式
    await call('POST', '/accounts/gemini/login')
    assert.equal((await waitLogin('gemini')).status, 'done')
    assert.equal((await list('gemini')).live.email, 'fake4@example.com')
    assert.equal(
      JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'settings.json'), 'utf8')).security.auth.selectedType,
      'oauth-personal',
    )
    // Command Code：凭据里认不出邮箱，用起的名字；同一份凭据不重复保存
    await call('POST', '/accounts/commandcode/login')
    assert.equal((await waitLogin('commandcode')).status, 'done')
    c = await call('POST', '/accounts/commandcode/save', { name: '备用' })
    assert.deepEqual(
      c.accounts.map((a) => a.name),
      ['Command Code 账号 1'],
      '已经保存过的凭据不重复保存',
    )

    // API：读模型列表（在服务端请求），选用后模型下拉只列这个 API 的模型，地址和密钥按 CLI 的规则传进去
    const apiSrv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.headers.authorization !== 'Bearer sk-test')
        return void res.writeHead(401).end(JSON.stringify({ error: { message: 'bad key' } }))
      res.end(JSON.stringify({ data: [{ id: 'm-b' }, { id: 'm-a' }] }))
    })
    await new Promise((r) => apiSrv.listen(0, '127.0.0.1', r))
    // 这个临时 server 也要登记：后面的断言一失败，它留着就会让进程退不出去
    const closeApiSrv = onExit(() => {
      apiSrv.closeAllConnections()
      apiSrv.close()
    })
    const apiBase = `http://127.0.0.1:${apiSrv.address().port}/v1`
    // name 必填（服务端按厂家名称查默认地址和余额接口），页面传的是整份 API 配置
    const got = await call('POST', '/accounts/api-models', {
      name: 'OpenAI',
      protocol: 'openai-chat',
      baseUrl: apiBase,
      apiKey: 'sk-test',
    })
    assert.deepEqual(got.models, ['m-a', 'm-b'])
    await assert.rejects(
      call('POST', '/accounts/api-models', {
        name: 'OpenAI',
        protocol: 'openai-chat',
        baseUrl: apiBase,
        apiKey: 'wrong',
      }),
      /401/,
    )
    // 缺 name 要明确报错，不能静默当成空名字（那样厂家默认地址和余额接口都查不到）
    await assert.rejects(
      call('POST', '/accounts/api-models', { protocol: 'openai-chat', baseUrl: apiBase, apiKey: 'sk-test' }),
      /at name/,
    )
    // 余额接口：地址只按厂家名称取，不支持余额的厂家、缺名称、缺密钥都要明确报错
    await assert.rejects(call('POST', '/accounts/api-balance', { name: '中转 A', apiKey: 'sk-test' }), /不支持余额查询/)
    await assert.rejects(call('POST', '/accounts/api-balance', { apiKey: 'sk-test' }), /at name/)
    await assert.rejects(call('POST', '/accounts/api-balance', { name: 'DeepSeek', apiKey: '' }), /先填密钥/)
    closeApiSrv()
    const apis = [
      {
        id: 'ap1',
        name: '中转 A',
        provider: 'relay-a',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example/v1',
        apiKey: 'sk-relay',
        authHeader: 'x-api-key',
        models: ['relay-1', 'relay-2'],
      },
      {
        id: 'ap2',
        name: 'Claude 中转',
        provider: 'claude-relay',
        protocol: 'anthropic',
        baseUrl: 'https://claude.example',
        apiKey: 'sk-ant',
        authHeader: 'bearer',
        models: ['claude-x'],
      },
    ]
    await call(
      'PUT',
      '/settings',
      withAuth({ apis, clis: { codex: { authMode: 'api', apiId: 'ap1' }, claude: { authMode: 'api', apiId: 'ap2' } } }),
    )
    const cm = await call('GET', '/clis/codex/models?refresh=1')
    assert.deepEqual(
      [cm.auth, cm.from, cm.models.map((m) => m.id), cm.models[0].isDefault],
      ['api', '中转 A', ['relay-1', 'relay-2'], true],
      'API 模式只列这个 API 的模型',
    )
    const accountModels = await call('GET', '/clis/gemini/models?refresh=1')
    assert.notEqual(accountModels.auth, 'api', '账号模式不受影响')
    const before = calls().length
    const t1 = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'codex',
      model: 'relay-1',
      prompt: '用 API 跑',
    })
    await waitDone(t1.id)
    const t2 = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'claude',
      model: 'claude-x',
      prompt: '用 API 跑 claude',
    })
    await waitDone(t2.id)
    const used = calls().slice(before)
    const codexCall = used.find((x) => x.kind === 'codex')
    const codexConfig = readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8')
    assert.ok(codexConfig.includes('model_provider = "relay-a"'), 'Codex 的 provider 写进 config.toml')
    assert.ok(codexConfig.includes('[model_providers.relay-a]'))
    assert.ok(codexConfig.includes('base_url = "https://relay.example/v1"'))
    assert.ok(codexConfig.includes('wire_api = "responses"'))
    assert.ok(codexConfig.includes('experimental_bearer_token = "sk-relay"'), '密钥也写进配置文件')
    assert.ok(!codexCall.args.some((a) => a.includes('model_providers')), '不再用 -c 传接口')
    assert.ok(!codexCall.args.includes('model_provider="relay-a"'))
    assert.equal(codexCall.apiEnv.agentpanel, undefined, '不再把密钥放在环境变量里')
    assert.ok(!codexCall.args.join(' ').includes('sk-relay'))
    const claudeCall = used.find((x) => x.kind === 'claude')
    const claudeSettings = JSON.parse(readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8'))
    assert.equal(claudeSettings.env?.ANTHROPIC_BASE_URL, 'https://claude.example')
    assert.equal(claudeSettings.env?.ANTHROPIC_AUTH_TOKEN, 'sk-ant', 'Bearer 方式写进 settings.json')
    assert.deepEqual(claudeCall.apiEnv.anthropic, [null, null, null], '不再走环境变量')
    // 协议对不上的 API 不会交给 CLI（Codex 选了 Anthropic 的 API）
    await call('PUT', '/settings', withAuth({ apis, clis: { codex: { authMode: 'api', apiId: 'ap2' } } }))
    assert.notEqual((await call('GET', '/clis/codex/models?refresh=1')).auth, 'api')
    assert.ok(
      !readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8').includes('model_providers.relay-a'),
      '协议对不上时清掉上一次写进去的 provider',
    )
    // 改用 API 需要改配置文件的 CLI：Gemini CLI 选了 gemini-api-key，改回账号时还原；Command Code 写进自定义接口
    await call(
      'PUT',
      '/settings',
      withAuth({
        apis: [
          {
            id: 'g1',
            name: 'Gemini Key',
            protocol: 'gemini',
            baseUrl: '',
            apiKey: 'gk',
            authHeader: 'x-api-key',
            models: ['gem-1'],
          },
          {
            id: 'c1',
            name: 'CC 接口',
            provider: 'cc',
            protocol: 'openai-chat',
            baseUrl: 'https://cc.example/v1',
            apiKey: 'ck',
            authHeader: 'x-api-key',
            models: ['cc-1'],
          },
        ],
        clis: {
          gemini: { authMode: 'api', apiId: 'g1' },
          commandcode: { authMode: 'api', apiId: 'c1' },
          pi: { authMode: 'api', apiId: 'c1' },
        },
      }),
    )
    const g = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'gemini',
      model: 'gem-1',
      prompt: '用 gemini API',
    })
    await waitDone(g.id)
    const geminiSettings = () => JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'settings.json'), 'utf8'))
    const geminiEnvFile = path.join(homeDir, '.gemini', '.env')
    const geminiEnv = () => readFileSync(geminiEnvFile, 'utf8')
    assert.equal(geminiSettings().security.auth.selectedType, 'gemini-api-key')
    assert.match(geminiEnv(), /GEMINI_API_KEY=gk/, '密钥写进 .gemini/.env')
    assert.match(geminiEnv(), /GOOGLE_GEMINI_BASE_URL=/)
    assert.equal(calls().findLast((x) => x.kind === 'gemini').apiEnv.gemini[0], null, '不再走环境变量')
    assert.equal(
      calls().findLast((x) => x.kind === 'gemini').apiEnv.trust,
      'true',
      'Gemini CLI 无界面运行要信任工作目录，否则报「not running in a trusted directory」',
    )
    const cc = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      model: 'cc-1',
      prompt: '用 cc API',
    })
    await waitDone(cc.id)
    const ccFile = path.join(homeDir, '.commandcode', 'settings.json')
    const ccProviders = path.join(homeDir, '.commandcode', 'providers.json')
    assert.deepEqual(JSON.parse(readFileSync(ccProviders, 'utf8')).provider.cc, {
      name: 'CC 接口',
      baseURL: 'https://cc.example/v1',
      apiKey: 'ck',
      api: 'openai-completions',
      models: { 'cc-1': {} },
    })
    assert.equal(JSON.parse(readFileSync(ccFile, 'utf8')).provider?.agentpanel, undefined, '不再写旧的 settings.json')
    const ccCall = calls().findLast((x) => x.kind === 'commandcode')
    assert.equal(ccCall.apiEnv.agentpanel, undefined, '密钥不再走环境变量')
    // 两种方式的模型下拉各列各的：API 方式只列这个 API 的；账号方式（还没保存就先读）不列 BYOK 和 API 的模型
    assert.deepEqual(
      (await call('GET', '/clis/commandcode/models?refresh=1')).models.map((m) => m.id),
      ['cc/cc-1'],
    )
    const ccAccount = await call('GET', '/clis/commandcode/models?auth=account')
    assert.deepEqual(
      [ccAccount.auth, ccAccount.models.map((m) => m.id)],
      ['account', ['fake/flash', 'fake/pro', 'gpt-fake']],
      '账号方式只列账号的模型',
    )
    assert.ok(!ccCall.args.join(' ').includes('ck'))
    // Pi：自己接的接口写进 models.json 的 providers，模型 ID 自带 provider
    const pa = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'pi',
      model: 'cc-1',
      prompt: '用 pi API',
    })
    await waitDone(pa.id)
    const piModels = path.join(homeDir, '.pi', 'agent', 'models.json')
    assert.deepEqual(JSON.parse(readFileSync(piModels, 'utf8')).providers.cc, {
      baseUrl: 'https://cc.example/v1',
      api: 'openai-completions',
      apiKey: 'ck',
      models: [{ id: 'cc-1' }],
    })
    const piCall = calls().findLast((x) => x.kind === 'pi')
    assert.equal(piCall.apiEnv.agentpanel, undefined, '密钥不再走环境变量')
    assert.ok(!piCall.args.includes('--provider'), '不再额外传 provider，模型 ID 自带前缀')
    assert.equal(piCall.args[piCall.args.indexOf('--model') + 1], 'cc/cc-1')
    await call(
      'PUT',
      '/settings',
      withAuth({
        apis: [],
        clis: { gemini: { authMode: 'account' }, commandcode: { authMode: 'account' }, pi: { authMode: 'account' } },
      }),
    )
    const g2 = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'gemini',
      prompt: '改回账号',
    })
    await waitDone(g2.id)
    assert.equal(geminiSettings().security.auth.selectedType, 'oauth-personal', '改回账号还原登录方式')
    assert.ok(!geminiEnv().includes('GEMINI_API_KEY'), '改回账号删掉 .env 里的 API 配置')
    assert.equal(
      JSON.parse(readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8')).env?.ANTHROPIC_AUTH_TOKEN,
      undefined,
      '改回账号删掉 Claude settings.json 里的 API 配置',
    )
    const cc2 = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      prompt: '改回账号 cc',
    })
    await waitDone(cc2.id)
    assert.equal(JSON.parse(readFileSync(ccFile, 'utf8')).provider?.agentpanel, undefined)
    assert.equal(JSON.parse(readFileSync(ccProviders, 'utf8')).provider?.cc, undefined)
    const pa2 = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'pi',
      prompt: '改回账号 pi',
    })
    await waitDone(pa2.id)
    assert.equal(JSON.parse(readFileSync(piModels, 'utf8')).providers?.cc, undefined, '改回账号删掉接口')
    // 凭据不进数据导出
    const backup = await call('GET', '/data/export?kinds=config,projects,tasks,uploads')
    assert.ok(!Object.keys(backup.files).some((f) => f.startsWith('accounts')), '账号凭据不在备份里')
    await call('PUT', '/settings', base0)
    step(
      '账号和 API：登录、保存、切换、登出（Claude Code 的 .claude.json 只动账号信息）；API 模式把地址和密钥写进 CLI 自己的配置、执行只传模型、协议对不上不用',
    )
  }

  // ---- 只接受本机页面的请求 ----
  const raw = (method, url, headers, body) =>
    new Promise((resolve, reject) => {
      const u = new URL(base + url)
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end(body)
    })
  assert.equal(
    await raw('GET', '/projects', { host: 'evil.example:' + new URL(base).port }),
    403,
    'DNS 重绑定：外部域名的 Host',
  )
  assert.equal(await raw('GET', '/projects', { origin: 'https://evil.example' }), 403, '外部网站的 Origin')
  assert.equal(await raw('POST', '/assist', { 'content-type': 'text/plain' }, '{}'), 415, '不是 JSON 的写请求')
  assert.equal(await raw('GET', '/projects', { origin: 'http://localhost:5173' }), 200, '本机页面可以访问')
  step('只接受本机页面的请求：拦下外部 Host、外部 Origin 和非 JSON 的写请求')

  // ---- 访问令牌 ----
  {
    const token = readFileSync(path.join(dataDir, 'access-token'), 'utf8').trim()
    const json = { 'content-type': 'application/json' }
    const cur = await call('GET', '/settings')
    const on = await fetch(base + '/settings', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ ...cur, requireToken: true }),
    })
    const cookie = (on.headers.get('set-cookie') ?? '').split(';')[0]
    assert.equal(cookie, `agent_panel_token=${token}`, '打开令牌的浏览器拿到 Cookie')
    assert.equal((await fetch(base + '/projects')).status, 401, '没带令牌被拒绝')
    assert.equal((await fetch(base + '/projects', { headers: { cookie } })).status, 200)
    // 带令牌的地址：发 Cookie 后跳到去掉令牌的地址
    const r = await fetch(base.replace('/api', '') + `/tasks?token=${token}&x=1`, { redirect: 'manual' })
    assert.equal(r.status, 302)
    assert.equal(r.headers.get('location'), '/tasks?x=1')
    assert.match(r.headers.get('set-cookie') ?? '', /agent_panel_token=/)
    assert.equal((await fetch(base.replace('/api', '') + '/?token=wrong', { redirect: 'manual' })).status, 401)
    await fetch(base + '/settings', { method: 'PUT', headers: { ...json, cookie }, body: JSON.stringify(cur) })
    assert.equal((await fetch(base + '/projects')).status, 200, '关掉后不再要求')
  }
  step('访问令牌：打开后没带令牌的请求被拒绝，用带令牌的地址打开的浏览器拿到 Cookie')

  // 没有提问通道的 CLI（Command Code、Gemini CLI）：面板临时接一个 ask_user 工具，等用户回答后交回，项目里原有的 MCP 配置用完还原
  {
    const mcpFile = path.join(project.path, '.mcp.json')
    const original = JSON.stringify({ mcpServers: { mine: { command: 'x' } } })
    writeFileSync(mcpFile, original)
    for (const cli of ['commandcode', 'gemini', 'pi']) {
      const before = readLog(log + '.askbridge').length
      const t = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: '',
        cli,
        askUser: true,
        prompt: `想做什么 FAKE_ASK:${JSON.stringify({ questions: [{ header: '方向', question: '想做什么？', options: [{ label: '修 bug（推荐）' }, { label: '写文档' }] }] })}`,
      })
      let req
      for (let i = 0; i < 100 && !req; i++) {
        req = (await call('GET', `/tasks/${t.id}`)).requests[0]
        if (!req) await sleep(100)
      }
      assert.ok(req, `${cli}：弹出了提问`)
      assert.equal(req.kind, 'question')
      assert.deepEqual(req.options, ['修 bug（推荐）', '写文档'])
      await call('POST', `/tasks/${t.id}/requests/${req.id}`, { allow: true, answers: ['写文档'] })
      const done = await waitDone(t.id)
      assert.equal(done.status, 'done')
      const rec = readLog(log + '.askbridge')
        .slice(before)
        .at(-1)
      // Command Code 现在用 RPC 的 turn/steer 插话；notes 与 steer 不再互斥，所以 read_user_notes 也注册了：
      // steer 在 CLI 不在活跃轮次时返回 false，没这个兜底通道补充消息会丢
      // 编排工具也挂在同一个面板服务上，这里只看提问这一组
      assert.deepEqual(
        rec.tools.filter((n) => ['ask_user', 'wait_user_message', 'read_user_notes'].includes(n)),
        cli === 'commandcode' ? ['ask_user', 'read_user_notes', 'wait_user_message'] : ['ask_user'],
      )
      // 共享状态只存在于工作流运行的 task.runs 里，对话模式没有：这两个工具不注册，模型不会调到一个必然失败的
      assert.ok(
        !rec.tools.includes('read_state') && !rec.tools.includes('write_state'),
        `${cli}：对话模式不注册 read_state / write_state`,
      )
      assert.match(rec.got, /想做什么？ → 写文档/, '回答交回给了模型')
      assert.ok(rec.hint, '提示里告诉模型有 ask_user')
      assert.ok(done.messages.some((m) => /收到：用户的回答/.test(m.text)))
    }
    assert.equal(readFileSync(mcpFile, 'utf8'), original, '项目里原有的 MCP 配置还原')
    assert.ok(!existsSync(path.join(project.path, '.gemini', 'settings.json')), '临时写的配置删掉了')
    assert.ok(!existsSync(path.join(project.path, '.pi')), 'Pi 的桥接扩展不写进项目')
    const piExt = calls()
      .filter((x) => x.kind === 'pi')
      .map((x) => x.args[x.args.indexOf('-e') + 1])
      .find((x) => x && /agent-panel-panel/.test(x))
    assert.ok(piExt && path.isAbsolute(piExt) && piExt.startsWith(dataDir), `桥接扩展在面板的数据目录里：${piExt}`)
    assert.ok(!existsSync(piExt), 'Pi 的桥接扩展用完删掉了')
    // 提问开关关着：不弹出，工具让模型自己选
    const off = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: `FAKE_ASK:${JSON.stringify({ questions: [{ question: '选哪个？', options: [{ label: 'a' }] }] })}`,
    })
    const offDone = await waitDone(off.id)
    assert.equal(offDone.requests.length, 0)
    assert.match(readLog(log + '.askbridge').at(-1).got, /不回答问题/)
    rmSync(mcpFile, { force: true })
  }
  step('没有提问通道的 CLI：临时接 ask_user 工具，回答后交回模型，开关关着时让模型自己选，项目里原有的配置还原')

  // 执行中补充：Command Code 走常驻 RPC 的 turn/steer，已经在「插话」那一节覆盖；
  // MCP 的 read_user_notes 拉取通道由 server/ask-mcp.test.ts 单独测试

  // 对话页开着时：CLI 回复完停在 wait_user_message 上，下一句直接交给同一个进程；切走宽限到了就结束
  {
    const before = readLog(log + '.wait').length
    let w = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: 'FAKE_WAIT 先看代码',
    })
    // 打开对话页时前端会先报已读，再报页面开着
    await call('POST', `/tasks/${w.id}/seen`, {})
    await call('POST', `/tasks/${w.id}/presence`, { viewerId: 'e2e', active: true })
    w = await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${w.id}`)
        return t.awaitingUser ? t : null
      },
      { timeout: 20000, label: '预热完停在等下一句' },
    )
    assert.ok(w.awaitingUser, '回复完停在等下一句上')
    assert.equal(w.working, false, '等下一句不算执行中')
    assert.ok(w.turnDoneAt, 'CLI 完成一轮时记了时间')
    await call('POST', `/tasks/${w.id}/messages`, { text: '接着看看测试' })
    w = await waitDone(w.id, 30000)
    assert.equal(w.status, 'done')
    assert.equal(w.awaitingUser, false)
    assert.equal('queue' in w, false, '不再有排队字段')
    const rec = readLog(log + '.wait')
      .slice(before)
      .at(-1)
    assert.match(rec.got, /接着看看测试/)
    assert.ok(rec.hint, '提示里告诉模型可以等下一句')
    const at = w.messages.findIndex((m) => m.role === 'user' && m.text === '接着看看测试')
    assert.ok(at > 0, '用户消息记进对话')
    assert.ok(
      w.messages.slice(at + 1).some((m) => m.role === 'agent' && /等到的下一句/.test(m.text)),
      'AI 在用户消息下面继续输出',
    )

    // 页面切走：宽限到了让还在等的 CLI 结束这一轮
    let left = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: 'FAKE_WAIT 等一会儿',
    })
    await call('POST', `/tasks/${left.id}/presence`, { viewerId: 'e2e', active: true })
    left = await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${left.id}`)
        return t.awaitingUser ? t : null
      },
      { timeout: 20000, label: '预热完停在等下一句' },
    )
    assert.ok(left.awaitingUser, '第二个对话也停在等下一句上')
    assert.equal(left.working, false, '等下一句不算执行中')
    assert.ok(left.turnDoneAt, '完成一轮时记了时间')
    await call('POST', `/tasks/${left.id}/presence`, { viewerId: 'e2e', active: false })
    left = await waitDone(left.id, 15000)
    assert.equal(left.status, 'done', '切走宽限到了，CLI 自己结束')
    assert.equal(left.awaitingUser, false)
    assert.equal(left.working, false)
  }
  step('对话页开着时 CLI 停在等下一句上：下一句直接交给同一个进程，切走后结束')

  // 对话页开着、模型没有调用 wait_user_message：面板自己把进程留着，回来发消息不再启动新进程
  {
    const beforePids = new Set(readLog(log).map((x) => x.pid))
    let w = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: '先看代码',
    })
    // 打开对话页时前端会先报已读，再报页面开着
    await call('POST', `/tasks/${w.id}/seen`, {})
    await call('POST', `/tasks/${w.id}/presence`, { viewerId: 'e2e', active: true })
    w = await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${w.id}`)
        return t.awaitingUser ? t : null
      },
      { timeout: 20000, label: '预热完停在等下一句' },
    )
    assert.ok(w.awaitingUser, '回复完停在等下一句上，不靠模型调用等待工具')
    assert.equal(w.working, false, '等下一句不算执行中')
    assert.ok(w.turnDoneAt, 'CLI 完成一轮时记了时间')

    // 回来发消息：同一个进程接着跑，不再启动新的 CLI（跑完这一轮又会保活，所以任务还是 running）
    const beforeMsgs = w.messages.length
    // 带一张图：交给 Agent 的是拷进任务目录的相对路径，记进对话的必须是上传目录里的原路径，
    // 否则气泡和看大图的浮层都取不到图，只剩破图（以前这里把相对路径当原附件记了进去）
    const nextAtt = await call('POST', '/uploads', {
      name: '接着说.png',
      mime: 'image/png',
      data: Buffer.from('png2').toString('base64'),
    })
    await call('POST', `/tasks/${w.id}/messages`, { text: '接着说', attachments: [nextAtt] })
    for (let i = 0; i < 120; i++) {
      w = await call('GET', `/tasks/${w.id}`)
      // 新的一句已经回复完、又回到等下一句：这一轮处理过了
      if (w.awaitingUser && w.messages.length > beforeMsgs) break
      await sleep(100)
    }
    assert.ok(w.messages.length > beforeMsgs, '用户消息和回复都记进对话')
    const pids = readLog(log)
      .filter((x) => !beforePids.has(x.pid))
      .map((x) => x.pid)
    assert.equal(new Set(pids).size, 1, '整个过程只启动了一个 CLI 进程')
    assert.equal('queue' in w, false, '不再有排队字段')
    const at = w.messages.findIndex((m) => m.role === 'user' && m.text === '接着说')
    assert.ok(at > 0, '用户消息记进对话')
    const saidAtt = w.messages[at].attachments?.[0]
    assert.ok(saidAtt, '附件跟着这条消息记进对话')
    assert.ok(saidAtt.path.startsWith(path.join(dataDir, 'uploads')), '记进对话的是上传目录里的绝对路径')
    // 交给 Agent 的那份照旧拷进任务的执行目录（这个对话在项目目录里跑），提示里的相对路径指向它
    assert.ok(existsSync(path.join(projectDir, 'attachments', saidAtt.name)), '拷进对话目录的那份还在，Agent 读得到')
    // 旧消息里存的是相对路径：接口按文件名回上传目录取到图，页面上的旧消息因此能恢复显示
    const relRaw = await fetch(`${base}/uploads/raw?path=${encodeURIComponent(`attachments/${saidAtt.name}`)}`)
    assert.equal(relRaw.status, 200, '相对路径也能取到图')
    assert.equal(await relRaw.text(), 'png2')
    assert.equal(
      (await fetch(`${base}/uploads/raw?path=${encodeURIComponent('attachments/../../etc/passwd')}`)).status,
      400,
      '不能借相对路径读附件目录以外的文件',
    )
    assert.ok(
      w.messages.slice(at + 1).some((m) => m.role === 'agent' && m.text.trim()),
      'AI 在用户消息下面继续输出',
    )

    // 用户走开（过了宽限）：保活结束，进程退出
    await call('POST', `/tasks/${w.id}/presence`, { viewerId: 'e2e', active: false })
    w = await waitDone(w.id, 15000)
    assert.equal(w.status, 'done', '切走宽限到了，CLI 自己结束')
  }
  step('模型没调用等待工具时，面板也把进程留着：回来发消息复用同一个 CLI')

  // 打开对话页就预热：轮询看到 done 的那一下，引擎刚标完状态、收尾还没释放执行位。
  // 这里不隔 sleep 紧循环盯住第一轮结束，看到 done 立刻预热（CI 上 60ms 轮询更容易撞进这个窗口）
  {
    let r = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: '看到 done 就预热',
    })
    for (;;) {
      r = await call('GET', `/tasks/${r.id}`)
      if (r.status !== 'running') break
    }
    assert.equal(r.status, 'done')
    r = await call('POST', `/tasks/${r.id}/prewarm`, {})
    assert.ok(r.status === 'running' || r.awaitingUser, '看到 done 后立刻预热也要真的把 CLI 启动回来')
    // 收掉这个对话的进程，别留给后面的用例
    await call('POST', `/tasks/${r.id}/seen`, {})
    await call('POST', `/tasks/${r.id}/presence`, { viewerId: 'e2e', active: false })
    await waitDone(r.id, 15000)
  }
  step('看到第一轮 done 就立刻预热，也要真的把 CLI 启动回来')

  // 预热接口本身：切换 CLI/模型后服务端会用它重开进程；打开对话页不再自动调用它
  {
    let w = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: '普通对话',
    })
    w = await waitDone(w.id, 30000)
    assert.equal(w.status, 'done')
    assert.ok(w.sessions[''], '第一轮留下了会话')
    assert.ok(w.turnDoneAt, '第一轮完成时记了时间')
    const doneAt = w.turnDoneAt
    const beforeMsgs = w.messages.length

    w = await call('POST', `/tasks/${w.id}/prewarm`, {})
    assert.ok(w.status === 'running' || w.awaitingUser, '打开对话就开始启动')
    assert.equal(w.working, false, '预热不算执行中')
    w = await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${w.id}`)
        return t.awaitingUser ? t : null
      },
      { timeout: 20000, label: '预热完停在等下一句' },
    )
    assert.ok(w.awaitingUser, '预热完停在等下一句上')
    assert.equal(w.prewarming, false)
    assert.equal(w.working, false, '预热/等下一句不算执行中')
    assert.equal(w.messages.length, beforeMsgs, '预热不往对话里加消息')
    assert.equal(w.turnDoneAt, doneAt, '预热本身不算完成一轮')

    // 预热好了再发消息：直接交给同一个进程，不用重新启动
    await call('POST', `/tasks/${w.id}/messages`, { text: '预热后直接问' })
    w = await waitDone(w.id, 30000)
    const at = w.messages.findIndex((m) => m.role === 'user' && m.text === '预热后直接问')
    assert.ok(at > 0, '用户消息记进对话')
    assert.ok(
      w.messages.slice(at + 1).some((m) => m.role === 'agent' && /等到的下一句/.test(m.text)),
      '模型在用户消息下面继续输出',
    )
    assert.notEqual(w.turnDoneAt, doneAt, '真正处理了用户消息才算完成一轮')
    const askedDoneAt = w.turnDoneAt
    const askedUpdatedAt = w.updatedAt

    // 再预热一次，然后切走：宽限到了结束，不在后台一直占着
    w = await call('POST', `/tasks/${w.id}/prewarm`, {})
    w = await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${w.id}`)
        return t.awaitingUser ? t : null
      },
      { timeout: 20000, label: '预热完停在等下一句' },
    )
    assert.ok(w.awaitingUser, '再次打开也预热好了')
    // 打开过这个对话：之后切走才会按宽限期回收；没打开过的话会一直留着等用户回来
    await call('POST', `/tasks/${w.id}/seen`, {})
    await call('POST', `/tasks/${w.id}/presence`, { viewerId: 'e2e', active: false })
    w = await waitDone(w.id, 15000)
    assert.equal(w.status, 'done')
    assert.equal(w.prewarming, false)
    assert.equal(w.working, false)
    assert.equal(w.turnDoneAt, askedDoneAt, '切走让预热退出不算完成一轮')
    assert.equal(w.updatedAt, askedUpdatedAt, '预热退出不改列表时间')
  }
  step('预热接口：切换 CLI/模型后按新选择重开进程，停在等下一句；打开对话页不再自动预热')

  // Skills / 命令库：读写各 CLI 用户目录下的 Skill 和命令，复制给别的 CLI 时命令自动换格式
  {
    const lib = (kind) => call('GET', `/library?kind=${kind}`)
    const put = (b) => call('PUT', '/library/file', b)
    await put({
      cli: 'claude',
      kind: 'skill',
      name: 'lib-demo',
      create: true,
      content: '---\nname: lib-demo\ndescription: 库里的测试 Skill\n---\n\n步骤\n',
    })
    const skillDir = path.join(homeDir, '.claude', 'skills', 'lib-demo')
    writeFileSync(path.join(skillDir, 'notes.md'), '附带文件')
    const listed = (await lib('skill')).items.find((i) => i.cli === 'claude' && i.name === 'lib-demo')
    assert.equal(listed.description, '库里的测试 Skill')
    assert.deepEqual((await call('GET', '/library/file?cli=claude&kind=skill&name=lib-demo')).files, ['notes.md'])
    await assert.rejects(
      put({ cli: 'claude', kind: 'skill', name: 'lib-demo', create: true, content: 'x' }),
      /已经有了/,
    )
    await assert.rejects(put({ cli: 'claude', kind: 'skill', name: '../evil', content: 'x' }), /名字/)
    // 复制给 Codex：整个文件夹带过去；已有同名的不覆盖
    let cp = await call('POST', '/library/copy', { cli: 'claude', kind: 'skill', name: 'lib-demo', to: ['codex'] })
    assert.deepEqual(cp.done, ['codex'])
    assert.ok(existsSync(path.join(homeDir, '.codex', 'skills', 'lib-demo', 'notes.md')))
    cp = await call('POST', '/library/copy', { cli: 'claude', kind: 'skill', name: 'lib-demo', to: ['codex'] })
    assert.deepEqual(cp.skipped, ['codex'])
    // 命令：Claude Code 是 md，Gemini CLI 是 toml
    await put({
      cli: 'claude',
      kind: 'command',
      name: 'lib-cmd',
      create: true,
      content: '---\ndescription: 测试命令\n---\n做点事 $ARGUMENTS\n',
    })
    await call('POST', '/library/copy', { cli: 'claude', kind: 'command', name: 'lib-cmd', to: ['gemini'] })
    const toml = readFileSync(path.join(homeDir, '.gemini', 'commands', 'lib-cmd.toml'), 'utf8')
    assert.match(toml, /description = "测试命令"/)
    assert.ok(toml.includes('{{args}}'))
    assert.ok((await lib('command')).items.some((i) => i.cli === 'gemini' && i.name === 'lib-cmd'))
    await call('DELETE', '/library/file?cli=gemini&kind=command&name=lib-cmd')
    await call('DELETE', '/library/file?cli=claude&kind=skill&name=lib-demo')
    assert.ok(!existsSync(skillDir), '删除 Skill 连文件夹一起删')
    assert.ok(existsSync(path.join(homeDir, '.codex', 'skills', 'lib-demo')), '只删选中的 CLI 里的那一份')
  }
  step('Skills / 命令库：新建、列出、复制给别的 CLI（命令换格式）、删除，名字不能越出目录')

  // 项目设置里的 Skill 分节：只读写项目目录下的技能目录，AI 修复拿得到路径和原文
  {
    const repo = '.agents/skills'
    const skillDir = path.join(projectDir, repo, 'proj-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: proj-skill\ndescription: 项目里的测试技能，按团队约定写提交说明\n---\n\n步骤\n',
    )
    writeFileSync(path.join(skillDir, 'run.sh'), 'echo hi\n')
    mkdirSync(path.join(projectDir, repo, 'bad-skill'), { recursive: true })
    writeFileSync(path.join(projectDir, repo, 'bad-skill/SKILL.md'), '---\nname: bad-skill\n---\n\n正文\n')

    const view = await call('GET', `/project-skills?projectId=${project.id}`)
    assert.equal(view.path, projectDir)
    const ok = view.skills.find((s) => s.name === 'proj-skill')
    assert.equal(ok.description, '项目里的测试技能，按团队约定写提交说明')
    assert.equal(ok.source, repo)
    assert.deepEqual(ok.issues, [])
    assert.ok(ok.clis.length > 1, '.agents/skills 由几个 Agent 共用，技能记下它们')
    assert.ok(
      view.repos.some((r) => r.dir === '.claude/skills'),
      '也能放 Claude Code 的项目技能',
    )
    const bad = view.skills.find((s) => s.name === 'bad-skill')
    assert.match(bad.issues.join(), /description/)

    // 各 Agent 在这个项目下能看到的技能里也有它
    const seen = await call('GET', `/clis/pi/skills?projectId=${project.id}`)
    assert.ok(
      seen.some((s) => s.name === 'proj-skill'),
      '项目目录里的技能出现在各 Agent 的列表里',
    )

    const file = await call(
      'GET',
      `/project-skills/file?projectId=${project.id}&repo=${encodeURIComponent(repo)}&name=proj-skill`,
    )
    assert.match(file.content, /description: 项目里的测试技能，按团队约定写提交说明/)
    assert.deepEqual(file.files, ['run.sh'], 'SKILL.md 以外的文件也列出来')

    // 新建骨架：写下来的就是合法格式
    await call('POST', '/project-skills', {
      projectId: project.id,
      repo,
      name: 'new-skill',
      description: '新建技能的说明够长了',
    })
    const made = readFileSync(path.join(projectDir, repo, 'new-skill/SKILL.md'), 'utf8')
    assert.match(made, /name: new-skill/)
    assert.match(made, /description: 新建技能的说明够长了/)

    await call('PUT', '/project-skills/file', {
      projectId: project.id,
      repo,
      name: 'new-skill',
      content: '---\nname: new-skill\ndescription: 改过的说明文字\n---\n\n新的步骤\n',
    })
    assert.match(readFileSync(path.join(projectDir, repo, 'new-skill/SKILL.md'), 'utf8'), /改过的说明文字/)

    // 只能碰 Agent 定义里的项目技能目录
    await assert.rejects(
      call('PUT', '/project-skills/file', { projectId: project.id, repo: '.git', name: 'x', content: 'x' }),
      /不能放 Skill/,
    )
    await assert.rejects(
      call('PUT', '/project-skills/file', { projectId: project.id, repo, name: '../evil', content: 'x' }),
      /名字/,
    )
    assert.ok(!existsSync(path.join(projectDir, 'evil')))

    // AI 修复：把 SKILL.md 的路径和原文交给 AI，提示里带项目目录
    const fix = await call('POST', '/ai-fix', {
      title: 'Skill「bad-skill」格式有问题',
      error: bad.issues.join('\n'),
      context: `SKILL.md：${bad.path}\n\n当前的 SKILL.md：\n\`\`\`markdown\n---\nname: bad-skill\n---\n\n正文\n\`\`\``,
      cwd: projectDir,
      topic: 'project-skill',
    })
    assert.ok(fix.prompt.includes(bad.path), 'AI 修复要知道改哪份 SKILL.md')
    assert.ok(fix.prompt.includes(projectDir), 'AI 修复在项目目录里做')

    await call('DELETE', `/project-skills/file?projectId=${project.id}&repo=${encodeURIComponent(repo)}&name=new-skill`)
    assert.ok(!existsSync(path.join(projectDir, repo, 'new-skill')), '删除连文件夹一起删')
    rmSync(path.join(projectDir, repo, 'proj-skill'), { recursive: true, force: true })
    rmSync(path.join(projectDir, repo, 'bad-skill'), { recursive: true, force: true })
  }
  step('项目技能：列出项目目录下的技能、新建骨架、改、删，AI 修复带上路径和原文')

  // MCP 工具：直接读写各 CLI 自己的配置文件，其他配置原样保留
  {
    const codexToml = path.join(homeDir, '.codex', 'config.toml')
    mkdirSync(path.dirname(codexToml), { recursive: true })
    writeFileSync(codexToml, 'model = "gpt-5"\n\n[mcp_servers.old]\ncommand = "old-cmd"\n')
    writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: {} }))
    // 一个最小的 stdio MCP 服务，用来测试「测试连接」
    const mcpJs = path.join(tmp, 'mini-mcp.mjs')
    writeFileSync(
      mcpJs,
      `import readline from 'node:readline'
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'mini' }, capabilities: {} } }))
  if (m.method === 'tools/list') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'hello', description: '打招呼' }] } }))
})`,
    )
    const server = {
      name: 'mini',
      transport: 'stdio',
      command: process.execPath,
      args: [mcpJs],
      env: { A: '1' },
      url: '',
      headers: {},
    }
    const t0 = await call('POST', '/mcp-tools/test', server)
    assert.equal(t0.ok, true, JSON.stringify(t0))
    assert.deepEqual(t0.tools, [{ name: 'hello', description: '打招呼' }])
    assert.equal((await call('POST', '/mcp-tools/test', { ...server, command: 'no-such-cmd-xyz' })).ok, false)
    let ov = await call('GET', '/mcp-tools')
    assert.deepEqual(
      ov.servers.map((x) => [x.name, x.clis]),
      [['old', ['codex']]],
    )
    ov = await call('PUT', '/mcp-tools/mini', { server, clis: ['claude', 'codex', 'gemini'] })
    assert.deepEqual(ov.servers.find((x) => x.name === 'mini').clis, ['claude', 'codex', 'gemini'])
    const cj = JSON.parse(readFileSync(path.join(homeDir, '.claude.json'), 'utf8'))
    assert.equal(cj.theme, 'dark', 'Claude Code 配置里别的内容保留')
    assert.deepEqual(cj.mcpServers.mini, { type: 'stdio', command: process.execPath, args: [mcpJs], env: { A: '1' } })
    const tomlText = readFileSync(codexToml, 'utf8')
    assert.ok(tomlText.includes('model = "gpt-5"') && tomlText.includes('[mcp_servers.old]'))
    assert.ok(tomlText.includes('[mcp_servers.mini.env]'))
    // 远程地址：Gemini CLI 写 httpUrl，Claude Code 写 type: http
    const remote = {
      name: 'web',
      transport: 'http',
      command: '',
      args: [],
      env: {},
      url: 'https://x.example/mcp',
      headers: { A: 'b' },
    }
    await call('PUT', '/mcp-tools/web', { server: remote, clis: ['claude', 'gemini'] })
    const gs = JSON.parse(readFileSync(path.join(homeDir, '.gemini', 'settings.json'), 'utf8'))
    assert.equal(gs.mcpServers.web.httpUrl, 'https://x.example/mcp')
    assert.equal(JSON.parse(readFileSync(path.join(homeDir, '.claude.json'), 'utf8')).mcpServers.web.type, 'http')
    // 只留 Codex：别的 CLI 里的同名工具被移除
    await call('PUT', '/mcp-tools/mini', { server, clis: ['codex'] })
    assert.equal(JSON.parse(readFileSync(path.join(homeDir, '.claude.json'), 'utf8')).mcpServers.mini, undefined)
    await call('DELETE', '/mcp-tools/mini')
    await call('DELETE', '/mcp-tools/web')
    ov = await call('GET', '/mcp-tools')
    assert.deepEqual(
      ov.servers.map((x) => x.name),
      ['old'],
    )
    assert.ok(readFileSync(codexToml, 'utf8').includes('[mcp_servers.old]'))
    await assert.rejects(call('PUT', '/mcp-tools/bad name', { server: { ...server, name: 'bad name' }, clis: [] }))
  }
  step('MCP 工具：读写 Claude Code / Codex / Gemini CLI 的配置文件，保留其他内容，测试连接能列出工具')

  // 项目设置里的 MCP：识别项目目录里的配置，导入只写各 CLI 的全局配置，项目文件一字不动
  {
    // 前面那个最小的 MCP 服务，用来测「测试连接」
    const miniJs = path.join(tmp, 'mini-mcp.mjs')
    const server = {
      name: 'fs',
      transport: 'stdio',
      command: process.execPath,
      args: [miniJs],
      env: {},
      url: '',
      headers: {},
    }
    const mcpJson = path.join(project.path, '.mcp.json')
    const projectMcp = JSON.stringify(
      {
        mcpServers: {
          fs: { command: 'npx', args: ['-y', 'fs-mcp'] },
          'bad name': { command: 'x' },
        },
      },
      null,
      2,
    )
    writeFileSync(mcpJson, projectMcp)
    mkdirSync(path.join(project.path, '.vscode'), { recursive: true })
    writeFileSync(
      path.join(project.path, '.vscode', 'mcp.json'),
      JSON.stringify({ servers: { browser: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'] } } }),
    )
    mkdirSync(path.join(project.path, '.claude'), { recursive: true })
    writeFileSync(path.join(project.path, '.claude', 'settings.json'), '{ 坏掉的 json')

    let pv = await call('GET', `/project-mcp?projectId=${project.id}`)
    assert.equal(pv.path, project.path)
    assert.deepEqual(pv.detected.map((d) => `${d.file}:${d.name}`).sort(), [
      '.mcp.json:bad name',
      '.mcp.json:fs',
      '.vscode/mcp.json:browser',
    ])
    assert.equal(pv.detected.find((d) => d.name === 'fs').status, 'new')
    assert.equal(pv.detected.find((d) => d.name === 'browser').source, 'VS Code 工作区配置')
    // 名字合不合面板规则要能看出来（导入前要在项目文件里改名）
    assert.equal(pv.detected.find((d) => d.name === 'bad name').nameOk, false)
    // 读不懂的文件只提示，不影响别的文件
    assert.deepEqual(
      pv.errors.map((e) => e.file),
      ['.claude/settings.json'],
    )

    // 项目里的工具也能测试连接（和「MCP 工具」页同一个实现）
    assert.equal((await call('POST', '/project-mcp/test', { ...server, name: 'fs' })).ok, true)

    // 导入一条：写进 Claude Code 的全局配置，项目文件不变；再读时状态变成「一致」
    const imp = await call('POST', `/project-mcp/import?projectId=${project.id}`, {
      items: [{ file: '.mcp.json', name: 'fs', clis: ['claude'] }],
    })
    assert.deepEqual(imp.done, [{ name: 'fs', file: '.mcp.json' }])
    assert.equal(readFileSync(mcpJson, 'utf8'), projectMcp, '项目里的配置文件不能被改')
    assert.deepEqual(JSON.parse(readFileSync(path.join(homeDir, '.claude.json'), 'utf8')).mcpServers.fs, {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'fs-mcp'],
    })
    assert.equal(imp.overview.detected.find((d) => d.name === 'fs').status, 'same')

    // 名字不合规则的导入会说清原因，不写进任何全局配置
    const bad = await call('POST', `/project-mcp/import?projectId=${project.id}`, {
      items: [{ file: '.mcp.json', name: 'bad name', clis: ['claude'] }],
    })
    assert.equal(bad.done.length, 0)
    assert.match(bad.skipped[0].reason, /工具名/)

    // 项目分节写的是同一份配置：停用后「MCP 工具」页也没了
    const fsServer = {
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'fs-mcp'],
      env: {},
      url: '',
      headers: {},
    }
    pv = await call('PUT', `/project-mcp/fs?projectId=${project.id}`, { server: fsServer, clis: [] })
    assert.equal(
      pv.servers.some((x) => x.name === 'fs'),
      false,
    )
    assert.equal(
      (await call('GET', '/mcp-tools')).servers.some((x) => x.name === 'fs'),
      false,
    )

    // 清理，别影响后面的用例
    rmSync(mcpJson, { force: true })
    rmSync(path.join(project.path, '.vscode'), { recursive: true, force: true })
    rmSync(path.join(project.path, '.claude'), { recursive: true, force: true })
    pv = await call('GET', `/project-mcp?projectId=${project.id}`)
    assert.deepEqual(pv.detected, [])
  }
  step('项目设置里的 MCP：识别 .mcp.json / .vscode/mcp.json，导入只写各 CLI 的全局配置，项目文件不改')

  // Windows 托盘程序（AgentPanel.exe）和服务的约定：启动完成输出地址，托盘关掉输入时服务退出
  {
    const trayPort = await freePort()
    const child = spawn(path.join(root, 'node_modules/.bin/tsx'), ['server/index.ts', '--prod'], {
      cwd: root,
      env: {
        ...process.env,
        LANG: 'zh_CN.UTF-8',
        AGENT_PANEL_DATA: dataDir,
        PORT: String(trayPort),
        AGENT_PANEL_TRAY: '1',
        FAKE_CLI_LOG: log,
        // 托盘的「检查更新」：当成发布的包，版本已经是最新的
        AGENT_PANEL_RELEASES_URL: `http://127.0.0.1:${relPort}/releases`,
        AGENT_PANEL_APP_DIR: path.join(tmp, 'tray-app'),
        AGENT_PANEL_VERSION: '0.11.9-dev',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    // 断言失败时也要把它关掉：它自己不会退，留着会占住事件循环，进程退不出去
    onExit(() => {
      if (child.exitCode === null) child.kill()
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    const exited = new Promise((r) => child.on('exit', (code) => r(code)))
    for (let i = 0; i < 100 && !out.includes('AGENT_PANEL_READY'); i++) await sleep(100)
    assert.ok(out.includes(`AGENT_PANEL_READY http://127.0.0.1:${trayPort}/?token=`), '托盘模式输出带令牌的地址')
    const waitOut = async (text) => {
      for (let i = 0; i < 100 && !out.includes(text); i++) await sleep(100)
      assert.ok(out.includes(text), `托盘收到 ${text}`)
    }
    // 点图标：没有打开着的页面时回答 0，托盘去打开新的
    child.stdin.write('focus m1\n')
    await waitOut('AGENT_PANEL_FOCUS m1 0')
    // 有页面开着：页面收到要加到标题上的标记，以及切过来后要打开设置
    const ac = new AbortController()
    const es = await fetch(`http://127.0.0.1:${trayPort}/api/app/events`, { signal: ac.signal })
    const reader = es.body.getReader()
    let sse = ''
    const readSse = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          sse += new TextDecoder().decode(value)
        }
      } catch {}
    })()
    for (let i = 0; i < 50 && !sse.includes('hello'); i++) await sleep(100)
    child.stdin.write('focus m2 settings\n')
    await waitOut('AGENT_PANEL_FOCUS m2 1')
    for (let i = 0; i < 50 && !sse.includes('m2'); i++) await sleep(100)
    assert.match(sse, /event: focus\ndata: \{"type":"focus","mark":"m2","view":"settings"\}/)
    ac.abort()
    await readSse
    // 右键「检查更新」：马上问 GitHub，已经是最新的就告诉托盘
    child.stdin.write('update\n')
    await waitOut('AGENT_PANEL_UPDATE checking')
    await waitOut('AGENT_PANEL_UPDATE latest 已经是最新版本（0.11.9-dev）')
    // 退出时还有 CLI 在跑：要一起停掉，不能留在后台继续改项目
    const n = calls().length
    await fetch(`http://127.0.0.1:${trayPort}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, mode: 'chat', agentId: B.id, prompt: 'SLOW 退出时停掉' }),
    })
    for (let i = 0; i < 50 && calls().length === n; i++) await sleep(100)
    const cliPid = calls().at(-1).pid
    child.stdin.end()
    const code = await Promise.race([exited, sleep(8000).then(() => 'timeout')])
    if (code === 'timeout') child.kill()
    assert.equal(code, 0, '托盘关掉输入后服务退出')
    await sleep(300)
    const alive = (() => {
      try {
        process.kill(cliPid, 0)
        return true
      } catch {
        return false
      }
    })()
    assert.ok(!alive, '服务退出时正在执行的 CLI 也被结束')
  }
  step(
    'Windows 托盘程序：服务启动完成后告诉托盘地址，点图标切到打开着的页面，右键检查更新，托盘退出时服务和正在执行的 CLI 一起退出',
  )

  // 项目分组顺序：默认按添加时间，拖拽后的顺序存进数据文件，重新读出来（刷新、重启）还在
  {
    const names = ['排序A', '排序B', '排序C']
    const created = []
    for (const name of names) {
      // 添加时间只有毫秒精度，逐个创建时中间间隔一下，保证顺序确定
      await sleep(20)
      created.push(
        await call('POST', '/projects', { name, description: '', path: '', categoryId: '', workflowId: wf.id }),
      )
    }
    assert.equal(created[0].childIsolation, 'worktree', '新项目默认子对话用独立 worktree')
    const listOf = async () => (await call('GET', '/projects')).map((p) => p.id)
    const order = (await listOf()).filter((id) => created.some((p) => p.id === id))
    assert.deepEqual(
      order,
      created.map((p) => p.id),
      '默认按添加时间排序，先添加的在前',
    )

    // 重排：拖拽后整个顺序写回，服务端重新编号 1、2、3…
    const all = await listOf()
    const moved = [created[2].id, ...all.filter((id) => id !== created[2].id)]
    const sorted = await call('PUT', '/projects/order', moved)
    assert.deepEqual(
      sorted.map((p) => p.id),
      moved,
      '按请求的顺序返回',
    )
    // 服务端把全部项目从 1 连续编号；这里只看这三个项目的相对顺序和编号是否连续
    const mine = sorted.filter((p) => created.some((c) => c.id === p.id))
    assert.deepEqual(
      mine.map((p) => p.name),
      ['排序C', '排序A', '排序B'],
      '重新编号后相对顺序正确',
    )
    const nums = mine.map((p) => p.sortOrder)
    assert.ok(
      nums.every((n, i) => i === 0 || n > nums[i - 1]),
      `编号按拖拽后的顺序递增：${nums.join(',')}`,
    )
    // 持久化：直接读数据文件，相当于刷新页面或重启服务后再读
    const saved = JSON.parse(readFileSync(path.join(dataDir, 'projects/projects.json'), 'utf8'))
    assert.deepEqual(
      saved
        .filter((p) => created.some((c) => c.id === p.id))
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((p) => p.name),
      ['排序C', '排序A', '排序B'],
      '顺序写进了数据文件',
    )
    assert.deepEqual(await listOf(), moved, '再读一次顺序不变')

    // 校验：重复、不存在、漏掉项目都拒绝，原顺序不变
    const bad = (ids) => assert.rejects(call('PUT', '/projects/order', ids))
    await bad([moved[0], moved[0], ...moved.slice(1)])
    await bad([...moved.slice(0, -1), 'no-such-project'])
    await bad(moved.slice(0, -1))
    assert.deepEqual(await listOf(), moved, '校验失败时不改顺序')

    // 清理，别影响后面的用例
    for (const p of created) await call('DELETE', `/projects/${p.id}`)
  }
  step('项目分组：默认按添加时间排序，拖拽后的顺序持久化，重复 / 不存在 / 漏项的重排请求被拒绝')
})
