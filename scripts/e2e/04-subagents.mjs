/**
 * 端到端测试分片：子对话生命周期、独立 worktree、计划、后台命令、项目教训
 *
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs），
 * 互不影响。总入口 scripts/e2e.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { rmSync, existsSync } from 'node:fs'

import path from 'node:path'
import { runShard } from './harness.mjs'

await runShard('子对话与计划', async (api) => {
  const { baseUrl: base, log, gitIn, call, sleep, waitFor, waitDone, waitTask, calls, readLog, step, setupBase } = api
  const { project, A, B } = await setupBase()
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
    const merged = await call('POST', `/tasks/${wtKid.id}/worktree/merge`)
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
    // 子对话做完（测试跑通）调用 submit_merge：面板直接合回父对话的分支，子对话标记完成，独立分支回收
    await waitDone(wtKid.id, 20000)
    for (const f of ['codex-output.txt', 'claude-output.txt']) rmSync(path.join(project.path, f), { force: true })
    const headBefore = gitIn(project.path, 'rev-parse', 'HEAD').toString().trim()
    const doneKid = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      parentTaskId: wtParent.id,
      prompt: 'COMMIT BEGIN_EDIT SUBMIT_MERGE 子对话做完自动合并',
    })
    // 开分支的那一轮结束后面板才在分支目录里接着做：等到合并完成，不等第一轮结束
    const closed = await waitTask(doneKid.id, (x) => x.resolved && x.worktree?.state === 'merged', 30000)
    const mergeLog = readLog(log + '.merge')
    assert.ok(mergeLog.length && !mergeLog.at(-1).got.isError, '子对话调用 submit_merge 提交了合并')
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
    step('子对话测试跑通后 submit_merge：面板合回父对话分支，子对话完成并回收独立分支')
    // 子对话请父对话决定：父对话里是一张提问卡片（带选项），用户在卡片上回答后直接交给子对话
    const askKid = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: B.id,
          parentTaskId: wtParent.id,
          prompt: 'ASK_PARENT 选一个方案',
        })
      ).id,
      20000,
    )
    let askParent = await call('GET', `/tasks/${wtParent.id}`)
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
    await call('POST', `/tasks/${wtParent.id}/child-asks/${askMsg.id}`, { answer: 'B 方案', delegate: false })
    await waitTask(askKid.id, (k) => k.messages.some((m) => m.role === 'user' && m.text.includes('用户的决定')))
    askParent = await call('GET', `/tasks/${wtParent.id}`)
    const answeredAsk = askParent.messages.find((m) => m.id === askMsg.id)
    assert.equal(answeredAsk.ask.answer, 'B 方案')
    assert.equal(answeredAsk.ask.by, 'user')
    await waitTask(askKid.id, (k) => !k.parentAsks?.length)
    assert.ok(
      askParent.inbox.some((x) => x.from === askKid.id && x.text.includes('用户已回答')) &&
        !askParent.inbox.some((x) => x.from === askKid.id && x.text.startsWith('（提问）')),
      '父对话的收件箱里换成「用户已回答」，不会再答一遍',
    )
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
      const done = await waitTask(planned.id, (k) => !!k.plans[0]?.doneAt, 30000)
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
      assert.equal(settled.jobs, undefined, '跑完以后不再列在运行中')
      assert.match(
        settled.messages.find((m) => m.panel === 'background').text,
        /重新总结整段工作/,
        '推回的结果要 AI 处理完重新总结',
      )
      await call('DELETE', `/tasks/${slow.id}`)
      step('后台命令：说完时还在跑的列在任务上，跑完推回并要求重新总结')
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
    // 对话设置：目标和规则交给子对话，子对话按指定的 CLI 跑，并发上限和停止全部子对话
    const conf = await call('PATCH', `/tasks/${ruleParent.id}`, {
      goal: '商品页支持到货通知',
      rules: [{ id: 'r1', text: '只改 src 下的文件', at: new Date().toISOString() }],
      childRun: { cli: 'codex', model: '', effort: '' },
      childLimit: 2,
    })
    assert.equal(conf.goal, '商品页支持到货通知')
    assert.equal(conf.childLimit, 2)
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
  }
})
