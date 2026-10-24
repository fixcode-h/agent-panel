/**
 * 用真实 Pi + 按剧本回答的模拟模型（mock-model.mjs）跑一遍子对话的交接摘要流程（ADR 0007）：
 * 父对话新建子对话 → 子对话开独立分支、改文件、submit_merge（先缺 handoff 被拒，再按模板写）
 * → 父对话 finish_child 合回 → 子对话完成并留下交接摘要 → 再叫醒时开新会话只带摘要。
 *
 * 不进 CI（要装 Pi）：npm i -g @earendil-works/pi-coding-agent 后 `node scripts/real-cli/pi-handoff.mjs`。
 * 云端容器里先去掉 ANTHROPIC_BASE_URL 这类环境变量，免得 Pi 绕过模拟模型。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { runShard } from '../e2e/harness.mjs'
import { startMockModel } from './mock-model.mjs'

const pi = process.env.PI_BIN || 'pi'
try {
  execFileSync(pi, ['--version'], { stdio: 'pipe' })
} catch {
  console.error(`找不到 Pi（${pi}）：先 npm i -g @earendil-works/pi-coding-agent，或用 PI_BIN 指定路径`)
  process.exit(1)
}

await runShard('真实 Pi：子对话交接摘要', async (api) => {
  const { call, waitFor, waitTask, step, onExit, gitIn, projectDir, tmp, homeDir } = api
  const modelLog = path.join(tmp, 'model.jsonl')
  const mock = await startMockModel({ log: modelLog })
  onExit(mock.close)
  const requests = () =>
    existsSync(modelLog)
      ? readFileSync(modelLog, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : []

  await call('PUT', '/settings', {
    stepTimeoutMinutes: 5,
    defaultCli: 'pi',
    apis: [
      {
        id: 'mock',
        name: 'Mock',
        provider: 'mock',
        protocol: 'anthropic',
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: 'sk-mock',
        models: ['mock-sonnet'],
      },
    ],
    clis: {
      pi: {
        enabled: true,
        command: pi,
        defaultModel: 'mock-sonnet',
        authMode: 'api',
        apiId: 'mock',
        options: { offline: true, codemode: false },
      },
    },
  })
  const agent = await call('POST', '/agents', {
    name: '派',
    cli: 'pi',
    description: '',
    model: '',
    icon: 'bot',
    categoryId: '',
    instructions: '',
    extraArgs: [],
    enabled: true,
  })
  const wf = await call('POST', '/workflows', {
    name: '单步',
    description: '',
    mainAgentId: agent.id,
    members: [],
    flows: [
      {
        id: 'main',
        name: '主流程',
        nodes: [{ id: 'n1', title: '做', agentId: '', instructions: '做。', x: 0, y: 0 }],
        edges: [
          { id: 'e1', from: 'start', to: 'n1' },
          { id: 'e2', from: 'n1', to: 'end' },
        ],
      },
    ],
    entryFlowId: 'main',
    document: '',
  })
  const project = await call('POST', '/projects', {
    name: '真实 Pi',
    description: '',
    path: projectDir,
    categoryId: '',
    workflowId: wf.id,
    childIsolation: 'worktree',
  })
  // 项目目录里有一处未提交改动（harness 留的）：先提交，合并时不受它影响
  gitIn(projectDir, 'add', '.')
  gitIn(projectDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
  step(`环境：Pi ${execFileSync(pi, ['--version']).toString().trim()}，模拟模型 :${mock.port}，HOME=${homeDir}`)

  // 父对话先跑一轮（起好 CLI 会话），再在它下面开子对话
  const parent = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: agent.id,
    prompt: '父对话',
  })
  await waitTask(parent.id, (t) => t.status === 'done', 60000)
  const kid = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: agent.id,
    parentTaskId: parent.id,
    title: '写交接验证文件',
    prompt: 'CHILD_WORK 在项目根目录新建 handoff-demo.txt，写一行 hello，然后请父对话收尾。',
  })
  // 用户开着子对话页看：回复完 CLI 进程保活，合回完成时也要结束它
  await call('POST', `/tasks/${kid.id}/presence`, { viewerId: 'real-pi', active: true })
  step('父对话（真实 Pi）跑完一轮，下面开子对话')

  // 子对话：开分支、改文件、submit_merge → 父对话 finish_child → 子对话完成
  const closed = await waitTask(kid.id, (x) => x.resolved && x.worktree?.state === 'merged', 120000).catch(
    async (e) => {
      const k = await call('GET', `/tasks/${kid.id}`)
      console.error(
        JSON.stringify(
          {
            kid: {
              status: k.status,
              resolved: k.resolved,
              worktree: k.worktree,
              messages: k.messages.map((m) => [m.role, m.panel, m.text?.slice(0, 300)]),
            },
            requests: requests().map((r) => ({
              user: r.user.slice(0, 200),
              calls: r.calls,
              tools: r.tools.length,
              reply: r.reply,
            })),
          },
          null,
          2,
        ),
      )
      throw e
    },
  )
  const kidReqs = requests().filter((r) => r.tools.some((t) => t.endsWith('submit_merge')))
  // 每次请求都带着这一轮之前的全部调用：取调用最多的那次
  const submits = kidReqs
    .reduce((a, r) => (r.calls.length > a.length ? r.calls : a), [])
    .filter((c) => c.name.endsWith('submit_merge'))
  assert.ok(submits[0]?.error && /handoff/.test(submits[0].result), '完全没带 handoff：工具参数校验拦下')
  assert.ok(submits[1]?.error, 'files 是空白：面板拒绝')
  assert.match(submits[1].result, /handoff 里还缺「关键文件和模块」/)
  assert.match(submits[1].result, /- files（关键文件和模块）/, '拒绝时给了模板')
  assert.ok(submits[2] && !submits[2].error, `按模板写好后请求成功：${submits[2]?.result}`)
  step(`子对话（真实 Pi）submit_merge：没带 handoff 被参数校验拦下，files 空白被面板拒并给模板，写好后成功`)

  const parentNow = await call('GET', `/tasks/${parent.id}`)
  assert.ok(
    parentNow.messages.some((m) => m.panel === 'wrapup' && m.child?.id === kid.id),
    '父对话里有收尾请求',
  )
  // 合并在 finish_child 调用里就做完了，带着结果的下一次模型请求稍后才到
  await waitFor(() => requests().some((r) => r.calls.some((c) => c.name.endsWith('finish_child') && !c.error)), {
    timeout: 30000,
    label: '父对话调用了 finish_child',
  })
  assert.equal(closed.status, 'done', '子对话完成')
  assert.ok(!existsSync(closed.worktree.path), '独立分支目录回收了')
  assert.equal(readFileSync(path.join(projectDir, 'handoff-demo.txt'), 'utf8'), 'hello\n', '改动合回了父对话的分支')
  assert.ok(!closed.wrapRequest, `完成后不再挂着收尾请求（${JSON.stringify(closed.wrapRequest)}）`)
  assert.match(closed.handoff?.text ?? '', /## 关键文件和模块\nhandoff-demo\.txt — 交接验证用的标记文件/)
  assert.match(closed.handoff.text, /## 相关文档\ndocs\/adr\/0007/)
  assert.match(closed.handoff.text, /## 合回的改动（分支 [^）]+）[\s\S]*handoff-demo\.txt/, '面板补上了改动文件')
  const ctx = closed.usage.agents[closed.agentId]?.context ?? 0
  assert.ok(ctx >= 30000, `完成时记下的上下文够大（${ctx}）`)
  const list = (await call('GET', `/tasks/${parent.id}/children`)).find((k) => k.id === kid.id)
  step(
    `子对话写交接要点 → 父对话 finish_child 合回 → 子对话完成（上下文 ${ctx}，子对话栏状态：${list?.state ?? list?.status}）`,
  )

  // 已完成、上下文大的子对话再被叫醒：开新会话只带交接摘要，接着改文件、再请父对话收尾一次
  const before = requests().length
  const sessionsBefore = { ...closed.sessions }
  const headBefore = gitIn(projectDir, 'rev-parse', 'HEAD').toString().trim()
  await call('POST', `/tasks/${kid.id}/messages`, { text: 'WAKE_AGAIN CHILD_WORK FILE=second.txt 再补一个文件' })
  const again = await waitTask(
    kid.id,
    (x) => x.resolved && gitIn(projectDir, 'rev-parse', 'HEAD').toString().trim() !== headBefore,
    120000,
  ).catch(async (e) => {
    const k = await call('GET', `/tasks/${kid.id}`)
    console.error(
      JSON.stringify(
        {
          resolved: k.resolved,
          wrap: k.wrapRequest,
          wt: k.worktree?.state,
          msgs: k.messages.slice(-4).map((m) => [m.role, m.panel, m.text?.slice(0, 300)]),
          calls: requests().slice(before).at(-1)?.calls,
        },
        null,
        1,
      ),
    )
    throw e
  })
  const wakeReqs = requests()
    .slice(before)
    .filter((r) => r.user.includes('WAKE_AGAIN'))
  const wake = wakeReqs[0]
  assert.ok(wake, '叫醒后模型收到了这一轮')
  assert.equal(wake.messages, 1, `新会话：请求里只有这一条消息（实际 ${wake.messages} 条）`)
  assert.match(wake.user, /## 之前对话的摘要[\s\S]*## 关键文件和模块\nhandoff-demo\.txt/, '带上交接摘要')
  assert.ok(!wake.user.includes('[tool_result'), '没有带上次的工具输出')
  assert.notDeepEqual(again.sessions, sessionsBefore, '换成了新会话')
  const resubmit = wakeReqs
    .at(-1)
    .calls.filter((c) => c.name.endsWith('submit_merge'))
    .at(-1)
  assert.ok(resubmit && !resubmit.error, `叫醒后再请求收尾成功：${resubmit?.result}`)
  assert.equal(readFileSync(path.join(projectDir, 'second.txt'), 'utf8'), 'hello\n', '第二次的改动也合回了')
  assert.match(again.handoff?.text ?? '', /## 关键文件和模块\nsecond\.txt/, '交接摘要换成这次的')
  assert.ok(!again.wrapRequest, `完成后不再挂着收尾请求（${JSON.stringify(again.wrapRequest)}）`)
  step(
    `叫醒已完成的子对话：开新会话只带交接摘要（会话 ${Object.values(sessionsBefore)} → ${Object.values(again.sessions)}），改完再请父对话收尾、合回、完成`,
  )

  // 上下文小（< 3 万）的子对话：完成后再叫醒，照旧接回原会话
  const small = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: agent.id,
    parentTaskId: parent.id,
    prompt: 'CHILD_WORK SMALL_CTX FILE=small.txt 新建 small.txt，写一行 hello，然后请父对话收尾。',
  })
  const smallDone = await waitTask(small.id, (x) => x.resolved && x.worktree?.state === 'merged', 120000)
  const smallCtx = smallDone.usage.agents[smallDone.agentId]?.context ?? 0
  assert.ok(smallCtx > 0 && smallCtx < 30000, `上下文小（${smallCtx}）`)
  assert.ok(smallDone.handoff?.text, '小的也留了交接摘要')
  const before2 = requests().length
  await call('POST', `/tasks/${small.id}/messages`, { text: 'WAKE_AGAIN SMALL_CTX 再补一个小改动' })
  const smallWoke = await waitTask(
    small.id,
    (x) => x.messages.filter((m) => m.role === 'agent' && m.text.includes('收到，接着做')).length > 0,
    60000,
  )
  const wake2 = requests()
    .slice(before2)
    .find((r) => r.user.includes('WAKE_AGAIN'))
  assert.ok(wake2, '叫醒后模型收到了这一轮')
  assert.ok(wake2.messages > 1, `接回原会话：请求里带着上次的 ${wake2.messages} 条消息`)
  assert.ok(!wake2.user.includes('## 之前对话的摘要'), '没有换成摘要')
  assert.deepEqual(smallWoke.sessions, smallDone.sessions, '会话 id 没变')
  step(`上下文小的子对话再被叫醒：接回原会话（带上次 ${wake2.messages} 条消息）`)

  // 用户遇到的卡住：父对话列计划派子对话（没写 step）后把计划全标完成；子对话改完派「版本控制」去收尾，
  // 不调用 submit_merge。父对话的计划要一直等到子对话合回，子对话派不出「版本控制」，被提醒后自己 submit_merge
  const lead = await call('POST', '/agents', {
    name: '统筹',
    cli: 'pi',
    description: '',
    model: '',
    icon: 'bot',
    categoryId: '',
    instructions: '',
    extraArgs: [],
    enabled: true,
    canDelegate: true,
    canPlan: true,
  })
  await call('POST', '/agents', {
    name: '版本控制',
    cli: 'pi',
    description: '本地提交和合并',
    model: '',
    icon: 'bot',
    categoryId: '',
    instructions: '',
    extraArgs: [],
    enabled: true,
    origin: 'builtin:vcs',
  })
  const boss = await call('POST', '/tasks', {
    projectId: project.id,
    mode: 'chat',
    agentId: lead.id,
    prompt: 'PLAN_PARENT 修一下背包背景图',
  })
  const stall = await waitFor(
    async () => (await call('GET', `/tasks/${boss.id}/children`)).find((k) => k.title.includes('修图子对话')),
    {
      timeout: 60000,
      label: '父对话新建子对话',
      describe: async () =>
        requests()
          .slice(-2)
          .map((r) => ({ user: r.user.slice(0, 80), tools: r.tools, reply: r.reply })),
    },
  )
  const bossTurn = await waitTask(
    boss.id,
    (x) => x.messages.some((m) => m.role === 'agent' && m.text.startsWith('计划：')),
    60000,
  )
  const planMsg = bossTurn.messages.find((m) => m.role === 'agent' && m.text.startsWith('计划：')).text
  assert.match(planMsg, /还在等结果，不能自己标完成：「派子对话修图」/, '父对话把计划全标完成被拦下')
  const bossPlan = bossTurn.plans.at(-1)
  assert.ok(!bossPlan.doneAt, '父对话的计划没有结束')
  assert.equal(bossPlan.steps[0].status, 'waiting', '派子对话那一步还在等')
  step('父对话（真实 Pi）派子对话时没写 step：挂在正在做的那一步，自己标完成被拦下，计划不显示「已完成」')

  const stallReqs = () =>
    requests().filter((r) => r.user.includes('CHILD_STALL') && r.calls.some((c) => c.name.endsWith('spawn_agents')))
  await waitFor(() => stallReqs().length, { timeout: 60000, label: '子对话派「版本控制」' })
  const spawn = stallReqs()[0].calls.find((c) => c.name.endsWith('spawn_agents'))
  assert.ok(spawn.error, `派「版本控制」被拒：${spawn.result}`)
  assert.match(spawn.result, /不用派「版本控制」[\s\S]*submit_merge/)
  // 它接着自己提交、去原目录 git merge，这一轮没请收尾就结束：面板提醒一次（分支已经合进去了也要提醒），
  // 子对话照做 submit_merge，父对话 finish_child，计划跟着收
  const stallDone = await waitTask(stall.id, (x) => x.resolved && x.worktree?.state === 'merged', 120000).catch(
    async (e) => {
      const k = await call('GET', `/tasks/${stall.id}`)
      console.error(
        JSON.stringify(
          {
            wrap: k.wrapRequest,
            wt: k.worktree,
            msgs: k.messages.map((m) => [m.role, m.panel, m.text?.slice(0, 200)]),
          },
          null,
          1,
        ),
      )
      throw e
    },
  )
  assert.equal(readFileSync(path.join(projectDir, 'stall.txt'), 'utf8'), 'hello\n')
  assert.ok(
    stallDone.messages.some((m) => m.panel === 'build' && m.text.includes('你的分支已经在父对话的分支里了')),
    '自己合并过去后，面板提醒它 submit_merge',
  )
  const bossEnd = await waitTask(boss.id, (x) => !!x.plans.at(-1)?.doneAt, 60000)
  assert.equal(bossEnd.plans.at(-1).steps[0].status, 'done', '子对话合回后，派它的那一步才标完成')
  assert.ok(!stallDone.wrapRequest, '完成后不挂收尾请求')
  step(
    '子对话（真实 Pi）派「版本控制」收尾被拒，自己 git merge 后不请收尾：面板提醒它 submit_merge；父对话合回后计划才完成',
  )

  if (process.env.PI_HANDOFF_DUMP)
    writeFileSync(
      process.env.PI_HANDOFF_DUMP,
      JSON.stringify(
        {
          kid: await call('GET', `/tasks/${kid.id}`),
          parent: await call('GET', `/tasks/${parent.id}`),
          requests: requests(),
        },
        null,
        2,
      ),
    )
})
