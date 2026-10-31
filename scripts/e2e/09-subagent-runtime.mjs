/**
 * 端到端测试分片：子对话运行中的事——执行计划等后台命令、后台命令推回、子对话列表口径、
 * 一次派多个子对话、全局规则与项目教训、子对话的监管（没输出、卡住、计划做一半就收尾）和续接。
 *
 * 从 04-subagents 拆出来（那一片是 e2e 墙钟最长的一片）：04 留子对话生命周期、独立 worktree、收尾合并和评审门禁，
 * 这里是项目改回默认隔离方式之后的那一半，两片互不依赖。
 * 和其他分片并行跑：每个分片自己有临时数据目录、假 CLI 日志、端口和服务（见 harness.mjs），
 * 假 CLI 写的输出文件也在各自的临时项目目录里，互不影响。总入口 scripts/e2e.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'

import { runShard } from './harness.mjs'

await runShard('子对话运行与监管', async (api) => {
  const { log, call, sleep, waitFor, waitDone, waitTask, calls, readLog, step, setupBase, agent } = api
  const { project, B } = await setupBase()
  const { id: _pid, createdAt: _c, updatedAt: _u, ...projectInput } = project
  // 按提示词找那一次调用：调用记录里这时可能已有别的调用（保活进程、父对话回报后的新一轮），
  // 也可能正写到最后半行（readLog 会丢掉半行），所以不能用 at(-1) 猜是哪一次
  const callOf = (prompt) =>
    waitFor(
      () =>
        calls()
          .filter((c) => (c.input ?? '').includes(prompt))
          .at(-1),
      {
        timeout: 15000,
        label: `提示词「${prompt}」的调用记录`,
      },
    )
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
    // 计划结束就是结束了：下一件事直接开新计划，不需要先写总结。
    // 结果刚推回时这一轮还在收尾（执行位还占着），这时发消息会 409「任务正在执行」：等一下再发
    let sent
    let lastBusy = ''
    for (let i = 0; i < 40 && !sent; i++) {
      try {
        sent = await call('POST', `/tasks/${planned.id}/messages`, { text: 'PLAN_NEXT 接着做' })
      } catch (e) {
        if (!String(e.message).includes('-> 409')) throw e
        lastBusy = String(e.message)
        // 40 × 100ms：CI 慢时 2 秒偏紧
        await sleep(100)
      }
    }
    // 等满了还是 409 时把最后一条原因带上，否则只看到「没发进去」不知道为什么
    assert.ok(sent, `这一轮收尾之后把下一条要求发进去了（最后一次：${lastBusy}）`)
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
  const kidLog = JSON.stringify(await callOf('子对话看规则'))
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
  const childRule = await call('POST', `/tasks/${ruleKid.id}/messages`, { text: '/rule 子对话不能发' }).catch((e) => e)
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
  // 只认这条消息本身那一轮：子对话做完后父对话被叫醒，汇报里会引用「用户在这个子对话里直接交代过：按设置再做一次」，
  // 按子串取最后一条时偶尔拿到的是父对话那一轮（CI 上时好时坏）
  const confLog = await callOf('## 用户这次的消息\n按设置再做一次')
  assert.equal(confLog.kind, 'codex', '子对话按父对话设置里的 CLI 执行')
  const confText = JSON.stringify(confLog)
  assert.ok(confText.includes('父对话的目标') && confText.includes('商品页支持到货通知'), '子对话看得到父对话的目标')
  assert.ok(confText.includes('只改 src 下的文件'), '设置里改的规则交给子对话')
  const back = await call('PATCH', `/tasks/${ruleParent.id}`, { childRun: null })
  assert.equal(back.childRun, undefined, '改回按角色自己的配置')
  assert.equal(typeof (await call('POST', `/tasks/${ruleParent.id}/children/stop`)).stopped, 'number')
  await call('DELETE', `/tasks/${ruleParent.id}`)
  step('全局规则：/rule 发布、列出、清空，子对话的提示里带上，子对话自己不能发；对话设置的目标、规则、子对话 CLI 生效')

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
  const lessonLog = JSON.stringify(await callOf('看看教训'))
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
  // ---- 子对话卡住：问过没回复就接回会话重启，重启也没恢复就记警告、新开子对话带上原任务接手 ----
  {
    const full = await call('GET', '/settings')
    await call('PUT', '/settings', { ...full, childIdleAskMinutes: 2 })
    const stuckParent = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: B.id,
          prompt: '卡住接手的父对话',
        })
      ).id,
      20000,
    )
    const dead = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      parentTaskId: stuckParent.id,
      prompt: 'HANG_FOREVER 一直卡死的子对话',
    })
    const kidsOf = async () => (await call('GET', `/tasks/${stuckParent.id}/children`)).filter((x) => x.id !== dead.id)
    const heir = await waitFor(async () => (await kidsOf()).find((x) => x.title.includes('（接手）')), {
      label: '重启没恢复，新开子对话接手',
      timeout: 40000,
      describe: async () => {
        const t = await call('GET', `/tasks/${dead.id}`)
        return {
          status: t.status,
          stopReason: t.stopReason,
          autoAsk: t.autoAsk,
          tail: t.messages.slice(-4).map((m) => `${m.role}:${m.text.slice(0, 50)}`),
        }
      },
    })
    // 接手的子对话先建出来，原子对话里的警告随后才写（replace 里 spawnChildOf 在 panelAlert 前）：等警告落下再断言，
    // 不然列表里刚出现「（接手）」就读，偶尔还没写到
    const old = await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${dead.id}`)
        return t.messages.some((m) => m.alert?.kind === 'no_response') ? t : undefined
      },
      { label: '原子对话里记了换人接手的警告', timeout: 10000 },
    )
    assert.equal(old.status, 'stopped', '卡住的子对话停下了')
    assert.equal(old.stopReason, 'replaced', '停下原因是换人接手，父对话继续时不会再拉起它')
    assert.ok(
      old.messages.some((m) => m.text.includes('【状态询问】')),
      '换人前先以父对话的名义问过状态',
    )
    assert.ok(
      old.messages.some((m) => m.alert?.kind === 'no_response' && m.text.includes('接手')),
      '原子对话里记了一条警告',
    )
    // 父对话的警告在原子对话那条之后才写（server/tasks/stuck-child.ts 先写子、再写父）：同样等它落下，
    // 不然拆片后这一片跑得快，读父对话时偶尔还没写到
    await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${stuckParent.id}`)
        return t.messages.some((m) => m.alert && m.text.includes('卡住了') && m.text.includes('接手'))
      },
      { label: '父对话里也记了一条警告', timeout: 10000 },
    )
    const done = await waitDone(heir.id, 20000)
    const brief = done.messages[0]
    assert.ok(brief.text.includes('【接手】'), '接手的派单说明为什么换人')
    assert.ok(brief.text.includes('HANG_FOREVER 一直卡死的子对话'), '接手的派单带上原来的任务')
    assert.equal(brief.peer?.rel, 'parent', '派单以父对话的名义交代')
    assert.equal(done.agentId, dead.agentId ?? B.id, '接手的子对话沿用原来的角色')
    await call('PUT', '/settings', full)
    await call('DELETE', `/tasks/${stuckParent.id}`)
    step('子对话卡住：问过没回复就重启，重启没恢复就警告并新开子对话接手')
  }
  // ---- 子对话计划做了一半就收尾（只回一句打算、不调工具）：面板马上推它接着做，同一进度只推一次 ----
  {
    const stallParent = await waitDone(
      (
        await call('POST', '/tasks', {
          projectId: project.id,
          mode: 'chat',
          agentId: B.id,
          prompt: '计划停住的父对话',
        })
      ).id,
      20000,
    )
    const stallKid = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      parentTaskId: stallParent.id,
      prompt: 'PLAN_STALL 计划做一半就停',
    })
    const pushes = (x) => x.messages.filter((m) => m.panel === 'build' && m.text.includes('你的计划才做了'))
    // 推送交到了 CLI：它回复里带上标记
    const pushed = await waitFor(
      async () => {
        const t = await call('GET', `/tasks/${stallKid.id}`)
        return t.messages.some((m) => m.role === 'agent' && m.text.includes('PLAN_NUDGE_GOT')) ? t : undefined
      },
      { label: '面板推子对话接着做计划，并交到了 CLI', timeout: 20000 },
    )
    assert.equal(pushes(pushed).length, 1, '计划停住时推了一次')
    // 三步计划加上面板放在最后的收尾（共用目录也要请父对话验收）一共四步
    assert.match(pushes(pushed)[0].text, /1\/4[\s\S]*「跑检查」/, '推的时候写明进度和接下来做哪一步')
    // 被推之后仍然原地不动：不再推第二次，改成照常上报父对话「未完成」
    await waitFor(
      async () => {
        const p = await call('GET', `/tasks/${stallParent.id}`)
        return p.messages.some((m) => m.child?.id === stallKid.id && m.text.includes('计划还没做完'))
      },
      { label: '推过一次仍没动：上报父对话未完成', timeout: 20000 },
    )
    assert.equal(pushes(await call('GET', `/tasks/${stallKid.id}`)).length, 1, '同一进度只推一次，不来回推')
    await call('DELETE', `/tasks/${stallParent.id}`)
    step('子对话计划做一半就收尾：面板马上推它接着做，推过仍不动就上报父对话，不来回推')
  }
  // ---- 父对话被停下后继续：一起被打断的子对话由面板连带拉起来，续接的提示写清是续接、子对话已在接着做 ----
  {
    const rp = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      prompt: 'SLOW 父对话中断后继续',
    })
    await waitFor(() => calls().some((c) => c.input.includes('SLOW 父对话中断后继续')), { label: '父对话开始执行' })
    const rk = await call('POST', '/tasks', {
      projectId: project.id,
      mode: 'chat',
      agentId: B.id,
      parentTaskId: rp.id,
      prompt: 'SLOW 被连带中断的子对话',
    })
    await waitFor(() => calls().some((c) => c.input.includes('SLOW 被连带中断的子对话')), { label: '子对话开始执行' })
    await call('POST', `/tasks/${rp.id}/stop`)
    await waitFor(
      async () => {
        const k = await call('GET', `/tasks/${rk.id}`)
        return k.status === 'stopped' && k.stopReason === 'parent'
      },
      { label: '子对话随父对话一起停下', timeout: 20000 },
    )
    await waitFor(async () => (await call('GET', `/tasks/${rp.id}`)).status === 'stopped', {
      label: '父对话停下',
      timeout: 20000,
    })
    const before = calls().length
    await call('POST', `/tasks/${rp.id}/resume`, {})
    const kidCall = await waitFor(
      () =>
        calls()
          .slice(before)
          .find((c) => c.input.includes('被连带中断的子对话') && c.input.includes('面板说明：上一轮')),
      { label: '子对话被连带拉起来、续接提示写清是续接', timeout: 20000 },
    )
    assert.ok(kidCall, '父对话继续时，一起被打断的子对话接着做')
    const parentCall = await waitFor(
      () =>
        calls()
          .slice(before)
          .find((c) => c.input.includes('父对话中断后继续') && c.input.includes('一起中断的子对话已经由面板拉起来')),
      { label: '父对话的续接提示点名已经拉起来的子对话', timeout: 20000 },
    )
    assert.match(parentCall.input, /被连带中断的子对话/, '续接提示写明拉起来的是哪个子对话')
    await call('POST', `/tasks/${rp.id}/stop`).catch(() => {})
    await call('POST', `/tasks/${rk.id}/stop`).catch(() => {})
    await call('DELETE', `/tasks/${rp.id}`)
    step('父对话被停下后继续：一起被打断的子对话由面板连带拉起来，续接提示写清是续接')
  }
})
