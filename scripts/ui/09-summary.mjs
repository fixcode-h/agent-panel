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

  // 手机宽度：项目列表和报告都要能正常换行
  await p.setViewportSize({ width: 480, height: 900 })
  await settle(p).catch(() => {})
  await check(p, '工作总结-手机宽度')
})
