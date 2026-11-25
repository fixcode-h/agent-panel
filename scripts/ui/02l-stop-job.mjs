/**
 * 界面检查分片：后台命令的「终止」按钮（运行区那一行、发起它的工具行、命令行窗口）。
 *
 * 演示数据里给「购物车右上角」挂两条还在跑的后台命令（一条编译、一条测试），发起它们的 run_background 行也在对话里：
 * - 运行区那一行和工具行行尾都有终止按钮，点了马上转圈禁用（重复点不再发请求）；
 * - 终止后那一行从运行区消失，工具行不再转圈、写「用户终止」，对话里多一条推回给 Agent 的「已被用户终止」；
 * - 命令行窗口标题栏在跑的时候有终止，另一条照样能终止。
 */

import { runShard } from './harness.mjs'
import { CART_CONVERSATION, openCartTask, patchDemoOnce } from './task-page.mjs'

await runShard(import.meta.filename, async (api) => {
  const { base, check, errors, settle } = api
  const p = await openCartTask(api)
  // 挂两条在跑的命令和发起它们的那一行：在下一次导航前改演示库，再整页重开
  await patchDemoOnce(p, 'stop-job', (db) => {
    const tk = (db.tasks ?? []).find((x) => x.title.includes('购物车右上角') && !x.parentTaskId)
    if (!tk) return
    const ago = (s) => new Date(Date.now() - s * 1000).toISOString()
    db.taskJobs = {
      ...db.taskJobs,
      [tk.id]: [
        {
          id: 'b11d0001',
          name: '编译 SilverPalaceEditor',
          command: 'Build.bat SilverPalaceEditor Win64 Development',
          state: 'running',
          startedAt: ago(61),
        },
        { id: 'b11d0002', name: '单元测试', command: 'npm run test:unit', state: 'running', startedAt: ago(20) },
      ],
    }
    const tool = (id, cmd) => ({
      kind: 'other',
      name: 'mcp__panel__run_background',
      label: '',
      detail: '',
      input: cmd,
      output: `已放到后台（编号 ${id}）。跑完结果会自动推回给你，先去做不依赖它的事。`,
      ms: 90,
    })
    tk.messages.push({
      id: 'ui-stop-job-row',
      role: 'agent',
      agentId: tk.messages.find((m) => m.agentId)?.agentId ?? '',
      step: '',
      text: '编译和单测都放到后台跑了，结果回来再接着看。',
      tools: [
        tool('b11d0001', 'Build.bat SilverPalaceEditor Win64 Development'),
        tool('b11d0002', 'npm run test:unit'),
      ],
      at: new Date().toISOString(),
    })
  })
  await p.goto(base)
  await p.getByText(CART_CONVERSATION, { exact: false }).first().click()
  await p
    .locator('#follow-up')
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('终止：重开对话后没有输入框'))

  const running = p.getByRole('region', { name: '运行中' }).or(p.locator('[aria-label="运行中"]')).first()
  const stops = () => p.getByRole('button', { name: '终止后台命令', exact: true }).filter({ visible: true })
  // 运行区两行 + 工具行两行
  await stops()
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('终止：后台命令行尾没有终止按钮'))
  const before = await stops().count()
  if (before < 4) errors.push(`终止：两条后台命令应该在运行区和工具行各有一个终止按钮，只有 ${before} 个`)
  await check(p, '终止-按钮', ['编译 SilverPalaceEditor'])

  // 点运行区编译那一行的终止，并马上再点一次：第二次不能再发请求
  await p.evaluate(() => {
    const w = window
    const orig = w.fetch
    w.__stopHits = 0
    w.fetch = (...a) => {
      if (String(a[0]).includes('/jobs/') && String(a[0]).endsWith('/stop')) w.__stopHits++
      return orig(...a)
    }
  })
  const btn = running.getByRole('button', { name: '终止后台命令', exact: true }).first()
  await btn.click()
  await btn.click({ force: true, timeout: 1000 }).catch(() => {})
  await p
    .getByText('已终止后台命令「编译 SilverPalaceEditor」', { exact: false })
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('终止：点了没有提示「已终止后台命令」'))
  // 演示后端不一定走 fetch（直接调函数）：只在能数到时断言
  const hits = await p.evaluate(() => window.__stopHits)
  if (hits > 1) errors.push(`终止：连点两次发了 ${hits} 次终止请求`)
  // 运行区那一行消失；工具行不再转圈、写「用户终止」
  await p
    .waitForFunction(
      () =>
        ![...document.querySelectorAll('[aria-label="运行中"]')].some((el) =>
          el.textContent?.includes('编译 SilverPalaceEditor'),
        ),
      undefined,
      { timeout: 8000 },
    )
    .catch(() => errors.push('终止：终止后运行区那一行没有消失'))
  // 发起它的那一行（多半折在「过程」里）：接上结果、写「用户终止」，不再等结果
  const row = await p.evaluate(
    ([k]) => {
      const db = JSON.parse(localStorage.getItem(k) ?? 'null')
      const tk = db?.tasks?.find((x) => x.title.includes('购物车右上角') && !x.parentTaskId)
      const m = tk?.messages.find((x) => x.id === 'ui-stop-job-row')
      return m?.tools.map((x) => ({ detail: x.detail, out: x.output, failed: !!x.failed }))
    },
    ['agent-panel-demo-v3'],
  )
  if (!row?.[0]?.out.includes('已被用户终止') || row[0].detail !== '用户终止')
    errors.push(`终止：发起编译的那一行没有接上「已被用户终止」（${JSON.stringify(row?.[0])}）`)
  if (row?.[1]?.out.includes('已结束')) errors.push('终止：没终止的单元测试那一行也被收口了')
  // 推回给 Agent 的那一条
  const told = await p.evaluate(
    ([k]) => {
      const db = JSON.parse(localStorage.getItem(k) ?? 'null')
      const tk = db?.tasks?.find((x) => x.title.includes('购物车右上角') && !x.parentTaskId)
      return tk?.messages.some(
        (m) => m.panel === 'background' && m.text.includes('已被用户终止') && m.text.includes('不要自己重新运行'),
      )
    },
    ['agent-panel-demo-v3'],
  )
  if (!told) errors.push('终止：对话里没有推回给 Agent 的「已被用户终止」')
  const after = await stops().count()
  if (after !== before - 2) errors.push(`终止：终止后编译那两处按钮应该消失（之前 ${before} 个，现在 ${after} 个）`)
  await check(p, '终止-编译已终止')

  // 命令行窗口：点单元测试那一行的标题打开窗口，标题栏有终止；点了以后窗口里的状态变成已停止
  await running.getByText('单元测试', { exact: false }).first().click()
  const dlg = p.getByRole('dialog').last()
  await dlg.waitFor({ timeout: 5000 }).catch(() => errors.push('终止：点标题没有打开命令行窗口'))
  const dlgStop = dlg.getByRole('button', { name: '终止后台命令', exact: true })
  if (!(await dlgStop.count())) errors.push('终止：命令行窗口标题栏没有终止按钮')
  else {
    await check(p, '终止-命令行窗口')
    await dlgStop.click()
    await p
      .waitForFunction(
        () =>
          ![...document.querySelectorAll('[aria-label="运行中"]')].some((el) => el.textContent?.includes('单元测试')),
        undefined,
        { timeout: 8000 },
      )
      .catch(() => errors.push('终止：从命令行窗口终止后运行区那一行没有消失'))
    // 窗口里拉到终态后终止按钮收起
    await dlgStop
      .waitFor({ state: 'detached', timeout: 8000 })
      .catch(() => errors.push('终止：命令结束后窗口里的终止按钮还在'))
    await p.keyboard.press('Escape')
  }
  await settle(p)
  if (await stops().count()) errors.push('终止：两条都终止后还有终止按钮')
  await check(p, '终止-全部终止')
})
