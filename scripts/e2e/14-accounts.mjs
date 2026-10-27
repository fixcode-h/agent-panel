/**
 * 端到端测试分片：账号和 API —— 登录、保存、切换、登出；API 模式把地址和密钥写进各个 CLI 自己的配置。
 *
 * 原来在 07-local 里，和本机请求、访问令牌、保活、Skills/MCP 那些步骤没有依赖：一块十几秒的独立主题，
 * 拆出来单独一片，最慢的那一片（本机请求与设置）不用再等它，端到端按分片并行见 scripts/e2e.mjs。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { runShard } from './harness.mjs'

await runShard('账号和 API', async (api) => {
  const { call, sleep, waitFor, waitDone, waitTask, calls, step, onExit, setupBase, homeDir } = api
  const { project } = await setupBase()
  // ---- 账号和 API：登录、保存、切换、登出；用 API 时把地址和密钥交给 CLI，模型只列这个 API 的 ----
  {
    const base0 = await call('GET', '/settings')
    const withAuth = (extra = {}) => ({
      ...base0,
      ...extra,
      clis: Object.fromEntries(
        ['claude', 'codex', 'commandcode', 'pi'].map((id) => [
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
    // Command Code：凭据里认不出邮箱，用起的名字；同一份凭据不重复保存
    await call('POST', '/accounts/commandcode/login')
    assert.equal((await waitLogin('commandcode')).status, 'done')
    c = await call('POST', '/accounts/commandcode/save', { name: '备用' })
    assert.deepEqual(
      c.accounts.map((a) => a.name),
      ['Command Code 账号 1'],
      '已经保存过的凭据不重复保存',
    )
    // 已经登录着再点登录：CLI 只说一句 Already logged in 就退出（退出码 0），凭据文件一个字节都不改，
    // 不能因此报「登录没有完成」；它带 SGR 转义打印的输出在界面上也不能剩 [32m 这类残码
    await call(
      'PUT',
      '/settings',
      withAuth({
        clis: {
          commandcode: {
            env: [
              { key: 'FAKE_AUTH', value: 'commandcode' },
              { key: 'FAKE_AUTH_ALREADY', value: '1' },
            ],
          },
        },
      }),
    )
    const ccAuth = path.join(homeDir, '.commandcode', 'auth.json')
    const ccBefore = readFileSync(ccAuth, 'utf8')
    await call('POST', '/accounts/commandcode/login')
    j = await waitLogin('commandcode')
    assert.equal(j.status, 'done', `已登录时再登录要算成功：${JSON.stringify(j)}`)
    assert.equal(j.error, undefined)
    assert.equal(readFileSync(ccAuth, 'utf8'), ccBefore, '这条路径 CLI 不改凭据文件')
    assert.match(j.output, /Already logged in/)
    assert.doesNotMatch(j.output, /\u001b|\[32m|\[1m|\[22m|\[39m/, '登录输出里没有 ANSI 残码')
    assert.equal((await list('commandcode')).live.loggedIn, true, '仍是原来那个账号')

    // 真的没登进去（用户关掉了浏览器里的授权页）：CLI 退出码 0 但什么都没写，仍要报失败，
    // 而且文案说的是「没有找到登录凭据」，不是「没有完成登录（退出码 0）」
    await call(
      'PUT',
      '/settings',
      withAuth({
        clis: {
          commandcode: {
            env: [
              { key: 'FAKE_AUTH', value: 'commandcode' },
              { key: 'FAKE_AUTH_NO_CREDENTIALS', value: '1' },
            ],
          },
        },
      }),
    )
    await call('POST', '/accounts/commandcode/logout')
    await call('POST', '/accounts/commandcode/login')
    j = await waitLogin('commandcode')
    assert.equal(j.status, 'failed', `退出码 0 但没凭据仍算失败：${JSON.stringify(j)}`)
    assert.match(j.error, /没有找到登录凭据/, '文案要说清是没有凭据')
    assert.match(j.error, /Login cancelled/, '尾部输出也带上，方便用户看到 CLI 说了什么')

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
    const accountModels = await call('GET', '/clis/commandcode/models?refresh=1')
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
    // API 的并发上限：设成 1 时第二个对话排队（显示在等哪个 API），第一个结束才开始；排队时能停止
    await call(
      'PUT',
      '/settings',
      withAuth({
        apis: apis.map((a) => ({ ...a, maxConcurrent: 1 })),
        clis: { codex: { authMode: 'api', apiId: 'ap1' }, claude: { authMode: 'api', apiId: 'ap2' } },
      }),
    )
    const slowChat = (prompt) =>
      call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: '',
        cli: 'codex',
        model: 'relay-1',
        prompt,
      })
    const qa = await slowChat('SLOW 并发上限 A')
    await waitFor(async () => calls().some((x) => x.kind === 'codex' && x.input?.includes('并发上限 A')), {
      label: '第一个对话的 CLI 启动',
    })
    const qb = await slowChat('并发上限 B')
    const qc = await slowChat('并发上限 C')
    const queued = await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${qc.id}`)
        return t.apiWait ? t : null
      },
      { label: '第三个对话排队等 API' },
    )
    assert.equal(queued.status, 'running', '排队中的对话仍算在运行（输入框是停止按钮）')
    // reason：这一轮还没开始、真的在排队等名额（'start'）；让出后拿回排上的队是 'yield'，界面不显示成排队
    assert.deepEqual(queued.apiWait, { api: '中转 A', ahead: 1, reason: 'start' })
    assert.ok(!calls().some((x) => x.input?.includes('并发上限 B')), '名额满了：第二个对话的 CLI 还没启动')
    await call('POST', `/tasks/${qc.id}/stop`)
    const qcDone = await waitDone(qc.id)
    assert.equal(qcDone.apiWait, undefined, '停止后不再显示排队')
    assert.equal((await call('GET', `/tasks/${qb.id}`)).apiWait?.ahead, 0, '前面的停了，后面的往前挪')
    await waitDone(qa.id)
    await waitDone(qb.id)
    const qaEnd = calls().find((x) => x.input?.includes('并发上限 A'))?.end
    const qbStart = calls().find((x) => x.input?.includes('并发上限 B'))
    assert.ok(qbStart && qaEnd && qbStart.start >= qaEnd, '第二个对话等第一个结束才开始')
    assert.ok(!calls().some((x) => x.input?.includes('并发上限 C')), '排队时停止的对话不再启动')
    // 对话派两个子任务、名额是 1：对话等子任务时让出名额，子任务一个一个跑，跑完交回对话接着做，不会互相等死
    // 子任务用默认 CLI（Claude Code，走「Claude 中转」）：对话也用它，父子抢同一个 API 的名额
    const sp = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: '',
      cli: 'claude',
      model: 'claude-x',
      prompt: 'SPAWN_TWO_SUBS 派两个子任务',
    })
    const spDone = await waitTask(
      sp.id,
      (t) => t.steps.filter((s) => s.slot === 'sub' && s.status === 'done').length === 2,
      60000,
    )
    assert.equal(spDone.status, 'done')
    const subRuns = calls().filter((x) => x.input?.includes('SLOW 限流子任务'))
    assert.equal(subRuns.length, 2)
    const [s1, s2] = subRuns.sort((a, b) => a.start - b.start)
    assert.ok(s1.end && s2.start >= s1.end, '名额是 1：第二个子任务等第一个结束才开始')
    await call(
      'PUT',
      '/settings',
      withAuth({ apis, clis: { codex: { authMode: 'api', apiId: 'ap1' }, claude: { authMode: 'api', apiId: 'ap2' } } }),
    )
    // 协议对不上的 API 不会交给 CLI（Codex 选了 Anthropic 的 API）
    await call('PUT', '/settings', withAuth({ apis, clis: { codex: { authMode: 'api', apiId: 'ap2' } } }))
    assert.notEqual((await call('GET', '/clis/codex/models?refresh=1')).auth, 'api')
    assert.ok(
      !readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8').includes('model_providers.relay-a'),
      '协议对不上时清掉上一次写进去的 provider',
    )
    // 改用 API 需要改配置文件的 CLI：Command Code 写进自定义接口
    await call(
      'PUT',
      '/settings',
      withAuth({
        apis: [
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
          commandcode: { authMode: 'api', apiId: 'c1' },
          pi: { authMode: 'api', apiId: 'c1' },
        },
      }),
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
        clis: { commandcode: { authMode: 'account' }, pi: { authMode: 'account' } },
      }),
    )
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
      '账号和 API：登录、保存、切换、登出（Claude Code 的 .claude.json 只动账号信息；已登录再登录仍算成功且输出无 ANSI 残码，退 0 但没凭据报「没有找到登录凭据」）；API 模式把地址和密钥写进 CLI 自己的配置、执行只传模型、协议对不上不用',
    )
  }
})
