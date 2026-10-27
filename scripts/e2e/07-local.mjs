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
import { tsxBin } from './spawn-server.mjs'

/**
 * 列表时间（updatedAt）比较允许的抖动，单位毫秒。
 *
 * updatedAt 是毫秒精度的 ISO 字符串，但两条落盘路径各自 new Date() 取时间，分片并行、负载高时
 * 会出现 1~2ms 的差（本轮实测：正常情况下 0ms，曾在一次全量跑里出现过 1ms——done 侧晚写了 1ms），
 * 这不是产品行为变了。
 * 真出错时（预热退出把列表时间改成现在）updatedAt 会晚至少一个 presence 宽限期——e2e 里
 * AGENT_PANEL_PRESENCE_GRACE_MS=1200（见 harness.mjs）；所以 200ms 两侧余量都够：它比 1~2ms 的
 * 抖动宽一百倍，又比 1200ms 的真实变化窄得多——抖动不会把它插穿，真实变化却跑不掉。
 */
const UPDATED_AT_TOLERANCE_MS = 200

await runShard('本机请求与设置', async (api) => {
  const {
    baseUrl: base,
    root,
    fake,
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
  // 自定义 CLI：配置文件写的 stdin CLI，本分片的配置读写和 ask/MCP 用例都用它
  const customSpec = JSON.parse(readFileSync(path.join(root, 'scripts/e2e/fixtures/custom-cli.json'), 'utf8'))
  mkdirSync(path.join(dataDir, 'config/clis'), { recursive: true })
  writeFileSync(path.join(dataDir, 'config/clis/custom.json'), JSON.stringify({ ...customSpec, command: fake }))
  await call('POST', '/clis/specs/reload', {})
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
  let rs = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: A.id,
    prompt: 'SLOW 停一下再继续',
  })
  // 等 CLI 真的起来再停，而且这一轮必须够长：假 CLI 默认那一轮只要 150ms，光是等它启动再发 stop
  // 仍然可能抢不到（stop 请求到达时它已经跑完，任务已是 done，stop 成了 no-op，断言 stopped 假失败）。
  // 带 SLOW 让这一轮持续十来秒，stop 才必然落在它执行期间（和 03-chat.mjs 的停止用例同一写法）
  await waitFor(() => calls().some((c) => c.input.includes('停一下再继续')), { label: '停止用例的任务开始执行' })
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
    ['commandcode', 'claude', 'codex', 'custom', 'pi'],
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

  // 没有提问通道的 CLI（Command Code、自定义 CLI）：面板临时接一个 ask_user 工具，等用户回答后交回，项目里原有的 MCP 配置用完还原
  {
    const mcpFile = path.join(project.path, '.mcp.json')
    const original = JSON.stringify({ mcpServers: { mine: { command: 'x' } } })
    writeFileSync(mcpFile, original)
    for (const cli of ['commandcode', 'custom', 'pi']) {
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
    assert.ok(!existsSync(path.join(project.path, '.custom', 'settings.json')), '临时写的配置删掉了')
    assert.ok(!existsSync(path.join(project.path, '.pi')), 'Pi 的桥接扩展不写进项目')
    const piExt = calls()
      .filter((x) => x.kind === 'pi')
      .map((x) => x.args[x.args.indexOf('-e') + 1])
      .find((x) => x && /agent-panel-(agent-)?panel/.test(x))
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

  // 保活中切换界面语言：系统提示词和 mod 的环境变量固定在旧进程里，新消息的提醒却是新语言；
  // 不能把下一句交给旧进程，要按新语言重开（和换 CLI / 模型同一条路）
  {
    const beforePids = new Set(readLog(log).map((x) => x.pid))
    const cur = await call('GET', '/settings')
    let w = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: '先看代码',
    })
    await call('POST', `/tasks/${w.id}/seen`, {})
    await call('POST', `/tasks/${w.id}/presence`, { viewerId: 'e2e', active: true })
    w = await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${w.id}`)
        return t.awaitingUser ? t : null
      },
      { timeout: 20000, label: '切换语言前停在等下一句' },
    )
    const first = readLog(log).filter((x) => !beforePids.has(x.pid))
    assert.equal(new Set(first.map((x) => x.pid)).size, 1, '第一轮只有一个进程')
    const n = readLog(log).length
    await call('PUT', '/settings', { ...cur, language: 'en' })
    await call('POST', `/tasks/${w.id}/messages`, { text: '接着说' })
    const next = await waitFor(
      () => {
        const rows = readLog(log).slice(n)
        return rows.length ? rows : null
      },
      { timeout: 20000, label: '语言变了以后按新语言重开进程' },
    )
    assert.ok(!first.some((x) => x.pid === next[0].pid), '语言变了不能把下一句交给旧语言的进程')
    assert.match(next[0].input, /Keep writing both your reply and your reasoning \/ thinking in English/)
    await call('PUT', '/settings', { ...cur })
    await call('POST', `/tasks/${w.id}/presence`, { viewerId: 'e2e', active: false })
    await waitDone(w.id, 15000)
  }
  step('保活中切换界面语言：不再交给旧进程，按新语言重开')

  // ---- 正在执行的对话不受回收限制：两个时长和保活上限只管「回复完停在等下一句」的空闲会话 ----
  {
    // 这一轮停在「等后台命令结果」上（CLI 注册了 waiter，任务 awaitingUser=true）。
    // 旧实现宽限到点会 cancelWait 把这个 waiter 取消、结束这一轮；新实现因为后台命令还在跑而不回收。
    // 不用「SLOW 慢吞吞地输出」那种写法：那时没有 waiter，旧实现什么都取消不了，断言在旧代码上也成立（恒真）
    let held = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'commandcode',
      askUser: false,
      prompt: 'BG_LONG BG_SLOW 等后台命令时切到后台 run_background',
    })
    await call('POST', `/tasks/${held.id}/presence`, { viewerId: 'e2e', active: true })
    held = await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${held.id}`)
        return t.awaitingUser && t.jobs?.length ? t : null
      },
      { timeout: 30000, label: '停在等后台命令结果' },
    )
    const heldPid = calls().findLast((c) => c.input.includes('等后台命令时切到后台')).pid
    await call('POST', `/tasks/${held.id}/presence`, { viewerId: 'e2e', active: false })
    // 等两倍宽限（测试里 1200ms）：只等 1600ms 时机器一忙，计时器可能晚于断言触发，
    // 旧实现下也会通过（用例就失去区分度了）；后台命令 4 秒，来得及
    await sleep(2400)
    held = await call('GET', `/tasks/${held.id}`)
    assert.equal(held.awaitingUser, true, '等后台命令结果的这一轮没被宽限取消（旧实现这里会结束这一轮）')
    assert.equal(calls().find((c) => c.pid === heldPid)?.end, undefined, 'CLI 进程还活着，结果还能交回来')
    await call('POST', `/tasks/${held.id}/stop?force=1`)
    await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${held.id}`)
        return t.status !== 'running' ? t : null
      },
      { timeout: 15000, label: '收掉等后台命令的对话' },
    )
  }
  step('正在等后台命令结果的对话切到后台，过了宽限也不回收')

  // 保活上限只淘汰空闲会话：有后台命令还在跑的不算空闲，不能连它的 CLI 一起收掉
  {
    const keep = (await call('GET', '/settings')).keepAliveLimit
    // 创建过就登记，不管哪条断言失败都要在 finally 里改回设置、收掉这些对话
    const created = []
    const track = (t) => {
      created.push(t)
      return t
    }
    try {
      const bg = track(
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: '',
          cli: 'commandcode',
          askUser: false,
          prompt: 'BG_LONG BG_SLOW 后台命令还在跑 run_background',
        }),
      )
      await call('POST', `/tasks/${bg.id}/presence`, { viewerId: 'e2e', active: true })
      const waiting = (id) =>
        waitFor(
          async () => {
            const t = await call('GET', `/tasks/${id}`)
            return t.awaitingUser ? t : null
          },
          { timeout: 20000, label: '停在等下一句' },
        )
      const bgTask = await waiting(bg.id)
      assert.ok(
        bgTask.jobs?.length,
        `后台命令还在跑：${JSON.stringify({ jobs: bgTask.jobs, status: bgTask.status, awaiting: bgTask.awaitingUser })}\n面板工具调用：${JSON.stringify(readLog(`${log}.panel`).slice(-4))}`,
      )
      const bgPid = calls().findLast((c) => c.input.includes('BG_LONG')).pid

      await call('PUT', '/settings', { ...(await call('GET', '/settings')), keepAliveLimit: 1 })
      const idle = []
      for (const name of ['保活上限里的空闲对话 A', '保活上限里的空闲对话 B']) {
        const t = track(
          await call('POST', '/tasks', {
            projectId: project.id,
            mode: 'chat',
            agentId: '',
            cli: 'commandcode',
            askUser: false,
            prompt: name,
          }),
        )
        await call('POST', `/tasks/${t.id}/presence`, { viewerId: 'e2e', active: true })
        await waiting(t.id)
        idle.push(t)
      }
      // 只切走 A（唯一的空闲候选）。B 的页面保持开着，用它跑一轮来触发上限检查：
      // 这样从「切走」到「触发」只有 B 的一轮（几十毫秒），A 不会先被宽限回收，测到的就是上限淘汰。
      // bg 也切走（否则 isViewing 会豁免它），但它有后台命令在跑，不应该被选中
      const [a, b] = idle
      // 切走前 A 还必须在等下一句：不在保活里的对话不会成为候选
      const aBefore = await call('GET', `/tasks/${a.id}`)
      assert.ok(aBefore.awaitingUser, `A 应该停在等下一句：${aBefore.status}/${aBefore.awaitingUser}`)
      await call('POST', `/tasks/${a.id}/presence`, { viewerId: 'e2e', active: false })
      await call('POST', `/tasks/${bg.id}/presence`, { viewerId: 'e2e', active: false })
      const again = '再回一句，用来触发上限回收'
      await call('POST', `/tasks/${b.id}/messages`, { text: again })
      // 等到 B 这一轮真的跑完（again 之后有新的回复）再算回到保活：只看 awaitingUser + 消息已存在
      // 会在消息刚送到、新一轮还没开始的瞬间就成立，那时还没触发上限检查
      await waitFor(
        async () => {
          const t = await call('GET', `/tasks/${b.id}`)
          const at = t.messages.findIndex((m) => m.text === again)
          const replied = at >= 0 && t.messages.slice(at + 1).some((m) => m.role === 'agent' && m.text.trim())
          return t.awaitingUser && replied
        },
        { timeout: 20000, label: '第二个空闲对话又回到等下一句' },
      )
      // 上限淘汰走 stopTask('idle')。但保活中「已经答完」的会话被收掉时 engine 不写 stopReason
      // （见 shared/engine.ts 的 finish：answered 就当作正常完成），所以从任务上看不出来是哪种路径。
      // 改按运行日志判：只有上限淘汰会记「保活的会话超过上限」这一条，宽限到点只 cancelWait、不记。
      // 日志是多行的，task id 在标题行的下面几行：要连着后几行一起看，不能只看标题那一行
      const recycleLine = await waitFor(
        async () => {
          const { logs } = await call('GET', '/data')
          if (!logs?.current || !existsSync(logs.current)) return null
          const lines = readFileSync(logs.current, 'utf8').split('\n')
          const hits = lines
            .map((l, i) => (l.includes('保活的会话超过上限') ? lines.slice(i, i + 4).join('\n') : ''))
            .filter(Boolean)
          return hits.some((l) => l.includes(a.id)) ? hits : null
        },
        {
          timeout: 15000,
          label: '超过上限时收掉空闲会话',
          describe: async () => {
            const { logs } = await call('GET', '/data')
            const text = logs?.current && existsSync(logs.current) ? readFileSync(logs.current, 'utf8') : ''
            return {
              limit: (await call('GET', '/settings')).keepAliveLimit,
              a: await call('GET', `/tasks/${idle[0].id}`).then((t) => [t.status, t.stopReason, t.awaitingUser]),
              b: await call('GET', `/tasks/${idle[1].id}`).then((t) => [t.status, t.stopReason, t.awaitingUser]),
              bg: await call('GET', `/tasks/${bg.id}`).then((t) => [
                t.status,
                t.stopReason,
                t.awaitingUser,
                t.jobs?.length,
              ]),
              log: logs?.current,
              aLines: text
                .split('\n')
                .filter((l) => l.includes(a.id))
                .slice(-14),
              tail: text.split('\n').slice(-14),
            }
          },
        },
      )
      // 收掉的是空闲对话，而且不看后台命令还在跑的那个（旧实现会把这三个一起选中，连着它一起收掉）
      assert.ok(!recycleLine.some((l) => l.includes(bg.id)), `有后台命令在跑的不算空闲会话：${recycleLine.join(' / ')}`)
      assert.ok(!recycleLine.some((l) => l.includes(b.id)), `页面开着的对话不回收：${recycleLine.join(' / ')}`)
      const bgNow = await call('GET', `/tasks/${bg.id}`)
      assert.equal(bgNow.awaitingUser, true, '后台命令还在跑的那个照旧停在等下一句')
      assert.equal(calls().find((c) => c.pid === bgPid)?.end, undefined, '它的 CLI 进程没被收掉')
    } finally {
      // 中途断言失败也要改回设置：不然这个分片后面的用例都按上限 1 跑
      await call('PUT', '/settings', { ...(await call('GET', '/settings')), keepAliveLimit: keep }).catch(() => {})
      // 保活中的对话（还在等下一句）不强制停止就会挂 15s 超时：直接并行收走，不等它们的宽限
      await Promise.all(
        created.map(async (t) => {
          await call('POST', `/tasks/${t.id}/stop?force=1`).catch(() => {})
          await waitFor(
            async () => {
              const x = await call('GET', `/tasks/${t.id}`)
              return x.status !== 'running' ? x : null
            },
            { timeout: 15000, label: '收起测试用的对话' },
          ).catch(() => {})
        }),
      )
    }
  }
  step('保活上限只淘汰空闲会话：有后台命令还在跑的对话不被收掉')

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
    w = await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${w.id}`)
        return t.status !== 'running' ? t : null
      },
      {
        timeout: 15000,
        label: '预热中的对话切走后回收',
        describe: async () => {
          const t = await call('GET', `/tasks/${w.id}`)
          return {
            status: t.status,
            awaitingUser: t.awaitingUser,
            prewarming: t.prewarming,
            working: t.working,
            turnSeen: t.turnDoneAt === t.turnSeenAt,
          }
        },
      },
    )
    assert.equal(w.status, 'done')
    assert.equal(w.prewarming, false)
    assert.equal(w.working, false)
    assert.equal(w.turnDoneAt, askedDoneAt, '切走让预热退出不算完成一轮')
    const updatedAtDrift = Math.abs(Date.parse(w.updatedAt) - Date.parse(askedUpdatedAt))
    // 值为空或非法时差值是 NaN，不会小于等于容差，断言会失败；消息里标成 <非法> 好一眼看出是值缺失而不是漂移
    const driftText = Number.isNaN(updatedAtDrift) ? '<非法>' : `${updatedAtDrift}ms`
    assert.ok(
      updatedAtDrift <= UPDATED_AT_TOLERANCE_MS,
      `预热退出不改列表时间（差了 ${driftText}，容差 ${UPDATED_AT_TOLERANCE_MS}ms：${askedUpdatedAt} → ${w.updatedAt}）`,
    )
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
    // 附件的读写：先写一个子目录里的文件，再读回来，最后在树里看到它
    const entry = { cli: 'claude', kind: 'skill', name: 'lib-demo', path: 'references/api.md' }
    await call('PUT', '/library/entry', { ...entry, content: '# API\n' })
    const got = await call('GET', `/library/entry?${new URLSearchParams(entry)}`)
    assert.equal(got.content, '# API\n')
    assert.equal(got.exists, true)
    const withTree = await call('GET', '/library/file?cli=claude&kind=skill&name=lib-demo')
    assert.deepEqual(
      withTree.tree.entries.map((e) => `${e.type}:${e.path}`),
      ['dir:references', 'file:notes.md', 'file:references/api.md'],
    )
    assert.deepEqual(withTree.files, ['notes.md', 'references/api.md'], 'files 等于树里的文件路径')
    // 路径穿越被拒
    await assert.rejects(
      call('GET', `/library/entry?cli=claude&kind=skill&name=lib-demo&path=${encodeURIComponent('../evil')}`),
      /相对路径/,
    )
    // 改名后旧路径没了、新路径读得到；删掉后从树里消失
    await call('POST', '/library/entry/rename', { ...entry, from: 'references/api.md', to: 'references/doc.md' })
    assert.equal((await call('GET', `/library/entry?${new URLSearchParams(entry)}`)).exists, false)
    await call('DELETE', `/library/entry?${new URLSearchParams({ ...entry, path: 'references/doc.md' })}`)
    const cleaned = await call('GET', '/library/file?cli=claude&kind=skill&name=lib-demo')
    assert.deepEqual(cleaned.files, ['notes.md'])
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
    // 命令：Claude Code 是 md，自定义 CLI 是 toml
    await put({
      cli: 'claude',
      kind: 'command',
      name: 'lib-cmd',
      create: true,
      content: '---\ndescription: 测试命令\n---\n做点事 $ARGUMENTS\n',
    })
    await call('POST', '/library/copy', { cli: 'claude', kind: 'command', name: 'lib-cmd', to: ['custom'] })
    const toml = readFileSync(path.join(homeDir, '.custom', 'commands', 'lib-cmd.toml'), 'utf8')
    assert.match(toml, /description = "测试命令"/)
    assert.ok(toml.includes('{{args}}'))
    assert.ok((await lib('command')).items.some((i) => i.cli === 'custom' && i.name === 'lib-cmd'))
    await call('DELETE', '/library/file?cli=custom&kind=command&name=lib-cmd')
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
    ov = await call('PUT', '/mcp-tools/mini', { server, clis: ['claude', 'codex', 'custom'] })
    assert.deepEqual(ov.servers.find((x) => x.name === 'mini').clis, ['claude', 'codex', 'custom'])
    const cj = JSON.parse(readFileSync(path.join(homeDir, '.claude.json'), 'utf8'))
    assert.equal(cj.theme, 'dark', 'Claude Code 配置里别的内容保留')
    assert.deepEqual(cj.mcpServers.mini, { type: 'stdio', command: process.execPath, args: [mcpJs], env: { A: '1' } })
    const tomlText = readFileSync(codexToml, 'utf8')
    assert.ok(tomlText.includes('model = "gpt-5"') && tomlText.includes('[mcp_servers.old]'))
    assert.ok(tomlText.includes('[mcp_servers.mini.env]'))
    // 远程地址：自定义 CLI 按配置写 url，Claude Code 写 type: http
    const remote = {
      name: 'web',
      transport: 'http',
      command: '',
      args: [],
      env: {},
      url: 'https://x.example/mcp',
      headers: { A: 'b' },
    }
    await call('PUT', '/mcp-tools/web', { server: remote, clis: ['claude', 'custom'] })
    const gs = JSON.parse(readFileSync(path.join(homeDir, '.custom', 'settings.json'), 'utf8'))
    assert.equal(gs.mcpServers.web.url, 'https://x.example/mcp')
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
  step('MCP 工具：读写 Claude Code / Codex / 自定义 CLI 的配置文件，保留其他内容，测试连接能列出工具')

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
    const child = spawn(tsxBin(root), ['server/index.ts', '--prod'], {
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
    // 等服务启动：分片并行时这台机器上同时有好几个 tsx 在首次编译，--prod 再起一个服务可能超过 10 秒，
    // 30 秒和 harness 等服务启动的上限一致，避免把「还在编译」误判成没启动
    for (let i = 0; i < 300 && !out.includes('AGENT_PANEL_READY'); i++) await sleep(100)
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
