/**
 * 界面检查分片：项目：侧栏排序和拖拽、浅色主题、文件面板、项目设置、AI 初始化、项目教训
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { runShard, dialogBottomSpaceProblems, segmentedContrastProblems } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  // 侧栏项目分组：默认按添加时间排（演示项目的时间各不相同），拖拽手柄能调整顺序并持久化，刷新后还是新顺序
  const projectRows = () =>
    p
      .locator('[data-sidebar] section button[title^="打开项目「"]')
      .evaluateAll((els) => els.map((e) => (e.getAttribute('title') ?? '').match(/「(.+?)」/)?.[1] ?? ''))
  await p.goto(base + '#/projects')
  const order0 = await projectRows()
  assert.deepEqual(
    order0.slice(0, 4),
    ['商城前台', '运营后台', '客户端主工程', '旧官网'],
    `侧栏项目没有按添加时间排序：${order0.join('、')}`,
  )
  await check(p, '侧栏-项目按添加时间', ['商城前台', '运营后台'])
  // 拖住「运营后台」的手柄，放到「商城前台」上：出现插入提示
  const orderGrip = p.getByRole('button', { name: '拖动调整「运营后台」的顺序' })
  const target = (await p.locator('[data-sidebar] section').nth(0).boundingBox()) ?? null
  if (!(await orderGrip.count()) || !target) errors.push('侧栏-拖拽：没有拖拽手柄')
  else {
    // 无头浏览器的鼠标拖不出 HTML5 拖放，用脚本发拖放事件（和 UI 设计拖图片的写法一样）
    await p.evaluate(() => {
      window.__dt = new DataTransfer()
      const handle = document.querySelector('[aria-label="拖动调整「运营后台」的顺序"]')
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__dt }))
    })
    await p.waitForTimeout(150)
    await p.evaluate(() => {
      const section = document.querySelectorAll('[data-sidebar] section')[0]
      const r = section.getBoundingClientRect()
      section.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: window.__dt,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      )
    })
    await p.waitForTimeout(150)
    await check(p, '侧栏-拖拽插入提示')
    await p.evaluate(() => {
      const section = document.querySelectorAll('[data-sidebar] section')[0]
      const r = section.getBoundingClientRect()
      section.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: window.__dt,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      )
      document
        .querySelector('[aria-label="拖动调整「运营后台」的顺序"]')
        .dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt }))
    })
    for (let i = 0; i < 40 && (await projectRows())[0] !== '运营后台'; i++) await p.waitForTimeout(50)
    const order1 = await projectRows()
    assert.deepEqual(order1.slice(0, 2), ['运营后台', '商城前台'], `拖拽后顺序不对：${order1.join('、')}`)
    await check(p, '侧栏-拖拽后顺序', ['运营后台', '商城前台'])
    // 刷新后仍是新顺序（演示版把顺序存在浏览器里，等价于真实服务端写盘）
    const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('agent-panel-demo-v3') ?? '{}'))
    assert.ok(
      saved.projects?.every((x) => typeof x.sortOrder === 'number'),
      '拖拽后没有把顺序存下来',
    )
    await p.reload()
    await p.locator('[data-sidebar] section button[title^="打开项目「"]').first().waitFor({ timeout: 10000 })
    assert.deepEqual((await projectRows()).slice(0, 2), ['运营后台', '商城前台'], '刷新后顺序变了')
    await check(p, '侧栏-刷新后顺序', ['运营后台', '商城前台'])
  }
  // 深色下侧栏的模式切换（Agent / Chat / 设计）选中项要认得出来（用户反馈过「黑暗模式看不清」）
  await p.evaluate(() => document.documentElement.classList.add('dark'))
  errors.push(...(await segmentedContrastProblems(p, '侧栏-深色')))
  // 浅色主题
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
  await p.goto(base + '#/projects')
  await check(p, '项目-浅色', ['任务', '设置'])
  errors.push(...(await segmentedContrastProblems(p, '侧栏-浅色')))
  // 浅色主题下再看一眼 Token 浮层：边框、分隔线、速度的颜色都要跟着主题
  {
    await p.goto(base)
    await p.getByText('购物车右上角', { exact: false }).first().click()
    await p.getByTitle('Token 用量').first().click()
    await check(p, '任务-浅色-Token浮层', ['整个运行', '缓存命中'])
    await p.keyboard.press('Escape')
  }
  // 项目首页右侧的文件面板：首屏只读根目录一层，展开哪个目录才读哪一层，收起再展开用缓存。
  // 左侧栏原来的独立文件页已经去掉，这里验证的是同一套 FileExplorer
  {
    await p.goto(base)
    // #/projects 的地址里带项目 id，演示里的 id 每次生成都不一样，从侧栏点进去
    await p.locator('[data-sidebar]').getByText('商城前台').first().click()
    // 面板打开时才开始读文件：清掉之前页面记下的请求，再看打开面板读了哪几层
    await p.evaluate(() => {
      window.__fileCalls = []
    })
    await p.getByRole('button', { name: '显示文件', exact: true }).first().click()
    await p
      .locator('aside button[title="src"]')
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => {})
    const panel = p.locator('aside').filter({ has: p.getByPlaceholder('查找文件') })
    const calls = () => p.evaluate(() => (window.__fileCalls ?? []).filter((x, i, a) => a.indexOf(x) === i).join(','))
    const first = await calls()
    if (first !== '') errors.push(`文件面板：打开时不该读整棵树，实际读了「${first || '(根)'}」，应该只读根目录一层`)
    const row = (name) => panel.locator(`button[title="${name}"]`).first()
    // 根目录这一层有 src、tests 和几个文件，没有更深层的内容
    await row('src')
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('文件面板：根目录没有列出 src'))
    await row('tests')
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('文件面板：根目录没有列出 tests'))
    if (await row('src/App.tsx').count()) errors.push('文件面板：没展开 src 就列出了它下面的文件')
    if (await panel.getByText('共 20000 个文件', { exact: false }).count())
      errors.push('文件面板：还在显示全量文件数量')
    await check(p, '文件面板-根目录一层', ['src', 'README.md'])
    // 展开 src：这时才读 src 这一层
    await row('src').click()
    await row('src/App.tsx')
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('文件面板：展开 src 后没有读它这一层'))
    if (!(await calls()).split(',').includes('src')) errors.push('文件面板：展开 src 时没有请求这一层')
    await check(p, '文件面板-展开一层', ['api', 'App.tsx'])
    // 收起再展开：不重复请求
    await row('src').click()
    await row('src/App.tsx')
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    const before = await p.evaluate(() => (window.__fileCalls ?? []).length)
    await row('src').click()
    await row('src/App.tsx')
      .waitFor({ timeout: 3000 })
      .catch(() => {})
    const after = await p.evaluate(() => (window.__fileCalls ?? []).length)
    if (after !== before) errors.push(`文件面板：收起再展开又请求了一次（${before} → ${after}）`)
    // 名称搜索：还没展开的深层文件也能搜到，结果是平铺的
    await panel.getByPlaceholder('查找文件').fill('Restock')
    await panel
      .locator('button[title="src/components/RestockButton.tsx"]')
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('文件面板：名称搜索没有找到还没展开的深层文件'))
    await check(p, '文件面板-名称搜索', ['RestockButton'])
    await panel.getByPlaceholder('查找文件').fill('')
    await panel
      .locator('button[title="src/components/RestockButton.tsx"]')
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})

    // 右键菜单：文件行、文件夹行、空白处各一次；右键本身不能打开文件或展开目录
    const menu = () => p.locator('[role="menu"]')
    const menuText = async () => (await menu().innerText()).replace(/\s+/g, ' ')
    const closeMenu = async () => {
      await p.keyboard.press('Escape')
      await menu()
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => {})
    }
    // 文件行右键：出现菜单项，但文件没有被打开（没有弹出文件窗口）
    await row('package.json').click({ button: 'right' })
    await menu()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('文件右键：没有弹出菜单'))
    const fileMenu = await menuText().catch(() => '')
    for (const item of ['打开', '复制相对路径', '复制绝对路径', '在文件夹中打开'])
      if (!fileMenu.includes(item)) errors.push(`文件右键：菜单里没有「${item}」`)
    if (await p.getByRole('dialog').count()) errors.push('文件右键：右键打开了文件窗口')
    await check(p, '文件面板-右键菜单')
    await closeMenu()
    if (await p.getByRole('dialog').count()) errors.push('文件右键：菜单项没点，文件窗口却开着')
    // 文件夹行右键：菜单是「展开」，目录没有被展开
    await row('tests').click({ button: 'right' })
    await menu()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('文件夹右键：没有弹出菜单'))
    const dirMenu = await menuText().catch(() => '')
    for (const item of ['展开', '复制相对路径', '在文件夹中打开'])
      if (!dirMenu.includes(item)) errors.push(`文件夹右键：菜单里没有「${item}」`)
    // 第一项必须是「展开」；整行比较，避免「在文件夹中打开」里的「打开」被误判
    const dirItems = await menu()
      .locator('[role="menuitem"]')
      .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))
    if (dirItems[0] !== '展开') errors.push(`文件夹右键：第一项是「${dirItems[0]}」，不是「展开」`)
    if (dirItems.includes('打开')) errors.push('文件夹右键：出现了只给文件的「打开」')
    if (await row('tests/cart.test.ts').count()) errors.push('文件夹右键：右键把目录展开了')
    await check(p, '文件面板-文件夹右键菜单')
    await closeMenu()
    // 空白处右键：整棵树的菜单。
    // 行的按钮是整宽的，右上角又被搜索栏占着，所以在树的右键触发元素（min-h-full 那层）
    // 右下角的空白上点真实鼠标。每次先把滚动区滚到底，保证这块空白在视口里。
    const scroll = panel.locator('div.min-h-full').first().locator('..')
    const blankTrigger = () => panel.locator('div.min-h-full').first()
    const openBlankMenu = async (label) => {
      await scroll
        .evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
        .catch(() => {})
      const tb = await blankTrigger()
        .boundingBox()
        .catch(() => null)
      if (!tb) {
        errors.push(`${label}：找不到文件树容器`)
        return
      }
      await p.mouse.click(tb.x + tb.width - 24, tb.y + tb.height - 8, { button: 'right' })
      await menu()
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push(`${label}：没有弹出菜单`))
    }
    await openBlankMenu('空白处右键')
    const blankMenu = await menuText().catch(() => '')
    for (const item of ['刷新', '全部展开', '全部收起', '复制项目路径', '在文件夹中打开'])
      if (!blankMenu.includes(item)) errors.push(`空白处右键：菜单里没有「${item}」`)
    await check(p, '文件面板-空白处右键菜单')
    await closeMenu()
    await menu()
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    // 先测「全部收起」：此时 src 还开着，收起后子项应该消失
    await openBlankMenu('空白处右键')
    const collapse = menu().locator('[role="menuitem"]').filter({ hasText: '全部收起' })
    if (!(await collapse.count())) errors.push('空白处右键：没有「全部收起」')
    else {
      // 用真实鼠标点：Radix 的菜单项要按下和抬起都落在同一个元素上才触发
      const cb = await collapse.boundingBox()
      if (!cb) errors.push('空白处右键：「全部收起」不可见')
      else {
        await p.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2)
        await menu()
          .first()
          .waitFor({ state: 'detached', timeout: 3000 })
          .catch(() => {})
        if (await p.locator('[role="menu"]').count())
          errors.push('空白处右键：点了「全部收起」菜单没有关闭（可能没点中）')
      }
    }
    await menu()
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    const collapsedRows = await panel
      .locator('button[title="src/App.tsx"]')
      .count()
      .catch(() => 0)
    if (collapsedRows) errors.push('全部收起：收起后目录下面还显示着子项')
    // 收起后没有展开的目录：这一项应该变灰
    await openBlankMenu('空白处右键')
    const collapseItem = menu().locator('[role="menuitem"]').filter({ hasText: '全部收起' })
    const disabled = await collapseItem.getAttribute('data-disabled').catch(() => null)
    if (disabled === null) errors.push('全部收起：没有展开的目录时菜单项没有禁用')
    await p.keyboard.press('Escape')
    await menu()
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    // 最后测「全部展开」：只作用于已经读过的层，不会新读没有出现过的目录。
    // 放在最后是因为展开后行会铺满可视区，右侧就不再有空白能点开菜单了。
    const beforeExpand = await calls()
    await openBlankMenu('空白处右键')
    const expandItem = menu().locator('[role="menuitem"]').filter({ hasText: '全部展开' })
    const eb = await expandItem.boundingBox().catch(() => null)
    if (!eb) errors.push('空白处右键：没有「全部展开」')
    else await p.mouse.click(eb.x + eb.width / 2, eb.y + eb.height / 2)
    await row('src/App.tsx')
      .waitFor({ timeout: 3000 })
      .catch(() => {})
    await settle(p)
    const afterExpand = await calls()
    const requested = afterExpand.split(',').filter((x) => x && !beforeExpand.split(',').includes(x))
    const known = await panel
      .locator('button[title]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''))
    const unknown = requested.filter((p2) => !known.some((k) => k.startsWith(p2 + '/')))
    if (unknown.length) errors.push(`全部展开：读了界面上还没有的目录「${unknown.join('、')}」`)
    await check(p, '文件面板-全部展开')
    await p.keyboard.press('Escape')
  }
  // 项目设置：测试步骤和按 Agent 派生的参数都要能正常显示，不能溢出、不能串行
  // 先点侧栏的项目（title 是「打开项目「名字」」）进入项目首页，管理区里有「项目设置」按钮
  const settingsButton = p.getByRole('button', { name: '项目设置' })
  if (!(await settingsButton.count()))
    await p
      .locator('[data-sidebar] button[title^="打开项目「"]')
      // 演示里只有「商城前台」配了测试步骤，按名字点它，不依赖侧栏顺序
      .filter({ hasText: '商城前台' })
      .first()
      .click()
      .catch(() => {})
  if (await settingsButton.count()) {
    await settingsButton.first().click()
    const dlg = p.getByRole('dialog')
    // 各分页滚到底的底部留白要和 dialogScrollClass 一致，最后一块不能被操作栏压住；
    // 测量方式和预期值都在 harness.mjs 里（预期值从 dialog.tsx 的 pb-N 读）
    const footSpace = async (label) => {
      errors.push(...(await dialogBottomSpaceProblems(p, `项目设置-底部留白（${label}）`)))
    }
    // 设置按左侧的页面分开：常规、必备角色、工作流、测试步骤各看一页
    await check(p, '项目设置-常规', ['推送到远端', '子对话隔离'])
    await footSpace('常规')
    // 项目技能：项目目录里的和用户级的都列出来，缺说明的技能给出问题提示和 AI 修复
    await dlg.getByRole('button', { name: 'Skill', exact: true }).click()
    await check(p, '项目设置-Skill', ['release-notes', 'shop-i18n', 'AI 优化', '新建 Skill'])
    await footSpace('Skill')
    // MCP：项目里识别到的配置（三种状态各有一条）、面板管理的工具、导入与 AI 排查入口
    await dlg.getByRole('button', { name: 'MCP', exact: true }).click()
    await check(p, '项目设置-MCP', [
      '只在项目里',
      '和各 Agent 的配置一致',
      '和各 Agent 的配置不同',
      '全部导入',
      '用 AI 排查整页',
    ])
    await footSpace('MCP')
    // 两页切回来都正常（导航里 Skill 和 MCP 相邻）
    await dlg.getByRole('button', { name: 'Skill', exact: true }).click()
    await check(p, '项目设置-Skill 再切回', ['新建 Skill'])
    await dlg.getByRole('button', { name: '必备角色', exact: true }).click()
    await check(p, '项目设置-必备角色', ['主理', '执行', '文档', '评审', '测试验收', '版本控制'])
    await footSpace('必备角色')
    await dlg.getByRole('button', { name: '工作流', exact: true }).click()
    await check(p, '项目设置-工作流', ['AI 配置'])
    await footSpace('工作流')
    await dlg
      .getByRole('button', { name: /^测试步骤/ })
      .first()
      .click()
    // 适用改动：不符合这次改动的步骤会跳过（判定在 shared/test-steps.ts 的 stepApplies）
    await check(p, '项目设置-测试步骤', [
      'AI 生成步骤',
      'WSL 发行版',
      '小改动也跑',
      '按改动大小决定验证范围',
      '每条可以写「适用改动」',
      // 范围三档（ADR 0020）：每条的选择器、头部那段说明（子对话只跑增量的那部分）都要显示出来。
      // 断言用页面上看得见的文字，悬停提示（title）不算
      '范围',
      '总是跑',
      '每条步骤选一个范围',
    ])
    await footSpace('测试步骤')
    // 「适用改动」能看见也能改：带出已配的 glob，而且逐字符敲第二条不会被归一化吞掉
    // （输入框保留原文、失焦才 parse；每次按键就 parse 再回显会把刚敲的逗号删掉）
    const applies = dlg.getByLabel('适用改动').first()
    assert.equal(await applies.inputValue(), '**/*.ts, **/*.tsx, **/package.json', '「适用改动」要带出已经配好的 glob')
    await check(p, '项目设置-适用改动')
    await applies.fill('**/*.cpp')
    await applies.pressSequentially(', **/*.h')
    assert.equal(await applies.inputValue(), '**/*.cpp, **/*.h', '手敲第二条 glob 时逗号不能被吞掉')
    await check(p, '项目设置-适用改动-手敲两条')
    // 项目教训：演示项目里有手动记的和角色记的，按文件生效的显示范围
    await dlg
      .getByRole('button', { name: /^项目教训/ })
      .first()
      .click()
    // 默认选中「默认」：只放一个标签都没有的教训；再点一次也不取消，带标签的在各自的标签里
    // （标签选择是组件库的 ChipGroup，单选小块是 radio）
    await check(p, '项目设置-项目教训', ['购物车相关改动同时改 legacy-cart', '默认', '加一条'])
    const defaultTab = dlg.getByRole('radio', { name: /^默认/ })
    await defaultTab.click()
    assert.equal(await defaultTab.getAttribute('aria-checked'), 'true', '再点一次选中的标签不能取消选中')
    await dlg.getByRole('radio', { name: /^支付/ }).click()
    await check(p, '项目设置-项目教训-标签页签', ['新增支付方式写进', '角色记录', 'src/payment/**'])
    assert.equal(
      await dlg.getByText('购物车相关改动同时改 legacy-cart').count(),
      0,
      '「支付」页签里不该有不带标签的教训',
    )
    await footSpace('项目教训')
    // 项目说明和各个 CLI 的说明文件共用同一个滚动区分支（section === 'doc' || cli:），单独确认一次
    await dlg.getByRole('button', { name: /^项目说明/ }).click()
    // 说明文件是异步读的，编辑框出来再量，否则量到的是「正在读取…」那一行
    await dlg
      .locator('textarea')
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('项目设置-项目说明：没有读到说明文件'))
    await check(p, '项目设置-项目说明')
    await footSpace('项目说明')
    // AI 初始化：演示项目已经初始化过，重新初始化后写过的文件和推荐设置按组列出，能逐项或全部应用
    await dlg.getByRole('button', { name: 'AI 初始化', exact: true }).click()
    await check(p, '项目设置-AI初始化', ['已于', '重新初始化'])
    await footSpace('AI 初始化')
    await dlg.getByRole('button', { name: '重新初始化' }).click()
    // 重新初始化后报告面板和「写入的文件」是异步算出来的，10 个分片并行时页面更慢、会超过 check 默认的 5 秒：
    // 把这条断言要的每一项都先等到再断言，免得界面还没渲染完就被当成没显示（见 docs/lessons/ui.md 异步加载先 waitFor）
    for (const text of ['写入的文件', 'AGENTS.md'])
      await p
        .getByText(text, { exact: false })
        .first()
        .waitFor({ timeout: 20000 })
        .catch(() => {})
    const reviewInit = p.getByRole('button', { name: '查看推荐并应用' })
    // 推荐面板要等对话跑完、结果解析完才出现（演示里实测 5~6 秒），先等面板再断言：
    // 不能指望 check 默认的 5 秒（见 docs/lessons/ui.md 那条「异步加载的入口先 waitFor 再断言」）
    await p
      .locator('[data-analysis-panel="init"]')
      .waitFor({ timeout: 20000 })
      .catch(() => errors.push('AI初始化-对话：推荐面板一直没有出现'))
    await check(p, 'AI初始化-对话', ['写入的文件', 'AGENTS.md'])
    // 结果直接画在对话右侧的报告面板（下面的检查兜住它一定出现）；旧路径里的「查看推荐并应用」有就点一下
    if (await reviewInit.count()) await reviewInit.click({ timeout: 10000 }).catch(() => {})
    await check(p, 'AI初始化-推荐设置', ['初始化完成', '推荐设置', '全部应用', '工作流', '测试步骤'])
    await p
      .getByRole('button', { name: '全部应用' })
      .click()
      .catch(() => errors.push('AI 初始化：没有「全部应用」'))
    await check(p, 'AI初始化-全部应用', ['已应用'])
    // 应用之后计数和按钮要立刻跟上：待应用的项清零、没有可应用项时「全部应用」不可点。
    // 看的是对话右侧的报告面板（ProjectInitReport），文案是「和项目设置一致」
    const initPanel = p.locator('[data-analysis-panel="init"]')
    await initPanel
      .getByText('全部推荐都已和项目设置一致', { exact: false })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('AI 初始化：全部应用后没有显示「全部推荐都已和项目设置一致」'))
    if (await initPanel.getByText('项待应用').count()) errors.push('AI 初始化：全部应用后还显示「N 项待应用」')
    if (!(await initPanel.getByRole('button', { name: '全部应用' }).isDisabled()))
      errors.push('AI 初始化：没有可应用项时「全部应用」还能点')
    await check(p, 'AI初始化-全部应用后状态')
    await p
      .getByText('评估后不适用的工作流')
      .scrollIntoViewIfNeeded()
      .catch(() => {})
    await check(p, 'AI初始化-工作流评估', ['评估后不适用的工作流', '可选工作流'])
    await p.keyboard.press('Escape')
    // 项目设置弹窗和里面的 AI 窗口叠着：一次 Escape 只关最上面那层，关到一层不剩再去点项目首页的输入框
    for (let i = 0; i < 3 && (await p.locator('[role="dialog"][data-state="open"]').count()); i++) {
      await p.keyboard.press('Escape')
      await settle(p).catch(() => {})
    }
    // 项目首页：任务按状态分组；输入和已有对话是同一件事的要求时，提示可以直接发过去
    await p.locator('#task-prompt').click()
    await p.keyboard.type('到货通知的按钮在详情页上点了没反应')
    await check(p, '项目首页-相关对话', ['发到这里', '需要你处理'])
    await p.keyboard.press('ControlOrMeta+a')
    await p.keyboard.press('Backspace')
    // 项目首页的项目教训：点一条打开项目设置的「教训」并展开它，改写过的带改写记录
    await p.getByText('项目教训 · ', { exact: false }).first().scrollIntoViewIfNeeded()
    await check(p, '项目首页-项目教训', ['项目教训 · 5', '已改写', '后台命令报完成后先看用时'])
    await p
      .getByRole('button', { name: /新增支付方式写进/ })
      .first()
      .click()
    await check(p, '项目教训-改写记录', ['改写记录', '为什么改', '提取全局教训'])
    // 提取全局教训：AI 给出的改动逐条勾选，确认后写进去
    await p.getByRole('button', { name: '提取全局教训' }).first().click()
    await p.getByText('把这个项目里换个项目也适用的教训提取出来').first().click()
    await check(p, '提取全局教训', ['确认写入全局教训', '新加'])
    await p.getByRole('button', { name: '确认写入全局教训' }).click()
    await check(p, '提取全局教训-已写入', ['条全局教训'])
    await p.keyboard.press('Escape')
  } else errors.push('项目设置：项目页上没有「项目设置」按钮')

  // 新建项目：没单独选工作流时按「通用项目」算（正式版启动时自动装好，演示里先手动添加），
  // 初始化完不应用任何推荐（比如推荐都和当前一致、「全部应用」没东西可点）也要能点「创建」
  await p.goto(base + '#/workflows')
  await p.getByRole('button', { name: '添加内置或导入的工作流' }).first().click()
  await p.getByRole('menuitem', { name: '从内置工作流添加' }).click()
  await p
    .getByRole('dialog')
    .locator('li', { has: p.getByText('通用项目', { exact: true }) })
    .getByRole('button', { name: '添加', exact: true })
    .click()
  await p.getByRole('dialog').waitFor({ state: 'hidden', timeout: 20000 })
  await p.goto(base + '#/projects')
  const createButton = () => p.getByRole('dialog').getByRole('button', { name: '创建', exact: true })
  const newProject = async (dirPath) => {
    await p.getByRole('button', { name: '新建项目' }).first().click()
    await p.getByRole('dialog').getByLabel('本地目录').fill(dirPath)
  }
  await newProject('/home/demo/code/notes')
  await check(p, '新建项目-未初始化', ['才能保存'])
  assert.equal(await createButton().isDisabled(), true, '新建项目：没初始化时「创建」应该不能点')
  await p.getByRole('dialog').getByRole('button', { name: 'AI 初始化项目' }).first().click()
  await p
    .getByRole('button', { name: '查看推荐并应用' })
    .click({ timeout: 20000 })
    .catch(() => errors.push('新建项目：等不到「查看推荐并应用」'))
  await check(p, '新建项目-初始化完成', ['初始化完成', '推荐设置'])
  if (await createButton().isDisabled()) errors.push('新建项目：初始化完成后「创建」还是不能点')
  else {
    await createButton().click()
    await p
      .getByRole('dialog')
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => errors.push('新建项目：点「创建」后弹窗没关（创建失败）'))
    await check(p, '新建项目-已创建', ['notes'])
  }

  // 目录里已有初始化写好的 AGENTS.md 和文档：认出来，不用再初始化就能创建
  await newProject('/home/demo/code/lua-helper')
  await p
    .getByRole('dialog')
    .getByText('才能保存')
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => errors.push('新建项目：目录已经初始化过，还要求先初始化'))
  if (await createButton().isDisabled()) errors.push('新建项目：目录已经初始化过，「创建」还是不能点')
  await p.getByRole('dialog').getByRole('button', { name: 'AI 初始化', exact: true }).click()
  await check(p, '新建项目-目录已初始化', ['目录已经初始化过', '重新初始化'])
  await p.keyboard.press('Escape')
})
