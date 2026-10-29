/**
 * 界面检查分片：任务页的抓取与杂项：元素抓取投递、提问右键菜单、差异窗口、执行计划、
 * 展开过程与右栏菜单、文件拖入、对话进程与内存曲线、执行中发消息与输入法、
 * 提问窗口、子对话提出的问题。
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 * 任务页按主题拆成 02 / 02b / 02c 三片：三片都用 scripts/ui/task-page.mjs 的同一个开场进入，
 * 各片自己重建前置状态，不依赖别的分片先跑过，任意顺序都能跑。
 */

import { runShard } from './harness.mjs'
import { childView, closeChildTab, openCartTask, taskPageHelpers } from './task-page.mjs'

await runShard(import.meta.filename, async (api) => {
  const { base, page, check, errors } = api
  const p = await openCartTask(api)
  const { waitToastsGone, backToTask, closed } = taskPageHelpers(p, api)

  // 抓取元素：从哪个输入框的按钮进入，抓到的引用就填回哪个输入框（父对话 + 右栏子对话同时在场时也不能插错）。
  // 以前按焦点 / 最近聚焦猜，两个输入框都在时容易把引用插到另一个对话。
  // 用独立页面跑：这条用例会往两个输入框里塞引用卡片、开关设置弹窗，放在主页面会把后面的焦点用例带脏
  {
    const d = await page({ width: 1440, height: 900 })
    // 新上下文自己生成一份演示数据：从首页进入、点列表里的那条对话，和本分片开头一致
    await d.goto(base)
    const conv = d.getByText('购物车右上角', { exact: false }).first()
    await conv
      .waitFor({ timeout: 15000 })
      .catch(() => errors.push('抓取投递：新页面的演示数据没生成出来（找不到对话列表项）'))
    await conv.click()
    await d.locator('#follow-up').waitFor({ timeout: 10000 })
    await d.getByRole('button', { name: '设置' }).first().click()
    await d.getByRole('switch', { name: '开发者模式' }).click()
    await d.keyboard.press('Escape')
    await d
      .getByText('开发者模式')
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    // 中间打开一个子对话：页面上有父对话（藏在父对话页签后面）和子对话两个输入框
    const env = d.locator('button[aria-label="环境"]').first()
    await env.click()
    await d.getByText('独立分支', { exact: true }).first().waitFor({ timeout: 5000 })
    await d
      .locator('[data-worktree-row]')
      .filter({ hasText: 'Git+worktree 不再提示文件撞车' })
      .getByRole('button', { name: '在中间打开子对话「Git+worktree 不再提示文件撞车」' })
      .click()
    const childPane = childView(d)
    await childPane
      .locator('#follow-up')
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('抓取投递：中间子对话的输入框没出来'))
    // 两个输入框的 id 都是 #follow-up（同一个组件），按所在区域区分：子对话在 [data-child-view] 里
    // 切回父对话页签后子对话区域藏起来、读屏树里没有：输入框按 DOM 找，计数不受显隐影响
    const childBox = d.locator('[data-child-view] #follow-up')
    const parentBox = d.locator('#follow-up').first()
    if ((await d.locator('#follow-up').count()) !== 2)
      errors.push(`抓取投递：页面上应该有父对话和子对话两个输入框（实际 ${await d.locator('#follow-up').count()} 个）`)
    // 抓取按钮和输入框不在同一个元素里（按钮在 composer 根上、输入框是它的子节点），所以不能靠容器定位；
    // 按 DOM 顺序取两个按钮，并显式校验归属：第一个在子对话区域外面（父对话），第二个在子对话区域里
    const pickBtns = d.getByLabel('抓取界面元素', { exact: true })
    const inPane = (i) => pickBtns.nth(i).evaluate((el) => !!el.closest('[data-child-view]'))
    if ((await pickBtns.count()) !== 2) errors.push('抓取投递：两个输入框旁边应该各有一个抓取按钮')
    if (await inPane(0)) errors.push('抓取投递：第一个抓取按钮居然在子对话里，用例的定位假设不成立')
    if (!(await inPane(1))) errors.push('抓取投递：第二个抓取按钮不在子对话里，用例的定位假设不成立')
    /** 在指定输入框里抓一个元素：点它的按钮 → 中键点页面上的元素 → 等抓取退出 */
    const pickInto = async (which, where) => {
      const overlay = d.locator('[data-element-picker]')
      await pickBtns.nth(which).click()
      const on = await overlay.waitFor({ timeout: 5000 }).then(
        () => true,
        () => false,
      )
      if (!on) return errors.push(`抓取投递：点${where}的抓取按钮没有进入抓取模式`)
      // 先把焦点挪到页面空白处：这条用例验的是「按点的是哪个按钮」判定，
      // 不能让焦点 / 最近聚焦恰好猜对，否则测不出改动的行为
      await d.locator('body').click({ position: { x: 5, y: 5 } })
      // 抓 page 上的一个具体元素（横向导航栏的「任务」）：抓什么不重要，重要的是它落在哪个输入框
      const nav = await d.getByRole('navigation', { name: '主导航' }).boundingBox()
      if (!nav) return errors.push('抓取投递：找不到侧边导航，没地方中键抓取')
      await d.mouse.move(nav.x + nav.width / 2, nav.y + 40)
      await d.mouse.click(nav.x + nav.width / 2, nav.y + 40, { button: 'middle' })
      await overlay
        .waitFor({ state: 'detached', timeout: 5000 })
        .catch(() => errors.push(`抓取投递：在${where}抓完没有退出抓取`))
    }
    /** 卡片张数：隔一会儿再读不算验证，直接等它变多 / 保持不变 */
    const chipCount = (scope) => scope.locator('[data-chip="quote"]').count()
    const beforeChild = await chipCount(childBox)
    const beforeParent = await chipCount(parentBox)
    await pickInto(1, '子对话输入框')
    // 等待条件必须和断言同作用域（都是子对话输入框内部）：[data-child-view] 是整个子对话区域，
    // 消息流里的引用卡片也用 data-chip 标记，拿整栏计数当同步点会被旧卡片提前满足
    const childGot = await d
      .waitForFunction(
        (n) => document.querySelectorAll('[data-child-view] #follow-up [data-chip="quote"]').length > n,
        beforeChild,
        { timeout: 5000 },
      )
      .then(
        () => true,
        () => false,
      )
    if (!childGot) errors.push('抓取投递：从子对话的按钮进入抓取，引用没有填回子对话输入框')
    if ((await chipCount(parentBox)) !== beforeParent)
      errors.push('抓取投递：从子对话的按钮进入抓取，引用却填进了父对话输入框')
    if ((await chipCount(childBox)) <= beforeChild) errors.push('抓取投递：子对话输入框里没有多出引用卡片')
    await check(d, '元素抓取-投给点按钮的那个输入框')
    // 反过来：切回父对话页签（子对话页签留着），从父对话的按钮进入，要填回父对话
    await d.getByRole('tablist', { name: '对话页签' }).getByRole('tab').first().click()
    await pickInto(0, '父对话输入框')
    if ((await chipCount(parentBox)) <= beforeParent)
      errors.push('抓取投递：从父对话的按钮进入抓取，引用没有填回父对话输入框')
    if ((await chipCount(childBox)) !== beforeChild + 1)
      errors.push('抓取投递：从父对话的按钮进入抓取，子对话输入框多出了引用卡片')
    await check(d, '元素抓取-父对话按钮投父对话')
    await d.close()
  }

  // 「提问」的右键菜单：关掉父对话的提问时已创建的子对话一起关；右键勾上「子对话也提问」时
  // 先问已有子对话要不要一起开，默认只对之后新建的生效
  {
    const d = await page({ width: 1440, height: 900 })
    await d.goto(base)
    await d
      .getByText('购物车右上角', { exact: false })
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => errors.push('提问联动：新页面的演示数据没生成出来'))
    await d.getByText('购物车右上角', { exact: false }).first().click()
    await d.locator('#follow-up').waitFor({ timeout: 10000 })
    const pane = () => childView(d)
    const parentAsk = d.getByRole('button', { name: 'AI 有问题时问我' }).first()
    if (await parentAsk.evaluate((el) => !!el.closest('[data-child-view]')))
      errors.push('提问联动：第一个提问按钮不在父对话里')
    const openChild = async () => {
      await d.locator('button[aria-label="环境"]').first().click()
      await d.getByText('独立分支', { exact: true }).first().waitFor({ timeout: 5000 })
      await d
        .locator('[data-worktree-row]')
        .filter({ hasText: 'Git+worktree 不再提示文件撞车' })
        .getByRole('button', { name: '在中间打开子对话「Git+worktree 不再提示文件撞车」' })
        .click()
      await pane().locator('#follow-up').waitFor({ timeout: 10000 })
    }
    const closeChild = async () => {
      await closeChildTab(d).click()
      await d
        .locator('[data-child-view]')
        .waitFor({ state: 'detached', timeout: 5000 })
        .catch(() => {})
    }
    // 右栏重开后重新取一次任务：演示里的联动改了记录，不保证推送到已经打开的面板
    const childAskOn = async () => {
      const btn = pane().getByRole('button', { name: 'AI 有问题时问我' }).first()
      return (await btn.getAttribute('aria-pressed')) === 'true'
    }
    const reopenChild = async () => {
      // 父对话在前台时子对话区域藏着（读屏树里没有），按 DOM 判断它还挂没挂着
      if (await d.locator('[data-child-view]').count()) await closeChild()
      await openChild()
    }

    /** 子对话页签开着时父对话藏在后面：点父对话页签切回来再点它的按钮（子对话页签留着） */
    const toParent = () => d.getByRole('tablist', { name: '对话页签' }).getByRole('tab').first().click()
    await openChild()
    if (!(await childAskOn())) errors.push('提问联动：新建的子对话默认就该开着提问')
    await toParent()
    // 右键父对话的提问按钮：菜单里出现「子对话也提问」，默认勾着（父对话自己开着提问）
    await parentAsk.click({ button: 'right' })
    const item = d.getByRole('menuitemcheckbox', { name: '子对话也提问' })
    await item
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('提问菜单：右键父对话的提问按钮没有出现「子对话也提问」'))
    if ((await item.getAttribute('aria-checked').catch(() => null)) !== 'true')
      errors.push('提问菜单：默认应该勾选「子对话也提问」')
    await check(d, '任务-提问右键菜单', ['只对之后新建的子对话生效'])
    await d.keyboard.press('Escape')
    // 关掉父对话的提问：已创建的子对话一起关
    await parentAsk.click()
    await reopenChild()
    if (await childAskOn()) errors.push('提问联动：父对话关掉提问后，已创建的子对话没有一起关')
    // 再打开父对话的提问：只开自己，之前被关掉的子对话不该自动打开
    await closeChild()
    await parentAsk.click()
    await reopenChild()
    if (await childAskOn()) errors.push('提问联动：重新打开父对话后，已创建的子对话不该自动打开')
    // 右键取消勾选：只影响之后新建的子对话，不弹窗
    await closeChild()
    await parentAsk.click({ button: 'right' })
    const menuItem = d.getByRole('menuitemcheckbox', { name: '子对话也提问' })
    await menuItem.waitFor({ timeout: 5000 }).catch(() => errors.push('提问菜单：第二次右键没有出现「子对话也提问」'))
    if ((await menuItem.getAttribute('aria-checked').catch(() => null)) !== 'true')
      errors.push('提问菜单：重新打开父对话提问后这一项应该还是勾着的')
    await menuItem.click()
    if (await d.getByRole('dialog').count()) errors.push('提问菜单：取消勾选不该弹选择窗口')
    await openChild()
    if (await childAskOn()) errors.push('提问菜单：取消勾选不该打开已创建的子对话')
    // 再勾上：这次是从未勾选变勾选，要弹窗问已有子对话要不要一起开，默认停在「只对之后新建」
    await closeChild()
    await parentAsk.click({ button: 'right' })
    await d.getByRole('menuitemcheckbox', { name: '子对话也提问' }).click()
    const dialog = d.getByRole('dialog')
    await dialog.waitFor({ timeout: 5000 }).catch(() => errors.push('提问菜单：勾上「子对话也提问」没有弹出选择窗口'))
    // 弹窗没出来时后面的点击会等满超时再抛错，把整个分片打断：先判在不在
    if (await dialog.count()) {
      const focused = (await d.evaluate(() => document.activeElement?.textContent ?? '')).trim()
      if (focused !== '只对之后新建的子对话')
        errors.push(`提问菜单：选择窗口默认焦点应该在「只对之后新建的子对话」上（实际「${focused}」）`)
      await dialog.getByRole('button', { name: '应用到已创建的子对话' }).click()
    }
    await openChild()
    if (!(await childAskOn())) errors.push('提问菜单：选「应用到已创建」后子对话的提问没有打开')
    await check(d, '任务-提问应用到已创建')
    await d.close()
  }

  // 差异窗口：文件头带统计和上一个/下一个文件，左右对照有行内高亮，可切上下对照
  {
    await backToTask()
    await p.getByRole('tab', { name: /改动/ }).click()
    await check(p, '改动-文件列表', ['改动 2 个文件', 'CartBadge.tsx', 'RestockButton.tsx'])
    await p.getByTitle('查看「src/components/CartBadge.tsx」的改动', { exact: true }).click()
    await check(p, '差异-左右对照', ['CartBadge.tsx', '处改动', '+5', '-3', '1 / 2', 'items.reduce'])
    // 修改行要标出行内改动（整行底色之外还有更深的一小段）
    if (!(await p.locator('[role="dialog"] [data-diff-mark]').count())) errors.push('差异窗口：修改行没有行内高亮')
    await p.getByRole('radio', { name: '上下对照' }).click()
    await check(p, '差异-上下对照', ['CartBadge.tsx', 'useEffect', 'document.title'])
    await p.getByRole('button', { name: '下一个文件', exact: true }).click()
    await check(p, '差异-下一个文件', ['RestockButton.tsx', '到货通知我', '2 / 2'])
    // 窄窗口：弹窗保持打开，直接把视口缩小；双栏只在自己的滚动区里横向滚动，页面本身不出横向滚动条
    await p.setViewportSize({ width: 820, height: 800 })
    await check(p, '差异-窄窗口', ['2 / 2', '到货通知我'])
    await p.getByRole('radio', { name: '左右对照' }).click()
    await check(p, '差异-窄窗口-左右', ['2 / 2'])
    await p.keyboard.press('Escape')
    await closed()
    // 浅色主题下再看一眼：整行底色、行内高亮、中缝和行号都要跟着主题走
    await p.setViewportSize({ width: 1440, height: 900 })
    await p.evaluate(() => document.documentElement.classList.remove('dark'))
    await p.getByTitle('查看「src/components/CartBadge.tsx」的改动', { exact: true }).click()
    await check(p, '差异-浅色', ['CartBadge.tsx', 'items.reduce'])
    await p.keyboard.press('Escape')
    await closed()
    await p.evaluate(() => document.documentElement.classList.add('dark'))
    await p.reload()
    await backToTask()
  }

  // 执行计划：输入框上方的按钮，点开是计划窗口（进行中的主步骤展开子步骤），以前的计划收在下面
  await p.getByRole('button', { name: '执行计划' }).click()
  await check(p, '执行计划', ['修复购物车角标', '等：端到端测试', '覆盖删除商品后角标归零', '以前的计划 · 1'])
  // 每个计划项右侧带耗时、顶部带总用时：进行中的在涨、完成的固定、待做的不显示；
  // 用时从标题下方的小字里搬走了，等待中的那一项只剩「等：…」
  {
    const readPlan = () =>
      p.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"][aria-label="执行计划"]')
        if (!dlg) return null
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
        // 按标题那一格定位到它自己的行，子步骤的用时不会被当成主步骤的
        const titleSpan = (title) => [...dlg.querySelectorAll('span')].find((s) => norm(s.textContent) === title)
        const timeOf = (title) => norm(titleSpan(title)?.parentElement?.querySelector('[data-plan-time]')?.textContent)
        const metaOf = (title) =>
          norm(titleSpan(title)?.parentElement?.parentElement?.querySelector('span.line-clamp-2')?.textContent)
        const total = dlg.querySelector('[data-plan-total]')
        const cur = document.querySelector('[data-plan-current-time]')
        const bar = dlg.querySelector('[data-plan-bar]')
        const updated = dlg.querySelector('[data-plan-updated]')
        return {
          total: norm(total?.textContent),
          // 进度条：1/4（演示计划：1 步完成、1 步等待、1 步进行中、1 步失败）
          bar: bar
            ? { now: Number(bar.getAttribute('aria-valuenow')), max: Number(bar.getAttribute('aria-valuemax')) }
            : null,
          // 「N 分钟前更新」：演示里进行中的那一步 12 分钟没动，应该带上警示色
          updated: norm(updated?.textContent),
          updatedWarning: updated ? [...updated.classList].includes('text-warning') : false,
          // 滞后步骤旁边的小标记、失败状态的图标
          stale: !!dlg.querySelector('[data-plan-stale-step]'),
          failedIcon: [...dlg.querySelectorAll('[role="img"]')].some((e) => e.getAttribute('aria-label') === '失败'),
          totalLabel: total?.getAttribute('aria-label') || '',
          items: [...dlg.querySelectorAll('[data-plan-time]')].map((e) => ({
            text: norm(e.textContent),
            label: e.getAttribute('aria-label') || '',
          })),
          current: { text: norm(cur?.textContent), label: cur?.getAttribute('aria-label') || '' },
          done: timeOf('角标订阅购物车变化'),
          running: timeOf('覆盖删除商品后角标归零'),
          waitingMeta: metaOf('跑端到端测试'),
          doneMeta: metaOf('角标订阅购物车变化'),
        }
      })
    const a = await readPlan()
    if (!a) errors.push('执行计划：没找到计划窗口')
    else {
      // fmtDuration 的几种写法：毫秒、秒、分+秒、时+分、天+时
      const duration = (text) => /^(\d+ms|(\d+d )?\d+h \d+m|\d+d \d+h|(\d+m )?\d+(\.\d+)?s)$/.test(text)
      if (!duration(a.total)) errors.push(`执行计划：顶部没有显示总用时（「${a.total}」）`)
      if (!a.totalLabel.startsWith('总用时 '))
        errors.push(`执行计划：总用时缺少「总用时」说明（aria-label「${a.totalLabel}」）`)
      // 完成 1 项 + 等待 1 项 + 进行中 1 项 + 子步骤完成/进行中各 1 项；待做的两项没有耗时
      if (a.items.length !== 5) errors.push(`执行计划：${a.items.length} 项有耗时，应该是 5 项（待做的两项不显示）`)
      for (const x of a.items) {
        if (!duration(x.text)) errors.push(`执行计划：耗时「${x.text}」不是时长格式`)
        if (!x.label.startsWith('用时 ')) errors.push(`执行计划：耗时缺少「用时」说明（aria-label「${x.label}」）`)
      }
      if (!a.current.text || !a.current.label.startsWith('用时 '))
        errors.push(`执行计划：计划按钮上正在做的那一步没有带耗时（「${a.current.text}」/「${a.current.label}」）`)
      if (!duration(a.done) || !duration(a.running))
        errors.push(`执行计划：完成/进行中的步骤没有耗时（完成「${a.done}」、进行中「${a.running}」）`)
      if (a.waitingMeta !== '等：端到端测试')
        errors.push(`执行计划：等待中的说明不对（「${a.waitingMeta}」，应该只有「等：端到端测试」）`)
      if (a.doneMeta) errors.push(`执行计划：完成的步骤下面还重复显示用时（「${a.doneMeta}」）`)
      // ADR 0020：进度条、「N 分钟前更新」、滞后警示、失败态都要在界面上看得见
      if (!a.bar || a.bar.now !== 1 || a.bar.max !== 4)
        errors.push(`执行计划：进度条不对（${JSON.stringify(a.bar)}），应该是 1/4`)
      if (!/分钟前更新|刚刚更新/.test(a.updated)) errors.push(`执行计划：没有显示「N 分钟前更新」（「${a.updated}」）`)
      if (!a.updatedWarning)
        errors.push(`执行计划：计划 12 分钟没更新了，「N 分钟前更新」没有用警示色（「${a.updated}」）`)
      if (!a.stale) errors.push('执行计划：进行中的步骤 12 分钟没变化，旁边没有滞后标记')
      if (!a.failedIcon) errors.push('执行计划：失败的步骤没有失败图标')
      // 进行中每秒在涨；完成的用 endedAt 固定住
      await p.waitForTimeout(1600)
      const b = await readPlan()
      if (!b) errors.push('执行计划：等了一秒后计划窗口不见了')
      else {
        if (b.total === a.total) errors.push(`执行计划：进行中总用时没有走（一直是 ${a.total}）`)
        if (b.running === a.running) errors.push(`执行计划：进行中的步骤耗时没有走（一直是 ${a.running}）`)
        if (b.done !== a.done) errors.push(`执行计划：完成的步骤耗时还在变（${a.done} → ${b.done}）`)
      }
    }
    await p.keyboard.press('Escape')
  }
  // 计划项的状态图标：进行中和等待中不能长得一样（以前一个转、一个沙漏）。
  // 读计算样式断言：形状（border-style）、动效类型和节奏（animationName + duration）、颜色、透明度、
  // 尺寸档位、有没有残留 SVG。只断言「有图标」拦不住两个状态被改成一样
  {
    await p.getByRole('button', { name: '执行计划' }).click()
    const readIcons = () =>
      p.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"][aria-label="执行计划"]')
        if (!dlg) return null
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const iconOf = (label) => {
          const icon = [...dlg.querySelectorAll('[role="img"]')].find((e) => e.getAttribute('aria-label') === label)
          if (!icon) return null
          const cs = getComputedStyle(icon)
          // 尺寸读布局值（offsetWidth/Height），不用 getBoundingClientRect：后者返回旋转后的包围盒，
          // 「进行中」在 animate-spin 转着，斜到 45° 时 18px 的正方形包围盒会胀成 ~25px，会让断言忽大忽小
          return {
            style: cs.borderStyle,
            color: cs.borderTopColor,
            // 等待中是 opacity 0.9→0.5 的呼吸，淡相也不能淡到看不见
            opacity: Number(cs.opacity),
            transform: norm(cs.transform),
            // 动画一栏：等待中是 1.6s 原地呼吸，进行中是 1s 旋转，名字和时长都不同
            spin: norm(cs.animationName) + ' ' + norm(cs.animationDuration),
            size: icon.offsetWidth + 'x' + icon.offsetHeight,
            // 图标自己不能带文字（沙漏那种内联 SVG 已经删掉，这里留一条防线）
            svg: icon.querySelectorAll('svg').length,
          }
        }
        return { running: iconOf('进行中'), waiting: iconOf('等待中'), pending: iconOf('待做'), done: iconOf('完成') }
      })
    const icons = await readIcons()
    if (!icons) errors.push('执行计划：没找到计划窗口，核对不到状态图标')
    else if (!icons.running || !icons.waiting || !icons.pending || !icons.done)
      errors.push(
        `执行计划：状态图标不全（进行中 ${!!icons.running}、等待中 ${!!icons.waiting}、待做 ${!!icons.pending}、完成 ${!!icons.done}）`,
      )
    else {
      // 1. 形状不同：等待中是虚线环，进行中是实线（一圈只有一道弧）
      if (icons.waiting.style === icons.running.style)
        errors.push(`执行计划：等待中和进行中的边框样式一样（都是 ${icons.waiting.style}），静态下分不开`)
      if (icons.waiting.style !== 'dashed')
        errors.push(`执行计划：等待中不是虚线环（border-style=${icons.waiting.style}）`)
      if (icons.running.style !== 'solid')
        errors.push(`执行计划：进行中不是实线弧（border-style=${icons.running.style}）`)
      // 2. 动效不能用同一套：等待中是原地呼吸（改 opacity），进行中是旋转（改 transform）
      if (icons.waiting.spin === icons.running.spin)
        errors.push(`执行计划：等待中和进行中的动效完全一样（${icons.waiting.spin}），只有颜色不同不够分`)
      if (/none/.test(icons.waiting.spin) || /none/.test(icons.running.spin))
        errors.push(`执行计划：状态图标没在动（进行中 ${icons.running.spin}、等待中 ${icons.waiting.spin}）`)
      if (icons.waiting.spin === icons.pending.spin)
        errors.push(`执行计划：等待中和待做的动效一样（${icons.waiting.spin}），等待中该在动、待做该静止`)
      // 进行中是旋转（Tailwind 的 spin 关键帧）、等待中是呼吸：同一个关键帧就分不出「在做」和「在等」
      if (!/^spin /.test(icons.running.spin)) errors.push(`执行计划：进行中不再是旋转（${icons.running.spin}）`)
      if (icons.waiting.spin.split(' ')[0] === icons.running.spin.split(' ')[0])
        errors.push(`执行计划：等待中和进行中用的是同一组关键帧（${icons.waiting.spin.split(' ')[0]}）`)
      // 等距虚线绕圆心转一圈和自身重合，看起来像没在动：呼吸用的关键帧不能让圆环转起来
      if (icons.waiting.transform && icons.waiting.transform !== 'none')
        errors.push(`执行计划：等待中的圆环带了 transform（${icons.waiting.transform}），呼吸不该带位移/旋转`)
      // 3. 颜色只作辅助，但也不能是同一个
      if (icons.waiting.color === icons.running.color)
        errors.push(`执行计划：等待中和进行中同色（${icons.waiting.color}）`)
      // 等待中靠透明度呼吸：整体不能是不透明的，淡相也不能淡到看不见（否则跟待做的静止空心圆混）
      if (icons.waiting.opacity >= 1)
        errors.push(`执行计划：等待中的圆环不透明（${icons.waiting.opacity}），呼吸靠的是 opacity`)
      const PULSE_FLOOR = 0.4
      if (icons.waiting.opacity < PULSE_FLOOR)
        errors.push(`执行计划：等待中最淡的一相只有 ${icons.waiting.opacity}，会淡到看不见`)
      if (icons.pending.opacity !== 1) errors.push(`执行计划：待做不该是半透明的（${icons.pending.opacity}）`)
      // 待做是静止的空心圆：和等待中靠「有没有动」分开
      if (!/none/.test(icons.pending.spin)) errors.push(`执行计划：待做的图标在动（${icons.pending.spin}）`)
      if (icons.pending.style === icons.waiting.style)
        errors.push('执行计划：待做和等待中的边框样式一样，一个是空心圆一个是虚线环才对')
      // 换图标不能把计划行搞乱：图标盒子只有两种合法尺寸，不同层级本来就不同大小（主步骤 18px、子步骤 14px），
      // 不跨层级比；要防的是换了图标后盒子缩了/胀了，所以只看每个状态落在不落在合法档位里
      const LEGAL_SIZES = ['14x14', '18x18']
      for (const [name, icon] of [
        ['进行中', icons.running],
        ['等待中', icons.waiting],
        ['待做', icons.pending],
        ['完成', icons.done],
      ])
        if (!LEGAL_SIZES.includes(icon.size))
          errors.push(`执行计划：「${name}」的图标尺寸是 ${icon.size}，只允许 ${LEGAL_SIZES.join(' / ')}`)
      if (icons.waiting.svg) errors.push(`执行计划：等待中的图标里还嵌着 ${icons.waiting.svg} 个 SVG（沙漏应已删掉）`)
      // 折叠头「n 个在等待」前面的小环和计划项里的等待环是同一套样式。
      // 注意：不能从 [data-plan-total] 往上找 button —— 它渲染在对话框 header 的 span 里，祖先链上没有 button，
      // 那样取会永远是空、这条断言静默空转。改成按文字找那个折叠按钮，找不到也算失败
      const headRing = await p.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => /个在等待/.test(b.textContent || ''))
        const ring = btn?.querySelector('.plan-wait-ring')
        return ring ? getComputedStyle(ring).borderStyle : ''
      })
      if (!headRing) errors.push('执行计划：折叠头「n 个在等待」前面没找到等待环')
      else if (headRing !== 'dashed') errors.push(`执行计划：折叠头的小环不是虚线（border-style=${headRing}）`)
      // 截一张同时含「进行中」和「等待中」的计划图：形状能不能一眼分开得看图确认，光断言样式不够
      await check(p, '执行计划-状态图标形状对比')
    }
    await p.keyboard.press('Escape')
  }
  // 全部完成后总用时停在最晚一项的结束时间，不再每秒增长
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k))
      const task = db.tasks.find((x) => x.title.includes('购物车'))
      const plan = task.plans.at(-1)
      const iso = (ms) => new Date(ms).toISOString()
      const end = Date.now() - 60_000
      plan.steps.forEach((s, i) => {
        const start = end - 240_000 + i * 40_000
        s.status = 'done'
        s.startedAt = iso(start)
        s.endedAt = iso(start + 30_000)
        s.waits = []
        for (const [j, c] of (s.children ?? []).entries()) {
          c.status = 'done'
          c.startedAt = iso(start + j * 5_000)
          c.endedAt = iso(start + (j + 1) * 5_000)
        }
      })
      plan.doneAt = iso(end)
      localStorage.setItem(k, JSON.stringify(db))
    }, key)
    await p.reload()
    await backToTask()
    await p.getByRole('button', { name: '执行计划' }).click()
    const total = () =>
      p.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"][aria-label="执行计划"]')
        return (dlg?.querySelector('[data-plan-total]')?.textContent ?? '').replace(/\s+/g, ' ').trim()
      })
    const first = await total()
    await p.waitForTimeout(1800)
    const second = await total()
    if (!first) errors.push('执行计划：全部完成后不显示总用时')
    else if (second !== first) errors.push(`执行计划：全部完成后总用时还在涨（${first} → ${second}）`)
    await check(p, '执行计划-完成后停住')
    await p.keyboard.press('Escape')
    // 提前结束（finish_plan）但还有没做完的步骤：折叠头不能说「计划已完成」，也不能和列表里的「等待中」同屏打架。
    // 用户报过这条：面板写着「✓ 计划已完成」，展开后最后一步还是橙色虚线环的等待中
    {
      const key2 = 'agent-panel-demo-v3'
      await p.evaluate((k) => {
        const db = JSON.parse(localStorage.getItem(k))
        const task = db.tasks.find((x) => x.title.includes('购物车'))
        const plan = task.plans.at(-1)
        // 前面几步做完，最后一步停在等待中没结算，计划却已经结束
        plan.steps.forEach((s, i) => {
          const last = i === plan.steps.length - 1
          s.status = last ? 'waiting' : 'done'
          s.waits = last ? [{ kind: 'background', ref: 'lint01', label: 'lint + 单测', state: 'waiting' }] : []
          // 最后一步自带子步骤（截图里那一步也拆成两件事）：这样「数条目」和「数主步骤」两种口径会分叉，
          // 下面那条数字断言才拦得住——两边都只有一步时，两种算法得出的数一样，断言是空的
          const kid = (id, title, status) => ({
            id,
            title,
            status,
            note: '',
            waits: [],
            startedAt: '',
            endedAt: '',
          })
          s.children = last
            ? [kid('9.1', '跑 lint', 'done'), kid('9.2', '跑单元测试', 'running'), kid('9.3', '看失败用例', 'pending')]
            : (s.children || []).map((c) => ({ ...c, status: 'done', waits: [] }))
        })
        plan.doneAt = new Date().toISOString()
        localStorage.setItem(k, JSON.stringify(db))
      }, key2)
      await p.reload()
      await backToTask()
      const head = await p.evaluate(() => {
        const btn = document.querySelector('button[aria-label="执行计划"]')
        return (btn?.textContent || '').replace(/\s+/g, ' ').trim()
      })
      if (/计划已完成/.test(head))
        errors.push(`执行计划-提前结束：还有没做完的步骤却写着「计划已完成」（折叠头「${head}」）`)
      if (!/计划已结束/.test(head)) errors.push(`执行计划-提前结束：折叠头没写「计划已结束」（「${head}」）`)
      if (!/没做完/.test(head)) errors.push(`执行计划-提前结束：没说还有几步没做完（「${head}」）`)
      await p.getByRole('button', { name: '执行计划' }).click()
      // 计划已经结束：里面没做完的步骤不能再画成等待中（橙色虚线环呼吸），读作「未完成」
      const inside = await p.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"][aria-label="执行计划"]')
        if (!dlg) return null
        const labels = [...dlg.querySelectorAll('[role="img"]')].map((e) => e.getAttribute('aria-label'))
        return { labels, expired: !!dlg.querySelector('.plan-wait-ring') }
      })
      if (!inside) errors.push('执行计划-提前结束：没找到计划窗口')
      else {
        if (inside.labels.includes('等待中'))
          errors.push('执行计划-提前结束：计划已结束，里面还有读作「等待中」的步骤（应显示为「未完成」）')
        if (inside.expired) errors.push('执行计划-提前结束：计划已结束，里面还画着等待中的虚线环')
        if (!inside.labels.includes('未完成')) errors.push('执行计划-提前结束：没做完的步骤没有标成「未完成」')
        const same = await p.evaluate(() => {
          const btn = document.querySelector('button[aria-label="执行计划"]')
          const dlg = document.querySelector('[role="dialog"][aria-label="执行计划"]')
          return /计划已完成/.test(btn?.textContent || '') && !!(dlg && dlg.querySelector('.plan-wait-ring'))
        })
        if (same) errors.push('执行计划-提前结束：「计划已完成」和等待中的步骤同时出现在一屏')
        // 折叠头的「n 步没做完」和窗内的进度必须是同一套计数标准（以前 leftSteps 数条目、进度数主步骤，
        // 带子步骤的计划会同时出现「3 步没做完」和「3/4」，用户看不出到底还剩几步）
        const nums = await p.evaluate(() => {
          const btn = document.querySelector('button[aria-label="执行计划"]')
          const dlg = document.querySelector('[role="dialog"][aria-label="执行计划"]')
          const left = /(\d+) 步没做完/.exec(btn?.textContent || '')?.[1] ?? ''
          const foot = [...(dlg?.querySelectorAll('span') ?? [])]
            .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
            .find((x) => /^\d+\/\d+$/.test(x))
          return { left, foot }
        })
        if (nums.left && nums.foot) {
          const [done, total] = nums.foot.split('/').map(Number)
          if (Number(nums.left) !== total - done)
            errors.push(`执行计划-提前结束：折叠头说「${nums.left} 步没做完」，窗内进度是 ${nums.foot}，两处对不上`)
        }
      }
      await check(p, '执行计划-提前结束')
      await p.keyboard.press('Escape')
      // 演示数据不在这里恢复：下面接着把整份原始数据写回去再刷新
    }
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await p.reload()
    await backToTask()
  }

  // 回复完成后思考和工具调用收进一个折叠，折叠行写这段做了什么；点开能看到过程，再点收起
  {
    const fold = p.getByRole('button', { name: /查看 \d+ 个文件/ }).first()
    await fold.click().catch(() => errors.push('任务：回复完成后没有收起过程的折叠行'))
    await check(p, '任务-展开过程', ['思考过程'])
    await fold.click().catch(() => {})
  }
  // 窄版右栏的右键菜单：能弹出，而且整个菜单都在视口里（不能溢出去）
  {
    const compactRow = p.locator('button[title="package.json"]').first()
    const cb = await compactRow.boundingBox()
    if (!cb) errors.push('任务右栏：没有列出 package.json')
    else {
      await p.mouse.click(cb.x + 40, cb.y + cb.height / 2, { button: 'right' })
      const box = await p
        .locator('[role="menu"]')
        .first()
        .boundingBox()
        .catch(() => null)
      if (!box) errors.push('任务右栏：右键没有弹出菜单')
      else {
        const vw = p.viewportSize().width
        const vh = p.viewportSize().height
        if (box.x < 0 || box.y < 0 || box.x + box.width > vw || box.y + box.height > vh)
          errors.push(`任务右栏：右键菜单超出视口（${JSON.stringify(box)}，视口 ${vw}×${vh}）`)
        await check(p, '任务-右栏右键菜单')
      }
      await p.keyboard.press('Escape')
      await p
        .locator('[role="menu"]')
        .first()
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => {})
    }
  }
  // 按 Agent 显示的对话：滚到回复中部时「谁 + 什么模型」固定在滚动区顶部，下一轮顶走。
  // 演示内容不够长，先把这一轮撑高，再滚到中部看署名行的位置
  {
    const stuck = await p.evaluate(async () => {
      const sc = document.querySelector('[data-conversation-scroll="messages"]')
      const row = [...document.querySelectorAll('*')].find((el) => getComputedStyle(el).position === 'sticky')
      if (!sc || !row) return 'no-sticky'
      const col = row.parentElement
      const pad = document.createElement('div')
      pad.style.height = '1800px'
      col.appendChild(pad)
      sc.scrollTop = 700
      await new Promise((r) => setTimeout(r, 250))
      const top = Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top)
      sc.scrollTop = 900
      await new Promise((r) => setTimeout(r, 250))
      const top2 = Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top)
      return { top, top2, bg: getComputedStyle(row).backgroundColor }
    })
    if (stuck === 'no-sticky') errors.push('署名吸顶：按 Agent 显示的对话里没有吸顶的署名行')
    else if (stuck.top !== 0 || stuck.top2 !== 0)
      errors.push(`署名吸顶：滚到回复中部时署名行没固定在顶部（top=${stuck.top}/${stuck.top2}）`)
    await p.evaluate(() => {
      const sc = document.querySelector('[data-conversation-scroll="messages"]')
      sc.scrollTop = 0
    })
    // 回到底部只浮在消息区里：滚上去后按钮不能跑到消息区外面压住输入框和信息条
    await p.waitForTimeout(150)
    const back = p.getByRole('button', { name: '回到底部' })
    if (!(await back.count())) errors.push('任务-回到底部：往上滚之后没有出现按钮')
    else {
      const b = await back.boundingBox()
      const sc = await p.locator('[data-conversation-scroll="messages"]').boundingBox()
      if (!b || !sc) errors.push('任务-回到底部：拿不到按钮或消息区的位置')
      else if (b.y + b.height > sc.y + sc.height + 1)
        errors.push(
          `任务-回到底部：按钮落在消息区外面（按钮底 ${Math.round(b.y + b.height)}，消息区底 ${Math.round(sc.y + sc.height)}）`,
        )
    }
    await check(p, '任务-回到底部')
    await check(p, '任务-署名吸顶')
  }
  // 启动命令只留图标，点开才显示完整命令
  const cmd = p.getByRole('button', { name: '查看启动命令' }).first()
  if (!(await cmd.count())) errors.push('任务：没有启动命令按钮')
  else {
    await cmd.click()
    await check(p, '任务-启动命令', ['acceptEdits'])
    await p.keyboard.press('Escape')
  }
  if (!(await p.getByPlaceholder('查找文件').count())) errors.push('任务：没有文件搜索框')
  if (!(await p.getByLabel('刷新文件').first().count())) errors.push('任务：没有「刷新文件」')
  // 文件树里的文件左键长按拖到输入框：按住够久才拖起来，松手插入「@相对路径」纯文本，不当附件上传；
  // 拖动之后的补发 click 要压掉（不能顺手把文件打开），短按仍然是打开文件
  {
    const row = p.locator('button[data-file-row][data-path="package.json"]').first()
    const input = p.locator('#follow-up')
    await input.fill('')
    const rb = await row.boundingBox()
    const ib = await input.boundingBox()
    if (!rb || !ib) errors.push('长按拖入：找不到文件行或输入框')
    else {
      await p.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2)
      await p.mouse.down()
      await p.waitForTimeout(420)
      const tx = ib.x + ib.width / 2
      const ty = ib.y + ib.height / 2
      for (let i = 1; i <= 12; i++) {
        await p.mouse.move(rb.x + ((tx - rb.x) * i) / 12, rb.y + ((ty - rb.y) * i) / 12)
        await p.waitForTimeout(25)
      }
      await p.mouse.up()
      await input
        .filter({ hasText: '@package.json' })
        .waitFor({ timeout: 3000 })
        .catch(() => {})
      const text = (await input.textContent()) ?? ''
      if (!text.includes('@package.json')) errors.push(`长按拖入：输入框里没有引用（${JSON.stringify(text)}）`)
      if (await input.locator('[data-chip]').count()) errors.push('长按拖入：引用被做成了附件卡片')
      if (await p.getByRole('dialog').count()) errors.push('长按拖入：拖动把文件也打开了')
      // 行首的 @ 不能是「图标和文字叠在一起」那个坏字形（Maple Mono 的 @ 宽不到 6 或叠字）。
      // 默认界面字体换成 Inter 后 @ 是比例字形，14px 下约 13–14px 宽，上限放到 16
      const atW = await p.evaluate(() => {
        const el = document.querySelector('#follow-up')
        const node = el?.firstChild
        if (!node || node.nodeType !== Node.TEXT_NODE) return 0
        const r = document.createRange()
        r.setStart(node, 0)
        r.setEnd(node, 1)
        return r.getBoundingClientRect().width
      })
      if (atW < 6 || atW > 16) errors.push(`长按拖入：@ 的宽度是 ${atW}，不像正常字形`)
      await check(p, '任务-长按拖入引用', ['@package.json'])
      // 短按还是打开文件
      await row.click()
      await p
        .getByRole('dialog')
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push('长按拖入：短按没有打开文件'))
      await p.keyboard.press('Escape')
      await input.fill('')
    }
  }
  // 从外面把文件拖到消息区（不是输入框）也算引入到要求里：拖入时整页提示，松开后进附件条和内联卡片；
  // 只拖文字时不拦截浏览器默认行为
  {
    const dropped = await p.evaluate(async () => {
      const sc = document.querySelector('[data-conversation-scroll="messages"]')
      if (!sc) return { error: '没有消息区' }
      const box = sc.getBoundingClientRect()
      const at = (dt, x, y) => ({ bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y })
      const file = new DataTransfer()
      file.items.add(new File(['dropped from the message area'], '页面拖入.txt', { type: 'text/plain' }))
      // 模拟真实拖拽：先在消息区进入、在子元素之间移动（enter/leave 交错），提示不能闪掉
      sc.dispatchEvent(new DragEvent('dragenter', at(file, box.left + 80, box.top + 70)))
      sc.dispatchEvent(new DragEvent('dragover', at(file, box.left + 90, box.top + 80)))
      await new Promise((r) => setTimeout(r, 200))
      const inner = sc.querySelector('div')
      if (inner) inner.dispatchEvent(new DragEvent('dragenter', at(file, box.left + 100, box.top + 90)))
      sc.dispatchEvent(new DragEvent('dragleave', at(file, box.left + 100, box.top + 90)))
      await new Promise((r) => setTimeout(r, 250))
      const hint = document.body.textContent.includes('松开鼠标，把文件附到要求里')
      const inputHighlighted = !!document.querySelector('#follow-up')?.closest('.border-accent')
      // 只拖文字：不能 preventDefault
      const text = new DataTransfer()
      text.setData('text/plain', '一段文字')
      const textEvent = new DragEvent('dragover', at(text, box.left + 90, box.top + 80))
      sc.dispatchEvent(textEvent)
      sc.dispatchEvent(new DragEvent('drop', at(file, box.left + 90, box.top + 80)))
      await new Promise((r) => setTimeout(r, 1200))
      return {
        hint,
        inputHighlighted,
        textPrevented: textEvent.defaultPrevented,
        hintAfterDrop: document.body.textContent.includes('松开鼠标，把文件附到要求里'),
        chip: !!document.querySelector('[data-chip="file"][data-name="页面拖入.txt"]'),
        inline: document.body.textContent.includes('页面拖入.txt'),
      }
    })
    if (dropped.error) errors.push(`拖文件：${dropped.error}`)
    else {
      if (!dropped.hint) errors.push('拖文件：在消息区拖入时没有整页提示')
      if (dropped.inputHighlighted) errors.push('拖文件：页面提示和输入框高亮同时出现，叠了两层提示')
      if (dropped.textPrevented) errors.push('拖文件：只拖文字时被拦截了（应该保持浏览器默认行为）')
      if (dropped.hintAfterDrop) errors.push('拖文件：松开后整页提示没有消失')
      if (!dropped.chip) errors.push('拖文件：在消息区松开后要求里没有这张卡片')
      if (!dropped.inline) errors.push('拖文件：附件没有出现在要求里')
    }
    await check(p, '任务-页面拖文件')
    // 这个附件只用于检查拖入，清掉以免影响后面的步骤
    await p
      .locator('[data-chip="file"][data-name="页面拖入.txt"]')
      .first()
      .press('Backspace')
      .catch(() => {})
  }

  // 进程面板只算当前对话及其附属：购物车这个对话有在跑的子对话，面板里要同时出现
  // 「本对话」和「子对话」两组，而且子对话的标题就在面板里（不是页面上别处的同名文字）
  {
    const btn = p.getByRole('button', { name: '对话进程' }).first()
    await btn.click()
    const panel = p.locator('[data-radix-popper-content-wrapper]').filter({ hasText: '内存合计' }).last()
    await panel
      .getByText('内存合计')
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('对话进程-子树：面板没有打开'))
    // 进程列表是打开后才异步拉的：等分组头出来再读，别把「正在读取进程…」当成结果
    await panel
      .getByText('本对话', { exact: true })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => {})
    const text = (await panel.textContent().catch(() => '')) ?? ''
    if (!text.includes('本对话')) errors.push('对话进程-子树：没有「本对话」分组')
    if (!text.includes('子对话')) errors.push('对话进程-子树：父对话没有列出附属子对话的进程')
    if (!text.includes('内存面板增加 AI 分析')) errors.push('对话进程-子树：面板里找不到子对话的进程归属标题')
    await check(p, '任务-对话进程-子树')
    await btn.click()
    await panel.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  }
  // 工作流任务：任务进度按节点列出，节点下面挂验收和它自己派出的子 Agent，窄窗口里从标题栏点开
  await p.getByText('商品详情页增加', { exact: false }).first().click()
  // 对话进程下拉：收起时不挂载面板内容（DOM 里没有节点、也不轮询），展开后才渲染进程列表和内存合计
  const procBtn = p.getByRole('button', { name: '对话进程' }).first()
  await procBtn.waitFor({ timeout: 5000 }).catch(() => errors.push('任务：没有「对话进程」按钮'))
  if ((await p.getByText('内存合计').count()) > 0) errors.push('对话进程：收起状态下面板内容已经挂在 DOM 里')
  await procBtn.click()
  await check(p, '任务-对话进程', [
    '内存合计',
    '清理无效进程',
    '已结束的子任务',
    // 合计行要说明是哪些加起来：这个对话和它的附属（子对话、子任务）
    '这个对话及附属（子对话、子任务）的进程合计',
    '下面按归属分组',
  ])
  // 子对话的进程只算它自己：组头分别标出本对话 / 子对话，内存读不到的写未采集
  await check(p, '任务-对话进程-归属', ['本对话', '子对话'])
  // 内存曲线：原有左右拖动和悬停读数保留；右键也能拖，拖过之后出现「回到最新」
  await p.getByRole('radio', { name: '内存曲线', exact: true }).click()
  await check(p, '任务-内存曲线', ['AI 分析', '每 30 秒采样一次'])
  const chatChart = p.getByRole('img', { name: '会话内存随时间的变化' })
  const chatBox = await chatChart.boundingBox()
  if (!chatBox) errors.push('任务-内存曲线：曲线没有渲染')
  else {
    if (await p.getByRole('button', { name: '回到最新' }).count())
      errors.push('任务-内存曲线：还没拖动就出现了「回到最新」')
    // 往右拖 = 看更早（MemoryChart 的 offset 变大）
    await p.mouse.move(chatBox.x + chatBox.width * 0.2, chatBox.y + chatBox.height / 2)
    await p.mouse.down({ button: 'right' })
    await p.mouse.move(chatBox.x + chatBox.width * 0.8, chatBox.y + chatBox.height / 2, { steps: 8 })
    await p.mouse.up({ button: 'right' })
    await check(p, '任务-内存曲线-右键拖动', ['回到最新'])
    await p.getByRole('button', { name: '回到最新' }).click()
    await p
      .getByRole('button', { name: '回到最新' })
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    if (await p.getByRole('button', { name: '回到最新' }).count())
      errors.push('任务-内存曲线：点了「回到最新」按钮还留着')
  }
  // 收起：面板内容不挂载。放在弹窗前做，聚焦的下拉状态最干净
  await p.getByRole('button', { name: '对话进程' }).first().click()
  await p
    .locator('[aria-label="对话进程"][aria-expanded="false"]')
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => {})
  if ((await p.locator('[aria-label="对话进程"]').first().getAttribute('aria-expanded')) !== 'false')
    errors.push('对话进程：收起后按钮的 aria-expanded 不是 false')
  if ((await p.getByText('内存合计').count()) > 0) errors.push('对话进程：收起后面板内容还挂在 DOM 里')
  // AI 分析：把采样和进程占用交给演示里的 AI 排查对话，在统一的弹窗里出结论（先重新打开下拉）
  await procBtn.click()
  await p.getByRole('radio', { name: '内存曲线', exact: true }).click()
  await p.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await p
    .getByRole('heading', { name: 'AI 排查：会话内存分析' })
    .last()
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('任务-内存曲线：点 AI 分析没有新建排查对话'))
  await check(p, '任务-内存曲线-AI分析', ['这次要做的：看一下这个会话的内存'])
  // 排查的结构化结论画在右栏：页签「结论 / 证据 n / 修复 n / 相关文件 n」，结论页有根因、把握和三个按钮
  {
    const diag = p.locator('[data-analysis-panel="diagnosis"]')
    await diag
      .getByRole('tab', { name: /^结论/ })
      .waitFor({ timeout: 20000 })
      .catch(() => errors.push('AI 排查：右栏没有出现「结论」页签'))
    for (const name of [/^证据\s*\d+/, /^修复\s*\d+/, /^相关文件\s*\d+/])
      if (!(await diag.getByRole('tab', { name }).count())) errors.push(`AI 排查：右栏缺少页签 ${name}`)
    for (const name of ['在当前对话里修', '开新任务修', '记成教训'])
      if (!(await diag.getByRole('button', { name, exact: true }).count()))
        errors.push(`AI 排查：结论页没有「${name}」`)
    if (!(await diag.getByRole('meter', { name: '把握' }).count())) errors.push('AI 排查：根因卡片没有把握条')
    // 对话区的 Agent 回复里不再铺结论块的 JSON（只看回复：用户那条排查提示词里本来就带着格式样例）
    if (
      await p
        .getByRole('dialog')
        .locator('[data-msg]:not([data-user])')
        .getByText('"rootCause"', { exact: false })
        .count()
    )
      errors.push('AI 排查：对话区里还铺着结论块的原文')
    // 状态胶囊带上这一轮的用时
    await p
      .getByRole('dialog')
      .getByText(/分析完成\s*·\s*\d/)
      .waitFor({ timeout: 20000 })
      .catch(() => errors.push('AI 排查：状态胶囊上没有分析用时'))
    await check(p, 'AI排查-结论', ['根因', '影响', '在当前对话里修'])
    await diag.getByRole('tab', { name: /^证据/ }).click()
    await check(p, 'AI排查-证据', ['claude'])
    await diag.getByRole('tab', { name: /^结论/ }).click()
  }
  // 关闭时先确认停止（和别处的 AI 排查一样）
  await p.getByRole('button', { name: '关闭', exact: true }).last().click()
  if (await p.getByText('停止 AI 排查？').isVisible()) {
    await p.getByRole('button', { name: '停止并关闭' }).click()
  }
  // 等弹窗真的收起再点任务页的东西，别被遮罩挡住
  await p
    .getByRole('dialog')
    .last()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => {})
  // 关窗口会弹「AI 排查继续在后台进行」：提示在右上角，正盖着「任务进度」，等它退场再点
  await waitToastsGone()
  await p.getByRole('button', { name: '任务进度' }).click()
  // 演示任务是启动后在后台模拟执行的，轮到这个任务时可能还没跑完：等测试节点的子 Agent 出现再断言
  await p
    .getByText('子角色 · 单元测试', { exact: false })
    .first()
    .waitFor({ timeout: 30000 })
    .catch(() => {})

  await check(p, '任务-节点与子Agent', ['分析需求、拆分任务', '单元测试', '子角色 · 单元测试'])
  // 执行中发消息：在聊天页新建一个对话，趁它还在回复时再发一条。消息立刻出现在对话里，
  // 没有「排队」卡片、也没有「下一条」的排队提示
  await p.goto(base + '#/chat')
  await p.locator('#task-prompt').fill('整理一下这个项目的模块结构')
  await p.waitForTimeout(300)
  const opened = await p
    .locator('#task-prompt')
    .press('Enter')
    .then(
      () => p.locator('#follow-up').waitFor({ timeout: 20000 }),
      () => undefined,
    )
    .then(
      () => true,
      () => false,
    )
  if (!opened) errors.push('执行中发消息：新建对话后没有进入任务页')
  else {
    await p.locator('#follow-up').fill('顺手看看测试配置')
    await p.locator('#follow-up').press('Enter')
    await p
      .getByText('顺手看看测试配置', { exact: false })
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('执行中发消息：消息没有立刻出现在对话里'))
    // 消息出现时输入框就该空了：清空不等接口返回（以前要等 POST 返回），否则服务端慢的时候
    // 就是「气泡已经标了已交给 CLI、输入框还满着」
    const leftInBox = (await p.locator('#follow-up').textContent()) ?? ''
    if (leftInBox.includes('顺手看看测试配置')) errors.push('执行中发消息：消息已经在对话里了，输入框里的字还在')
    if (await p.getByText('排队', { exact: false }).count()) errors.push('执行中发消息：还能看到「排队」')
    if (await p.getByText('下一条', { exact: true }).count()) errors.push('执行中发消息：还能看到「下一条」的排队卡片')
    // 交付方式要回传给用户看：演示里这一轮收不下，消息上要写明「结束后自动处理」，不是只存个内部枚举
    await check(p, '任务-执行中发消息', ['这一轮结束后自动处理'])
  }
  // 上一条还在发送时再按回车：只发出一条，而且要说明为什么没发出去（以前是静默什么都不做，看着像卡住了）
  {
    const text = '连按两次回车的测试'
    // 演示版把发消息的请求人为拖慢（见 demo-backend 的 demo-slow-messages），才能真的撞上「上一条还在发送」。
    // 这个值会被界面检查的演示倍速缩短（scripts/ui/harness.mjs 的 DEMO_SPEED=4），12000 折算下来约 3 秒，余量够两次按键
    await p.evaluate(() => localStorage.setItem('demo-slow-messages', '12000'))
    await p.locator('#follow-up').fill(text)
    await p.locator('#follow-up').press('Enter')
    await p.locator('#follow-up').press('Enter')
    // 发出去的那一刻就清空输入框、消息插进对话：不等接口返回。这里演示版把发消息拖慢成几秒（上面设的），
    // 旧实现这会儿输入框里还满是字
    const leftover = (await p.locator('#follow-up').textContent()) ?? ''
    if (leftover.includes(text)) errors.push('输入框-连按两次回车：消息已经发出了，输入框里的字还在')
    // 面板接收之前那条消息标「待认领」，服务端记下后换成实际的交付方式（下面断言）
    await p
      .getByText('待认领', { exact: true })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('发送时序：接口返回前那条消息没有标成「待认领」'))
    const hint = await p
      .getByText('上一条还在发送，稍等一下')
      .first()
      .waitFor({ timeout: 5000 })
      .then(
        () => true,
        () => false,
      )
    if (!hint) errors.push('发送被拦下：没有提示为什么没发出去')
    await p
      .locator('.ml-auto', { hasText: text })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => {})
    // 等第一条真的发完（输入框清空），再数：只能有一条
    await p
      .waitForFunction(
        () => !(document.querySelector('#follow-up')?.textContent ?? '').includes('连按两次回车的测试'),
        { timeout: 10000 },
      )
      .catch(() => {})
    const n = await p.locator('.ml-auto', { hasText: text }).count()
    if (n !== 1) errors.push(`连按两次回车：发出了 ${n} 条（应该只有 1 条）`)
    // 等这一条真的交出去（本地那条「待认领」被服务端那份替掉）再往下走：sending 要等接口返回才放开，
    // 急着进下一条用例（输入法回车）会被「上一条还在发送」拦住
    await p
      .waitForFunction(() => !document.body.innerText.includes('待认领'), undefined, { timeout: 15000 })
      .catch(() => errors.push('发送时序：消息一直停在「待认领」'))
    await p.evaluate(() => localStorage.removeItem('demo-slow-messages'))
    await check(p, '输入框-连按两次回车')
  }
  // 中文输入法组合结束后按一下回车就要发出去：部分 Windows 输入法这时 nativeEvent.isComposing 还是 true
  {
    const text = '中文输入完直接按回车'
    await p.locator('#follow-up').focus()
    await p.evaluate(() => {
      const ed = document.querySelector('#follow-up')
      // 组合开始 → 字已经落进输入框 → 组合结束（真实输入法的先后顺序）
      ed.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      ed.textContent = '中文输入完直接按回车'
      ed.dispatchEvent(new InputEvent('input', { bubbles: true }))
      ed.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    await p.waitForTimeout(200)
    await p.evaluate(() => {
      const ed = document.querySelector('#follow-up')
      ed.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }),
      )
    })
    const sent = await p
      .locator('.ml-auto', { hasText: text })
      .first()
      .waitFor({ timeout: 5000 })
      .then(
        () => true,
        () => false,
      )
    if (!sent) errors.push('输入法组合结束后按一次回车：消息没有发出去')
    await check(p, '输入框-组合结束后回车发出')
  }
  // 反过来：组合中按下的回车（选字用的那一下）不能当成发送
  {
    const text = '组合中按下回车不该发出'
    await p.locator('#follow-up').focus()
    await p.evaluate(() => {
      const ed = document.querySelector('#follow-up')
      ed.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      ed.textContent = '组合中按下回车不该发出'
      ed.dispatchEvent(new InputEvent('input', { bubbles: true }))
      ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      ed.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    await p.waitForTimeout(600)
    const n = await p.locator('.ml-auto', { hasText: text }).count()
    if (n) errors.push('输入法组合中按回车：消息被发出去了（选字用的回车不能当成发送）')
    // 清掉输入框，别影响后面的用例
    await p.locator('#follow-up').fill('')
    await check(p, '输入框-组合中回车不发出')
  }
  // 提问窗口右上角的关闭：这个问题不回答、终止对话，窗口马上收起、换回输入框（以前停止接口返回的任务还带着提问，关不掉）
  await p.goto(base + '#/chat')
  await p.locator('#task-prompt').fill('问我日期用哪种格式再改')
  await p.waitForTimeout(300)
  await p.locator('#task-prompt').press('Enter')
  const ask = p.getByRole('dialog', { name: 'AI 的问题' })
  if (
    !(await ask.waitFor({ timeout: 20000 }).then(
      () => true,
      () => false,
    ))
  )
    errors.push('提问窗口：对话里说「问我」后没有弹出提问')
  else {
    await check(p, '提问窗口', ['日期显示用哪种格式？', '提交回答'])
    await ask.getByRole('button', { name: '不回答，终止对话' }).click()
    if (
      !(await ask.waitFor({ state: 'detached', timeout: 5000 }).then(
        () => true,
        () => false,
      ))
    )
      errors.push('提问窗口：点右上角的关闭后提问没有收起')
    else if (!(await p.locator('#follow-up').isVisible())) errors.push('提问窗口：关掉后输入框没有回来')
    else await check(p, '提问窗口-关闭后')
  }

  // 子对话请你决定的提问（一次问了两个）：右上角的关闭也是不回答、终止子对话，不再只是收起
  await p.goto(base)
  await p.getByText('购物车右上角', { exact: false }).first().click()
  const go = p.getByRole('button', { name: '去选择' }).first()
  if (
    !(await go.waitFor({ timeout: 10000 }).then(
      () => true,
      () => false,
    ))
  )
    errors.push('子对话提问：父对话里没有「去选择」')
  else {
    await go.scrollIntoViewIfNeeded()
    await go.click()
    const kidAsk = p.getByRole('dialog', { name: 'AI 的问题' }).filter({ hasText: '需要你选择' })
    if (
      !(await kidAsk.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      ))
    )
      errors.push('子对话提问：点「去选择」后没有弹出选择窗口')
    else {
      await check(p, '子对话提问', ['需要你选择', '购物车数量用哪种缓存？', '问题 2'])
      await kidAsk.getByRole('button', { name: '不回答，终止子对话' }).click()
      if (
        !(await kidAsk.waitFor({ state: 'detached', timeout: 5000 }).then(
          () => true,
          () => false,
        ))
      )
        errors.push('子对话提问：点关闭后选择窗口没有收起')
      else if (await p.getByText('展开选择', { exact: true }).count())
        errors.push('子对话提问：关闭后还留着「展开选择」，只是收起了没有终止')
      else {
        await check(p, '子对话提问-关闭后', ['继续执行'])
        // 父对话里的两张提问卡片记成不回答（演示里父对话页不轮询，刷新一下再看）
        await p.reload()
        await p
          .getByText('你没回答，子对话已终止', { exact: false })
          .first()
          .waitFor({ timeout: 10000 })
          .catch(() => errors.push('子对话提问：关闭后父对话里的提问卡片没有记成不回答'))
        if (await p.getByRole('button', { name: '去选择' }).count())
          errors.push('子对话提问：关闭后父对话里还有「去选择」')
      }
    }
  }
})
