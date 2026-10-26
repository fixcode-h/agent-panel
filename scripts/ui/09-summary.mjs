/**
 * 界面检查分片：工作总结
 *
 * 检查左侧导航的入口、选项目（默认选一个、能多选）、生成报告、预览 / 编辑切换、
 * 复制按钮把 Markdown 写进剪贴板，以及窄屏下没有横向滚动。
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

  // 项目：默认选中一个，再点一个变成两个
  const boxes = p.getByRole('checkbox')
  await boxes
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('工作总结：没有列出项目'))
  if ((await boxes.count()) < 2) errors.push('工作总结：演示数据里项目少于两个，没法验证多选')
  else {
    await p
      .getByText('已选 1 个')
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：打开时没有默认选中一个项目'))
    await boxes.nth(1).click()
    await p
      .getByText('已选 2 个')
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：勾选第二个项目后已选数量没有变成 2'))
    await check(p, '工作总结-多选项目', ['已选 2 个'])
  }

  // 生成：演示后端过一会儿给出示例报告
  await p.getByRole('button', { name: '生成报告' }).first().click()
  await p
    .getByRole('button', { name: '复制' })
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => errors.push('工作总结：生成后没有出现报告（看不到复制按钮）'))
  await check(p, '工作总结-报告', ['今天的报告', '做了', '最近的报告'])
  // 报告按项目分节，能看到 Bug 的「问题在哪 + 怎么修的」
  const preview = p.locator('section', { hasText: '今天的报告' }).first()
  if (!(await preview.getByText('Bug', { exact: false }).count()))
    errors.push('工作总结：报告里没有 Bug 一条（演示报告应当带上问题在哪、怎么修的）')

  // 编辑：切到编辑是 textarea，内容是 Markdown
  await p.getByRole('radio', { name: '编辑' }).click()
  const area = p.getByLabel('报告内容')
  await area.waitFor({ timeout: 3000 }).catch(() => errors.push('工作总结：切到编辑后没有出现文本框'))
  const text = await area.inputValue().catch(() => '')
  if (!text.startsWith('## ')) errors.push(`工作总结：编辑框里不是 Markdown 报告（${text.slice(0, 30)}）`)
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
  if (!copied.includes('## ')) errors.push(`工作总结：剪贴板里不是报告正文（${copied.slice(0, 40)}）`)
  await check(p, '工作总结-复制')

  // 手机宽度：项目列表和报告都要能正常换行
  await p.setViewportSize({ width: 480, height: 900 })
  await settle(p).catch(() => {})
  await check(p, '工作总结-手机宽度')
})
