/**
 * 端到端测试分片：子对话生命周期、独立 worktree、计划、后台命令、项目教训
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs），
 * 互不影响。总入口 scripts/e2e.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { rmSync, existsSync, writeFileSync } from 'node:fs'

import path from 'node:path'
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
    agent,
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
    kids = await call('GET', `/tasks/${parent.id}/children`)
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
    assert.ok(
      ((await call('GET', `/tasks/${parent.id}`)).childrenWorking ?? 0) >= 1,
      '父对话详情也带上还在运行的子对话数：标题栏据此转圈',
    )
    await call('POST', `/tasks/${parent.id}/presence`, { viewerId: 'e2e', active: false })
    away = await waitDone(away.id, 20000)
    assert.equal(away.status, 'done', `父对话没人看、宽限到了，子对话照样跑完（${away.status} / ${away.stopReason}）`)
    assert.notEqual(away.stopReason, 'parent', '不是被父对话连带停掉的')
    await call('POST', `/tasks/${parent.id}/presence`, { viewerId: 'e2e', active: true })
    step('父对话切走：宽限到期不连带停掉还在跑的子对话')

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
    // 假 CLI 每次都在工作目录写输出文件：项目目录里前面测试留下的那份没进版本控制，会挡住合并
    for (const f of ['codex-output.txt', 'claude-output.txt']) rmSync(path.join(project.path, f), { force: true })
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
    // 催合并那条消息会让子对话再跑一轮：等它这一轮结束再合，不然会撞上「对话正在执行」
    let merged
    await waitFor(
      async () => {
        try {
          merged = await call('POST', `/tasks/${wtKid.id}/worktree/merge`)
          return true
        } catch (e) {
          if (/正在执行/.test(String(e))) return false
          throw e
        }
      },
      { label: '子对话这一轮结束后合并' },
    )
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
    assert.equal(rebornList[0].state, 'active')
    step('子对话工作区被回收后继续：自动重建同名分支并在新目录里执行')
    step('子对话标记完成：没合并时拦下，合并后删掉独立分支')
    // 子对话做完（测试跑通、只剩合回）调用 submit_merge 请父对话收尾：父对话 finish_child 合回自己的分支，
    // 子对话计划收尾、标记完成，独立分支回收（ADR 0005）
    await waitDone(wtKid.id, 20000)
    for (const f of ['codex-output.txt', 'claude-output.txt']) rmSync(path.join(project.path, f), { force: true })
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
    // 上下文大的已完成子对话再被叫醒：开新会话只带交接摘要，不接回原会话把上次的工具输出全读一遍
    const logBefore = readLog(log).length
    const wokeAt = new Date().toISOString()
    await call('POST', `/tasks/${doneKid.id}/messages`, { text: '再补一个小改动' })
    await waitDone(doneKid.id, 20000)
    const revived = readLog(log)
      .slice(logBefore)
      .find((x) => x.kind === 'codex' && x.input.includes('再补一个小改动'))
    assert.ok(revived, '叫醒后执行了这一轮')
    assert.ok(!revived.resume, '没有接回原会话')
    assert.match(revived.input, /## 之前对话的摘要[\s\S]*## 关键文件和模块\nchild-done\.txt/, '新会话带上交接摘要')
    step('已完成的子对话再被叫醒：上下文大时开新会话只带交接摘要')
    // 叫醒的这一轮没有新改动，结束后又收口完成、上报父对话
    await waitTask(doneKid.id, (x) => x.resolved, 20000)
    await waitTask(wtParent.id, (p) => p.messages.some((m) => m.child?.id === doneKid.id && m.at > wokeAt), 20000)
    // 上报会再叫起父对话一轮（收尾请求）：等它跑完，别和下一段抢项目目录
    for (let idle = 0; idle < 5; ) {
      idle = (await call('GET', `/tasks/${wtParent.id}`)).status === 'running' ? 0 : idle + 1
      await sleep(100)
    }
    step('子对话测试跑通后请父对话收尾：父对话 finish_child 合回分支，子对话完成并回收独立分支')
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
      // 子对话卡片自己也带上「N 个文件未提交 + 目录」：父对话不点开也知道改动在哪
      const row = (await call('GET', `/tasks/${stopParent.id}/children`)).find((x) => x.id === stopKid.id)
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
      for (const f of ['codex-output.txt', 'claude-output.txt']) rmSync(path.join(project.path, f), { force: true })
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
      for (const f of ['codex-output.txt', 'claude-output.txt']) rmSync(path.join(project.path, f), { force: true })
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

    // ---- 执行计划：步骤挂在后台命令上等结果，结果回来自动标完成；计划全部完成就结束，不再补总结 ----
    {
      const planned = await waitDone(
        (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: 'PLAN_BG 列计划' }))
          .id,
        20000,
      )
      assert.equal(planned.plans.length, 1, '列了一份计划')
      // 计划结束看它自己的完成字段（doneAt），不再拿 summary 当哨兵
      // 计划先收口、结果消息后推回（中间要写盘）：两样都到了再查，不然偶发读到还没推回的那一刻
      const done = await waitTask(
        planned.id,
        (k) =>
          !!k.plans[0]?.doneAt &&
          k.messages.some((m) => m.panel === 'background' && m.text.includes('计划步骤「跑测试」')),
        30000,
      )
      const plan = done.plans[0]
      assert.deepEqual(
        plan.steps.map((x) => [x.title, x.status]),
        [
          ['改代码', 'done'],
          ['跑测试', 'done'],
        ],
        '后台命令成功后，等它的步骤自动标完成',
      )
      assert.equal(plan.steps[1].waits[0].state, 'ok')
      assert.ok(plan.doneAt, '全部完成后计划收起')
      assert.equal(plan.summary, '', '不再补计划总结')
      assert.ok(
        done.messages.some((m) => m.panel === 'background' && m.text.includes('计划步骤「跑测试」')),
        '推回的后台结果点名是计划里哪一步在等',
      )
      // 计划结束就是结束了：下一件事直接开新计划，不需要先写总结
      await call('POST', `/tasks/${planned.id}/messages`, { text: 'PLAN_NEXT 接着做' })
      const next = await waitTask(planned.id, (k) => k.plans.length === 2 && k.plans[1].steps.length > 0, 30000)
      assert.equal(next.plans[0].doneAt === '', false, '上一份计划已经结束')
      assert.equal(next.plans[1].steps[0].title, '继续改代码', '不需要写总结就能开新计划')
      assert.equal(next.plans[1].doneAt, '', '新计划还在进行中')
      await call('DELETE', `/tasks/${planned.id}`)
      step('执行计划：等待中的步骤结果回来自动完成，计划全部完成就结束、可以直接开新计划')
    }

    // ---- 还在跑的后台命令：这一轮说完了它还在跑，任务上带着 jobs；跑完推回结果，要 AI 重新总结 ----
    {
      const slow = await waitDone(
        (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: 'BG_LONG 跑测试' }))
          .id,
        20000,
      )
      const now = await call('GET', `/tasks/${slow.id}`)
      assert.deepEqual(
        now.jobs?.map((j) => j.name),
        ['慢测试'],
        '回复说完时后台命令还在跑：任务上带着它，界面在总结上面转圈',
      )
      const back = await waitTask(slow.id, (k) => k.messages.some((m) => m.panel === 'background'), 30000)
      const settled = await waitDone(back.id, 20000)
      assert.deepEqual(settled.jobs ?? [], [], '跑完以后不再列在运行中')
      assert.match(
        settled.messages.find((m) => m.panel === 'background').text,
        /重新总结整段工作/,
        '推回的结果要 AI 处理完重新总结',
      )
      await call('DELETE', `/tasks/${slow.id}`)
      step('后台命令：说完时还在跑的列在任务上，跑完推回并要求重新总结')
    }

    // ---- 子任务起的后台命令：记录上带它的步骤，结果推回父对话并标注来源，跑完从运行中消失 ----
    // 以前 step 在引擎里就被丢了，服务端不知道这条命令是哪个子任务起的，运行区只能和父对话自己的命令混在一起列
    {
      const spawned = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        prompt: 'SPAWN_SUB_BG 派一个子任务跑命令',
      })
      // 子任务起了一条 4 秒的慢命令：还在跑的时候抓，接口上要带 step（RunningNow 按它列「子任务 + 命令名」）
      const withJob = await waitFor(
        async () => {
          const t = await call('GET', `/tasks/${spawned.id}`)
          return (t.jobs?.length ?? 0) > 0 && t.jobs[0].step ? t : null
        },
        { timeout: 30000, label: '子任务起的后台命令带着 step 出现在运行中' },
      )
      const job = withJob.jobs[0]
      const sub = withJob.steps.find((s) => s.slot === 'sub' && s.id === job.step)
      assert.ok(sub, '子任务起的后台命令带它自己的步骤 id：没有 step 就分不清是谁起的')
      assert.equal(sub.title, '核对限流规则')
      assert.equal(sub.parentId, '@chat', '归属的是父对话派出的那一步')
      // 结果的来源要在推回的消息里写明，父对话才知道这条命令是谁起的
      const back = await waitFor(
        async () => {
          const t = await call('GET', `/tasks/${spawned.id}`)
          return t.messages.some((m) => m.panel === 'background' && /这条后台命令是子任务/.test(m.text)) ? t : null
        },
        { timeout: 30000, label: '子任务的后台结果推回父对话并标注来源' },
      )
      assert.match(
        back.messages.find((m) => m.panel === 'background').text,
        /这条后台命令是子任务「核对限流规则」起的/,
        '推回的文本标注是哪个子任务起的',
      )
      const settled = await waitDone(back.id, 30000)
      assert.deepEqual(settled.jobs ?? [], [], '跑完以后从运行中消失，不再占着子任务那一行')
      await call('DELETE', `/tasks/${settled.id}`)
      step('子任务起的后台命令：带子任务步骤，结果推回并标注来源，跑完消失')
    }

    // ---- 子对话列表口径：在等后台命令的照样列，父对话自己在跑时也照样给 ----
    // 以前运行区自己写 `working && !resolved`，在等后台命令、已解决但还在跑的子对话只在悬浮层里有、
    // 运行区没有，同一个页面对不上数。这里固定接口要如实给「还在跑」和「在等什么」，
    // 界面那两处读同一份（见 shared/task.ts 的 visibleChildren）。
    {
      const p2 = await waitDone(
        (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: '父对话' })).id,
        20000,
      )
      // 在等后台命令：这一轮说完了，命令还在跑，CLI 在等结果
      const bg = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        parentTaskId: p2.id,
        prompt: 'BG_LONG 跑测试',
      })
      await waitTask(bg.id, (k) => !k.working && (k.jobs?.length ?? 0) > 0, 30000)
      // 还在跑的子对话：用来验「父对话在跑时列表照样给」
      const busy = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        parentTaskId: p2.id,
        prompt: 'SLOW 还在跑',
      })
      await waitFor(async () => (await call('GET', `/tasks/${busy.id}`)).working === true, {
        timeout: 15000,
        label: '子对话开始执行',
      })
      // 还没跑完时不能标「解决」：这一轮还在执行就先拒，不把「还在跑」写成「已完成」
      // （「已解决但还在跑」那个显示状态只出现在收尾流程的时间窗口里，
      // 判定矩阵由单测覆盖，页面由界面检查的演示数据覆盖）
      await assert.rejects(call('PATCH', `/tasks/${busy.id}`, { resolved: true }), /还在执行/)

      const kids = await call('GET', `/tasks/${p2.id}/children`)
      const bgRow = kids.find((x) => x.id === bg.id)
      assert.ok(bgRow, '在等后台命令的子对话出现在父对话的列表里')
      assert.ok(bgRow.background >= 1, '还在跑的后台命令数如实给：界面靠它把这一条列进运行区')
      assert.equal(bgRow.waiting?.kind, 'background', '在等什么要说成「等后台命令」，不能被当成卡住')
      assert.equal(kids.find((x) => x.id === busy.id).working, true, '还在跑的子对话如实报 working')

      // 父对话自己在跑时，列表照样给：运行区按最新一轮列，不再看父对话在不在跑
      await call('POST', `/tasks/${p2.id}/messages`, { text: 'SLOW 接着做' })
      const during = await call('GET', `/tasks/${p2.id}/children`)
      assert.equal(during.length, kids.length, '父对话在跑时子对话列表不变，运行区照样列得出来')
      assert.ok(during.find((x) => x.id === bg.id)?.background >= 1, '父对话在跑时后台命令的状态也照样给')

      await call('POST', `/tasks/${p2.id}/stop`)
      step('子对话列表：在等后台命令的照样列，父对话在跑时也照样给')
    }

    // ---- 父对话一次派多个子对话：没有子对话并发上限，全部立即开始，没有「排队中」 ----
    {
      // 只有能分派、在项目里的顶层对话才是父对话，才有 create_conversation
      const delegator = await agent({
        name: '统筹',
        cli: 'claude',
        canDelegate: true,
        instructions: '你负责派子对话。',
      })
      // 从这一段开始记 create_conversation 的条数：不按最后 6 条截，少派一条时不会混进前面用例的记录
      const dispatchedBefore = readLog(log + '.panel').filter((x) => x.name === 'create_conversation').length
      const many = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: delegator.id,
        prompt: 'SPAWN_MANY_CHILDREN 派 6 个子对话',
      })
      // 这一轮结束时 6 次 create_conversation 都返回了
      await waitDone(many.id, 30000)
      const dispatched = readLog(log + '.panel')
        .filter((x) => x.name === 'create_conversation')
        .slice(dispatchedBefore)
      assert.equal(dispatched.length, 6, '父对话派出了 6 个子对话')
      assert.ok(
        dispatched.every((x) => !x.isError && x.text.includes('它在后台执行') && !/排队|上限/.test(x.text)),
        '派出的子对话都立即开始，没有「排队」「到上限」的提示',
      )
      // 子对话带 SLOW（每个跑十来秒）：要在这段时间里看到 6 个都在执行，才说明没有排队
      const kids = await waitFor(
        async () => {
          const list = await call('GET', `/tasks/${many.id}/children`)
          return list.length === 6 && list.every((k) => k.cliAlive && k.working) ? list : undefined
        },
        { timeout: 30000, label: '6 个子对话同时执行' },
      )
      assert.equal(kids.length, 6, '6 个子对话同时在跑：不再按并发上限排队')
      await call('POST', `/tasks/${many.id}/stop`)
      await waitDone(many.id, 20000)
      step('父对话派多个子对话：全部立即开始，没有并发上限和排队')
    }

    // ---- 全局规则：父对话输入 /rule 发布，不发给 CLI；子对话这一轮的提示里带上 ----
    const ruleParent = await waitDone(
      (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: '父对话' })).id,
      20000,
    )
    const ruled = await call('POST', `/tasks/${ruleParent.id}/messages`, { text: '/rule 不要改 package.json' })
    assert.deepEqual(
      ruled.rules.map((r) => r.text),
      ['不要改 package.json'],
      '规则存在父对话上',
    )
    assert.match(ruled.messages.at(-1).text, /已发布全局规则/)
    assert.notEqual(ruled.status, 'running', '/rule 由面板处理，不启动 CLI')
    const ruleKid = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: B.id,
          parentTaskId: ruleParent.id,
          prompt: '子对话看规则',
        })
      ).id,
      20000,
    )
    assert.equal(ruleKid.worktree, null)
    const kidLog = JSON.stringify(calls().at(-1))
    assert.ok(
      kidLog.includes('全局规则（父对话发布，必须遵守）') && kidLog.includes('不要改 package.json'),
      '子对话的提示里带上了父对话的全局规则',
    )
    // 子对话完成后才回报父对话：等回报进来，免得它插在下面 /rule 的回复后面
    for (let i = 0; i < 30; i++) {
      const p = await call('GET', `/tasks/${ruleParent.id}`)
      if (p.messages.some((m) => m.text.includes('子对话「子对话看规则」'))) break
      await sleep(100)
    }
    const listed = await call('POST', `/tasks/${ruleParent.id}/messages`, { text: '/rule' })
    assert.match(listed.messages.at(-1).text, /1\. 不要改 package\.json/)
    const cleared = await call('POST', `/tasks/${ruleParent.id}/messages`, { text: '/rule clear' })
    assert.deepEqual(cleared.rules, [])
    const childRule = await call('POST', `/tasks/${ruleKid.id}/messages`, { text: '/rule 子对话不能发' }).catch(
      (e) => e,
    )
    assert.match(String(childRule.message ?? childRule), /只能在项目对话里发布/)
    // 对话设置：目标和规则交给子对话，子对话按指定的 CLI 跑，停止全部子对话。
    // childLimit 是已经去掉的子对话并发上限：旧客户端带上它不能报错，读出来直接忽略
    const conf = await call('PATCH', `/tasks/${ruleParent.id}`, {
      goal: '商品页支持到货通知',
      rules: [{ id: 'r1', text: '只改 src 下的文件', at: new Date().toISOString() }],
      childRun: { cli: 'codex', model: '', effort: '' },
      childLimit: 2,
    })
    assert.equal(conf.goal, '商品页支持到货通知')
    assert.ok(!('childLimit' in conf), '对话设置里不再有子对话并发上限，旧字段被忽略')
    assert.equal(conf.childRun.cli, 'codex')
    await waitDone((await call('POST', `/tasks/${ruleKid.id}/messages`, { text: '按设置再做一次' })).id, 20000)
    const confLog = calls().at(-1)
    assert.equal(confLog.kind, 'codex', '子对话按父对话设置里的 CLI 执行')
    const confText = JSON.stringify(confLog)
    assert.ok(confText.includes('父对话的目标') && confText.includes('商品页支持到货通知'), '子对话看得到父对话的目标')
    assert.ok(confText.includes('只改 src 下的文件'), '设置里改的规则交给子对话')
    const back = await call('PATCH', `/tasks/${ruleParent.id}`, { childRun: null })
    assert.equal(back.childRun, undefined, '改回按角色自己的配置')
    assert.equal(typeof (await call('POST', `/tasks/${ruleParent.id}/children/stop`)).stopped, 'number')
    await call('DELETE', `/tasks/${ruleParent.id}`)
    step(
      '全局规则：/rule 发布、列出、清空，子对话的提示里带上，子对话自己不能发；对话设置的目标、规则、子对话 CLI 生效',
    )

    // ---- 项目教训：单独的接口记一条（同名更新），新会话的提示里带全局条目全文和按文件条目的标题 ----
    await call('POST', `/projects/${project.id}/lessons`, {
      title: '价格一律用整数分',
      rule: '格式化统一走 formatPrice',
    })
    await call('POST', `/projects/${project.id}/lessons`, {
      title: '支付方式写进配置',
      rule: '下单流程只读配置字段，不按名字判断',
      paths: ['src/payment/**'],
    })
    const relearned = await call('POST', `/projects/${project.id}/lessons`, {
      title: '价格一律用整数分',
      rule: '格式化统一走 src/utils/money.ts',
    })
    assert.equal(relearned.lessons.length, 2, '同名的规则更新原来那条')
    assert.equal(relearned.lessons[0].rule, '格式化统一走 src/utils/money.ts')
    assert.equal(relearned.lessons[0].source, 'user')
    const emptyLesson = await call('POST', `/projects/${project.id}/lessons`, { title: ' ' }).catch((e) => e)
    assert.ok(emptyLesson instanceof Error, '空规则不能记')
    // 不带 lessons 的项目设置请求不清空教训
    const { lessons: _lessons, ...withoutLessons } = projectInput
    const kept = await call('PUT', `/projects/${project.id}`, withoutLessons)
    assert.equal(kept.lessons.length, 2)
    // 全局教训：没确认不能写；写进去后新会话的提示里排在项目教训后面
    const unconfirmed = await call('PUT', '/global-lessons', { lessons: [] }).catch((e) => e)
    assert.ok(unconfirmed instanceof Error, '没确认不能改全局教训')
    await call('PUT', '/global-lessons', {
      confirmed: true,
      lessons: [{ id: 'g-e2e', title: '等待用后台命令', rule: '不用会立刻退出的定时脚本' }],
    })
    assert.equal((await call('GET', '/global-lessons')).length, 1)
    const learned = await waitDone(
      (await call('POST', '/tasks', { projectId: project.id, mode: 'chat', agentId: B.id, prompt: '看看教训' })).id,
      20000,
    )
    const lessonLog = JSON.stringify(calls().at(-1))
    assert.ok(lessonLog.includes('## 项目教训'), '新会话带上项目教训')
    assert.ok(lessonLog.includes('格式化统一走 src/utils/money.ts'), '所有改动都适用的给全文')
    assert.ok(lessonLog.includes('支付方式写进配置'), '按文件的列标题')
    assert.ok(!lessonLog.includes('下单流程只读配置字段'), '按文件的全文不放进提示，按需用工具取')
    assert.ok(lessonLog.includes('不用会立刻退出的定时脚本'), '全局教训也带上')
    assert.ok(
      lessonLog.indexOf('格式化统一走') < lessonLog.indexOf('不用会立刻退出的定时脚本'),
      '全局教训排在项目教训后面',
    )
    await call('PUT', '/global-lessons', { confirmed: true, lessons: [] })
    await call('DELETE', `/tasks/${learned.id}`)
    await call('PUT', `/projects/${project.id}`, { ...projectInput, lessons: [] })
    step('项目教训：接口记录和同名更新，新会话的提示只带全局条目全文和其余标题')

    // ---- 子对话长时间没有输出：面板以父对话的名义自动问它状态，用户消息照样能送达 ----
    {
      // 阈值 2 分钟（测试里 1 分钟 = 1.5 秒）：等 CLI 已经被标成没有响应，自动询问走「停掉卡住的 CLI、接回会话」
      const full = await call('GET', '/settings')
      await call('PUT', '/settings', { ...full, childIdleAskMinutes: 2 })
      assert.equal((await call('GET', '/settings')).childIdleAskMinutes, 2, '自动询问的阈值保存成功')
      const askParent = await waitDone(
        (
          await call('POST', '/tasks', {
            projectId: project.id,
            mode: 'chat',
            agentId: B.id,
            prompt: '自动询问的父对话',
          })
        ).id,
        20000,
      )
      const silent = await call('POST', '/tasks', {
        projectId: project.id,
        mode: 'chat',
        agentId: B.id,
        parentTaskId: askParent.id,
        prompt: 'HANG 自动询问静默子对话',
      })
      await waitFor(() => calls().some((c) => c.input.includes('HANG 自动询问静默子对话')), {
        label: '静默的子对话开始执行',
      })
      const asked = await waitFor(
        async () => {
          const t = await call('GET', `/tasks/${silent.id}`)
          return t.messages.find((m) => m.text.includes('【状态询问】'))
        },
        {
          label: '自动询问送达子对话',
          timeout: 20000,
          describe: async () => {
            const t = await call('GET', `/tasks/${silent.id}`)
            return {
              status: t.status,
              working: t.working,
              autoAsk: t.autoAsk,
              lastAt: t.messages.at(-1)?.at,
              threshold: (await call('GET', '/settings')).childIdleAskMinutes,
              tail: t.messages.slice(-3).map((m) => `${m.role}:${m.text.slice(0, 40)}`),
            }
          },
        },
      )
      // 以父对话的名义发起：子对话里画成「接收消息」，不是用户说的话
      assert.equal(asked.peer?.rel, 'parent', '自动询问标明是父对话发来的')
      // 用户这时发消息：走同一条非阻塞送达路径，不能被询问挡住
      let sent
      for (let i = 0; i < 40 && !sent; i++) {
        try {
          sent = await call('POST', `/tasks/${silent.id}/messages`, { text: '用户的新消息：先做这个' })
        } catch (e) {
          // 这一轮刚好在收尾：等它落盘完再发，409 的请求没有副作用
          if (!e.message.includes('409')) throw e
          await sleep(50)
        }
      }
      const mine = sent?.messages.find((m) => m.text.includes('用户的新消息'))
      assert.ok(mine, '自动询问之后用户的消息照样进了子对话')
      assert.ok(mine.delivery, `用户消息记录了送达方式（${mine.delivery?.how}）`)
      assert.notEqual(mine.delivery.how, 'lost', '用户消息不能因为自动询问丢掉')
      // 子对话回了状态询问（CLI 卡住时面板接回会话重开，询问作为这一轮的内容交给它）
      await waitFor(
        async () => {
          const t = await call('GET', `/tasks/${silent.id}`)
          return t.messages.some((m) => m.text.includes('STATUS_ASK_GOT'))
        },
        { label: '子对话回复了状态询问', timeout: 20000 },
      )
      await call('PUT', '/settings', full)
      await call('DELETE', `/tasks/${askParent.id}`)
      step('子对话长时间没有输出：自动询问送达并被回复，用户消息不被挡')
    }
  }
})
