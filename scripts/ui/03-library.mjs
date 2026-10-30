/**
 * 界面检查分片：工作流、内置工作流、新建任务的 Agent 开关、AI 分析执行结果、角色、Skills、MCP
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base + '#/workflows')
  await check(p, '工作流', ['流程图', '主流程'])
  // 内置工作流列表：整理后的十个工作流都要能正常显示，不重复、不溢出
  await p.getByRole('button', { name: '添加内置或导入的工作流' }).first().click()
  await p.getByText('从内置工作流添加').first().click()
  await check(p, '工作流-内置列表', ['通用项目', '依赖升级与安全', '发布与回滚', '代码评审'])
  await p.keyboard.press('Escape')
  // 流程图的撤销 / 重做（左上面包屑旁边）：刚打开时不能撤销；改一下（自动排列）能撤销，Ctrl+Z 撤销后能重做，
  // Ctrl+Shift+Z 重做回来，最后按钮撤销回原样（工作流是自动保存的，别把演示数据改乱）
  {
    const undo = p.getByRole('button', { name: '撤销', exact: true })
    const redo = p.getByRole('button', { name: '重做', exact: true })
    const tools = p.getByRole('toolbar', { name: '画布工具' })
    if (!(await tools.count())) errors.push('工作流-画布工具：底部没有画布工具条')
    if (!(await undo.isDisabled().catch(() => false))) errors.push('工作流-撤销：刚打开就能撤销')
    else {
      await tools.getByRole('button', { name: '自动排列' }).click()
      await settle(p)
      if (await undo.isDisabled()) errors.push('工作流-撤销：自动排列后还不能撤销')
      await p.evaluate(() => document.activeElement?.blur())
      await p.keyboard.press('Control+z')
      await settle(p)
      if (await redo.isDisabled()) errors.push('工作流-撤销：Ctrl+Z 撤销后不能重做')
      if (!(await undo.isDisabled())) errors.push('工作流-撤销：撤销回去以后还能再撤销')
      await p.keyboard.press('Control+Shift+z')
      await settle(p)
      if (await undo.isDisabled()) errors.push('工作流-撤销：Ctrl+Shift+Z 没有重做')
      await check(p, '工作流-撤销重做', ['工作流'])
      await undo.click()
      await settle(p)
    }
    // 「在项目里运行」：弹窗里选项目、写任务描述，没写描述时不能开始
    await p.getByRole('button', { name: '在项目里运行' }).first().click()
    const dlg = p.getByRole('dialog')
    await dlg.waitFor({ timeout: 5000 }).catch(() => errors.push('工作流-在项目里运行：没有弹出选项目的窗口'))
    if (await dlg.count()) {
      if (!(await dlg.getByLabel('在哪个项目里执行').count())) errors.push('工作流-在项目里运行：弹窗里没有项目选择')
      if (!(await dlg.getByRole('button', { name: '开始运行' }).isDisabled()))
        errors.push('工作流-在项目里运行：没写任务描述也能开始')
      await dlg.getByLabel('任务描述').fill('按这个工作流做一遍')
      if (await dlg.getByRole('button', { name: '开始运行' }).isDisabled())
        errors.push('工作流-在项目里运行：写了描述还不能开始')
      await check(p, '工作流-在项目里运行', ['在项目里运行', '任务描述'])
      await p.keyboard.press('Escape')
      await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
    }
  }
  // 属性栏顶部除了当前对象，还有「流程说明」（编辑工作流说明）和「运行进度」两个页签；
  // 底部工具条上选在哪个项目运行，「重新运行」只在这个项目里跑过时出现（运行进度同一份数据，两边要一致）
  const inspector = p.locator('aside[aria-label="属性"]')
  {
    const tools = p.getByRole('toolbar', { name: '画布工具' })
    if (!(await tools.getByRole('combobox', { name: '在哪个项目里运行' }).count()))
      errors.push('工作流-工具条：没有选项目的下拉')
    await inspector.getByRole('tab', { name: '流程说明' }).click()
    if (
      !(await inspector
        .locator('textarea')
        .first()
        .inputValue()
        .catch(() => ''))
    )
      errors.push('工作流-流程说明页签：没有显示工作流说明')
    await inspector.getByRole('tab', { name: '运行进度' }).click()
    const never = await inspector.getByText('还没有在', { exact: false }).count()
    const rerun = await tools.getByRole('button', { name: '重新运行' }).count()
    if (!never === !rerun) errors.push('工作流-运行进度：「重新运行」和运行进度对「跑没跑过」的判断不一致')
    await check(p, '工作流-运行进度页签', ['运行进度'])
  }
  // 属性栏的宽度可调：选中节点后拖左边缘，变宽并记住
  await p.getByText('处理并推荐').first().click()
  // 属性栏顶部的页签写当前编辑的对象（照 Workflow 设计稿）
  if (!(await inspector.getByText('节点 · 处理并推荐').count()))
    errors.push('工作流-属性栏：页签上没有写「节点 · 名称」')
  // 照设计稿：角色和 Agent 并排一行，验收、确认、重试排成一张开关列表
  if (!(await inspector.getByLabel('执行的 Agent').count())) errors.push('工作流-属性栏：角色旁边没有 Agent')
  if (
    !(await inspector.getByRole('group', { name: '步骤选项' }).getByRole('switch', { name: '完成后等我确认' }).count())
  )
    errors.push('工作流-属性栏：步骤选项列表里没有「完成后等我确认」开关')
  const grip = p.locator('[role="separator"][aria-label="拖动调整属性栏的宽度"]')
  const width = async () => (await inspector.boundingBox())?.width ?? 0
  const before = await width().catch(() => 0)
  const g = await grip.boundingBox().catch(() => null)
  if (!g) errors.push('工作流-属性栏：找不到拖动条')
  else {
    await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
    await p.mouse.down()
    await p.mouse.move(g.x - 160, g.y + g.height / 2, { steps: 10 })
    await p.mouse.up()
    await settle(p)
    if (Math.abs(before - 380) > 2) errors.push(`工作流-属性栏：默认宽度是 ${before}，不是 380`)
    const after = await width()
    if (after < before + 100) errors.push(`工作流-属性栏：拖动后宽度是 ${after}，没有变宽`)
  }
  await check(p, '工作流-属性栏宽度')
  // 执行步骤可以折叠：收起后只剩标题行和一行摘要，输入框不再占高度；再点一下展开回来
  {
    const fold = p.getByRole('button', { name: '收起这一步' }).first()
    if (!(await fold.count())) errors.push('工作流-步骤折叠：步骤上没有折叠按钮')
    else {
      await fold.click()
      await p
        .getByRole('button', { name: '展开这一步' })
        .first()
        .waitFor({ timeout: 3000 })
        .catch(() => {})
      if (!(await p.getByRole('button', { name: '展开这一步' }).count()))
        errors.push('工作流-步骤折叠：收起后按钮没有变成「展开这一步」')
      if (await p.getByLabel('这一步要做的事').count())
        errors.push('工作流-步骤折叠：收起后「这一步要做的事」还占着位置')
      await check(p, '工作流-步骤折叠')
      await p.getByRole('button', { name: '展开这一步' }).first().click()
      await p
        .getByLabel('这一步要做的事')
        .first()
        .waitFor({ timeout: 3000 })
        .catch(() => {})
      if (!(await p.getByLabel('这一步要做的事').count())) errors.push('工作流-步骤折叠：再点一下没有展开')
    }
  }
  // 内置工作流：正式版启动时全部加入，演示里手动添加；添加后连同 Agent 一起建好，直接打开
  await p.getByRole('button', { name: '添加内置或导入的工作流' }).click()
  await p.getByRole('menuitem', { name: '从内置工作流添加' }).click()
  await check(p, '内置工作流', ['通用项目', '功能开发（OpenSpec）', 'Blender 建模与动画'])
  await p.getByRole('button', { name: '添加', exact: true }).first().click()
  // 要建好几个 Agent，演示里每个请求都有模拟的延迟，等弹窗关掉
  await p.getByRole('dialog').waitFor({ state: 'hidden', timeout: 20000 })
  await check(p, '内置工作流-添加后', ['识别现场与方案', '文档同步'])
  // 项目里新建对话：输入框上可以选择用不用项目设置的 Agent，对话页不能再换 Agent 和参数
  await p.goto(base)
  const agentSwitch = p.getByRole('switch', { name: '使用项目设置的角色' })
  await agentSwitch.waitFor({ timeout: 10000 }).catch(() => errors.push('新建任务：没有「使用项目设置的角色」开关'))
  if (await agentSwitch.count()) {
    if ((await agentSwitch.getAttribute('aria-checked')) !== 'true') errors.push('新建任务：开关默认没有勾选')
    // 开关只显示图标，Agent 名字放在 title 里
    if ((await agentSwitch.textContent())?.trim()) errors.push('新建任务：Agent 开关还显示文字')
    if (!(await agentSwitch.getAttribute('title'))) errors.push('新建任务：Agent 开关没有说明')
    await check(p, '新建任务-Agent开关')
    // 不勾选后换成 CLI / 模型的选择
    await agentSwitch.click()
    await p
      .getByRole('switch', { name: '使用项目设置的角色', checked: false })
      .waitFor({ timeout: 3000 })
      .catch(() => {})
    if ((await agentSwitch.getAttribute('aria-checked')) !== 'false') errors.push('新建任务：开关点一下没有关掉')
    if (!(await p.getByTitle('对话用的 Agent').count())) errors.push('新建任务：关掉 Agent 后没有显示 CLI 选择')
    await check(p, '新建任务-不用Agent')
    await agentSwitch.click()
  }
  await p.locator('#task-prompt').fill('分析一下这个项目的结构')
  await p.waitForTimeout(300)
  await p.locator('#task-prompt').press('Enter')
  await p
    .locator('#follow-up')
    .waitFor({ timeout: 20000 })
    .catch(() => errors.push('对话页：没有打开输入框'))
  // 对话页输入框里只剩「提问」开关和 CLI / 模型，没有换 Agent 和改参数的地方
  if (!(await p.getByRole('button', { name: 'AI 有问题时问我' }).count())) errors.push('对话页：没有「提问」开关')
  for (const name of ['参数', '无角色，直接用 Agent']) {
    if (await p.getByText(name, { exact: false }).count()) errors.push(`对话页：还能看到「${name}」`)
  }
  await check(p, '对话-不能换Agent和参数')
  // AI 分析执行结果：新建分析对话，代码问题按模块分组带「修复」，角色和工作流的优化可以逐条或全部应用
  // 工作流任务从项目首页的任务列表点进去
  await p.goto(base)
  await p.getByText('商品详情页增加', { exact: false }).first().click()
  await p.getByRole('button', { name: '更多操作' }).click()
  await p.getByRole('menuitem', { name: 'AI 分析执行结果' }).click()
  await p.getByRole('dialog').getByRole('button', { name: '开始分析' }).click()
  await p.getByText('工作流优化', { exact: true }).waitFor({ timeout: 20000 })
  await p.getByRole('button', { name: '看差异' }).first().click()
  await check(p, 'AI分析-建议', ['代码问题', '商品卡片', '面板框架', '工作流优化', '先确认范围', '应用到工作流'])
  // 报告画在右侧的功能面板里，不在对话区（用户 2026-10-25 要求，ADR 0016）
  const report = p.locator('[data-analysis-panel="run"]')
  if (!(await report.count())) errors.push('AI 分析：报告没有画在右侧的功能面板里')
  if (await p.locator('main').getByText('工作流优化', { exact: true }).count())
    errors.push('AI 分析：对话区里还铺着分析报告')
  // AI 分析窗口里嵌的对话不再画自己的页签行（标题和窗口标题栏重复）：对话的操作按钮挂到窗口标题栏上，
  // 「分析」标签由窗口标题栏的「AI 分析」代替；「提问」默认不勾选
  if (await p.getByRole('dialog').getByRole('tablist', { name: '对话页签' }).count())
    errors.push('AI 分析：窗口里还画着对话自己的页签行，和窗口标题栏重复')
  if (!(await p.getByRole('dialog').locator('header').getByRole('button', { name: '分析报告' }).count()))
    errors.push('AI 分析：对话的功能面板开关没有挂到窗口标题栏上')
  if (
    (await p.getByRole('dialog').getByRole('button', { name: 'AI 有问题时问我' }).getAttribute('aria-pressed')) !==
    'false'
  )
    errors.push('AI 分析：「提问」默认是勾选的')
  // 报告分段能折叠：点「代码问题」的小标题收起这一段
  await report.getByRole('button', { name: /^代码问题/ }).click()
  if (await report.getByText('商品卡片', { exact: false }).count()) errors.push('AI 分析：代码问题折叠后还能看到条目')
  await check(p, 'AI分析-折叠代码问题')
  await report.getByRole('button', { name: /^代码问题/ }).click()
  // 单项「修复」在当前分析对话里直接修：对话里多一条【修复】开头的消息，按钮变成处理中 / 已处理，不开子对话
  await report.getByRole('button', { name: '修复', exact: true }).first().click()
  await p
    .getByRole('dialog')
    .getByText('【修复】', { exact: false })
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => errors.push('AI 分析：点了「修复」没有在当前对话里发出修复'))
  await report
    .getByText(/处理中|已处理/)
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => errors.push('AI 分析：点了「修复」后按钮没有变成处理中 / 已处理'))
  await check(p, 'AI分析-当前对话修复')
  await report
    .getByText('已处理')
    .first()
    .waitFor({ timeout: 30000 })
    .catch(() => errors.push('AI 分析：修复这一轮结束后没有显示「已处理」'))
  await report.getByRole('button', { name: /全部应用/ }).click()
  await check(p, 'AI分析-已应用', ['已应用'])
  // 功能面板能收起，从标题栏的按钮再打开
  await report.getByRole('button', { name: '收起功能面板' }).click()
  if (await p.locator('[data-analysis-panel]').count()) errors.push('AI 分析：功能面板收起后还在')
  // 收起后右栏换回项目文件：窗口里的文件栏默认比对话页窄（最宽 320），分析对话占主体（用户 2026-10-30 要求）
  {
    const filesW = await p.evaluate(() => {
      const rail = [...document.querySelectorAll('[role="dialog"] [data-task-panel]')].find(
        (el) => el.getBoundingClientRect().width > 0,
      )
      return rail ? Math.round(rail.getBoundingClientRect().width) : 0
    })
    if (!filesW || filesW > 320) errors.push(`AI 分析：窗口里的项目文件栏宽 ${filesW}px，默认应不超过 320px`)
  }
  await check(p, 'AI分析-收起功能面板')
  await p.getByRole('dialog').getByRole('button', { name: '分析报告' }).first().click()
  await report.getByText('工作流优化', { exact: true }).waitFor({ timeout: 5000 })
  // 接着追问：报告还留在右侧
  await p.getByRole('dialog').locator('#follow-up').first().click()
  await p.keyboard.type('接着说说第一个问题')
  await p.keyboard.press('Enter')
  await p.waitForTimeout(800)
  if (!(await report.getByText('工作流优化', { exact: true }).count()))
    errors.push('AI 分析：接着追问后右侧的报告不见了')
  await check(p, 'AI分析-追问后报告还在')
  // 功能面板和中间对话的分界可以左右拖（和文件面板同一套 usePaneWidth / ResizeHandle，各自记宽度）：
  // 拖动后宽度跟着变、刷新后还是这个宽度；覆盖态（窄屏抽屉）没有并排可拖，那时不该有拖动条。
  // 默认宽度和对话对半（用户 2026-11 要求），不是原来那个 440 定宽
  {
    // 拖动条挂在右栏 aside 上（不在 data-analysis-panel 里面）。宽度和位置都从拖动条自己的那一栏量：
    // 页面背后还留着项目页的右栏，按全局定位会量到别的栏（AI 分析窗口是 Portal 挂在 body 末尾的）
    const grip = p.locator('[role="separator"][aria-label="拖动调整功能面板的宽度"]:visible')
    const railBox = () =>
      p.evaluate(() => {
        const g = [...document.querySelectorAll('[role="separator"][aria-label="拖动调整功能面板的宽度"]')].find(
          (el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0
          },
        )
        const rail = g?.closest('[data-task-panel]')
        if (!rail) return null
        const r = rail.getBoundingClientRect()
        const row = rail.parentElement?.getBoundingClientRect()
        return { width: r.width, left: r.x - (row?.x ?? 0), rowW: row?.width ?? 0 }
      })
    const width = async () => (await railBox())?.width ?? 0
    const box0 = await railBox()
    const before = box0?.width ?? 0
    // 首次打开（这台机器上没拖过）：右栏宽度约等于这一行容器的一半，和中间对话一样宽
    const half = (box0?.rowW ?? 0) / 2
    const saved0 = await p.evaluate(() => localStorage.getItem('pane:report-panel'))
    const g = await grip.boundingBox().catch(() => null)
    if (!(await grip.count())) errors.push('AI分析-功能面板宽度：宽屏时没有拖动条')
    else if (saved0 !== null) errors.push(`AI分析-功能面板宽度：还没拖过就记着宽度 ${saved0}，验的不是默认值`)
    else if (!half) errors.push('AI分析-功能面板宽度：量不到右栏所在的容器宽度')
    else if (Math.abs(before - half) > 2)
      errors.push(`AI分析-功能面板宽度：默认宽度是 ${before}，不是容器一半 ${Math.round(half)}（应该和对话对半）`)
    // 拖动条量不到位置、或者默认宽度不对就不接着拖：后面的拖动、记忆、双击都建立在这个前提上
    if (g && half && Math.abs(before - half) <= 2) {
      // 往左拖 120：右栏在右边，往左拖变宽
      await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
      await p.mouse.down()
      await p.mouse.move(g.x - 120, g.y + g.height / 2, { steps: 10 })
      await p.mouse.up()
      await settle(p)
      const after = await width()
      if (Math.abs(after - (before + 120)) > 4)
        errors.push(`AI分析-功能面板宽度：拖动后宽度是 ${after}，没到 ${before + 120}`)
      // 宽度记在本机（usePaneWidth 写 pane:<key>）：存进去的值要等于拖过的宽度，
      // 而且组件重新挂载时从它初始化——关掉分析窗口再开，宽度不回到默认
      {
        const saved = await p.evaluate(() => localStorage.getItem('pane:report-panel'))
        if (Number(saved) !== Math.round(after))
          errors.push(`AI分析-功能面板宽度：记下的宽度是 ${saved}，不是 ${after}`)
        await check(p, 'AI分析-功能面板宽度', ['工作流优化'])
        // 窗口收起再展开：TaskView 重新挂载，宽度从 localStorage 恢复（不用新建分析对话，后面的归属断言还能用）
        await p.getByRole('dialog').getByRole('button', { name: '最小化' }).click()
        await p
          .getByRole('button', { name: '展开' })
          .waitFor({ timeout: 5000 })
          .catch(() => errors.push('AI分析-功能面板宽度：最小化后没有出现浮条'))
        await p.getByRole('button', { name: '展开' }).click()
        await report.getByText('工作流优化', { exact: true }).waitFor({ timeout: 20000 })
        await settle(p)
        const kept = await width()
        if (Math.abs(kept - after) > 4)
          errors.push(`AI分析-功能面板宽度：重新展开后宽度是 ${kept}，没保持拖过的 ${after}`)
        await check(p, 'AI分析-功能面板宽度-重新展开后保持')
        // 上限按这一栏自己的容器算（paneMax 从右栏的父容器量）：拖到最宽也不会把中间区挤没。
        // 用量几何关系验证：右栏最宽时左边的中间区仍不小于 320（都从拖动条自己那一栏量，不全局取栏）
        const wide = await grip.boundingBox().catch(() => null)
        if (!wide) errors.push('AI分析-功能面板宽度：拖到最宽前量不到拖动条')
        else {
          await p.mouse.move(wide.x + wide.width / 2, wide.y + wide.height / 2)
          await p.mouse.down()
          await p.mouse.move(wide.x - 2000, wide.y + wide.height / 2, { steps: 10 })
          await p.mouse.up()
          await settle(p)
          const max = await width()
          // 拖动条落在右栏左边缘：定位已经限定在拖动条自己的那一栏（见 railBox），这里直接用
          const geo = await railBox()
          if (!geo) errors.push('AI分析-功能面板宽度：量不到被拖的那一栏')
          else {
            if (geo.left < 320 - 2)
              errors.push(`AI分析-功能面板宽度：拖到最宽后中间只剩 ${Math.round(geo.left)}，小于 320`)
            if (geo.rowW && max > geo.rowW - 320 + 2)
              errors.push(`AI分析-功能面板宽度：拖到最宽 ${Math.round(max)}，超过了容器 ${Math.round(geo.rowW)} 减 320`)
          }
          await check(p, 'AI分析-功能面板宽度-上限')
        }
      }
      // 双击拖动条恢复默认宽度
      const g2 = await grip.boundingBox().catch(() => null)
      if (!g2) errors.push('AI分析-功能面板宽度：恢复默认前量不到拖动条')
      else {
        await p.mouse.dblclick(g2.x + g2.width / 2, g2.y + g2.height / 2)
        await settle(p)
        const reset = await width()
        // 双击拖动条恢复默认：和首次打开一样回到「容器一半」的对半，不是回到老的 440
        const halfNow = ((await railBox())?.rowW ?? 0) / 2
        if (!halfNow) errors.push('AI分析-功能面板宽度：双击后量不到右栏所在的容器宽度')
        else if (Math.abs(reset - halfNow) > 2)
          errors.push(`AI分析-功能面板宽度：双击后宽度是 ${reset}，没回到容器一半 ${Math.round(halfNow)}`)
        await check(p, 'AI分析-功能面板宽度-双击恢复')
        // 窄屏（xl 以下）功能面板是盖在对话上的抽屉（reportCover），没有并排可拖，那时不该有拖动条
        await p.setViewportSize({ width: 1024, height: 900 })
        await settle(p)
        // 窄屏下右栏被 CSS 隐住（xl:flex 生效不了），从标题栏那个只在窄屏显示的按钮盖在对话上打开；
        // 宽屏那个按钮此刻是 hidden，点它会当成「收起」
        await p.getByRole('dialog').locator('button[aria-label="分析报告"]:visible').first().click()
        await p
          .locator('[data-analysis-panel="run"]')
          .waitFor({ timeout: 5000 })
          .catch(() => errors.push('AI分析-功能面板宽度：窄屏下没有打开功能面板'))
        if (await p.locator('[role="separator"][aria-label="拖动调整功能面板的宽度"]:visible').count())
          errors.push('AI分析-功能面板宽度：窄屏覆盖态不该有拖动条')
        await check(p, 'AI分析-功能面板宽度-窄屏无拖动条')
        // 抽屉盖着标题栏，用抽屉自己的「收起功能面板」收起；再回到宽屏，后面的用例还是宽屏并排的样子
        await p.locator('[data-analysis-panel="run"]').getByRole('button', { name: '收起功能面板' }).click()
        await p.setViewportSize({ width: 1440, height: 900 })
        await settle(p)
        if (!(await p.locator('[role="separator"][aria-label="拖动调整功能面板的宽度"]:visible').count()))
          errors.push('AI分析-功能面板宽度：回到宽屏后拖动条没有回来')
      }
    }
  }
  // 工作流执行的分析开在项目里（不是挂在某个对话下）：窗口给的是「在项目对话里打开」
  if (!(await p.getByRole('button', { name: '在项目对话里打开' }).count()))
    errors.push('AI 分析：工作流执行的分析没有开在项目对话里')
  // 看完关掉窗口（还在回答就一起停掉），后面的页面不被它挡住
  await p.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).first().click()
  await p
    .getByRole('dialog')
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => {})
  await p.goto(base + '#/agents')
  await check(p, 'Agent', ['命令预览', '主理'])
  // 列表栏标题不能被头部按钮挤得截断（用户报过：「角色」被压成半个字）：工作流页同一个列表栏，一起查
  for (const [hash, pane] of [
    ['#/agents', '角色列表'],
    ['#/workflows', '工作流列表'],
    ['#/library', 'Skills列表'],
  ]) {
    if (hash !== '#/agents') await p.goto(base + hash)
    const h1 = p.locator(`section[aria-label="${pane}"] h1`).first()
    await h1.waitFor({ timeout: 5000 }).catch(() => {})
    const cut = await h1.evaluate((el) => el.scrollWidth > el.clientWidth + 1).catch(() => true)
    if (cut) errors.push(`${pane}：标题被头部按钮挤得截断了`)
  }
  await p.goto(base + '#/agents')
  // 角色页固定按分类分组：必备角色单独一组，然后是演示数据里的「规划 / 开发 / 质量」和未分类。
  // 原来的「按标签 / 按分类」切换已经去掉，列表上方不再有分组方式可选
  const rolePane = p.locator('section[aria-label="角色列表"]')
  if (await rolePane.getByRole('radio', { name: '按分类' }).count()) errors.push('角色页：还留着「按分类」的分组切换')
  // 高级角色、基本角色分两页（列表栏顶上的分段）：默认先看高级角色，必备组里是主理、执行、分析
  const layers = rolePane.getByRole('radiogroup', { name: '角色层' })
  const core = p.locator('[data-group-id="#core"]')
  if (!(await layers.count())) errors.push('角色页：没有「高级角色 / 基本角色」分页')
  else {
    const adv =
      (await core
        .first()
        .textContent()
        .catch(() => '')) ?? ''
    if (!/必备\s*·\s*3/.test(adv)) errors.push(`角色页：高级角色页的必备分组计数不是 3（读到「${adv.slice(0, 20)}」）`)
    if (!(await core.getByRole('button', { name: /^主理/ }).count())) errors.push('角色页：高级角色页没有「主理」')
    await check(p, 'Agent-高级角色', ['主理', '执行'])
    await layers.getByRole('radio', { name: /^基本角色/ }).click()
  }
  // 用 data-group-id / role=group 定位：分类名和标签、角色名可能同名，按文字找会指错组
  if (!(await core.count())) errors.push('角色页：没有「必备」分组')
  else {
    const text = (await core.first().textContent()) ?? ''
    if (!/必备\s*·\s*4/.test(text)) errors.push(`Agent：基本角色页必备分组的计数不是 4（读到「${text.slice(0, 20)}」）`)
    // 默认全部展开：必备组里的角色直接可见（评审也是必备角色，子对话收尾前派它看 diff）
    if (!(await core.getByRole('button', { name: /^评审/ }).count())) errors.push('角色页：必备分组默认没有展开')
  }
  // 分类组按演示数据的分类显示：测试工程师和代码审查在「质量」分类里
  const quality = rolePane.getByRole('group', { name: '质量', exact: true })
  if (!(await quality.count())) errors.push('角色页：没有「质量」分类分组')
  else {
    if (!/质量\s*·\s*3/.test((await quality.first().textContent()) ?? ''))
      errors.push('角色页：「质量」分组的标题没有显示条数')
    if (!(await quality.getByRole('button', { name: /^测试工程师/ }).count()))
      errors.push('角色页：「质量」分类默认没有展开')
  }
  await check(p, 'Agent-按分类', ['必备', '质量'])

  // 分类可以折叠：点组头收起，角色行不再渲染；再点一下展开回来
  const qualityToggle = quality.getByRole('button', { name: /^质量/ }).first()
  if (!(await qualityToggle.count())) errors.push('角色页：「质量」组头不能折叠')
  else {
    await qualityToggle.click()
    if ((await qualityToggle.getAttribute('aria-expanded')) !== 'false')
      errors.push('角色页：收起「质量」后组头的 aria-expanded 不是 false')
    if (await quality.getByRole('button', { name: /^测试工程师/ }).count())
      errors.push('角色页：收起「质量」后角色还在列表里')
    // data-collapsed 在组节点自己身上：locator('[data-collapsed]') 查的是后代，取不到
    if ((await quality.first().getAttribute('data-collapsed')) === null)
      errors.push('角色页：收起「质量」后没有标记 data-collapsed')
    await check(p, 'Agent-分类收起', ['质量'])
    await qualityToggle.click()
    if ((await qualityToggle.getAttribute('aria-expanded')) !== 'true')
      errors.push('角色页：展开「质量」后组头的 aria-expanded 不是 true')
    if (!(await quality.getByRole('button', { name: /^测试工程师/ }).count()))
      errors.push('角色页：展开「质量」后角色没有回来')
  }

  // 搜索时强制展开：命中的角色不能藏在收起的组里；清空后恢复原来的收起状态
  const search = p.getByPlaceholder('搜索名称、简介、模型或标签')
  await qualityToggle.click()
  await search.fill('测试工程师')
  await quality
    .getByRole('button', { name: /^测试工程师/ })
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('角色页：搜索时收起的「质量」组没有自动展开'))
  // 筛选期间组头退回纯标题：点了没有可见效果却会改掉持久化的折叠状态，这时不该是可点的开关
  if (await quality.getByRole('button', { name: /^质量/ }).count())
    errors.push('角色页：搜索时「质量」组头还是可点的折叠开关')
  await search.fill('')
  await p.waitForTimeout(100)
  if (await quality.getByRole('button', { name: /^测试工程师/ }).count())
    errors.push('角色页：清空搜索后「质量」没有回到收起状态')

  // 折叠状态记在本机：刷新后仍然是收起的；再点开，后面的用例在全部展开的列表里走
  await p.reload()
  await quality
    .getByRole('button', { name: /^质量/ })
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('角色页：刷新后没有「质量」分组'))
  if ((await quality.getByRole('button', { name: /^质量/ }).first().getAttribute('aria-expanded')) !== 'false')
    errors.push('角色页：刷新后「质量」的折叠状态没有保留')
  await quality.getByRole('button', { name: /^质量/ }).first().click()

  // 「子任务」是派子任务时的默认角色，不是用户可选的角色：角色页不展示它，也不让它单独撑出一个组
  if (await rolePane.getByRole('button', { name: /^子任务/ }).count())
    errors.push('角色页：列表里出现了「子任务」这个默认子任务角色')
  await search.fill('子任务')
  await p.waitForTimeout(300)
  if (await rolePane.getByRole('button', { name: /^子任务/ }).count())
    errors.push('角色页：搜索「子任务」还能搜到这个默认子任务角色')
  await search.fill('')
  // 内置 Agent：手动添加，已经随工作流建好的标成已添加
  await p.getByRole('button', { name: '添加内置角色' }).first().click()
  await check(p, '内置Agent', ['通用约束', '调研', '方案设计', '已添加'])
  // 「子任务」是子任务机制默认用的角色，启动时自动建好：用户不需要也不能手动添加，不能列在弹窗里。
  // 用 data-builtin-key 定位：角色名和「已添加」在同一个 <p> 里，按文字精确匹配找不到它
  if (await p.getByRole('dialog').locator('[data-builtin-key="helper"]').count())
    errors.push('内置Agent：弹窗里列出了「子任务」，用户不需要手动添加它')
  await p.keyboard.press('Escape')
  // 评审是必备角色：参数定义和角色设定由面板维护，参数页只改取值、角色设定只读
  await search.fill('评审')
  await p.getByText('评审', { exact: true }).first().click()
  await p.getByRole('tab', { name: /^参数/ }).click()
  await check(p, 'Agent-必备参数', ['这里改的是所有项目的默认取值'])
  await p.getByRole('tab', { name: /^角色设定/ }).click()
  await check(p, 'Agent-必备角色设定', ['由面板维护，只读'])
  // 复制一份就是普通 Agent（参数定义可以改）：在副本上检查参数的选项编辑、联动
  await p.getByRole('button', { name: '复制一份' }).click()
  await p.getByRole('tab', { name: /^参数/ }).click()
  await p.getByRole('button', { name: /\{\{vcs\}\}/ }).click()
  await p.getByRole('textbox', { name: '新选项' }).fill('svn')
  await p.getByRole('textbox', { name: '新选项' }).press('Enter')
  await p.getByRole('button', { name: '删除选项「svn」' }).scrollIntoViewIfNeeded()
  await check(p, 'Agent-参数选项', ['svn'])
  // 参数联动：后面的参数按前面的选择决定显示，规则在参数卡片里配
  await p.getByRole('combobox', { name: '显示条件' }).click()
  await p.getByRole('option', { name: /（target）/ }).click()
  await p.getByRole('group', { name: '条件取值' }).scrollIntoViewIfNeeded()
  await check(p, 'Agent-参数联动', ['选了其中一个时', '选项跟随', '联动'])
  await p.getByRole('tab', { name: /^角色设定/ }).click()
  await check(p, '角色-角色设定', ['通用约束', '实际交给它的设定'])
  // 参数面板里的说明浮层：面板一打开 Radix 就把焦点挪到第一个问号，说明不该跟着自己弹出来
  // （以前会出现一个盖住面板的说明），只有 hover 或点问号才出现，而且同时只留一个
  await p.getByRole('button', { name: /^参数 · / }).click()
  await p.waitForTimeout(400)
  if (await p.getByRole('tooltip').count()) errors.push('Agent-参数说明：打开参数面板就自己弹出了说明浮层')
  const helpTip = p.getByRole('img', { name: '说明' }).first()
  await helpTip.hover()
  await p
    .getByRole('tooltip')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('Agent-参数说明：hover 问号没有出现说明浮层'))
  let tips = await p.getByRole('tooltip').count()
  if (tips !== 1) errors.push(`Agent-参数说明：hover 后可见的说明浮层是 ${tips} 个，不是 1 个`)
  await p.mouse.move(5, 5)
  await p
    .getByRole('tooltip')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => errors.push('Agent-参数说明：鼠标移开后说明浮层没消失'))
  // 点问号也能打开，不靠 hover 停留的那点延时
  await helpTip.click()
  await p
    .getByRole('tooltip')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('Agent-参数说明：点问号没有打开说明浮层'))
  tips = await p.getByRole('tooltip').count()
  if (tips !== 1) errors.push(`Agent-参数说明：点开后有 ${tips} 个说明浮层，不是 1 个`)
  await p.keyboard.press('Escape')
  await p
    .getByRole('tooltip')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => errors.push('Agent-参数说明：按 Esc 后说明浮层没消失'))
  await check(p, 'Agent-参数说明')
  await p.getByRole('tab', { name: /^概览/ }).click()
  await check(p, '角色-概览', ['能开启子对话', '能启动计划', '运行环境'])
  // 角色分层：必备的「主理」是高级角色，「能力」页列出挂载的基本角色和各自的用法，评审只能派出
  await search.fill('主理')
  await p.getByText('主理', { exact: true }).first().click()
  await p.getByRole('tab', { name: /^能力/ }).click()
  await check(p, '角色-能力挂载', ['高级角色', '挂载的能力', '评审', '派成子任务', '父对话可以就地微改动'])
  await search.fill('')
  // 技能页：左列表 + 右详情。左边按 Agent 分组，点一项右边换成它的详情（不再是弹窗）
  await p.goto(base + '#/library')
  await check(p, 'Skills', ['commit-message', 'code-review', '文件结构'])
  // 左栏头部的按钮不能顶出左栏（用户报过：「超出范围了」）：按钮右边界要落在左栏里
  {
    const pane = p.locator('section[aria-label="Skills列表"]')
    const box = await pane.boundingBox()
    if (!box) errors.push('Skills-不溢出：找不到左栏')
    else {
      for (const name of ['新建', 'AI 创建 Skill']) {
        const b = await p.getByRole('button', { name, exact: true }).first().boundingBox()
        if (!b) errors.push(`Skills-不溢出：找不到「${name}」按钮`)
        else if (b.x + b.width > box.x + box.width + 1)
          errors.push(
            `Skills-不溢出：「${name}」右边界 ${Math.round(b.x + b.width)} 超出左栏 ${Math.round(box.x + box.width)}`,
          )
      }
      // 标题也要完整放下（被按钮挤出去时它会溢出左栏）
      const h = await pane.locator('h1').first().boundingBox()
      if (h && h.x + h.width > box.x + box.width + 1) errors.push('Skills-不溢出：标题超出左栏')
      if (!(await p.getByRole('combobox', { name: '种类' }).count())) errors.push('Skills-不溢出：分页不是下拉')
      await check(p, 'Skills-不溢出')
    }
  }
  // 地址跟着选中项走：刷新、复制链接能回到同一项
  await p
    .getByRole('button', { name: /commit-message/ })
    .first()
    .click()
  await p.waitForFunction(() => location.hash.includes('#/library/commit-message'), { timeout: 5000 }).catch(() => {})
  if (!(await p.evaluate(() => location.hash)).includes('#/library/commit-message'))
    errors.push('Skills：点技能后地址里没有记下选中项')
  // 搜索只过滤列表，不改选中项：搜完清空还要回到原来那一项（以前会把地址改成第一项）
  const hashBefore = await p.evaluate(() => location.hash)
  await p.getByPlaceholder('搜索名字和说明').fill('code-review')
  await p.waitForTimeout(200)
  if ((await p.evaluate(() => location.hash)) !== hashBefore) errors.push('Skills-搜索：搜索时地址里的选中项被改了')
  await p.getByPlaceholder('搜索名字和说明').fill('')
  await p.waitForTimeout(200)
  if (!(await p.getByLabel('内容', { exact: true }).count()))
    errors.push('Skills-搜索：清空搜索后详情页没有回到原来那一项')
  await check(p, 'Skills-搜索')
  await check(p, 'Skill详情', ['复制给别的 Agent', '保存', 'SKILL.md'])
  // 详情页里直接编辑主文件并保存：保存按钮只在有改动时可点
  const editor = p.getByLabel('内容', { exact: true }).first()
  const mainBefore = await editor.inputValue()
  await editor.fill(`${mainBefore}\n\n加一行说明，验证详情的保存。`)
  await p.getByRole('button', { name: '保存', exact: true }).first().click()
  await p
    .getByText('已保存')
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('Skill详情：保存后没有提示已保存'))
  await check(p, 'Skill详情-保存')
  // 文件结构：主文件置顶，目录默认展开（点一下才收起）；点开文件能看内容
  await check(p, 'Skill详情-文件树', ['pitfalls.md'])
  await p.getByRole('button', { name: 'references' }).click()
  if (await p.getByRole('button', { name: 'pitfalls.md' }).count())
    errors.push('Skill详情-文件树：点目录没有收起里面的文件')
  await check(p, 'Skill详情-目录收起')
  await p.getByRole('button', { name: 'references' }).click()
  await p.getByRole('button', { name: 'pitfalls.md' }).click()
  await p
    .getByLabel('文件内容')
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('Skill详情-文件树：点开文件后没有内容框'))
  const extra = await p
    .getByLabel('文件内容')
    .inputValue()
    .catch(() => '')
  if (!extra.includes('pitfalls.md')) errors.push(`Skill详情-文件树：读到的内容不对（「${extra.slice(0, 40)}」）`)
  await check(p, 'Skill详情-附加文件')
  // 改一个附加文件再保存，重开还在
  await p.getByLabel('文件内容').fill('# references/pitfalls.md\n\n改过的内容。\n')
  // 顶部主文件也有「保存」，此时是灰的：按可点击的那个定位附加文件的保存
  await p.getByRole('button', { name: '保存', exact: true, disabled: false }).first().click()
  await p
    .getByText('已保存')
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => {})
  await p.getByRole('button', { name: 'SKILL.md' }).click()
  await p.getByRole('button', { name: 'pitfalls.md' }).click()
  const again = await p
    .getByLabel('文件内容')
    .inputValue()
    .catch(() => '')
  if (!again.includes('改过的内容')) errors.push('Skill详情-附加文件：保存后重开没有读到改过的内容')
  await check(p, 'Skill详情-附加文件保存')
  // 有未保存的改动时，外面刷新一次（改附加文件会触发）不能把编辑器里的内容冲掉（评审 R3）
  const draft = `${await p.getByLabel('内容', { exact: true }).inputValue()}

没保存的草稿。`
  await p.getByLabel('内容', { exact: true }).fill(draft)
  await p.getByRole('button', { name: 'pitfalls.md' }).click()
  await p.getByLabel('文件内容').waitFor({ timeout: 5000 })
  if ((await p.getByLabel('内容', { exact: true }).inputValue()) !== draft)
    errors.push('Skill详情：刷新后主文件里没保存的改动被冲掉了')
  await check(p, 'Skill详情-未保存不被刷新冲掉')
  // 留着上面的草稿直接切到另一个技能：新技能的内容必须真的读进来（不能被上一个技能的草稿挡住）
  await p
    .getByRole('button', { name: /code-review/ })
    .first()
    .click()
  await p.waitForFunction(() => location.hash.includes('#/library/code-review'), { timeout: 5000 }).catch(() => {})
  const switched = await p
    .getByLabel('内容', { exact: true })
    .inputValue()
    .catch(() => '')
  if (!switched.includes('code-review'))
    errors.push(`Skills：切到另一个技能后编辑器里不是它的内容（「${switched.slice(0, 40)}」）`)
  await check(p, 'Skills-切技能读新内容')

  // AI 优化还在，而且是对这一项做（入口在详情页头部）
  await p.getByRole('button', { name: 'AI 优化' }).click()
  await p.getByRole('dialog').getByRole('textbox', { name: '描述' }).fill('步骤写得再具体一些')
  await p.keyboard.press('Enter')
  await check(p, 'Skill-AI优化', ['格式校验通过', 'SKILL.md'])
  await p.getByRole('button', { name: '应用修改' }).click()
  await p
    .getByRole('button', { name: '应用修改' })
    .waitFor({ state: 'detached', timeout: 10000 })
    .catch(() => errors.push('Skill-AI优化：点了「应用修改」窗口没有关上'))
  // 分页是下拉（用户要求「改成下拉」）：用现成的 Select，选项文字里带「可更新」的条数
  await p.getByRole('combobox', { name: '种类' }).click()
  await check(p, 'Skills-分页下拉', ['Skill', '自带 Skill'])
  // 命令分页按用户要求去掉了：下拉里只有 Skill 和自带 Skill
  if (await p.getByRole('option', { name: '命令', exact: true }).count()) errors.push('Skills：分页里不该再有「命令」')
  await p.getByRole('option', { name: /自带 Skill/ }).click()
  await check(p, '自带Skill', ['brainstorming', 'blender', '版本控制'])
  // 自带 Skill 分页没有可新建的东西：「新建」按钮不该出现（以前点了没反应）
  if (await p.getByRole('button', { name: '新建', exact: true }).count())
    errors.push('自带Skill：这一页不该有「新建」按钮')
  await check(p, '自带Skill-没有新建')

  // 点卡片打开详情（用户报过：自带技能点不开）：名称、分类、安装状态、文件结构、只读说明
  await p
    .getByRole('button', { name: /coding-standards/ })
    .first()
    .click()
  await p.waitForFunction(() => location.hash.includes('#/library/coding-standards'), { timeout: 5000 }).catch(() => {})
  if (!(await p.evaluate(() => location.hash)).includes('#/library/coding-standards'))
    errors.push('自带Skill-详情：点卡片后地址里没有记下选中项')
  await check(p, '自带Skill-详情', ['编码', '文件结构', '~/.agents/skills'])
  if (!(await p.getByText('由面板随版本提供', { exact: false }).count()))
    errors.push('自带Skill-详情：没有说明这里不能编辑')
  if (await p.getByLabel('内容', { exact: true }).count()) errors.push('自带Skill-详情：自带技能不该有可编辑的正文框')
  // 文件树里能点开一个附件看内容（只读）：coding-standards 带 design-patterns.md
  // 按 title 定位：左栏卡片的说明里也可能出现这些文件名
  await p.locator('main button[title="design-patterns.md"]').click()
  const bundledText = await p
    .locator('pre')
    .first()
    .textContent()
    .catch(() => '')
  if (!bundledText?.includes('设计模式'))
    errors.push(`自带Skill-详情：点开的文件内容不对（「${bundledText?.slice(0, 30)}」）`)
  // 主文件也看得到
  await p.locator('main button[title="SKILL.md"]').click()
  const mainBundled = await p
    .locator('pre')
    .first()
    .textContent()
    .catch(() => '')
  if (!mainBundled?.includes('coding-standards'))
    errors.push(`自带Skill-详情：SKILL.md 没读出来（「${mainBundled?.slice(0, 30)}」）`)
  await check(p, '自带Skill-详情-文件内容')

  // 详情页里也有单项的安装 / 更新按钮
  if (!(await p.getByRole('button', { name: /已安装|安装|更新/ }).count()))
    errors.push('自带Skill-详情：详情页里没有安装 / 更新按钮')

  // 文件树的目录能折叠：task-records 带 templates/，点一下收起里面的文件、再点展开
  await p
    .getByRole('button', { name: /task-records/ })
    .first()
    .click()
  // 左栏卡片上的说明里也有「acceptance.md」这类文件名：定位一律带 title（文件树的行才有 title = 相对路径），
  // 不然按名字找会命中列表里的卡片
  const treeRow = (path) => p.locator(`main button[title="${path}"]`)
  const folder = treeRow('templates')
  const inner = treeRow('templates/acceptance.md')
  await folder.waitFor({ timeout: 5000 }).catch(() => errors.push('自带Skill-目录折叠：找不到 templates 目录'))
  if (!(await inner.count())) errors.push('自带Skill-目录折叠：目录默认没有展开')
  // 点击后等「里面那个文件消失 / 回来」这个可观测状态，不要点完立刻查（渲染还没落地）
  await folder.click()
  await inner
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => errors.push('自带Skill-目录折叠：点目录没有收起里面的文件'))
  await folder.click()
  await inner.waitFor({ timeout: 3000 }).catch(() => errors.push('自带Skill-目录折叠：再点一下没有展开'))
  await check(p, '自带Skill-目录折叠')

  // 刷新后选中项要还在（分页种类也记在本地存储里）：以前挂载时会把地址里的 id 清掉，选中项被顶成第一项
  await p
    .getByRole('button', { name: /coding-standards/ })
    .first()
    .click()
  await p.waitForFunction(() => location.hash.includes('#/library/coding-standards'), { timeout: 5000 }).catch(() => {})
  await p.reload()
  await p
    .getByRole('combobox', { name: '种类' })
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('自带Skill-刷新：刷新后页面没起来'))
  const afterReload = await p.evaluate(() => location.hash)
  if (!afterReload.includes('#/library/coding-standards'))
    errors.push(`自带Skill-刷新：刷新后地址里的选中项被改成了「${afterReload}」`)
  // 刷新后列表要重新读一遍：等详情真的渲染出来再断言，不要 reload 完立刻查（读到的是「读取中…」）
  await p
    .getByText('由面板随版本提供', { exact: false })
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('自带Skill-刷新：刷新后右侧不是原来那个技能的详情'))
  await check(p, '自带Skill-刷新后选中项还在')

  // 一键更新：演示版预置了两条「和自带的不同」，点一下全部换回自带版本
  await p.getByRole('combobox', { name: '种类' }).click()
  await p.getByRole('option', { name: /自带 Skill/ }).click()
  if (!(await p.getByText('和自带的不同').count())) errors.push('自带Skill：没有可更新的项，「更新全部」没法验证')
  await p.getByRole('button', { name: '更新全部' }).click()
  await p
    .getByText('和自带的不同')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => {})
  if (await p.getByText('和自带的不同').count()) errors.push('自带Skill-一键更新：更新后还留着「和自带的不同」')
  await check(p, '自带Skill-一键更新', ['已安装'])
  await p.goto(base + '#/mcp')
  await check(p, 'MCP工具', ['github', 'filesystem'])
  await p.getByLabel('编辑').first().click()
  await p.getByRole('button', { name: '测试连接' }).click()
  await check(p, 'MCP编辑', ['连接成功', 'read_file'])
  await p.keyboard.press('Escape')
  // 粘贴文档里的 JSON 点「分析」：名字、命令、参数、环境变量都要填进表单
  await p.getByRole('button', { name: '添加' }).click()
  await p
    .getByPlaceholder(/mcpServers/)
    .fill('{ "mcpServers": { "pasted": { "command": "uvx", "args": ["mcp-server-time"], "env": { "TZ": "UTC" } } } }')
  await p.getByRole('button', { name: '分析', exact: true }).click()
  if (!(await p.locator('input[value="pasted"]').count())) errors.push('MCP-JSON填入：分析后名字没填进去')
  if (!(await p.locator('input[value="mcp-server-time"]').count())) errors.push('MCP-JSON填入：分析后参数没填进去')
  await check(p, 'MCP-JSON填入', ['已填入下面的表单'])
  await p.keyboard.press('Escape')
  // 工作流「重新运行」放在最后：它会在演示项目里新建一个对话，放前面会挡住上面按标题找的那条工作流任务。
  // 「Web 功能开发」在演示项目「商城前台」里跑过：运行进度列出节点，重新运行建一个新对话并打开，
  // 回到工作流时工具条上有「运行中」，点它打开的就是这次执行
  await p.goto(base + '#/workflows')
  await p.getByText('Web 功能开发').first().click()
  {
    const tools = p.getByRole('toolbar', { name: '画布工具' })
    const rerun = tools.getByRole('button', { name: '重新运行' })
    await rerun.waitFor({ timeout: 10000 }).catch(() => errors.push('工作流-重新运行：跑过的工作流没有「重新运行」'))
    await p.locator('aside[aria-label="属性"]').getByRole('tab', { name: '运行进度' }).click()
    if (!(await p.getByRole('list', { name: '节点进度' }).getByText('分析需求、拆分任务').count()))
      errors.push('工作流-运行进度：没有列出最近一次执行的节点')
    if (await rerun.count()) {
      await rerun.click()
      await p
        .locator('#follow-up')
        .waitFor({ timeout: 20000 })
        .catch(() => errors.push('工作流-重新运行：点了没有打开新建的对话'))
      const opened = await p.evaluate(() => location.hash)
      await p.goBack()
      const pill = tools.getByRole('button', { name: /^运行中/ })
      await pill.waitFor({ timeout: 10000 }).catch(() => errors.push('工作流-运行中：重新运行后工具条上没有「运行中」'))
      await check(p, '工作流-运行中', ['运行中'])
      if (await pill.count()) {
        await pill.click()
        await p.waitForFunction((h) => location.hash === h, opened, { timeout: 5000 }).catch(() => {})
        if ((await p.evaluate(() => location.hash)) !== opened)
          errors.push('工作流-运行中：点「运行中」打开的不是正在跑的那次执行')
      }
    }
  }
})
