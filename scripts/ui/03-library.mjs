/**
 * 界面检查分片：工作流、内置工作流、新建任务的 Agent 开关、AI 分析执行结果、角色、Skill 与命令、MCP
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
  // 属性栏的宽度可调：选中节点后拖左边缘，变宽并记住
  await p.getByText('处理并推荐').first().click()
  const inspector = p.locator('aside[aria-label="属性"]')
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
  // 报告画在右侧的功能面板里，不在对话区（用户 2026-10-25 要求，ADR 0015）
  const report = p.locator('[data-analysis-panel="run"]')
  if (!(await report.count())) errors.push('AI 分析：报告没有画在右侧的功能面板里')
  if (await p.locator('main').getByText('工作流优化', { exact: true }).count())
    errors.push('AI 分析：对话区里还铺着分析报告')
  // 分析对话的标题前有「分析」标签，和普通对话区分开；「提问」默认不勾选
  if (!(await p.getByRole('dialog').locator('[data-analysis-mark]').count()))
    errors.push('AI 分析：标题前没有「分析」标签')
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
  // 必备角色自成一个分组：评审也是必备角色（子对话收尾前派它看 diff）
  await check(p, 'Agent', ['命令预览', '必备', '评审'])
  // 必备分组后面跟着计数（评审、分析升进来之后是 8）：label 和计数是两个 span，只查文本查不出数字
  const coreHead = await p.evaluate(() => {
    const label = [...document.querySelectorAll('span')].find((el) => el.textContent?.trim() === '必备')
    return label?.parentElement?.textContent?.trim() ?? ''
  })
  if (!/必备\s*·\s*8/.test(coreHead)) errors.push(`Agent：必备分组的计数不是 8（读到「${coreHead}」）`)
  // 内置 Agent：手动添加，已经随工作流建好的标成已添加
  await p.getByRole('button', { name: '添加内置角色' }).first().click()
  await check(p, '内置Agent', ['通用约束', '调研', '方案设计', '已添加'])
  await p.keyboard.press('Escape')
  // 评审是必备角色：参数定义和角色设定由面板维护，参数页只改取值、角色设定只读
  const search = p.getByPlaceholder('搜索名称、简介、模型或标签')
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
  await p.goto(base + '#/library')
  await check(p, 'Skills与命令', ['commit-message', 'code-review'])
  await p.getByRole('radio', { name: '自带 Skill' }).click()
  await check(p, '自带Skill', ['brainstorming', 'blender', '版本控制'])
  // 一键更新：演示版预置了两条「和自带的不同」，点一下全部换回自带版本
  if (!(await p.getByText('和自带的不同').count())) errors.push('自带Skill：没有可更新的项，「更新全部」没法验证')
  await p.getByRole('button', { name: '更新全部' }).click()
  await p
    .getByText('和自带的不同')
    .first()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => {})
  if (await p.getByText('和自带的不同').count()) errors.push('自带Skill-一键更新：更新后还留着「和自带的不同」')
  await check(p, '自带Skill-一键更新', ['已安装'])
  await p.getByRole('radio', { name: 'Skill', exact: true }).click()
  await p.getByText('commit-message', { exact: true }).first().click()
  await check(p, 'Skill编辑', ['复制给别的 Agent', '保存'])
  await p.getByRole('button', { name: 'AI 优化' }).click()
  await p.getByRole('dialog').getByRole('textbox', { name: '描述' }).fill('步骤写得再具体一些')
  await p.keyboard.press('Enter')
  await check(p, 'Skill-AI优化', ['格式校验通过', 'SKILL.md'])
  // 应用完 AI 优化的窗口自己关上；等它关掉再关下面的编辑框（以前按 Esc，机器慢时会把编辑框也关掉）
  await p.getByRole('button', { name: '应用修改' }).click()
  await p
    .getByRole('button', { name: '应用修改' })
    .waitFor({ state: 'detached', timeout: 10000 })
    .catch(() => errors.push('Skill-AI优化：点了「应用修改」窗口没有关上'))
  // 命令：「所有 Agent」的命令和 AI 创建（上面的 Skill 编辑框还开着，先关掉）
  await p.getByRole('dialog').getByText('关闭', { exact: true }).click()
  await p.getByRole('radio', { name: '命令' }).click()
  await check(p, '命令-所有Agent', ['/changelog', '所有 Agent'])
  await p.getByRole('button', { name: 'AI 创建' }).click()
  await p.getByRole('dialog').getByRole('textbox', { name: '描述' }).fill('/i18n：找出没翻译的文案，补上英文')
  await p.keyboard.press('Enter')
  await check(p, '命令-AI创建', ['格式校验通过', '命令文件（所有 Agent 共用）'])
  await p.getByRole('button', { name: '创建命令' }).click()
  await check(p, '命令-AI创建后', ['/i18n'])
  await p.goto(base + '#/mcp')
  await check(p, 'MCP工具', ['github', 'filesystem'])
  await p.getByLabel('编辑').first().click()
  await p.getByRole('button', { name: '测试连接' }).click()
  await check(p, 'MCP编辑', ['连接成功', 'read_file'])
  await p.keyboard.press('Escape')
})
