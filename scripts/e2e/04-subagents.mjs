/**
 * 端到端测试分片：子对话生命周期、共用目录与独立 worktree、收尾合并、提问卡片、评审门禁、点「解决」收口计划
 *
 * 执行计划、后台命令、规则与教训、子对话监管和续接在 09-subagent-runtime（从这一片拆出去，压低 e2e 墙钟）。
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs），
 * 互不影响。总入口 scripts/e2e.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'

import path from 'node:path'
import { cliOutputFile } from '../fake-cli/outputs.mjs'
import { runShard } from './harness.mjs'

await runShard('子对话与计划', async (api) => {
  const {
    baseUrl: base,
    log,
    gitIn,
    call,
    sleep,
    waitFor,
    waitDone,
    waitTask,
    calls,
    readLog,
    step,
    setupBase,
    mergeTask,
    clearCliOutputs,
  } = api
  const { project, A, B, C } = await setupBase()
  // ---- 子对话的 CLI 生命周期：列表如实给 cliAlive；打开父对话不启动任何子对话；发消息才启动 ----
  {
    let parent = await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: '父对话' })
    parent = await waitDone(parent.id, 20000)
    assert.equal(parent.status, 'done')
    // 子对话直接用接口建（对话 Agent 建子对话需要走工作流，这里只测进程生命周期）
    const mkChild = (title, prompt) =>
      call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, parentTaskId: parent.id, prompt })
    let kid = await mkChild('子对话一', '第一件事')
    kid = await waitDone(kid.id, 20000)
    assert.equal(kid.status, 'done')

    // 状态先标成完成、进程随后才退出：等一小会儿再看，免得偶尔撞上进程还没退干净
    let kids = await call('GET', `/tasks/${parent.id}/children`)
    for (let i = 0; i < 20 && kids.find((x) => x.id === kid.id)?.cliAlive; i++) {
      await sleep(100)
      kids = await call('GET', `/tasks/${parent.id}/children`)
    }
    const one = kids.find((x) => x.id === kid.id)
    assert.ok(one, '子对话出现在父对话的列表里')
    assert.equal(one.cliAlive, false, '跑完、进程已经结束：cliAlive 为 false')
    assert.ok(one.startedAt, '列表带上本次开启的时间，用来排序')
    assert.ok(!('queue' in kid), '不再有排队字段')

    // 只打开父对话页、只读查子对话：不会把子对话的 CLI 启动起来
    await call('POST', `/tasks/${parent.id}/presence`, { viewerId: 'e2e', active: true })
    await call('GET', `/tasks/${parent.id}/children`)
    kids = await call('GET', `/tasks/${parent.id}/children`)
    assert.equal(kids.find((x) => x.id === kid.id).cliAlive, false, '打开父对话不会启动子对话的 CLI')
    assert.ok(!(await call('GET', `/tasks/${kid.id}`)).prewarming, '也不会预热')

    // 打开子对话页，不发消息：仍然没有启动
    await call('POST', `/tasks/${kid.id}/presence`, { viewerId: 'e2e-child', active: true })
    kids = await call('GET', `/tasks/${parent.id}/children`)
    assert.equal(kids.find((x) => x.id === kid.id).cliAlive, false, '只打开子对话也不启动 CLI')

    // 真正发消息才启动
    const resumed = await call('POST', `/tasks/${kid.id}/messages`, { text: '接着做第二件事' })
    assert.equal(resumed.status, 'running', '发消息才启动这一轮')
    // cliAlive 按真实进程算：发消息后进程要先起来，等一小会儿再看
    kids = await call('GET', `/tasks/${parent.id}/children`)
    for (let i = 0; i < 30 && !kids.find((x) => x.id === kid.id)?.cliAlive; i++) {
      await sleep(100)
      kids = await call('GET', `/tasks/${parent.id}/children`)
    }
    assert.equal(kids.find((x) => x.id === kid.id).cliAlive, true, '发消息后进程活着')
    const busy = await call('GET', '/tasks')
    assert.ok(
      busy.find((x) => x.id === parent.id)?.childrenWorking >= 1,
      '子对话在跑时父对话的摘要带上 childrenWorking，侧栏据此显示执行中',
    )
    kid = await waitDone(kid.id, 20000)
    assert.equal(kid.status, 'done')
    // 第二轮跑完再看：本次开启时间已经换成新这一轮的，列表按它把这条重新排到前面
    kids = await call('GET', `/tasks/${parent.id}/children`)
    const again = kids.find((x) => x.id === kid.id)
    assert.ok(
      again.startedAt > one.startedAt,
      `完成后再接新任务：本次开启时间往前走（${one.startedAt} → ${again.startedAt}）`,
    )
    step('子对话：列表如实给 cliAlive，打开对话不启动 CLI，发消息才启动，父对话带上 childrenWorking')

    // 父对话页切走、宽限期（测试里 1.2 秒）到了：在运行的子对话不能跟着失活，要自己跑完（ADR 0012）
    let away = await mkChild('子对话切走', 'SLOW 父对话切走后照样跑完')
    await waitFor(() => calls().some((c) => c.input.includes('SLOW 父对话切走后照样跑完')), {
      label: '子对话开始执行',
    })
    // 子对话刚起来那一刻可能还没算进父对话的计数（并行跑全量时 CPU 被抢，窗口更宽）：等它出现，
    // 不要用一次断言把「晚几十毫秒」判成失败。真的不出现时 waitFor 会带着等了多久超时
    await waitFor(async () => ((await call('GET', `/tasks/${parent.id}`)).childrenWorking ?? 0) >= 1, {
      label: '父对话详情也带上还在运行的子对话数：标题栏据此转圈',
    })
    await call('POST', `/tasks/${parent.id}/presence`, { viewerId: 'e2e', active: false })
    away = await waitDone(away.id, 20000)
    assert.equal(away.status, 'done', `父对话没人看、宽限到了，子对话照样跑完（${away.status} / ${away.stopReason}）`)
    assert.notEqual(away.stopReason, 'parent', '不是被父对话连带停掉的')
    await call('POST', `/tasks/${parent.id}/presence`, { viewerId: 'e2e', active: true })
    step('父对话切走：宽限到期不连带停掉还在跑的子对话')

    // 父对话在等子对话（计划里还挂着没做完的步骤），自己这一轮已经结束、进程也退了（不保活的 CLI）：
    // 宽限到了不能把它收口成「已中断」——旧实现按「没有执行位就是空闲」收了，子对话的结果回来时没有父对话接
    let waiting = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      prompt: 'PLAN_LEFT 等子对话时切到后台',
    })
    waiting = await waitDone(waiting.id, 20000)
    assert.ok((await call('GET', `/tasks/${waiting.id}`)).plans?.length, '计划留在没做完的状态')
    const busyKid = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      parentTaskId: waiting.id,
      prompt: 'SLOW 子对话在跑，父对话在等',
    })
    await waitFor(() => calls().some((c) => c.input.includes('SLOW 子对话在跑，父对话在等')), {
      label: '子对话开始执行',
    })
    // 创建子对话不会叫醒父对话（createTask 只 start 子对话，不发 noteParent），这里防的只是“上一轮还没落完”的收尾窗口
    await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${waiting.id}`)
        return t.working ? null : t
      },
      { timeout: 15000, label: '父对话这一轮跑完' },
    )
    assert.equal(
      (await call('GET', `/tasks/${waiting.id}`)).working,
      false,
      '切走前父对话必须没有执行位：它不保活，这一轮结束进程就退了',
    )
    await call('POST', `/tasks/${waiting.id}/presence`, { viewerId: 'e2e-waiting', active: true })
    await call('POST', `/tasks/${waiting.id}/presence`, { viewerId: 'e2e-waiting', active: false })
    // 宽限 1200ms，等两倍：机器忙时计时器可能晚触发，等太短会让旧实现也通过（用例失去区分度）
    await sleep(2400)
    const held = await call('GET', `/tasks/${waiting.id}`)
    // 先确认断言时刻父对话仍然没有执行位：要是这段时间里它被叫醒在跑，旧实现也会因 live 里有条目而判忙，
    // 后面两条就成了假绿；这条先把“构造变了”打红
    assert.equal(held.working, false, `宽限窗口里父对话一直被叫醒在跑（${held.status}），这段用例失去区分度`)
    assert.notEqual(
      held.stopReason,
      'presence',
      `父对话在等子对话：宽限到了也不能被回收成「已中断」（现在 ${held.status} / ${held.stopReason}）`,
    )
    assert.notEqual(held.status, 'stopped', '父对话还有子对话的结果要接，不能落成已停止')
    await call('POST', `/tasks/${busyKid.id}/stop?force=1`).catch(() => {})
    await call('POST', `/tasks/${waiting.id}/stop?force=1`).catch(() => {})
    await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${waiting.id}`)
        return t.status !== 'running' ? t : null
      },
      { timeout: 15000, label: '收掉等子对话的父对话' },
    )
    step('父对话在等子对话：宽限到期不回收父对话（子对话的结果还要交给它）')

    // 父对话的 CLI 结束时一起结束子对话的进程
    let slow = await mkChild('子对话二', 'SLOW 父对话关闭时一起结束')
    await waitFor(() => calls().some((c) => c.input.includes('SLOW 父对话关闭时一起结束')), {
      label: '子对话开始执行',
    })
    assert.equal((await call('GET', `/tasks/${slow.id}`)).status, 'running', '子对话正在执行')
    await call('POST', `/tasks/${parent.id}/stop`)
    slow = await waitDone(slow.id, 15000)
    assert.notEqual(slow.status, 'running', '父对话的 CLI 结束后，子对话的进程也结束了')
    assert.ok(slow.messages.length > 0, '停止时保留已有的输出，下次发消息能重新启动')
    // 停止时子对话的进程是异步结束的（stopTask 里的 closeChildren 不阻塞停止请求），
    // 状态先落盘、进程随后退出，这里等一小会儿再看，不和进程回收抢时间
    let after = await call('GET', `/tasks/${parent.id}/children`)
    for (let i = 0; i < 30 && after.find((x) => x.id === slow.id)?.cliAlive; i++) {
      await sleep(100)
      after = await call('GET', `/tasks/${parent.id}/children`)
    }
    assert.equal(after.find((x) => x.id === slow.id).cliAlive, false, '子对话的进程没有留成孤儿')
    // 父对话自己也停掉，后面的用例从干净状态开始
    await waitDone(parent.id, 15000)
    step('父对话关闭：名下子对话的 CLI 一起结束，已有内容保留')

    // 常驻保活的 CLI（Command Code）跑完一轮：同一轮结束只给父对话上报一次。
    // result 事件和「回复完停在等下一句」是两个信号，两处各记一遍时父对话会收到两条一模一样的「接收消息」，
    // 前端收拢只是兜旧数据，不能靠它掩盖这里又拆回两处
    {
      let keepParent = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        prompt: '保活子对话的父对话',
      })
      keepParent = await waitDone(keepParent.id, 20000)
      const keepKid = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: C.id,
        parentTaskId: keepParent.id,
        // 带 COMMIT：这一轮要真的改了东西，result 那次才不会被「只回一句话」的空回合判定跳过
        prompt: 'COMMIT 保活的子对话跑一轮',
      })
      // 有人在看这个子对话时，回复完才会保活等下一句：这样 result 和保活两个信号都会出现
      await call('POST', `/tasks/${keepKid.id}/presence`, { viewerId: 'e2e-keepalive', active: true })
      const reportsOf = (x) => x.messages.filter((m) => m.peer?.kind === 'report' && m.peer.id === keepKid.id)
      keepParent = await waitTask(keepParent.id, (x) => reportsOf(x).length > 0, 30000)
      // 用例成立的前提：回复完停在保活等下一句（listen 那一处结束信号真的会出现）
      const kidNow = await call('GET', `/tasks/${keepKid.id}`)
      assert.equal(kidNow.awaitingUser, true, '子对话回复完停在保活等下一句')
      // 两处信号相隔通常不到 1 秒：再等一会儿看有没有第二条（不同 subject 的合法汇报不算）
      await sleep(1500)
      keepParent = await call('GET', `/tasks/${keepParent.id}`)
      const reports = reportsOf(keepParent)
      const dup = reports.filter(
        (m, i) =>
          i > 0 &&
          m.peer.subject === reports[i - 1].peer.subject &&
          Math.abs(Date.parse(m.at) - Date.parse(reports[i - 1].at)) < 5000,
      )
      assert.equal(
        dup.length,
        0,
        `同一轮结束只上报一次；实际的汇报：${JSON.stringify(reports.map((m) => [m.at, m.peer?.subject]))}`,
      )
      await call('POST', `/tasks/${keepKid.id}/stop`)
      await waitDone(keepKid.id, 15000)
      await call('POST', `/tasks/${keepParent.id}/stop`)
      await waitDone(keepParent.id, 15000)
      step('保活的子对话跑完一轮：父对话只收到一条汇报')
    }

    // 「提问」关着、父对话停在保活等下一句（working 是 false 但执行位占着）时，子对话的提问自动交给父对话：
    // 要直接交给等着的 CLI 开始作答，不能当成空闲去开新一轮、被「任务正在执行」拒掉后只留一行「消息没有送到」
    {
      let waitParent = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: C.id,
        // 带 COMMIT 和保活的子对话那段一样：这一轮够长，看着它的 presence 先到，回复完才停在等下一句
        prompt: 'COMMIT 停在等下一句的父对话',
        askUser: false,
      })
      await call('POST', `/tasks/${waitParent.id}/presence`, { viewerId: 'e2e-wait-parent', active: true })
      // 保活等下一句时 status 仍是 running（waitTask 只认停下的），用 waitFor 看 awaitingUser
      await waitFor(
        async () => {
          const x = await call('GET', `/tasks/${waitParent.id}`)
          return x.awaitingUser && !x.working
        },
        { label: '父对话回复完停在保活等下一句', timeout: 30000 },
      )
      const askKid = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        parentTaskId: waitParent.id,
        prompt: 'ASK_PARENT 父对话等下一句时提问',
      })
      // 交给的是同一个保活进程（假 CLI 的调用日志只记启动）：看父对话在这条要求之后有没有新的回复
      const answered = (x) => {
        const i = x.messages.findIndex((m) => m.text.includes(`子对话「${askKid.title}」在等你决定`))
        return i >= 0 && x.messages.slice(i + 1).some((m) => m.role === 'agent')
      }
      await waitFor(async () => answered(await call('GET', `/tasks/${waitParent.id}`)), {
        label: '父对话的 CLI 收到替子对话决定的要求并开始作答',
        describe: async () =>
          JSON.stringify(
            (await call('GET', `/tasks/${waitParent.id}`)).messages.map((m) => [m.role, m.text.slice(0, 60)]),
          ),
        timeout: 30000,
      })
      waitParent = await call('GET', `/tasks/${waitParent.id}`)
      assert.ok(
        !waitParent.messages.some((m) => m.alert?.kind === 'delivery'),
        `父对话里没有「消息没有送到」：${JSON.stringify(waitParent.messages.filter((m) => m.alert).map((m) => m.text))}`,
      )
      await call('POST', `/tasks/${askKid.id}/stop`)
      await waitDone(askKid.id, 15000)
      await call('POST', `/tasks/${waitParent.id}/stop`)
      await waitDone(waitParent.id, 15000)
      step('父对话停在等下一句时子对话提问：直接交给等着的 CLI，不报「消息没有送到」')
    }

    // ---- 子对话不建独立分支：和父对话共用一个目录；父对话在独立分支里时就在父的那个目录 ----
    const isoNew = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: A.id,
      prompt: 'COMMIT BEGIN_EDIT 父对话在独立分支',
      isolate: true,
    })
    assert.equal(isoNew.worktree?.state, 'active', '勾了独立分支就在创建对话时开好')
    const isoParent = await waitDone(isoNew.id, 20000)
    assert.equal(isoParent.worktree?.state, 'active', '顶层对话传了 isolate 才隔离')
    let isoKid = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      parentTaskId: isoParent.id,
      prompt: 'COMMIT 子对话在父分支上改',
      isolate: true,
    })
    assert.equal(isoKid.worktree, null, '子对话传了 isolate 也不建独立分支')
    isoKid = await waitDone(isoKid.id, 20000)
    assert.ok(
      gitIn(isoParent.worktree.path, 'log', '--oneline').toString().includes('子对话'),
      '子对话直接在父对话的分支目录里提交',
    )
    const parentDropped = await call('POST', `/tasks/${isoParent.id}/worktree/discard`)
    assert.equal(parentDropped.worktree.state, 'discarded')
    await call('DELETE', `/tasks/${isoParent.id}`)
    step('子对话不建独立分支：和父对话共用目录，父对话在独立分支里时就在父的目录里改')

    // ---- 项目设成「独立 worktree」：子对话各自开分支改，编译交给面板合回原目录 ----
    const { id: _pid, createdAt: _c, updatedAt: _u, ...projectInput } = project
    await call('PUT', `/projects/${project.id}`, { ...projectInput, childIsolation: 'worktree' })
    const wtParent = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: A.id,
          prompt: '父对话',
          // 这一段的测试要用户亲手回答卡片：「提问」关着时子对话的提问会自动交给父对话，不挂卡片
          askUser: true,
        })
      ).id,
      20000,
    )
    assert.equal(wtParent.worktree, null, '父对话没开独立分支')
    let wtKid = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: B.id,
          parentTaskId: wtParent.id,
          prompt: 'COMMIT BEGIN_EDIT 子对话在自己的分支里改',
        })
      ).id,
      20000,
    )
    // 第一轮在原目录里查看，调用 begin_edit 后才开分支，面板马上在分支目录里开新会话接着做
    const editLog = readLog(log + '.edit')
    assert.ok(editLog.length && !editLog.at(-1).got.isError, '子对话调用 begin_edit 开了分支')
    assert.equal(editLog.at(-1).cwd, project.path, '开分支前在原目录里')
    // 分支目录里做完一轮没调用 submit_merge：面板催它一次合回去（这一句也是在分支目录里的一轮）
    const nudges = (x) => x.messages.filter((m) => m.panel === 'build' && m.text.includes('没合回父对话分支'))
    wtKid = await waitTask(wtKid.id, (x) => nudges(x).length > 0 && !x.working)
    const wtCall = calls().find((c) => c.cwd !== project.path && (c.input ?? '').includes('之前的对话'))
    assert.ok(wtCall, '开分支后在分支目录里开了新会话')
    assert.equal(wtKid.worktree?.state, 'active', '子对话要改文件时开了独立分支')
    assert.ok(
      !wtKid.messages.some((m) => m.role === 'system' && m.text.includes('已开独立分支')),
      '开分支不另记居中提示，begin_edit 这次调用本身就是对话里的一行',
    )
    assert.equal(wtCall.cwd, wtKid.worktree.path, '开分支后的一轮在分支目录里执行')
    assert.match(wtCall.input, /之前的对话[\s\S]*BEGIN_EDIT/, '新会话带上了之前的对话')
    assert.ok(!wtCall.args.includes('--resume'), '换了目录不续接旧会话')
    assert.ok(
      !gitIn(project.path, 'log', '--oneline').toString().includes('子对话在自己的分支'),
      '提交在子对话的分支上，项目目录不受影响',
    )
    const wtList = await call('GET', `/tasks/${wtParent.id}/children`)
    assert.equal(wtList.find((x) => x.id === wtKid.id)?.branch, wtKid.worktree.branch, '子对话列表带上分支')
    // 做完没合并：面板会写一条提醒，条件一到就继续，不用固定等
    await waitFor(async () => nudges(await call('GET', `/tasks/${wtKid.id}`)).length === 1, {
      label: '写完合并提醒',
    })
    const afterNudge = await call('GET', `/tasks/${wtKid.id}`)
    assert.equal(nudges(afterNudge).length, 1, '做完没合并只催一次')
    assert.match(nudges(afterNudge)[0].text, /submit_merge/, '催的时候说明用 submit_merge 合回去')
    const wtPrompt = JSON.stringify(wtCall)
    assert.match(wtPrompt, /别的子对话改不到这里/, '提示里说明了在独立分支里改')
    assert.match(wtPrompt, /在独立分支里验证，再合回原分支/, '提示里说明在自己的分支里编译测试、再合回去')
    assert.match(wtPrompt, /submit_merge/, '合回原分支用 submit_merge')
    assert.ok(!wtPrompt.includes('claim_files 认领'), '独立分支里不用认领文件')
    // 假 CLI 每轮都在工作目录写输出文件；项目目录里留着的那份没进版本控制，子对话分支里也有同名的，会挡住合并。
    // 这里故意多放两份：一份对得上分支里的（codex 就是这条子对话的 CLI），一份分支里没有的（pi）。
    // CI 上挂的是「写了没清」——旧清理只在重试循环外做一次，重试期间又被写回来；mergeTask 每次尝试前都清，
    // 名字覆盖全部 CLI 则由 outputs.test.mjs 的断言兜住
    const staleOutputs = [cliOutputFile('codex'), cliOutputFile('pi')]
    for (const f of staleOutputs) writeFileSync(path.join(project.path, f), 'stale\n')
    const before = (await call('GET', `/tasks/${wtParent.id}/worktrees`)).items
    assert.equal(before.length, 1, '父对话的独立分支列表带上子对话的')
    assert.ok(before[0].child && !before[0].merged && before[0].ahead + before[0].dirty > 0, '子对话的分支还没合并')
    // 还没合回原分支时不能标记完成：标记完成会删掉分支
    const early = await fetch(`${base}/tasks/${wtKid.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolved: true }),
    })
    assert.equal(early.status, 409, '有没合并的改动时不标记完成')
    assert.match((await early.json()).error, /先合并或删除分支/)
    // 催合并那条消息会让子对话再跑一轮：要从它这一轮结束、合并成功才停，中途被正在执行的回合挡住就再试
    const merged = await mergeTask(wtKid.id, { label: '子对话这一轮结束后合并' })
    assert.ok(!existsSync(path.join(project.path, staleOutputs[1])), '合并前清掉了分支里没有的残留输出文件')
    assert.equal(merged.task.worktree.state, 'active', '合并后分支留着，对话还能接着改')
    assert.ok(
      gitIn(project.path, 'log', '--oneline').toString().includes('子对话在自己的分支'),
      '合并后提交回到项目目录',
    )
    assert.ok((await call('GET', `/tasks/${wtParent.id}/worktrees`)).items[0].merged, '合并后标成已合并')
    // 合完再标记完成：独立分支的目录和分支一起删掉
    const wtDir = merged.task.worktree.path
    const resolved = await call('PATCH', `/tasks/${wtKid.id}`, { resolved: true })
    assert.equal(resolved.resolved, true)
    assert.equal(resolved.worktree.state, 'merged', '标记完成后独立分支记成已合并')
    assert.ok(!existsSync(wtDir), '标记完成后独立分支的目录删掉了')
    assert.ok(
      !gitIn(project.path, 'branch', '--list', merged.task.worktree.branch).toString().trim(),
      '标记完成后分支也删掉了',
    )
    // 已经合回原分支、workspace 和分支都被回收的子对话又被继续：按原来的名字重建工作区再执行，
    // 不报「项目目录不存在」，也不偷偷退回共用目录
    const oldBranch = merged.task.worktree.branch
    const rebornTask = await call('POST', `/tasks/${wtKid.id}/messages`, {
      text: 'COMMIT 继续这个图标的第二轮优化',
    })
    assert.equal(rebornTask.worktree?.state, 'active', '继续时自动重建独立分支')
    assert.equal(rebornTask.worktree.branch, oldBranch, '分支名沿用这条对话原来的')
    assert.equal(rebornTask.worktree.path, wtDir, '工作区建回原来的目录')
    assert.equal(rebornTask.worktree.baseBranch, merged.task.worktree.baseBranch, '合并回原来的分支')
    assert.ok(existsSync(wtDir), '重建后的独立目录在磁盘上')
    // 等这一轮真的跑起来：假 CLI 的调用记录里有新那句要求
    const rebornStart = Date.now()
    while (!calls().some((c) => (c.input ?? '').includes('第二轮优化'))) {
      if (Date.now() - rebornStart > 30000) throw new Error('重建后的子对话没有开始执行')
      await sleep(150)
    }
    assert.equal(calls().at(-1).cwd, wtDir, '这一轮在重建后的目录里执行')
    const rebornNow = await call('GET', `/tasks/${wtKid.id}`)
    assert.ok(
      !rebornNow.messages.some((m) => m.error || (m.text ?? '').includes('项目目录不存在')),
      '不再报项目目录不存在',
    )
    const rebornList = (await call('GET', `/tasks/${wtParent.id}/worktrees`)).items
    assert.equal(rebornList[0].branch, oldBranch, '状态栏上显示重建后的分支')
    // 重建时是 active（上面已断言）；这一轮跑得快、又没有要合回的改动时，读到列表前可能已经收口成 merged
    assert.ok(['active', 'merged'].includes(rebornList[0].state), `状态栏上的分支状态（${rebornList[0].state}）`)
    step('子对话工作区被回收后继续：自动重建同名分支并在新目录里执行')
    step('子对话标记完成：没合并时拦下，合并后删掉独立分支')
    // 子对话做完（测试跑通、只剩合回）调用 submit_merge 请父对话收尾：父对话 finish_child 合回自己的分支，
    // 子对话计划收尾、标记完成，独立分支回收（ADR 0005）
    await waitDone(wtKid.id, 20000)
    clearCliOutputs(project.path)
    const headBefore = gitIn(project.path, 'rev-parse', 'HEAD').toString().trim()
    const doneKid = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      parentTaskId: wtParent.id,
      prompt: 'COMMIT BEGIN_EDIT SUBMIT_MERGE BIG_CONTEXT 子对话做完自动合并',
    })
    // 开分支的那一轮结束后面板才在分支目录里接着做：等到合并完成，不等第一轮结束
    const closed = await waitTask(doneKid.id, (x) => x.resolved && x.worktree?.state === 'merged', 30000)
    const mergeLog = readLog(log + '.merge')
    assert.ok(mergeLog.length && !mergeLog.at(-1).got.isError, '子对话调用 submit_merge 请父对话收尾')
    // 父对话是在 finish_child 的 HTTP 响应回来之后才补写这条记录的（fake-cli），而 resolved 在服务端返回前就置位了：
    // 等到 resolved 就立刻读文件，会在「服务端已置位、记录还没落盘」这段窗口里读空（CI 上并行跑分片时窗口更大）。
    // 这里等记录真的出现（它是父对话调过 finish_child 的直接证据），不要靠固定等待凑时间
    const finishLog = await waitFor(
      () => {
        const hit = readLog(log + '.finish').filter((x) => x.id === doneKid.id && !x.got.isError)
        return hit.length ? hit : undefined
      },
      { timeout: 10000, label: '父对话调用 finish_child 的记录' },
    )
    assert.ok(
      finishLog.some((x) => x.id === doneKid.id && !x.got.isError),
      '父对话收到收尾请求后调用 finish_child 收尾',
    )
    const wrapParent = await call('GET', `/tasks/${wtParent.id}`)
    assert.ok(
      wrapParent.messages.some(
        (m) =>
          m.panel === 'wrapup' && m.child?.id === doneKid.id && m.peer?.kind === 'wrapup' && m.peer.rel === 'child',
      ),
      '收尾请求在父对话里是一行「子对话请求」',
    )
    assert.ok(closed.resolved, '合进父对话的分支后子对话标记完成')
    assert.ok(!existsSync(closed.worktree.path), '完成后独立分支的目录回收了')
    assert.match(
      gitIn(project.path, 'log', '-1', '--format=%s').toString(),
      /Agent 面板：合并「/,
      '改动合进了父对话所在的分支',
    )
    assert.notEqual(gitIn(project.path, 'rev-parse', 'HEAD').toString().trim(), headBefore, '父对话的分支多了合并提交')
    assert.ok(
      closed.messages.some((m) => m.panel === 'build' && m.text.includes('已合回原分支')),
      '合并结果记在子对话里',
    )
    // 这一轮已经答完（CLI 报过完成）后合并回收才把它收掉：不能留下「被中断」，用户会以为它没做完
    assert.equal(closed.status, 'done', '正常收尾的子对话被回收后仍是完成状态，不是 stopped')
    // 评审在计划里是独立一步（不是藏在某步内部），合并前它已经标完成
    assert.ok(
      closed.plans?.at(-1)?.steps.some((s) => s.review && s.status === 'done'),
      '计划里有标 review 的评审步骤，且已完成',
    )
    assert.ok(
      !closed.messages.some(
        (m) => m.role === 'system' && (m.text.includes('这一轮被中断') || m.text.includes('已暂停')),
      ),
      '答完一轮后被合并回收，不写「这一轮被中断」',
    )
    // 交接摘要（ADR 0007）：子对话写的关键信息加面板补的提交和改动文件，分支删掉后还留着
    assert.match(closed.handoff?.text ?? '', /## 关键文件和模块\nchild-done\.txt — 子对话完成的标记/)
    assert.match(closed.handoff.text, /## 合回的改动（分支 [^）]+）[\s\S]*child-done\.txt/, '面板补上了改动文件')
    // 已完成的子对话再被叫醒：不管上下文多大都 resume 接回原会话（用户 2026-10-31 定的，取代 ADR 0007 的换新会话）
    const logBefore = readLog(log).length
    const wokeAt = new Date().toISOString()
    await call('POST', `/tasks/${doneKid.id}/messages`, { text: '再补一个小改动' })
    await waitDone(doneKid.id, 20000)
    const revived = readLog(log)
      .slice(logBefore)
      .find((x) => x.kind === 'codex' && x.input.includes('再补一个小改动'))
    assert.ok(revived, '叫醒后执行了这一轮')
    assert.ok(revived.resume, '接回了原会话')
    assert.ok(!revived.input.includes('## 之前对话的摘要'), '不换成只带交接摘要的新会话')
    step('已完成的子对话再被叫醒：不管上下文多大都接回原会话')
    // 叫醒的这一轮没有新改动，结束后又收口完成、上报父对话
    await waitTask(doneKid.id, (x) => x.resolved, 20000)
    await waitTask(wtParent.id, (p) => p.messages.some((m) => m.child?.id === doneKid.id && m.at > wokeAt), 20000)
    // 上报会再叫起父对话一轮（收尾请求）：等它跑完，别和下一段抢项目目录
    for (let idle = 0; idle < 5; ) {
      idle = (await call('GET', `/tasks/${wtParent.id}`)).status === 'running' ? 0 : idle + 1
      await sleep(100)
    }
    step('子对话测试跑通后请父对话收尾：父对话 finish_child 合回分支，子对话完成并回收独立分支')
    // ---- 父对话正在跑一轮时子对话请收尾：收尾请求以插话（steer）进入那一轮，父对话照样要合回 ----
    // 子对话 submit_merge 时父对话正忙（被前一个子对话的状态上报叫起），【收尾请求】走 noteParent → steerTask
    // 插进父对话这一轮，不再另开一轮。CI 上 10 个分片并行时经常撞上这个时机，以前假 CLI 收到插话只记下来、
    // 不处理里面的 finish_child，子对话就停在「已请父对话收尾」，下一步只能等到超时。
    {
      const busyParent = await waitDone(
        (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: A.id, prompt: '父对话' })).id,
        20000,
      )
      // HOLD_STEER：这一轮不靠固定时长，而是一直挂到真的收到插话才收尾。
      // 用 SLOW 的固定时长当同步点时，子对话要经过 begin_edit 开分支、派评审、评审交回才能走到 submit_merge，
      // 往往超过了那个窗口；那一轮先结束，收尾请求就退化成普通新一轮 input，插话这条路径根本没被跑到
      // （去掉 takeSteer 里处理收尾请求的那段，用例照样通过）。见项目教训 lmvm2cr7ycvig
      await call('POST', `/tasks/${busyParent.id}/messages`, { text: 'HOLD_STEER 先忙着' })
      await waitFor(async () => (await call('GET', `/tasks/${busyParent.id}`)).working, {
        timeout: 20000,
        label: '父对话正在跑一轮',
      })
      const busyKid = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        parentTaskId: busyParent.id,
        prompt: 'COMMIT BEGIN_EDIT SUBMIT_MERGE 父对话忙着的时候请收尾',
      })
      const mergedBusy = await waitTask(busyKid.id, (x) => x.resolved && x.worktree?.state === 'merged', 60000)
      assert.ok(mergedBusy.resolved, '父对话正在跑时请收尾，也合回去了')
      assert.equal(mergedBusy.worktree.state, 'merged', '独立分支回收')
      // 关键：必须是「插话」那条路办的。父对话那一轮如果先结束了，收尾请求会走普通新一轮 input，
      // .finish 里照样有记录、merged 照样成立，但插话路径没被覆盖，这个用例就白写了
      // 等 .finish 那行写下来再看：子对话显示「已合并」时，父对话那边 finish_child 的结果可能还在回给假 CLI 的路上，
      // 立刻读会偶发读不到（并行跑时约 1/4）。这是断言抢时间，不是功能坏了（失败现场最终都有 via:"steer" 记录）
      const viaSteerOf = () => readLog(log + '.finish').filter((x) => x.id === busyKid.id && x.via === 'steer')
      await waitFor(async () => viaSteerOf().length > 0, {
        timeout: 20000,
        label: '收尾请求是以插话交给父对话那一轮的',
        // 超时时把这些记录全打出来：区分「真的没走插话」还是「记录没落盘 / 走的 input 路」
        describe: () => ({
          kid: busyKid.id,
          hold: readLog(log + '.hold'),
          finish: readLog(log + '.finish'),
        }),
      })
      const viaSteer = viaSteerOf()
      // 插话那次可能被拒（finishChildStep 在「正在合并」「还没请求收尾」时返回 isError），
      // 这一轮 input 里同一个请求会再试一次并成功（见 R5 的处理）：所以看「至少成功过一次」
      assert.ok(
        viaSteer.some((x) => !x.got.isError),
        `父对话在这一轮里（插话进来）就调了 finish_child：${JSON.stringify(viaSteer)}`,
      )
      // 假 CLI 那一轮确实一直在等插话（不是静默被当成卡住、也不是等满上限自己结束）
      const holds = readLog(log + '.hold')
      assert.ok(
        holds.some((x) => x.held && x.kid === busyKid.id),
        `父对话那一轮一直等到插话进来（HOLD_STEER 记 held）：${JSON.stringify(holds)}`,
      )
      await waitDone(busyParent.id, 60000)
      step('父对话正在跑一轮时子对话请收尾：收尾请求以插话进来，父对话照样合回')
    }
    // ---- 停下来时独立分支里还有没提交的改动：父对话里要说清几个文件、在哪个目录，并能一键继续 ----
    {
      const stopParent = await waitDone(
        (
          await call('POST', '/tasks', {
            projectId: project.id,
            mode: 'chat',
            agentId: A.id,
            prompt: '父对话',
            askUser: true,
          })
        ).id,
        20000,
      )
      // 带 PLAN_NEXT：这一轮会留一个没做完的计划（停止时计划不会自动收起）。
      // 带 SLOW：这一轮要跑十来秒，够在它还在跑的时候放进一个没提交的文件、再点停止
      const stopKid = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        parentTaskId: stopParent.id,
        prompt: 'BEGIN_EDIT PLAN_NEXT SLOW 停下时分支里还有没提交的改动',
      })
      // 假 CLI 在这一轮开头就调用 begin_edit 开分支：等它真的在分支里跑起来
      const branch = await waitFor(
        async () => {
          const me = await call('GET', `/tasks/${stopKid.id}`)
          return me.status === 'running' && me.worktree?.state === 'active' ? me.worktree : undefined
        },
        { timeout: 40000, label: '子对话开好独立分支并在跑' },
      )
      // 分支目录里放一个没提交的文件：用户点停止时它就留在那儿（面板不自动提交、也不清理）
      writeFileSync(path.join(branch.path, 'dirty-when-stopped.txt'), 'x\n')
      await call('POST', `/tasks/${stopKid.id}/stop`)
      // 停止是异步收尾的：等父对话里真的出现那条提示，不靠固定等待
      const note = await waitFor(
        async () =>
          (await call('GET', `/tasks/${stopParent.id}`)).messages.find(
            (m) => m.worktree?.dirty > 0 && m.child?.id === stopKid.id,
          ),
        { timeout: 20000, label: '父对话收到「有未提交改动」的提示' },
      )
      // 提示里写的是可读的事实：几个文件、在哪个目录，不是内部的枚举值
      assert.match(note.text, /个文件没有提交/, '提示里写清还有几个文件没提交')
      assert.ok(note.text.includes(branch.path), '提示里写上独立分支目录')
      assert.equal(note.worktree.path, branch.path, '提示里带上目录，界面不用再查一次')
      assert.equal(note.child.state, 'stopped', '那一行标出子对话已经停下')
      // 等它真的停下（停止是异步收尾），再看子对话卡片
      await waitFor(async () => (await call('GET', `/tasks/${stopKid.id}`)).status === 'stopped', {
        label: '子对话停下',
      })
      // 子对话卡片自己也带上「N 个文件未提交 + 目录」：父对话不点开也知道改动在哪。
      // /children 不等独立分支的 git（几十个子对话时不把消息和 SSE 首包拖住，见
      // docs/modules/server/bugs/children-git-blocks-open.md）：第一次可能是 worktreeChecked=false 的占位值，
      // git 结果在下一次轮询到位，所以这里等到真的核对过再看 dirty
      // 占位时不能给「0 个文件」：那会被界面显示成「干净」，比晚一轮更糟
      const pending = (await call('GET', `/tasks/${stopParent.id}/children`)).find((x) => x.id === stopKid.id)
      if (pending && !pending.worktreeChecked) {
        assert.equal(pending.dirty, undefined, '没核对过时不能把 dirty 说成 0')
        assert.equal(pending.unmerged, undefined, '没核对过时不能把 unmerged 说成 false（已合回）')
      }
      const row = await waitFor(
        async () => {
          const hit = (await call('GET', `/tasks/${stopParent.id}/children`)).find((x) => x.id === stopKid.id)
          return hit?.worktreeChecked ? hit : undefined
        },
        { timeout: 20000, label: '子对话卡片核对完独立分支状态' },
      )
      // 停止时计划还没做完（用户最常遇到的停止情形，见上面的 PLAN_NEXT），
      // 这时也要照样报出没提交的文件，不能因为「还有 holds」就当成不需要判完成而什么都不给
      const kidDone = await call('GET', `/tasks/${stopKid.id}`)
      assert.ok(
        kidDone.plans?.at(-1)?.steps.some((s) => s.status !== 'done'),
        '子对话还留着没做完的计划（就是要覆盖的 holds 场景）',
      )
      assert.ok(row.dirty > 0, '子对话卡片带上没提交的文件数（计划没做完时也要有）')
      assert.equal(row.dir, branch.path, '子对话卡片带上独立分支目录')
      // 一键继续走的是面板已有的「继续」接口（重新占执行位），不另造一套
      const resumed = await call('POST', `/tasks/${stopKid.id}/resume`, {})
      assert.equal(resumed.status, 'running', '一键继续后重新占住执行位接着做')
      await waitDone(stopKid.id, 40000)
      // 打断并重发（supersede=dirty）：那条提示不能说成「已停下」，它马上就接着做
      const cutKid = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        parentTaskId: stopParent.id,
        prompt: 'BEGIN_EDIT SLOW 会被新消息打断的子对话',
      })
      const cutBranch = await waitFor(
        async () => {
          const me = await call('GET', `/tasks/${cutKid.id}`)
          return me.status === 'running' && me.worktree?.state === 'active' ? me.worktree : undefined
        },
        { timeout: 40000, label: '打断用例的子对话在分支里跑' },
      )
      writeFileSync(path.join(cutBranch.path, 'dirty-when-interrupted.txt'), 'x\n')
      await call('POST', `/tasks/${cutKid.id}/messages`, { text: '马上改成这条', interrupt: true })
      const cutNote = await waitFor(
        async () =>
          (await call('GET', `/tasks/${stopParent.id}`)).messages.find(
            (m) => m.child?.id === cutKid.id && m.text.includes('被打断'),
          ),
        { timeout: 20000, label: '父对话收到「被打断」的提示' },
      )
      assert.equal(cutNote.child.state, 'running', '被打断的那条不写成「已中断」，它马上接着做')
      assert.match(cutNote.text, /个文件没有提交/, '被打断时也说清还有几个文件没提交')
      await call('POST', `/tasks/${cutKid.id}/stop`)
      await waitFor(async () => (await call('GET', `/tasks/${cutKid.id}`)).status === 'stopped', {
        timeout: 20000,
        label: '打断用例的子对话停下',
      })
      step('停下的子对话：父对话里提示「有未提交改动 + 目录」，可以一键继续；被打断时不说成「已停止」')
    }
    // 提问这一段另用一个刚建好的父对话：上面刚收尾的子对话会各自 submit_merge，每次都会把父对话叫起一轮
    // （【收尾请求】），合并结果推回子对话后它们还会再跑一轮、再叫一次父对话。提问和回答要是落进这样的一轮，
    // 走的是「实时交付」而不是收件箱，下面的「换成用户已回答」就不存在了——CI 上偶发失败就是这个。
    // 新父对话名下还没有子对话，没有谁会叫起它，提问一定落进收件箱。
    const askParentTask = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: A.id,
          prompt: '父对话',
          askUser: true,
        })
      ).id,
      20000,
    )
    // 子对话请父对话决定：父对话里是一张提问卡片（带选项），用户在卡片上回答后直接交给子对话
    const askKid = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: B.id,
          parentTaskId: askParentTask.id,
          prompt: 'ASK_PARENT 选一个方案',
        })
      ).id,
      20000,
    )
    let askParent = await call('GET', `/tasks/${askParentTask.id}`)
    const askMsg = askParent.messages.find((m) => m.panel === 'ask')
    assert.ok(askMsg, '父对话里记了提问卡片')
    assert.equal(askMsg.ask.from, askKid.id)
    assert.deepEqual(askMsg.ask.options, ['A 方案', 'B 方案'], '卡片带上子对话给的选项')
    assert.equal(askMsg.ask.answer, undefined, '还没回答')
    assert.deepEqual(
      (await call('GET', `/tasks/${askKid.id}`)).parentAsks?.map((x) => x.id),
      [askMsg.id],
      '子对话上也挂着这个提问，输入框换成选择弹窗',
    )
    assert.ok(
      !askParent.messages.some((m) => m.role === 'system' && !m.panel && m.text.includes('提问')),
      '提问不再是居中的系统提示',
    )
    // 回答之前先确认这张提问真的落在父对话的收件箱里：父对话正在跑一轮时提问会实时交给它、不进收件箱，
    // 那种情况这段要断言的「换成用户已回答」本来就不会出现。等条件成立再回答，不靠时间差
    await waitFor(
      async () =>
        (await call('GET', `/tasks/${askParentTask.id}`)).inbox.some(
          (x) => x.from === askKid.id && x.text.startsWith('（提问）'),
        ),
      { label: '提问进了父对话的收件箱' },
    )
    await call('POST', `/tasks/${askParentTask.id}/child-asks/${askMsg.id}`, { answer: 'B 方案', delegate: false })
    await waitTask(askKid.id, (k) => k.messages.some((m) => m.role === 'user' && m.text.includes('用户的决定')))
    // 对话之间的消息带上发件方和类型：子对话里画成「接收消息」，不当成用户说的话
    const kidMsgs = (await call('GET', `/tasks/${askKid.id}`)).messages
    // 这个子对话是直接建的（用户发的第一句），只有卡片上的回答经父对话交过来
    assert.equal(kidMsgs[0].peer, undefined, '用户自己建子对话时第一句仍是用户消息')
    const answerMsg = kidMsgs.find((m) => m.text.includes('用户的决定'))
    assert.equal(answerMsg.peer?.kind, 'answer', '卡片上的回答交给子对话时标成「回答」')
    assert.ok(answerMsg.peer.subject.includes('B 方案'), '标题里接上答案')
    askParent = await call('GET', `/tasks/${askParentTask.id}`)
    const answeredAsk = askParent.messages.find((m) => m.id === askMsg.id)
    assert.equal(answeredAsk.ask.answer, 'B 方案')
    assert.equal(answeredAsk.ask.by, 'user')
    await waitTask(askKid.id, (k) => !k.parentAsks?.length)
    assert.ok(
      askParent.inbox.some((x) => x.from === askKid.id && x.text.includes('用户已回答')) &&
        !askParent.inbox.some((x) => x.from === askKid.id && x.text.startsWith('（提问）')),
      '父对话的收件箱里换成「用户已回答」，不会再答一遍',
    )
    // 子对话页的选择弹窗点了关闭：这些提问不回答，子对话终止；父对话的卡片记成不回答，它的 AI 也不会再替用户决定
    {
      const closeKid = await waitDone(
        (
          await call('POST', '/tasks', {
            projectId: project.id,
            mode: 'chat',
            agentId: B.id,
            parentTaskId: askParentTask.id,
            prompt: 'ASK_PARENT 关掉这个提问',
          })
        ).id,
        20000,
      )
      const pending = await waitFor(
        async () => {
          const p = await call('GET', `/tasks/${askParentTask.id}`)
          const m = p.messages.find((x) => x.panel === 'ask' && x.ask.from === closeKid.id)
          return m && p.inbox.some((x) => x.from === closeKid.id && x.text.startsWith('（提问）')) ? m : undefined
        },
        { label: '第二个子对话的提问进了父对话' },
      )
      assert.equal((await call('GET', `/tasks/${closeKid.id}`)).parentAsks?.length, 1)
      const closedKid = await call('POST', `/tasks/${closeKid.id}/parent-asks/close`)
      assert.deepEqual(closedKid.parentAsks, [], '返回的子对话里已经没有提问，弹窗马上收起')
      await waitFor(
        async () =>
          (await call('GET', `/tasks/${askParentTask.id}/children`)).find((x) => x.id === closeKid.id)?.cliAlive ===
          false,
        { label: '子对话终止：CLI 进程结束' },
      )
      assert.notEqual((await call('GET', `/tasks/${closeKid.id}`)).status, 'running')
      const p2 = await call('GET', `/tasks/${askParentTask.id}`)
      const card = p2.messages.find((m) => m.id === pending.id)
      assert.equal(card.ask.by, 'user')
      assert.match(card.ask.answer, /不回答/, '父对话的卡片记成不回答')
      assert.equal(card.ask.declined, true, '卡片上写「你没回答」，不是「你已决定」')
      assert.ok(
        !p2.inbox.some((x) => x.from === closeKid.id && x.text.startsWith('（提问）')) &&
          p2.inbox.some((x) => x.from === closeKid.id && x.text.includes('不用再替用户决定')),
        '父对话的收件箱里换成「用户不回答」',
      )
      await assert.rejects(
        call('POST', `/tasks/${askParentTask.id}/child-asks/${pending.id}`, { answer: 'A 方案', delegate: false }),
        /已经回答过/,
      )
    }
    step('子对话请你决定的提问点了关闭：不回答，子对话终止，父对话不再替你决定')
    await call('DELETE', `/tasks/${askParentTask.id}`)
    // ---- 收尾前评审：完整测试之前派「评审」，评审给 🛑 时 submit_merge 被拦下，改完复看通过才合回 ----
    {
      // 假 CLI 每次都在工作目录写输出文件：和分支里那份一样就合得回去，先清掉项目目录里遗留的那份
      clearCliOutputs(project.path)
      const headBefore = gitIn(project.path, 'rev-parse', 'HEAD').toString().trim()
      const reviewKid = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        parentTaskId: wtParent.id,
        prompt: 'COMMIT BEGIN_EDIT REVIEW_BLOCK SUBMIT_MERGE 评审给必须改项时不许合回',
      })
      const closed = await waitTask(reviewKid.id, (x) => x.resolved && x.worktree?.state === 'merged', 40000)
      const reviews = closed.steps.filter((s) => s.slot === 'sub' && s.title === '评审改动')
      assert.equal(reviews.length, 2, '收尾时派了两次评审：第一次给 🛑，改完再复看')
      assert.match(reviews[0].output, /^验收结论：不通过/, '第一次评审的第一行就是结论（长报告被截断也读得到）')
      assert.match(reviews[0].output, /🛑/, '后面列出必须改项')
      assert.match(reviews[1].output, /^验收结论：通过/, '复看的第一行是通过')
      // 评审是计划里的独立步骤：用户能在计划面板上看到这一步和它的状态
      const planSteps = closed.plans?.at(-1)?.steps ?? []
      const planReviews = planSteps.filter((s) => s.review)
      assert.equal(planReviews.length, 2, '计划里有两个独立的评审步骤：评审本次改动、复看评审')
      assert.ok(
        planReviews.every((s) => s.status === 'done'),
        '两个评审步骤最后都是完成',
      )
      assert.ok(
        planSteps.some((s) => s.title === '按评审意见修改' && !s.review),
        '按评审意见修改也单列成一步，不和其他步骤合并',
      )
      const planLog = readLog(log + '.plan')
      assert.ok(
        planLog.some((x) => x.steps.some((s) => s.review === true && s.status === 'waiting')),
        '派评审时计划里的评审步骤标成等待中',
      )
      // 评审不通过时直接请父对话收尾：面板按结论拦下，不合进去
      assert.ok(
        readLog(log + '.review').some((x) => x.rejected),
        '🛑 没改完就调用 submit_merge 时被面板拦下',
      )
      const failedMerge = readLog(log + '.merge').find((x) => x.got.isError && /评审/.test(JSON.stringify(x.got)))
      assert.ok(failedMerge, '拒绝的理由说清了是评审没过')
      assert.match(JSON.stringify(failedMerge.got), /不通过/, '拦下时告诉它评审结论是不通过')
      // 复看通过后才真的合回父对话所在的分支
      assert.ok(
        readLog(log + '.merge').some((x) => !x.got.isError),
        '复看通过后 submit_merge 成功，父对话合回分支',
      )
      assert.notEqual(
        gitIn(project.path, 'rev-parse', 'HEAD').toString().trim(),
        headBefore,
        '父对话的分支多了合并提交',
      )
      step('收尾前评审：计划里的独立评审步骤、🛑 时拦下、复看通过后才合回')
    }
    // ---- 计划里只写了评审的标题、没标 review：submit_merge 被拒，补上之后才合回 ----
    {
      clearCliOutputs(project.path)
      const mergesBefore = readLog(log + '.merge').length
      const kid = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        parentTaskId: wtParent.id,
        prompt: 'COMMIT BEGIN_EDIT NO_REVIEW_PLAN SUBMIT_MERGE 计划里没写评审步骤时不许合回',
      })
      const closed = await waitTask(kid.id, (x) => x.resolved && x.worktree?.state === 'merged', 40000)
      const merges = readLog(log + '.merge').slice(mergesBefore)
      assert.ok(
        merges.some((x) => x.got.isError && /计划里缺少评审步骤/.test(JSON.stringify(x.got))),
        '计划里的评审步骤没标 review 时 submit_merge 被拦下，理由写清了缺的是评审步骤',
      )
      assert.ok(
        merges.some((x) => !x.got.isError),
        '补上带 review 标记的评审步骤后 submit_merge 成功、合回父对话分支',
      )
      assert.ok(
        closed.plans?.at(-1)?.steps.some((s) => s.review && s.status === 'done'),
        '补上的评审步骤在计划里且已完成',
      )
      assert.equal(
        closed.steps.filter((s) => s.slot === 'sub' && s.title === '评审改动').length,
        1,
        '评审本身只派了一次：拦下的是计划少了一步，不是评审没过',
      )
      step('计划里缺少评审步骤：submit_merge 被拦下，补上后才合回')
    }
    await call('DELETE', `/tasks/${wtParent.id}`)
    await call('PUT', `/projects/${project.id}`, projectInput)
    step('子对话独立 worktree：第一次执行时开分支，提交不影响项目目录，编译交给面板，合并后回到原目录')
  }
  // 用户点「解决」时计划一并收口：走正式后端这条路径（PATCH resolved → settleChildForUser → settlePlan → 流转）。
  // 界面检查只覆盖演示后端，这条改的是 server/tasks.ts，得在这里兜住
  {
    // 前提：子对话和父对话共用一个目录（不开独立分支）。有独立分支且没合回时，点解决仍会先被「分支没合回」拦住，
    // 测不到计划收口这条路径。项目原来的隔离方式用完恢复
    // 没有 GET /projects/:id 这个路由（只有列表和 PUT/DELETE），从列表里取这一个
    const projBefore = (await call('GET', '/projects')).find((x) => x.id === project.id)
    assert.ok(projBefore, '前提：测试用的项目还在')
    const { id: _projId, createdAt: _projCreated, updatedAt: _projUpdated, ...projPayload } = projBefore
    const isoBefore = projBefore.childIsolation
    if (isoBefore !== 'claim') await call('PUT', `/projects/${project.id}`, { ...projPayload, childIsolation: 'claim' })
    const solveParent = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: A.id,
          prompt: '解决按钮：父对话',
        })
      ).id,
      20000,
    )
    // 计划故意留四项没做完（6 步里前 2 步 done，还带一层子步骤）
    const solveKid = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: B.id,
          parentTaskId: solveParent.id,
          prompt: 'PLAN_LEFT 计划留四项没做完',
        })
      ).id,
      20000,
    )
    assert.equal(solveKid.worktree, null, '前提：共用目录的子对话不建独立分支')
    const planBefore = solveKid.plans.at(-1)
    assert.ok(planBefore, '前提：子对话列了计划')
    // 6 步之外还有面板放在最后的收尾（共用目录也要请父对话验收）
    assert.equal(
      planBefore.steps.filter((s) => s.status !== 'done').length,
      5,
      '前提：计划 6 步里 2 步做完、4 步没做完，加上没做的收尾',
    )
    // 反向保护：同一个「计划没做完」的子对话走父对话收尾（finish_child）仍然被拦住——
    // 这条路径不传 fromUser，不能把真没做完的工作也当成做完
    const finishMarks = () => readLog(log + '.finish').filter((x) => x.via === 'marker' && x.id === solveKid.id)
    await call('POST', `/tasks/${solveParent.id}/messages`, {
      text: `FINISH_CHILD:${solveKid.id} 收尾这个子对话`,
    })
    const mark = await waitFor(() => finishMarks().at(-1), {
      timeout: 20000,
      label: '父对话调用 finish_child 的记录',
      describe: () => {
        const got = calls().filter((c) => (c.input ?? '').includes('FINISH_CHILD'))
        const last = got.at(-1)
        return last
          ? `带标记的 input 尾段：${String(last.input).slice(-260)}`
          : `没有任何一次调用带 FINISH_CHILD（最近一次调用 ${String(calls().at(-1)?.input ?? '').slice(-160)}）`
      },
    })
    assert.equal(mark.got?.isError, true, '计划没做完时父对话收尾仍被拦')
    // 只认「计划」这一步拦的：包装文案对任何 hold 都写「还没做完」，收窄到 childHoldText(['plan']) 那句
    assert.match(JSON.stringify(mark.got), /计划还没做完/, '拦住的原因说清是「计划还没做完」')
    const afterFinish = await call('GET', `/tasks/${solveKid.id}`)
    // resolved 未设置时字段不出现在 JSON 里，按「没标完成」算
    assert.equal(afterFinish.resolved ?? false, false, '父对话收尾被拦后子对话没有被标完成')
    assert.equal(
      afterFinish.plans.at(-1).steps.filter((s) => s.status !== 'done').length,
      5,
      '父对话收尾不会顺手把计划收口（fromUser 只走用户点解决那条路）',
    )
    step('计划没做完时父对话收尾仍被拦（计划不会跟着收口）')
    // 用户点「解决」：计划一并收口，不再因为「计划没做完」返回 409。
    // PATCH 路由自己就会写 resolved: true（见 server/tasks.ts 的 Object.assign），所以返回值证明不了「真的置完成」：
    // 真正的证据是父对话多一条这个子对话的完成上报（上报排在置完成之后，见 reportChild）
    const reportsOf = (x) => x.messages.filter((m) => m.peer?.kind === 'report' && m.peer.id === solveKid.id)
    const reportsBefore = reportsOf(await call('GET', `/tasks/${solveParent.id}`)).length
    const solved = await call('PATCH', `/tasks/${solveKid.id}`, { resolved: true })
    assert.equal(solved.resolved, true, '点解决成功，不再 409「计划没做完」')
    const parentAfter = await waitFor(
      async () => {
        const x = await call('GET', `/tasks/${solveParent.id}`)
        return reportsOf(x).length > reportsBefore ? x : undefined
      },
      { timeout: 15000, label: '父对话收到这个子对话的完成上报' },
    )
    assert.equal(
      reportsOf(parentAfter).length,
      reportsBefore + 1,
      '真的置完成为止并上报了父对话（不只是 PATCH 的返回值）',
    )
    const planAfter = solved.plans.at(-1)
    const allDone = (s) => s.status === 'done' && (s.children ?? []).every(allDone)
    assert.ok(planAfter.steps.length, '解决后计划还在（没有被清掉）')
    assert.ok(planAfter.steps.every(allDone), '计划里所有步骤（含子步骤）都收口成完成')
    assert.ok(
      planAfter.steps.some((s) => (s.children ?? []).length > 0),
      '前提：这份计划带子步骤，递归收口才算验到',
    )
    assert.ok(planAfter.doneAt, '计划落到完成态（折叠头走「计划已完成」）')
    // 再点一次：已经解决的不会再上报一次父对话（幂等看报告条数，比整份消息数更准）
    const again = await call('PATCH', `/tasks/${solveKid.id}`, { resolved: true })
    assert.equal(again.resolved, true, '重复点解决仍然成功')
    assert.ok(again.plans.at(-1).steps.every(allDone), '重复点不会把计划改回未完成')
    // 幂等是服务端同步跳过的（reportedDone / reportedState 去重），「不该发生」等不到条件，只能等一会儿再看
    await sleep(500)
    assert.equal(
      reportsOf(await call('GET', `/tasks/${solveParent.id}`)).length,
      reportsBefore + 1,
      '已经解决过的子对话不会再往父对话上报一次「已完成」',
    )
    // ---- 共用目录的子对话（和 P4、没有版本管理同一条路）：评审、验证、交接、父对话验收一样不少 ----
    // 以前只有独立分支有 submit_merge，共用目录的子对话改完计划一收就算完成，评审门禁根本走不到（用户 2026-10-31 报的 P4 场景）
    {
      clearCliOutputs(project.path)
      const mergesBefore = readLog(log + '.merge').length
      const sharedParent = await waitDone(
        (
          await call('POST', '/tasks', {
            projectId: project.id,
            mode: 'chat',
            agentId: A.id,
            prompt: '共用目录：父对话',
          })
        ).id,
        20000,
      )
      const kid = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        parentTaskId: sharedParent.id,
        prompt: 'REVIEW_BLOCK SUBMIT_MERGE 共用目录的子对话评审给必须改项时不许收尾',
      })
      const closed = await waitTask(kid.id, (x) => x.resolved, 40000)
      assert.equal(closed.worktree, null, '前提：共用目录的子对话没有独立分支')
      const merges = readLog(log + '.merge').slice(mergesBefore)
      assert.ok(
        merges.some((x) => x.got.isError && /评审/.test(JSON.stringify(x.got))),
        '评审给了必须改项时 submit_merge 被拦下：共用目录也过评审门禁',
      )
      assert.ok(
        merges.some((x) => !x.got.isError && /验收/.test(JSON.stringify(x.got))),
        '复看通过后请父对话验收成功（没有分支要合）',
      )
      // 假 CLI 收到「已验收」那一轮会把整份计划再交一次，收尾不一定还在最后：按种类找
      const wrap = closed.plans.at(-1).steps.find((x) => x.wrapUp)
      assert.equal(wrap?.wrapUp, 'deliver', '计划里有面板加的「请父对话验收」')
      assert.equal(wrap.status, 'done', '父对话验收后面板把收尾标完成')
      assert.ok(closed.handoff?.text, '交接要点照样留在任务上')
      step('共用目录的子对话：评审门禁照样拦、复看通过后请父对话验收，验收后才完成')
    }
    if (isoBefore !== 'claim')
      await call('PUT', `/projects/${project.id}`, { ...projPayload, childIsolation: isoBefore })
    // 不在这里删父对话：子对话刚被置完成时 CLI 还在收尾，那一轮结束时要处理手上的消息，
    // 这时连它一起删掉服务端会报「任务不存在」；分片结束由 harness 清理临时数据目录
    step('用户点「解决」时计划一并收口（正式后端）：成功、幂等，父对话收尾仍被拦')
  }
})
