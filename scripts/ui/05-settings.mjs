/**
 * 界面检查分片：设置：常规、全局教训、字体、Markdown 样式、风格库、数据和内存曲线、用量统计；英文界面
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import { runShard, stickyLeakProblems } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await p.getByRole('button', { name: '设置' }).first().click()
  // 默认项断言当前真正默认的那一个（不写成「或」，默认再变时要红）：演示后端固定返回 win32 和
  // gitbash → wsl → powershell → cmd 的顺序，recommendedShell() 选 Git Bash，与跑检查的机器无关
  await check(p, '设置', ['常规', '内容宽度', '命令行环境', 'Git Bash（默认）', '子对话没有输出时自动询问'])
  if (!(await p.getByLabel('子对话没有输出时自动询问（分钟）').count())) errors.push('设置：没有子对话自动询问的输入框')
  // 窗口矮到左栏要滚动时：吸顶的「设置」标题上方不能露出滚过去的分类（以前漏出半行「快捷键」）
  await p.setViewportSize({ width: 1440, height: 560 })
  errors.push(...(await stickyLeakProblems(p, '设置-矮窗口')))
  await p.setViewportSize({ width: 1440, height: 900 })
  // 「子对话默认也提问」：和「新会话默认开启提问」同一组，默认开着；改了之后新建的父对话右键菜单跟着变
  {
    const childAsk = p.getByRole('switch', { name: '子对话默认也提问' })
    if (!(await childAsk.count())) errors.push('设置：没有「子对话默认也提问」这一项')
    else if ((await childAsk.getAttribute('aria-checked')) !== 'true')
      errors.push('设置：「子对话默认也提问」默认应该是打开的')
    // 新开一个页面改设置再新建父对话：设置存在这个页面的演示数据里，和在另一个页面改的不通
    const d = await page({ width: 1440, height: 900 })
    await d.goto(base)
    await d.getByRole('button', { name: '设置' }).first().click()
    const newAsk = d.getByRole('switch', { name: '新会话默认开启提问' })
    await newAsk.waitFor({ timeout: 10000 }).catch(() => errors.push('设置：新页面里没有「新会话默认开启提问」'))
    if ((await newAsk.getAttribute('aria-checked')) !== 'true') await newAsk.click()
    const dChildAsk = d.getByRole('switch', { name: '子对话默认也提问' })
    await dChildAsk.waitFor({ timeout: 5000 }).catch(() => errors.push('设置：新页面里没有「子对话默认也提问」'))
    if ((await dChildAsk.getAttribute('aria-checked')) !== 'true')
      errors.push('设置：「子对话默认也提问」默认应该是打开的')
    await dChildAsk.click()
    await d
      .waitForFunction(() => localStorage.getItem('ask-user-child-default') === '0', undefined, { timeout: 5000 })
      .catch(() => errors.push('设置：「子对话默认也提问」改了之后没有同步到新会话读的缓存'))
    await check(d, '设置-子对话默认也提问')
    // 设置是 dialog：hash 导航不会关掉它，留着会用自己的焦点陷阱抢走输入框焦点，Enter 发不出去
    await d.keyboard.press('Escape')
    await d
      .getByRole('dialog')
      .first()
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => errors.push('设置：Esc 没有关掉设置弹窗'))
    await d.goto(base + '#/chat')
    await d
      .locator('#task-prompt')
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('设置：回到新聊天页后没有输入框'))
    await settle(d)
    await d.locator('#task-prompt').fill('验证子对话提问的默认值')
    await d.locator('#task-prompt').press('Enter')
    await d
      .locator('#task-prompt')
      .waitFor({ state: 'detached', timeout: 20000 })
      .catch(() => errors.push('设置：新建对话后没有打开任务页'))
    const ask = d.getByRole('button', { name: 'AI 有问题时问我' }).first()
    await ask.waitFor({ timeout: 10000 }).catch(() => errors.push('设置：新建的父对话里没有提问按钮'))
    if ((await ask.getAttribute('aria-pressed')) !== 'true')
      errors.push('设置：新会话的提问应该开着（这条用例的前提），实际没开')
    await ask.click({ button: 'right' })
    const item = d.getByRole('menuitemcheckbox', { name: '子对话也提问' })
    await item.waitFor({ timeout: 5000 }).catch(() => errors.push('设置：新建的父对话右键没有「子对话也提问」'))
    if ((await item.getAttribute('aria-checked')) !== 'false')
      errors.push('设置：关掉「子对话默认也提问」后，新建父对话的右键菜单应该默认不勾选')
    await check(d, '设置-新父对话的子对话默认')
    await d.close()
  }
  // 设置搜索：Ctrl+F 聚焦，跨页搜到别的页的项；回车跳过去并定位到那一行；Esc 先清空搜索、不关弹窗
  {
    await p.keyboard.press('Control+f')
    const box = p.getByRole('textbox', { name: '搜索设置' })
    if (!(await box.evaluate((el) => el === document.activeElement))) errors.push('设置搜索：Ctrl+F 没有聚焦搜索框')
    await box.fill('保活 分钟')
    await check(p, '设置-搜索', ['搜索设置', '离开对话后保留多久', '没看过的回复保留多久'])
    await box.fill('额外参数')
    await p.getByRole('option', { name: /额外参数/ }).waitFor({ timeout: 5000 })
    await box.press('Enter')
    await p
      .locator('[data-setting="额外参数"][data-setting-flash]')
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('设置搜索：回车后没有跳到「额外参数」那一行'))
    await box.fill('zzzz')
    await check(p, '设置-搜索-没有结果', ['没有找到「zzzz」相关的设置'])
    await box.press('Escape')
    if ((await box.inputValue()) !== '') errors.push('设置搜索：Esc 没有清空搜索框')
    if (!(await p.getByRole('dialog').count())) errors.push('设置搜索：搜索框里按 Esc 不该关掉设置弹窗')
  }
  await p.getByRole('button', { name: '全局教训', exact: true }).click()
  await check(p, '设置-全局教训', ['改了提示词或界面文案', '加一条'])
  await p.getByRole('button', { name: '外观', exact: true }).click()
  await check(p, '设置-外观', ['配色', 'Claude Code（默认）', 'Claude', '中性', 'Maple Mono NL', '字间距', '空格宽度'])
  // 换配色：html 上挂 data-palette，主按钮颜色跟着变；默认的「Claude Code」挂 code，只有「Claude」配色不挂属性
  await p.getByRole('radio', { name: '中性' }).click()
  if ((await p.evaluate(() => document.documentElement.dataset.palette)) !== 'neutral')
    errors.push('设置-外观：选「中性」后 html 上应该挂 data-palette="neutral"')
  await check(p, '设置-外观-中性配色')
  await p.getByRole('radio', { name: 'Claude', exact: true }).click()
  if ((await p.evaluate(() => document.documentElement.dataset.palette)) !== undefined)
    errors.push('设置-外观：选「Claude」配色后 html 上不应该再有 data-palette')
  await p.getByRole('radio', { name: 'Claude Code（默认）' }).click()
  if ((await p.evaluate(() => document.documentElement.dataset.palette)) !== 'code')
    errors.push('设置-外观：换回默认的「Claude Code」配色后 html 上应该挂 data-palette="code"')
  // Markdown 样式：顶部预览是真的 Markdown 组件；改一项立刻写进 #md-style，恢复默认后清空
  await p.getByRole('button', { name: 'Markdown 样式', exact: true }).click()
  await check(p, '设置-Markdown样式', ['H1 标题', '表格斑马纹', '代码块自动换行', '标题字号'])
  await p.getByRole('switch', { name: '表格斑马纹' }).click()
  if (!(await p.evaluate(() => document.getElementById('md-style')?.textContent ?? '')).includes('--md-table-zebra'))
    errors.push('设置-Markdown样式：打开斑马纹后 #md-style 里应该有 --md-table-zebra')
  await check(p, '设置-Markdown样式-斑马纹')
  await p.getByRole('button', { name: '全部恢复默认' }).click()
  await p.getByRole('dialog').getByRole('button', { name: '恢复默认', exact: true }).click()
  if (await p.evaluate(() => document.getElementById('md-style')?.textContent))
    errors.push('设置-Markdown样式：全部恢复默认后 #md-style 应该是空的')
  // 组件页：通用部件都画出来；页签可以关掉、关掉后回到第一个
  await p.getByRole('button', { name: '组件', exact: true }).click()
  await check(p, '设置-组件', ['StatusPill', 'TabBar · TabItem', 'RowShell', 'InlineChip', 'ReplyHeader'])
  const sample = p.getByRole('tablist', { name: '示例页签' })
  await sample.getByRole('tab', { name: /代码审查/ }).click()
  await sample.getByRole('button', { name: '关闭页签' }).first().click()
  if ((await sample.getByRole('tab').count()) !== 2) errors.push('设置-组件：关掉示例页签后应该剩 2 个页签')
  // 第二批通用部件：样例都在；图标开关用 aria-pressed 报状态，多选小块点一下要翻转
  await check(p, '设置-组件-新部件', ['IconButton', 'ChipGroup', 'Progress', 'Sheet', 'Canvas · on-canvas'])
  {
    const wrap = p.getByRole('button', { name: '自动换行' })
    await wrap.click()
    if ((await wrap.getAttribute('aria-pressed')) !== 'true')
      errors.push('设置-组件：点「自动换行」图标开关后应该是按下状态')
    const tue = p.getByRole('group', { name: '示例多选小块' }).getByRole('button', { name: '周二' })
    await tue.click()
    if ((await tue.getAttribute('aria-pressed')) !== 'true') errors.push('设置-组件：多选小块点「周二」后应该选中')
  }
  // 微调：总结卡默认直角；按钮的「微调」改字重立刻写进 #md-style，恢复本组后清空
  {
    const radius = await p
      .locator('.md-card')
      .first()
      .evaluate((el) => getComputedStyle(el).borderTopLeftRadius)
    if (radius !== '0px') errors.push(`设置-组件：总结卡默认应该是直角，实际圆角 ${radius}`)
    await p.getByRole('button', { name: '微调', exact: true }).first().click()
    await p.getByRole('radio', { name: '半粗' }).first().click()
    if (
      !(await p.evaluate(() => document.getElementById('md-style')?.textContent ?? '')).includes(
        '--c-button-weight:600',
      )
    )
      errors.push('设置-组件：按钮字重改成半粗后 #md-style 里应该有 --c-button-weight:600')
    await check(p, '设置-组件-微调', ['圆角', '字重', '恢复本组'])
    await p.getByRole('button', { name: '恢复本组' }).first().click()
    if (await p.evaluate(() => document.getElementById('md-style')?.textContent))
      errors.push('设置-组件：恢复本组后 #md-style 应该是空的')
  }
  await p.getByRole('button', { name: '风格库' }).click()
  await check(p, '设置-风格库', ['暗黑奇幻'])
  // 内存曲线：两路数据、采样间隔、AI 分析入口都在；右键往右拖能看更早的采样，再点回最新
  await p.getByRole('button', { name: '数据', exact: true }).click()
  await check(p, '设置-数据', ['内存', 'AI 分析', '每 30 秒采样一次', '最近一次采样'])
  // 清理：对话工作目录（回收站的那行不能清）、失效的独立分支、构建产物
  await check(p, '设置-数据-清理', [
    '对话工作目录',
    '共 316.0 MB',
    '抓网页快照',
    '占用较大',
    '调研过的一个旧对话',
    '回收站',
    // 记录已删、目录还在的孤儿目录：不列出来就永远清不掉
    '对话记录已删除',
    '已删除的对话',
    '独立分支',
    '清理失效的目录',
    '构建产物',
    '清理构建产物',
  ])
  const bigRow = p.getByText('抓网页快照').locator('xpath=..')
  if (
    await bigRow
      .getByRole('button', { name: '清理' })
      .isDisabled()
      .catch(() => true)
  )
    errors.push('设置-数据-清理：正常对话的工作目录应该能清理')
  // 回收站里的对话恢复后还要用这个目录，按钮要禁用（不只是不显示）
  const trashRow = p.getByText('调研过的一个旧对话').locator('xpath=..')
  if (
    !(await trashRow
      .getByRole('button', { name: '清理' })
      .isDisabled()
      .catch(() => false))
  )
    errors.push('设置-数据-清理：回收站里的对话不能清工作目录，按钮应该禁用')
  // 独立分支要手动点「检查占用」才开始扫（四 GB，不跟设置页每次打开一起算）
  if (!(await p.getByRole('button', { name: '检查占用' }).count()))
    errors.push('设置-数据-清理：独立分支没有「检查占用」入口')
  await p.getByRole('button', { name: '检查占用' }).click()
  await check(p, '设置-数据-清理-检查后', ['worktrees/agent-panel/demo-1', '可释放 210.0 MB'])
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
  // 已经在今天（当前区间）时不应该出现重置按钮
  const resetBtn = p.getByRole('button', { name: '重置', exact: true })
  if (await resetBtn.count()) errors.push('用量统计：已经在今天时还有重置按钮')
  await p.keyboard.press('[')
  await rangeBecomes((r) => r !== todayRange)
  if ((await usageRange()) === todayRange) errors.push('用量统计：按 [ 没有切到上一个区间')
  // 手动翻了区间：出现重置按钮，点它回到今天，按钮跟着消失
  if (!(await resetBtn.count())) errors.push('用量统计：翻到别的区间后没有出现重置按钮')
  else {
    await check(p, '设置-用量统计-重置按钮')
    await resetBtn.click()
    await rangeBecomes((r) => r === todayRange)
    if ((await usageRange()) !== todayRange) errors.push('用量统计：点重置没回到今天')
    if (await resetBtn.count()) errors.push('用量统计：点重置回到今天后重置按钮还留着')
  }
  await p.keyboard.press('[')
  await rangeBecomes((r) => r !== todayRange)
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
  // 周 / 月：同样只显示一个区间，标签跟着粒度变；切粒度直接落在当前区间
  const nowDate = new Date()
  // 本周从周一起算，和 shared/usage.ts 的 periodStart 一致
  const monday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - ((nowDate.getDay() + 6) % 7))
  const monthDay = (d) => `${d.getMonth() + 1}月${d.getDate()}日`
  await p.getByRole('tab', { name: '按周', exact: true }).click()
  await rangeBecomes((r) => /第 \d+ 周/.test(r))
  const weekLabel = await p.locator('[data-usage-period-trigger]').innerText()
  if (!/第 \d+ 周/.test(weekLabel)) errors.push(`用量统计：按周的标签不是一周（${weekLabel}）`)
  if (!weekLabel.includes(monthDay(monday))) errors.push(`用量统计：切到按周没有落到本周（${weekLabel}）`)
  if (await resetBtn.count()) errors.push('用量统计：切到本周后还有重置按钮')
  if ((await usageRows().count()) > 7) errors.push('用量统计：按周视图超过了一周的天数')
  await check(p, '设置-用量统计-按周')
  await p.getByRole('tab', { name: '按月', exact: true }).click()
  await rangeBecomes((r) => /\d{4}年\d+月/.test(r))
  const monthLabel = await p.locator('[data-usage-period-trigger]').innerText()
  if (!/\d{4}年\d+月/.test(monthLabel)) errors.push(`用量统计：按月的标签不是一个月（${monthLabel}）`)
  if (!monthLabel.includes(`${nowDate.getFullYear()}年${nowDate.getMonth() + 1}月`))
    errors.push(`用量统计：切到按月没有落到本月（${monthLabel}）`)
  if (await resetBtn.count()) errors.push('用量统计：切到本月后还有重置按钮')
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
  // 分组：按项目 / 按对话，表格列跟着变、合计仍在，时间区间选择器隐藏
  const groupSwitch = p.getByRole('radiogroup', { name: '分组' })
  await groupSwitch.waitFor({ timeout: 3000 }).catch(() => errors.push('用量统计：没有分组切换'))
  const usageTable = p.locator('section[aria-label="用量统计"] table')
  const waitUsageRows = async () => {
    for (let i = 0; i < 60 && (await usageTable.locator('tbody tr').count()) === 0; i++) await p.waitForTimeout(100)
  }
  if (await groupSwitch.count()) {
    await groupSwitch.getByRole('radio', { name: '按项目' }).click()
    await waitUsageRows()
    if (await p.locator('[data-usage-period-trigger]').count())
      errors.push('用量统计：按项目分组时还显示时间区间选择器')
    const projectHead = await usageTable
      .locator('thead')
      .innerText()
      .catch(() => '')
    if (!projectHead.includes('项目')) errors.push(`用量统计：按项目分组的表头不是项目（${projectHead.slice(0, 40)}）`)
    if (projectHead.includes('时间')) errors.push('用量统计：按项目分组时还有时间列')
    if ((await usageTable.locator('tbody tr').count()) === 0) errors.push('用量统计：按项目分组没有行')
    await check(p, '设置-用量统计-按项目', ['合计', '费用', '按项目'])

    await groupSwitch.getByRole('radio', { name: '按对话' }).click()
    await waitUsageRows()
    const taskHead = await usageTable
      .locator('thead')
      .innerText()
      .catch(() => '')
    if (!taskHead.includes('对话')) errors.push(`用量统计：按对话分组的表头不是对话（${taskHead.slice(0, 40)}）`)
    if ((await usageTable.locator('tbody tr').count()) === 0) errors.push('用量统计：按对话分组没有行')
    await check(p, '设置-用量统计-按对话', ['合计', '费用', '按对话'])

    // 切回按时间：粒度选择器和区间选择器都回来，落到当前区间
    await groupSwitch.getByRole('radio', { name: '按时间' }).click()
    await p
      .getByRole('tab', { name: '按天', exact: true })
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('用量统计：切回按时间后没有粒度选择器'))
    await p
      .locator('[data-usage-period-trigger]')
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('用量统计：切回按时间后没有时间区间'))
  }
  await settle(p)
  await p.keyboard.press('Escape')
  // 分片前面几步里 Esc 先关的是刚用过的浮层（下拉、日历），设置弹窗不一定跟着关：显式点关闭，
  // 否则遮罩盖着侧栏，下面的点击会一直等
  const settingsDialog = p.getByRole('dialog')
  const closeSettings = async () => {
    if (!(await settingsDialog.count())) return
    await settingsDialog.getByRole('button', { name: /^关闭/ }).click()
    await settingsDialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  await closeSettings()
  // 部署提醒点：演示后端用 localStorage 的 demo-deploy-outdated 造「部署那份和自带的不同」（见 demo-deploy.ts）。
  // 有差异时图标栏「设置」和设置里的「Agent」「部署」都要亮点，重新部署后三处一起消失。
  // 提示数据（skill-updates）只在本窗口获得焦点时重读；不重载页面——设置弹窗的状态会被重载保留，重载后侧栏被盖住
  const settingsRow = () => p.locator('nav[aria-label="功能栏"]').getByRole('button', { name: '设置', exact: true })
  // 提示挂在按钮的 aria-describedby 上：放进按钮里会被算进可访问名称，按名字找「设置」就找不到了
  const hintOf = (loc) =>
    loc.evaluateAll((els) => {
      const el = els[0]
      if (!el) return ''
      const id = el.getAttribute('aria-describedby')
      return id ? (document.getElementById(id)?.textContent ?? '').trim() : ''
    })
  const waitHint = async (loc, expected) => {
    for (let i = 0; i < 80; i++) {
      if ((await hintOf(loc)) === expected) return true
      await p.waitForTimeout(100)
    }
    return false
  }
  const deployHint = '1 项部署内容有更新，需要重新部署'
  const setOutdated = (value) =>
    p.evaluate((v) => {
      if (v) localStorage.setItem('demo-deploy-outdated', v)
      else localStorage.removeItem('demo-deploy-outdated')
      window.dispatchEvent(new Event('focus'))
    }, value)
  await settingsRow().waitFor({ timeout: 8000 })
  await setOutdated('grilling')
  // 点的提示不能把按钮的名字挤掉：按「设置」还能找到它
  if ((await p.getByRole('button', { name: '设置', exact: true }).count()) !== 1)
    errors.push('部署提醒点：有差异时「设置」按钮的名字变了')
  if (!(await waitHint(settingsRow(), deployHint)))
    errors.push(`部署提醒点：侧栏「设置」上没有提示（${await hintOf(settingsRow())}）`)
  await settingsRow().click()
  const agentItem = p.getByRole('button', { name: 'Agent', exact: true })
  await agentItem.click()
  const deployItem = p.locator('nav[aria-label="Agent"]').getByRole('button', { name: '部署', exact: true })
  await deployItem.waitFor({ timeout: 5000 })
  if ((await hintOf(agentItem)) !== deployHint) errors.push('部署提醒点：设置里「Agent」项上没有提示')
  if ((await hintOf(deployItem)) !== deployHint) errors.push('部署提醒点：设置里「部署」项上没有提示')
  // 进去能看到具体哪一项要更新
  await deployItem.click()
  await p
    .getByText('和自带的不同，可更新')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('部署提醒点：部署页没有标出哪一项和自带的不同'))
  // 重新部署后三处同时消失（数据刷新后自然消失，不是本地记住一个点）
  await p.getByRole('switch', { name: 'grilling' }).click()
  await p.getByRole('button', { name: '部署', exact: true }).last().click()
  if (!(await waitHint(deployItem, ''))) errors.push('部署提醒点：重新部署后「部署」项上的提示还在')
  await check(p, '设置-部署-重新部署后提示点消失')
  await closeSettings()
  await settingsRow().waitFor({ timeout: 8000 })
  // 侧栏在设置弹窗开着时查不到（量弹窗盖住），关掉再看
  if (!(await waitHint(settingsRow(), ''))) errors.push('部署提醒点：重新部署后侧栏「设置」上的提示还在')
  // 浅色下也要能看清：同一套点样式，再造一次差异看一眼
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
  await setOutdated('grilling')
  if (!(await waitHint(settingsRow(), deployHint))) errors.push('部署提醒点：浅色主题下侧栏「设置」上没有提示')
  await check(p, '设置-部署-浅色提醒点')
  // 没有差异时不能一直亮着；清掉钩子，后面的检查也不受影响
  await setOutdated('')
  if (!(await waitHint(settingsRow(), ''))) errors.push('部署提醒点：没有差异时侧栏「设置」上还有提示')
  // 回收站与对话内容搜索：删掉的对话先进回收站、能恢复；正文里搜到的对话点开能定位到那条消息。
  // 用新页面跑：这里要往对话里发消息、删对话，别把上面设置检查的数据带脏
  {
    const d = await page({ width: 1440, height: 900 })
    await d.goto(base)
    await d.getByText('购物车右上角', { exact: false }).first().click()
    const input = d.locator('#follow-up')
    const hasInput = await input.waitFor({ timeout: 10000 }).then(
      () => true,
      () => false,
    )
    if (!hasInput) errors.push('对话搜索：对话页的输入框没出来')
    else {
      // 只在正文里出现的词：标题里没有它，命令面板和侧栏都得靠搜对话内容才找得到
      await input.fill('界面检查用的独占词：紫藤花架')
      await d.keyboard.press('Enter')
      await d
        .getByText('紫藤花架')
        .first()
        .waitFor({ timeout: 10000 })
        .catch(() => errors.push('对话搜索：消息没有出现在对话里'))
      // 命令面板：命中显示成「对话标题 + 命中片段」，点它跳到那条消息
      await d.keyboard.press('Control+k')
      const search = d.getByRole('combobox').first()
      await search.fill('紫藤花架')
      await check(d, '对话搜索-命令面板命中正文', ['对话内容', '紫藤花架'])
      await d.getByRole('option').filter({ hasText: '购物车右上角' }).first().click()
      const jumped = await d
        .waitForFunction(() => /^#\/projects\/[^/]+\/[^/]+\/[^/]+$/.test(location.hash), undefined, { timeout: 5000 })
        .then(
          () => true,
          () => false,
        )
      if (!jumped) errors.push('对话搜索：点正文命中后地址里没有消息 id（没有定位到那条消息）')
      await check(d, '对话搜索-跳到那条消息')
      // 侧栏搜索框走同一份结果：正文命中列在「对话内容」分组里
      await d.locator('#sidebar-search').fill('紫藤花架')
      await check(d, '对话搜索-侧栏命中正文', ['对话内容'])
      // 回收站：删掉的对话从列表里消失，但能在设置里找到并恢复
      await d.locator('#sidebar-search').fill('购物车右上角')
      const sideRow = d.locator('aside').getByText('购物车右上角', { exact: false }).first()
      await sideRow.click({ button: 'right' })
      await d.getByRole('menuitem', { name: '删除', exact: true }).click()
      await d.getByRole('button', { name: '删除', exact: true }).last().click()
      // 侧栏右键删除没有 toast（只有任务页那个删除按钮才有），这里断言它真的从侧栏结果里消失
      await d
        .locator('aside')
        .getByText('购物车右上角', { exact: false })
        .first()
        .waitFor({ state: 'detached', timeout: 5000 })
        .catch(() => errors.push('回收站：删除后侧栏里还有这个对话'))
      await d.getByRole('button', { name: '设置', exact: true }).first().click()
      await d.getByRole('button', { name: '数据', exact: true }).click()
      await check(d, '回收站-列出已删除的对话', ['回收站', '购物车右上角', '恢复', '永久删除'])
      await d.getByRole('button', { name: '恢复', exact: true }).first().click()
      await check(d, '回收站-恢复后', ['回收站是空的'])
    }
  }

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
