/**
 * 界面检查分片：工作总结
 *
 * 检查左侧导航的入口、项目「下拉 + 增加 + 删除」、每个项目下对话「下拉 + 增加 + 删除」、
 * 生成报告（固定三节结构）、预览 / 编辑切换、复制按钮把 Markdown 写进剪贴板，以及窄屏下没有横向滚动。
 * 和其他分片并行跑：演示数据各自从头生成（见 harness.mjs）。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base + '#/summary')

  // 左侧导航里的入口：点进去就在这个页面
  await p
    .getByRole('button', { name: '工作总结' })
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('工作总结：左侧导航里没有入口'))
  await check(p, '工作总结-列表', ['工作总结', '项目', '生成报告'])

  // 时间范围：默认今天（和改造前一致），可以切昨天 / 近 7 天 / 自定义日期
  const range = p.getByRole('radiogroup', { name: '总结范围' })
  await range.waitFor({ timeout: 5000 }).catch(() => errors.push('工作总结：没有时间范围选择'))
  if (await range.count()) {
    const checked = async (name) => (await range.getByRole('radio', { name }).getAttribute('aria-checked')) === 'true'
    if (!(await checked('今天'))) errors.push('工作总结：默认范围不是「今天」')
    await range.getByRole('radio', { name: '近 7 天' }).click()
    await p
      .getByText('不挑就是近 7 天全部', { exact: false })
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：切到「近 7 天」后说明文字没跟着变'))
    // 自定义范围要能选起止日期
    await range.getByRole('radio', { name: '自定义' }).click()
    await p
      .getByLabel('开始日期')
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：选「自定义」后没有开始日期'))
    await p
      .getByLabel('结束日期')
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：选「自定义」后没有结束日期'))
    await range.getByRole('radio', { name: '今天' }).click()
    await p
      .getByText('不挑就是今天全部', { exact: false })
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：切回「今天」后说明文字没恢复'))
  }
  await check(p, '工作总结-范围切换')

  // 项目选择器：下拉选一个再点「增加」，下拉本身不会直接算选中
  const picker = p.getByLabel('选择要总结的项目')
  await picker.waitFor({ timeout: 5000 }).catch(() => errors.push('工作总结：没有项目下拉'))
  await p
    .getByText('还没有加入项目。选一个项目后点「增加」。')
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('工作总结：打开时没有空状态提示'))

  // 项目头部的「增加」按钮（第一个）：点一次加一个项目
  const addProject = p.getByRole('button', { name: '增加', exact: true }).first()
  await addProject.click()
  await p
    .getByText('已选 1 个')
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('工作总结：点「增加」后没有加入一个项目'))
  const removeProjects = p.getByRole('button', { name: /^删除项目/ })
  if ((await removeProjects.count()) !== 1) errors.push('工作总结：加入项目后没有对应的删除按钮')
  await check(p, '工作总结-加入项目', ['已选 1 个'])

  // 再加一个项目：多个项目能同时存在
  await addProject.click()
  await p
    .getByText('已选 2 个')
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('工作总结：加入第二个项目后已选数量没有变成 2'))

  // 切到别的页面再回来：已选的项目（顺序和名字）原样还在（页面状态存在本机，见 web/src/lib/summary-page.ts）
  const pickNames = async () =>
    p.getByRole('button', { name: /^删除项目/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  const beforeSwitch = await pickNames()
  await p.getByRole('button', { name: '计划', exact: true }).first().click()
  await p.getByRole('button', { name: '工作总结', exact: true }).first().click()
  await p
    .getByText('已选 2 个')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('工作总结：切到别的页面再回来，已选的项目没了'))
  const afterSwitch = await pickNames()
  if (afterSwitch.join('|') !== beforeSwitch.join('|'))
    errors.push(`工作总结：切页面回来后项目变了（${beforeSwitch.join('、')} → ${afterSwitch.join('、')}）`)
  await check(p, '工作总结-切页面回来')

  // 刷新（F5）后选择也还在：存到本机才成立
  await p.reload()
  await p
    .getByRole('button', { name: /^删除项目/ })
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('工作总结：刷新后已选的项目没了'))
  if ((await pickNames()).join('|') !== beforeSwitch.join('|')) errors.push('工作总结：刷新后选择的项目和刷新前不一样')
  await check(p, '工作总结-刷新后恢复')

  // 每个项目下挑对话：下拉 + 增加，加进去的能在这一项里删掉。
  // 先在两个项目里找一个今天有对话的（演示数据里商城前台今天跑过）
  const taskPicker = p.getByLabel('选择要分析的对话').first()
  await taskPicker
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('工作总结：已加入的项目下没有对话下拉（今天应当有可总结的对话）'))
  if (await taskPicker.count()) {
    // 这个是 Radix 下拉，不是原生 select：点开后在浮层里点选项，没有 <option> 可取
    await taskPicker.click()
    const option = p.getByRole('option').first()
    await option.waitFor({ timeout: 3000 }).catch(() => errors.push('工作总结：对话下拉点开后没有可选的对话'))
    if (await option.count()) {
      await option.click()
      // 对话的「增加」在项目行里，和项目头部的那个不是同一个
      await p.locator('li', { has: taskPicker }).getByRole('button', { name: '增加', exact: true }).first().click()
      const removeTasks = p.getByRole('button', { name: /^删除对话/ })
      await removeTasks
        .first()
        .waitFor({ timeout: 3000 })
        .catch(() => errors.push('工作总结：点对话的「增加」后没有出现在该项目下'))
      await check(p, '工作总结-加入对话', ['只分析已选的 1 个对话'])
      await removeTasks.first().click()
      await removeTasks
        .first()
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => errors.push('工作总结：删掉对话后它还留在该项目下'))
    }
  }

  // 删掉第二个项目：删除只影响这一项，剩下的那个继续留着
  await removeProjects.nth(1).click()
  await p
    .getByText('已选 1 个')
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('工作总结：删掉第二个项目后已选数量没有回到 1'))

  // 生成：演示后端过一会儿给出示例报告
  await p.getByRole('button', { name: '生成报告' }).first().click()
  await p
    .getByRole('button', { name: '复制' })
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => errors.push('工作总结：生成后没有出现报告（看不到复制按钮）'))
  await check(p, '工作总结-报告', ['今天的报告', '最近的报告'])
  // 报告固定三节：节名按 Markdown 标题渲染出来
  const preview = p.locator('section', { hasText: '今天的报告' }).first()
  for (const heading of ['一、需求进度', '二、用户报告的 Bug', '三、今日小结']) {
    if (!(await preview.getByText(heading, { exact: false }).count()))
      errors.push(`工作总结：报告里没有固定的二级节「${heading}」`)
  }

  // 编辑：切到编辑是 textarea，内容是 Markdown，第一行是一级标题
  await p.getByRole('radio', { name: '编辑' }).click()
  const area = p.getByLabel('报告内容')
  await area.waitFor({ timeout: 3000 }).catch(() => errors.push('工作总结：切到编辑后没有出现文本框'))
  const text = await area.inputValue().catch(() => '')
  if (!text.startsWith('# ')) errors.push(`工作总结：编辑框里不是 Markdown 报告（${text.slice(0, 30)}）`)
  for (const heading of ['## 一、需求进度', '## 二、用户报告的 Bug', '## 三、今日小结']) {
    if (!text.includes(heading)) errors.push(`工作总结：生成的报告缺少「${heading}」`)
  }
  await check(p, '工作总结-编辑')

  // 改几个字但不点保存：切到别的页面再回来，编辑 tab 和还没保存的改动都要还在
  await area.fill(text + '\n\n（还没保存的草稿）')
  await p.getByRole('button', { name: '计划', exact: true }).first().click()
  await p.getByRole('button', { name: '工作总结', exact: true }).first().click()
  const areaBack = p.getByLabel('报告内容')
  await areaBack.waitFor({ timeout: 5000 }).catch(() => errors.push('工作总结：切页面回来后没有回到编辑 tab'))
  const draftBack = await areaBack.inputValue().catch(() => '')
  if (!draftBack.includes('（还没保存的草稿）')) errors.push('工作总结：切页面回来后编辑器里还没保存的改动丢了')
  await check(p, '工作总结-草稿跨页面保留')

  // 复制：写到剪贴板，并弹出成功提示
  await p.getByRole('radio', { name: '预览' }).click()
  await p.getByRole('button', { name: '复制' }).first().click()
  await p
    .getByText('已复制报告')
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('工作总结：复制后没有成功提示'))
  const copied = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '')
  if (!copied.includes('## 三、今日小结')) errors.push(`工作总结：剪贴板里不是报告正文（${copied.slice(0, 40)}）`)
  await check(p, '工作总结-复制')

  // 对比两份：再生成一份（演示后端的第二份报告和第一份不同），勾选两份看新增 / 消失 / 状态变化
  await p.getByRole('button', { name: '生成报告' }).first().click()
  await p
    .getByRole('button', { name: '对比两份' })
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => errors.push('工作总结：没有「对比两份」入口'))
  // 等第二份报告进列表（列表按时间倒序，新的在最前）
  await p
    .locator('section', { hasText: '最近的报告' })
    .locator('li')
    .nth(1)
    .waitFor({ timeout: 20000 })
    .catch(() => errors.push('工作总结：没有生成出第二份报告，没法对比'))
  await p.getByRole('button', { name: '对比两份' }).first().click()
  const boxes = p.getByLabel('对比这份报告')
  await boxes
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('工作总结：对比模式里没有勾选框'))
  if ((await boxes.count()) < 2) errors.push('工作总结：「最近的报告」里没有两份可以对比')
  else {
    await boxes.nth(0).check()
    await boxes.nth(1).check()
    const cmp = p.locator('section', { hasText: '两份报告的对比' }).first()
    await cmp.waitFor({ timeout: 5000 }).catch(() => errors.push('工作总结：勾选两份后没有出现对比区'))
    for (const heading of ['需求进度', '用户报告的 Bug', '今日小结']) {
      if (!(await cmp.getByText(heading, { exact: true }).count())) errors.push(`工作总结：对比区里没有「${heading}」`)
    }
    // 标题实际写成「新增（1）」「已修复（消失）（1）」：按整行精确匹配，
    // 否则「已修复（消失）」会把「消失」也命中，看不出需求进度有没有真的消失项
    for (const [kind, re] of [
      ['新增', /^新增（\d+）$/],
      ['消失', /^消失（\d+）$/],
      ['状态变化', /^状态变化（\d+）$/],
      ['已修复（消失）', /^已修复（消失）（\d+）$/],
    ]) {
      if (!(await cmp.getByText(re).count())) errors.push(`工作总结：对比区里没有「${kind}」`)
    }
    await check(p, '工作总结-对比两份')
    // 取消对比：对比区收起，列表回到普通模式
    await p.getByRole('button', { name: '取消对比' }).click()
    await p
      .getByText('两份报告的对比')
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => errors.push('工作总结：取消对比后对比区还在'))
    // 再选一次，然后直接换范围：对比要跟着收起（不能还挂着上一段的两份报告，也不能留在对比模式）
    await p.getByRole('button', { name: '对比两份' }).click()
    await boxes.nth(0).check()
    await boxes.nth(1).check()
    await cmp.waitFor({ timeout: 5000 }).catch(() => errors.push('工作总结：重新勾选两份后没有出现对比区'))
    await range.getByRole('radio', { name: '近 7 天' }).click()
    await p
      .getByText('两份报告的对比')
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => errors.push('工作总结：换范围后对比区还在'))
    if (await p.getByRole('button', { name: '取消对比' }).count()) errors.push('工作总结：换范围后还留在对比模式')
    await range.getByRole('radio', { name: '今天' }).click()
  }

  // 换范围不能把上一段的报告当成这一段的：切到近 7 天后当前报告消失，旧报告还在「最近的报告」里
  await range.getByRole('radio', { name: '近 7 天' }).click()
  await p
    .locator('section', { hasText: '今天的报告' })
    .first()
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => errors.push('工作总结：切到近 7 天后仍然显示「今天的报告」'))
  await p
    .getByText('最近的报告')
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('工作总结：切范围后「最近的报告」列表没了'))
  await range.getByRole('radio', { name: '今天' }).click()
  await check(p, '工作总结-换范围不串报告')

  // 项目在别的地方被删掉：回到这一页时它从选择里消失并提示一次，不静默也不拿着错数据去生成。
  // 演示版的数据库在 localStorage 里（改完要整页导航，只改 hash 会被内存里的数据盖回去）
  await p.evaluate(() => {
    const db = JSON.parse(localStorage.getItem('agent-panel-demo-v3') || 'null')
    const state = JSON.parse(localStorage.getItem('summary-page:v1') || 'null')
    const picked = state?.picks?.[0]?.projectId
    if (!db || !picked) return
    db.projects = db.projects.filter((x) => x.id !== picked)
    localStorage.setItem('agent-panel-demo-v3', JSON.stringify(db))
  })
  await p.reload()
  await p
    .getByText('1 个项目已不存在，已从选择里移除')
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('工作总结：恢复时没有提示已不存在的项目被移除'))
  if (await p.getByRole('button', { name: /^删除项目/ }).count()) errors.push('工作总结：已经不存在的项目还留在选择里')
  await p
    .getByText('已选 0 个')
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('工作总结：移除已不存在的项目后已选数量没变'))
  await check(p, '工作总结-已删项目被过滤')

  // 手机宽度：项目列表和报告都要能正常换行
  await p.setViewportSize({ width: 480, height: 900 })
  await settle(p).catch(() => {})
  await check(p, '工作总结-手机宽度')
})
