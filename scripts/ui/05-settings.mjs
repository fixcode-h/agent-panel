/**
 * 界面检查分片：设置：常规、全局教训、字体、风格库、数据和内存曲线、用量统计；英文界面
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await p.getByRole('button', { name: '设置' }).first().click()
  // 默认项断言当前真正默认的那一个（不写成「或」，默认再变时要红）：演示后端固定返回 win32 和
  // gitbash → wsl → powershell → cmd 的顺序，recommendedShell() 选 Git Bash，与跑检查的机器无关
  await check(p, '设置', ['常规', '内容宽度', '命令行环境', 'Git Bash（默认）'])
  await p.getByRole('button', { name: '全局教训', exact: true }).click()
  await check(p, '设置-全局教训', ['改了提示词或界面文案', '加一条'])
  await p.getByRole('button', { name: '字体', exact: true }).click()
  await check(p, '设置-字体', ['Maple Mono NL', '字间距', '空格宽度'])
  await p.getByRole('button', { name: '风格库' }).click()
  await check(p, '设置-风格库', ['暗黑奇幻'])
  // 内存曲线：两路数据、采样间隔、AI 分析入口都在；右键往右拖能看更早的采样，再点回最新
  await p.getByRole('button', { name: '数据', exact: true }).click()
  await check(p, '设置-数据', ['内存', 'AI 分析', '每 30 秒采样一次', '最近一次采样'])
  const chart = p.getByRole('img', { name: '面板进程和子进程的内存曲线' })
  await chart.scrollIntoViewIfNeeded()
  const box = await chart.boundingBox()
  // 往右拖 = 想看更早（shared/memory.ts 的 panEndMs）：往左拖会被夹回最新，"回到最新" 就不该出现，先把这条钉住
  if (await p.getByRole('button', { name: '回到最新' }).count()) errors.push('设置-数据：还没拖动就出现了「回到最新」')
  await p.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2)
  await p.mouse.down({ button: 'right' })
  await p.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 8 })
  await p.mouse.up({ button: 'right' })
  await check(p, '设置-数据-拖动', ['回到最新'])
  await p.getByRole('button', { name: '回到最新' }).click()
  await p
    .getByRole('button', { name: '回到最新' })
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => {})
  if (await p.getByRole('button', { name: '回到最新' }).count()) errors.push('设置-数据：点了「回到最新」按钮还留着')

  // 用量统计：按天 / 按周 / 按月只显示当前一个区间，日历能选日期、有数据的日子带标记，
  // 费用列按计价模型折算，分时段定价的模型还能看到峰谷明细
  await p.getByRole('button', { name: '用量统计', exact: true }).click()
  await check(p, '设置-用量统计-按天', ['用量统计', '费用', '合计'])
  // 打开时焦点落在粒度选择器上，方向键直接能切
  if ((await p.evaluate(() => document.activeElement?.getAttribute('role'))) !== 'tab')
    errors.push('用量统计：打开时焦点没落在区段选择器上')
  // 计价模型是下拉框的 aria-label，页面上显示的是选中的模型名，所以按 role 查而不是按文本
  if (!(await p.getByRole('combobox', { name: '计价模型' }).count())) errors.push('用量统计：没有计价模型选择器')
  const usageRows = () => p.locator('section[aria-label="用量统计"] table tbody tr')
  const dayRows = await usageRows().count()
  if (dayRows > 1) errors.push(`用量统计：按天视图应该只显示一个区间，现在有 ${dayRows} 行`)
  if (!(await p.locator('[data-usage-tiers]').count())) errors.push('用量统计：分时段定价的模型没有显示峰谷明细')
  // 日历：能打开、有数据的日子有标记、能翻月
  await p.locator('[data-usage-period-trigger]').click()
  await p
    .locator('[data-usage-calendar]')
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('用量统计：点区间标签没有打开日历'))
  const markedDays = await p.locator('[data-usage-calendar] button[aria-label*="有数据"]').count()
  if (!markedDays) errors.push('用量统计：日历上没有标出有数据的日子')
  if (!(await p.getByLabel('上个月').count())) errors.push('用量统计：日历没有翻月按钮')
  await check(p, '设置-用量统计-日历')
  await p.keyboard.press('Escape')
  // 点一个有数据的历史日子：表格切到那一天
  await p.locator('[data-usage-period-trigger]').click()
  await p.locator('[data-usage-calendar]').waitFor({ timeout: 5000 })
  await p.locator('[data-usage-calendar] button[aria-label*="有数据"]').first().click()
  await check(p, '设置-用量统计-选中某天', ['合计', '费用'])
  const usageRange = () => p.locator('[data-usage-period-trigger]').innerText()
  /** 按了快捷键以后等区间标签变成想要的样子（最多 2 秒），再交给下面的断言判断 */
  const rangeBecomes = async (ok) => {
    for (let i = 0; i < 40 && !ok(await usageRange()); i++) await p.waitForTimeout(50)
  }
  const usageBody = await p.locator('section[aria-label="用量统计"]').innerText()
  if (!/\d+\.\d+M|\d+\.\d+K/.test(usageBody)) errors.push('用量统计：token 没有用 K/M 显示')
  // 快捷键：T 回到今天，[ ] 前后翻区间
  const pickedRange = await usageRange()
  await p.keyboard.press('t')
  await rangeBecomes((r) => r !== pickedRange)
  const todayRange = await usageRange()
  await p.keyboard.press('[')
  await rangeBecomes((r) => r !== todayRange)
  if ((await usageRange()) === todayRange) errors.push('用量统计：按 [ 没有切到上一个区间')
  await p.keyboard.press(']')
  await rangeBecomes((r) => r === todayRange)
  if ((await usageRange()) !== todayRange) errors.push('用量统计：按 ] 没有回到下一个区间')
  // Esc 只关日历，不关设置
  await p.locator('[data-usage-period-trigger]').click()
  await p.locator('[data-usage-calendar]').waitFor({ timeout: 5000 })
  await p.keyboard.press('Escape')
  await p
    .locator('[data-usage-calendar]')
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => {})
  if (await p.locator('[data-usage-calendar]').count()) errors.push('用量统计：Esc 没有关掉日历')
  if (!(await p.getByRole('dialog').isVisible())) errors.push('用量统计：Esc 把设置也关掉了')
  // 周 / 月：同样只显示一个区间，标签跟着粒度变
  await p.getByRole('tab', { name: '按周', exact: true }).click()
  await rangeBecomes((r) => /第 \d+ 周/.test(r))
  const weekLabel = await p.locator('[data-usage-period-trigger]').innerText()
  if (!/第 \d+ 周/.test(weekLabel)) errors.push(`用量统计：按周的标签不是一周（${weekLabel}）`)
  if ((await usageRows().count()) > 7) errors.push('用量统计：按周视图超过了一周的天数')
  await check(p, '设置-用量统计-按周')
  await p.getByRole('tab', { name: '按月', exact: true }).click()
  await rangeBecomes((r) => /\d{4}年\d+月/.test(r))
  const monthLabel = await p.locator('[data-usage-period-trigger]').innerText()
  if (!/\d{4}年\d+月/.test(monthLabel)) errors.push(`用量统计：按月的标签不是一个月（${monthLabel}）`)
  await check(p, '设置-用量统计-按月')
  // 换计价模型：合计和峰谷明细跟着换，单价表按新模型走
  await p.getByRole('combobox', { name: '计价模型' }).click()
  await p.getByRole('option', { name: 'DeepSeek V4 Pro' }).click()
  await check(p, '设置-用量统计-计价模型', ['DeepSeek V4 Pro'])
  // 下拉框要能完整显示模型名：截断成「DeepSeek V4 P…」也算没排整齐
  const clipped = await p
    .getByRole('combobox', { name: '计价模型' })
    .evaluate((el) => el.scrollWidth > el.clientWidth + 1)
  if (clipped) errors.push('用量统计：计价模型下拉的文字被截断了')
  if (!(await p.locator('[data-usage-tiers]').count())) errors.push('用量统计：换计价模型后峰谷明细没了')
  // 换回默认模型，后面的检查不受影响
  await p.getByRole('combobox', { name: '计价模型' }).click()
  await p.getByRole('option', { name: 'DeepSeek Flash' }).click()
  await settle(p)
  await p.keyboard.press('Escape')
  // 英文界面的截图和以前一样放在浅色主题下看
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
  // 英文界面：切到 English 后对话页的执行中提示和按钮都正常，没有 Queue
  await p.goto(base)
  await p.getByRole('button', { name: '设置', exact: true }).first().click()
  const lang = p.getByRole('combobox', { name: '语言' })
  await lang.waitFor({ timeout: 5000 }).catch(() => {})
  if (await lang.count()) {
    // 下拉是把选项渲染在弹层里的自定义列表，不是原生 select
    await lang.click()
    // 切换语言后页面会重新加载：等加载完再往下走
    const reloaded = p.waitForEvent('load', { timeout: 5000 }).catch(() => {})
    await p
      .getByRole('option', { name: /English/ })
      .first()
      .click()
    await reloaded
    await p.goto(base + '#/chat')
    await p.locator('#task-prompt').waitFor({ timeout: 10000 })
    await settle(p)
    await p.locator('#task-prompt').fill('Check the module layout')
    await p.waitForTimeout(300)
    await p.locator('#task-prompt').press('Enter')
    await p
      .locator('#follow-up')
      .waitFor({ timeout: 20000 })
      .catch(() => errors.push('英文界面：没有打开对话页'))
    await p.locator('#follow-up').fill('Also check the test setup')
    await p.waitForTimeout(300)
    await p.locator('#follow-up').press('Enter')
    // 发送成功时输入框会被清空；没清空说明没送出去（英文界面里按钮旁边容易看不出状态）
    let cleared = false
    for (let i = 0; i < 30 && !cleared; i++) {
      cleared = (await p.locator('#follow-up').innerText()).trim() === ''
      if (!cleared) await p.waitForTimeout(150)
    }
    if (!cleared) errors.push('英文界面：执行中的消息没有发出去（输入框没清空）')
    await p
      .getByText('Also check the test setup', { exact: false })
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('英文界面：执行中发的消息没有立刻出现'))
    if (await p.getByText('Queue', { exact: false }).count()) errors.push('英文界面：还能看到 Queue')
    await check(p, '英文-执行中发消息')
    // 英文的文件面板：搜索框、计数文案都换成英文
    await p.goto(base)
    await p.locator('[data-sidebar]').getByText('商城前台').first().click()
    await p.getByRole('button', { name: 'Show files', exact: true }).first().click()
    await p
      .getByText('files read', { exact: false })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => {})
    if (!(await p.getByPlaceholder('Find file').count())) errors.push('英文界面：文件面板的搜索框没有换成 Find file')
    if (!(await p.getByText('files read', { exact: false }).count())) errors.push('英文界面：文件面板的计数还是中文')
    const enPanel = p.locator('aside').filter({ has: p.getByPlaceholder('Find file') })
    await enPanel.locator('button[title="src"]').first().click()
    await enPanel
      .locator('button[title="src/App.tsx"]')
      .waitFor({ timeout: 8000 })
      .catch(() => {})
    await check(p, '文件面板-英文', ['files read'])
  } else errors.push('英文界面：设置里没有语言选择')
})
