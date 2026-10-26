/**
 * 界面检查分片：任务页的子对话：独立分支环境弹窗、已归档的子对话、子对话面板与文件覆盖、
 * 运行视图、点「解决」收口计划、运行区里的工作流任务。
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 * 任务页按主题拆成 02 / 02b / 02c 三片：三片都用 scripts/ui/task-page.mjs 的同一个开场进入，
 * 各片自己重建前置状态，不依赖别的分片先跑过，任意顺序都能跑。
 */

import { runShard } from './harness.mjs'
import { openCartTask, taskPageHelpers } from './task-page.mjs'

await runShard(import.meta.filename, async (api) => {
  const { base, page, check, errors, settle } = api
  const p = await openCartTask(api)
  const { backToTask } = taskPageHelpers(p, api)

  // 环境弹窗里的「独立分支」：父对话在最前、其余按创建时间从早到晚（演示数据的创建顺序和时间故意不一致）；
  // 点中间那行在右栏打开对应子对话，合并/删除按钮各管各的，父对话自己那行点不了
  {
    const env = p.locator('button[aria-label="环境"]').first()
    /** 右栏是不是子对话面板：aside 的 aria-label 在「文件 / 子对话 / 运行 n」之间切换 */
    const paneOpen = () => p.getByRole('complementary', { name: '子对话' }).count()
    const openEnv = async () => {
      const shown = p.getByText('独立分支', { exact: true }).first()
      // 取消删除确认后弹层可能还开着，再点一次会把它收起来
      if (!(await shown.isVisible().catch(() => false))) await env.click()
      await shown.waitFor({ timeout: 5000 })
    }
    const closeEnv = async () => {
      await p.keyboard.press('Escape')
      await p
        .getByText('独立分支', { exact: true })
        .first()
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => {})
    }
    /** 某一组里各行的文字、能不能点、鼠标形状（分组见 data-worktree-group） */
    const rowsIn = (group) =>
      p.evaluate(
        (g) =>
          [...document.querySelectorAll(`[data-worktree-group="${g}"] [data-worktree-row]`)].map((el) => {
            const open = el.querySelector('button[aria-label^="在右侧打开子对话"]')
            return {
              text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
              clickable: !!open,
              cursor: open ? getComputedStyle(open).cursor : getComputedStyle(el).cursor,
            }
          }),
        group,
      )
    // 按删除与否分两组：未删除（父对话 + 两个还在的，创建时间从早到晚是 ESLint → Git+worktree）、
    // 已删除（已合回 main 的那条）
    const liveKids = ['整理 ESLint 规则', 'Git+worktree 不再提示文件撞车']
    const removedKids = ['修侧栏时间显示']
    const checkOrder = async (where) => {
      const live = await rowsIn('live')
      if (live.length !== liveKids.length + 1) {
        errors.push(`独立分支（${where}）：未删除组列出 ${live.length} 行，应该有父对话 + ${liveKids.length} 个`)
      } else {
        if (!live[0].text.includes('agent-panel/cart-badge') || live[0].clickable)
          errors.push(`独立分支（${where}）：未删除组第一行不是父对话自己（${JSON.stringify(live[0])}）`)
        if (live.slice(1).some((x) => !x.clickable)) errors.push(`独立分支（${where}）：子对话行不是可点按钮`)
        if (live.slice(1).some((x) => x.cursor !== 'pointer'))
          errors.push(`独立分支（${where}）：子对话行的鼠标不是手型`)
        const got = liveKids.map((title) => live.slice(1).findIndex((x) => x.text.includes(title)))
        if (got.some((i) => i < 0) || got.join(',') !== '0,1')
          errors.push(`独立分支（${where}）：未删除组没有按创建时间升序（${got.join(',')}）`)
      }
      const removed = await rowsIn('removed')
      if (removed.length !== removedKids.length)
        errors.push(`独立分支（${where}）：已删除组列出 ${removed.length} 行，应该有 ${removedKids.length} 个`)
      else if (!removed[0].text.includes(removedKids[0]))
        errors.push(`独立分支（${where}）：已删除组里没有已合并的那条（${JSON.stringify(removed[0])}）`)
    }
    await openEnv()
    await check(p, '独立分支-计数', ['3 个没合并'])
    await checkOrder('排序')
    await check(p, '独立分支-顺序')
    // 右键菜单：行里右键能开菜单，菜单里有打开对话 / 合并 / AI 合并 / 复制 / 删除；
    // 正在执行、已经删掉的项合并和删除都不能用，而且要把原因真的送到用户眼前（title + 点了 toast）
    const menuOf = async (title, group = 'live') => {
      await p
        .locator(`[data-worktree-group="${group}"] [data-worktree-row]`)
        .filter({ hasText: title })
        .click({ button: 'right' })
      const menu = p.locator('[data-radix-menu-content], [role="menu"]').first()
      const shown = await menu.waitFor({ timeout: 5000 }).then(
        () => true,
        () => false,
      )
      if (!shown) errors.push(`独立分支：在「${title}」那行右键没有弹出菜单`)
      return menu
    }
    const closeMenu = async () => {
      // 点过菜单项之后 Radix 已经自己收起来了，这时再按 Esc 会落到下面的环境弹窗上把它关掉，
      // 后面的用例就找不到行了；所以先看菜单还在不在，开着才按 Esc
      const menu = p.locator('[data-radix-menu-content], [role="menu"]').first()
      if (!(await menu.isVisible().catch(() => false))) return
      await p.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
    }
    // 不能用时用 aria-disabled 而不是真 disabled：真 disabled 会被 pointer-events-none 挡掉，
    // 鼠标悬不上去、title 的原因根本看不到（评审 R2）。这里断言的就是「悬得到 + 有原因 + 真的置灰了」
    const unavailable = async (item) =>
      (await item.getAttribute('aria-disabled')) === 'true' &&
      (await item.getAttribute('title'))?.length > 0 &&
      (await item.evaluate(
        (el) => getComputedStyle(el).pointerEvents !== 'none' && Number(getComputedStyle(el).opacity) < 1,
      ))
    {
      // 这一条还在执行（working）：菜单项要列全，合并和删除不能用并写原因
      const menu = await menuOf('Git+worktree 不再提示文件撞车')
      const names = ['打开对话', '合并到原分支', '用 AI 合并', '复制分支名', '复制路径', '删除独立分支']
      for (const name of names)
        if (!(await menu.getByRole('menuitem', { name, exact: true }).count()))
          errors.push(`独立分支：右键菜单里没有「${name}」`)
      const del = menu.getByRole('menuitem', { name: '删除独立分支', exact: true })
      const merge = menu.getByRole('menuitem', { name: '合并到原分支', exact: true })
      if (!(await unavailable(del))) errors.push('独立分支：正在执行的项在右键菜单里能删除（或缺原因 / 悬不上）')
      if (!(await unavailable(merge))) errors.push('独立分支：正在执行的项在右键菜单里能合并（或缺原因 / 悬不上）')
      // 菜单还开着时截图：人工核对菜单项、图标和置灰效果
      await check(p, '独立分支-右键菜单')
      await closeMenu()
    }
    // 已删除的项：后端 discard 只认 active（server/tasks.ts 的 isolated），点了必被拒，
    // 所以菜单里的删除必须也是不可用（评审 R1：行内按钮早就隐藏，菜单却可点就两边不一致了）
    {
      const menu = await menuOf('修侧栏时间显示', 'removed')
      const del = menu.getByRole('menuitem', { name: '删除独立分支', exact: true })
      const merge = menu.getByRole('menuitem', { name: '合并到原分支', exact: true })
      if (!(await unavailable(del))) errors.push('独立分支：已删除的项在右键菜单里还能删除（后端会拒）')
      if (!(await unavailable(merge))) errors.push('独立分支：已删除的项在右键菜单里还能合并')
      // 点了要把原因 toast 出来，而不是静默无反应。
      // force: true —— Playwright 的 actionability 检查会把 aria-disabled 当成不可点，
      // 而真实鼠标是可以点到的（上面已经断言 pointer-events 不是 none），这里要的正是那个点击
      await del.click({ force: true })
      const told = await p
        .getByText('这个分支已经删除了')
        .first()
        .waitFor({ timeout: 3000 })
        .then(
          () => true,
          () => false,
        )
      if (!told) errors.push('独立分支：点不可用的删除菜单项没有提示原因')
      await closeMenu()
    }
    await check(p, '独立分支-已删除不可操作')
    // 右键菜单里的合并、删除和行内按钮走同一套逻辑：点删除就弹删除确认（不连带开对话）
    {
      const menu = await menuOf('整理 ESLint 规则')
      const del = menu.getByRole('menuitem', { name: '删除独立分支', exact: true })
      if ((await del.getAttribute('aria-disabled')) === 'true')
        errors.push('独立分支：没在执行、没合并的项在右键菜单里不能删除')
      else {
        await del.click()
        const ok = await p
          .getByText('删除独立分支 agent-panel/eslint-rules？')
          .waitFor({ timeout: 5000 })
          .then(
            () => true,
            () => false,
          )
        if (!ok) errors.push('独立分支：从右键菜单点删除没有弹出确认框')
        else {
          if (await paneOpen()) errors.push('独立分支：从右键菜单点删除把对话也打开了')
          await p.getByRole('button', { name: '取消' }).last().click()
          await p
            .getByText('删除独立分支 agent-panel/eslint-rules？')
            .waitFor({ state: 'detached', timeout: 3000 })
            .catch(() => {})
        }
      }
    }
    await check(p, '独立分支-右键删除确认')
    // 父对话自己那行点了不打开任何对话
    await p.locator('[data-worktree-row]').first().click()
    if (await paneOpen()) errors.push('独立分支：点父对话自己那行打开了对话面板')
    // 点删除按钮不会连带打开对话：弹的是删除确认，右栏保持原样
    const row = p.locator('[data-worktree-row]').filter({ hasText: '整理 ESLint 规则' })
    await row.getByRole('button', { name: '删除独立分支' }).click()
    const asked = p
      .getByText('删除独立分支 agent-panel/eslint-rules？')
      .waitFor({ timeout: 5000 })
      .then(
        () => true,
        () => false,
      )
    if (!(await asked)) errors.push('独立分支：点删除按钮没有弹出确认框')
    else {
      if (await paneOpen()) errors.push('独立分支：点删除按钮把对话也打开了')
      await p.getByRole('button', { name: '取消' }).last().click()
      await p
        .getByText('删除独立分支 agent-panel/eslint-rules？')
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => {})
    }
    // 键盘可达：聚焦子对话行按 Enter，就在右栏打开对应子对话。
    // 取消删除确认后弹层可能还在收起，先等它关掉再重新打开，别聚焦到正在卸载的节点上
    await closeEnv()
    await openEnv()
    // 子对话栏、运行区里也有同名按钮：限定在独立分支这一行里
    const target = p
      .locator('[data-worktree-row]')
      .filter({ hasText: 'Git+worktree 不再提示文件撞车' })
      .getByRole('button', { name: '在右侧打开子对话「Git+worktree 不再提示文件撞车」' })
    await target.focus()
    await p.keyboard.press('Enter')
    // 子对话面板标题栏右边那个 ✕ 的 aria-label 是「关闭子对话」（运行视图里叫「关闭子对话面板」）；
    // 子对话栏的卡片里也有同名按钮，限定在右栏 aside 里，别点错
    const closePane = p
      .getByRole('complementary', { name: '子对话' })
      .getByRole('button', { name: '关闭子对话', exact: true })
    const pane = await closePane.waitFor({ timeout: 5000 }).then(
      () => true,
      () => false,
    )
    if (!pane) errors.push('独立分支：用键盘在行上按 Enter 没有打开子对话')
    else {
      // 面板先出来、子对话内容后加载：等标题真的画出来再判断打开的是哪一个
      const rightTitle = await p
        .locator('[data-task-panel]')
        .getByText('Git+worktree 不再提示文件撞车')
        .first()
        .waitFor({ timeout: 5000 })
        .then(
          () => true,
          () => false,
        )
      if (!rightTitle) errors.push('独立分支：右栏打开的不是对应的子对话')
      await closePane.click()
      await closePane.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
    }
    await check(p, '独立分支-打开子对话')
    // 刷新后顺序、计数都不变
    await p.reload()
    await backToTask()
    await openEnv()
    await check(p, '独立分支-刷新后计数', ['3 个没合并'])
    await checkOrder('刷新后')
    await check(p, '独立分支-刷新后顺序')
    await closeEnv()
  }

  // 已归档（用户从菜单里收起 / 删掉）的子对话：任务记录还在、status 还可能写着 running、计划也没做完，
  // 但不能再列进运行区，也不能算进「执行中」（用户报的现象：删掉的任务还挂在运行区，计划 8/10 · 等结果一直不消失）。
  // 用独立页面跑：这条要改 localStorage 造出「已归档」的条目（改完必须整页导航，行上才读得到新数据）。
  // 造的是归档后的落盘状态：这一轮已经停掉（working=false）、计划和 status 还停在原样——正是截图里那行的样子
  {
    const d = await page({ width: 1440, height: 900 })
    await d.goto(base)
    await d.getByText('购物车右上角', { exact: false }).first().click()
    await d.locator('#follow-up').waitFor({ timeout: 10000 })
    const hidden = '内存面板增加 AI 分析'
    /** 运行区里列出来的子对话标题（每行标题按钮的 openTip 里带着名字） */
    const runTitles = () =>
      d.evaluate(() =>
        [...document.querySelectorAll('[aria-label="运行中"]')]
          .flatMap((b) => [...b.children])
          .map((r) => (r.querySelector('button[title*="打开子对话"]')?.innerText || '').trim())
          .filter(Boolean),
      )
    /** 打开子对话弹层切到「全部」，读各分组标题上的条数（「执行中 · 5」「已完成 · 3」） */
    const groupCounts = async () => {
      await d
        .getByRole('button', { name: /个进行中，共 \d+ 个/ })
        .first()
        .click()
      await d.getByRole('button', { name: '全部' }).first().click()
      await settle(d)
      const groups = await d.evaluate(() => {
        // 弹层就是底部那个浮层：里面有整行宽、左对齐的条目按钮
        const tray = [...document.querySelectorAll('div.absolute.bottom-full')].find((el) =>
          [...el.querySelectorAll('button')].some((b) => (b.className || '').includes('text-left')),
        )
        return tray
          ? [...tray.querySelectorAll('p')]
              .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
              .filter((x) => / · \d+$/.test(x))
          : []
      })
      await d.keyboard.press('Escape')
      await d
        .locator('div.absolute.bottom-full')
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => errors.push('已归档：弹层没有收起来'))
      return groups
    }
    const amount = (list, name) => {
      const hit = list.find((x) => x.startsWith(`${name} · `))
      return hit ? Number(hit.split(' · ')[1]) : 0
    }
    /** 运行区是异步取子对话摘要后才画出来的：等它真的列出子对话行，别在空数组上断言 */
    const waitRunRows = () =>
      d
        .waitForFunction(
          () =>
            [...document.querySelectorAll('[aria-label="运行中"]')].some((box) =>
              [...box.children].some((r) => !!r.querySelector('button[title*="打开子对话"]')),
            ),
          { timeout: 10000 },
        )
        .catch(() => errors.push('已归档：运行区没有列出子对话'))
    await waitRunRows()
    if (!(await runTitles()).includes(hidden)) errors.push(`已归档：运行区一开始没有「${hidden}」，后面的核对没有意义`)
    const before = await groupCounts()
    if (amount(before, '执行中') < 1) errors.push('已归档：弹层「全部」里一开始就没有「执行中」分组')
    // 归档它：working 按归档后的样子落成 false，没做完的计划和 status 都留着——
    // 旧实现只看计划没做完，就继续把它画成在跑
    const hit = await d.evaluate((title) => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('agent-panel-demo-'))
      if (!key) return ''
      const db = JSON.parse(localStorage.getItem(key))
      const task = (db.tasks || []).find((x) => x.title === title)
      if (!task) return ''
      task.archived = true
      task.working = false
      localStorage.setItem(key, JSON.stringify(db))
      return task.id
    }, hidden)
    if (!hit) errors.push(`已归档：演示数据里没有「${hidden}」，造不出这个场景`)
    await d.reload()
    const token = d.getByTitle('Token 用量').first()
    if (
      !(await token.waitFor({ timeout: 5000 }).then(
        () => true,
        () => false,
      ))
    ) {
      await d.getByText('购物车右上角', { exact: false }).first().click()
      await token.waitFor({ timeout: 10000 }).catch(() => errors.push('已归档：刷新后没回到任务页'))
    }
    await settle(d)
    await waitRunRows()
    const after = await runTitles()
    if (after.includes(hidden)) errors.push(`运行区：已归档的子对话还列在这里（${after.join(' | ')}）`)
    const next = await groupCounts()
    if (amount(next, '执行中') !== amount(before, '执行中') - 1)
      errors.push(`已归档：执行中分组没有少一个（改前 ${amount(before, '执行中')}、改后 ${amount(next, '执行中')}）`)
    if (amount(next, '已完成') !== amount(before, '已完成') + 1)
      errors.push(
        `已归档：已归档的条目没有归到「已完成」（改前 ${amount(before, '已完成')}、改后 ${amount(next, '已完成')}）`,
      )
    await check(d, '子对话-已收起不再列运行区')
  }

  // 子对话里点「启动工作流」：在子对话这块面板内换成那次运行的视图，标题栏左边能返回子对话，
  // 右边是 ⋯ 和 ✕（✕ 关掉子对话面板本身，和返回不一样），返回后子对话原样回来
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    // 演示数据里没有子对话：照父对话里的工作流任务造一个，并补一条「启动工作流」的调用
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k))
      const parent = db.tasks.find((x) => x.title.includes('购物车'))
      const wf = db.tasks.find((x) => x.mode === 'workflow' && x.runs?.length && x.projectId === parent.projectId)
      if (!wf) return
      db.tasks = db.tasks.filter((x) => x.id !== 'demo-child-run')
      const child = structuredClone(wf)
      Object.assign(child, {
        id: 'demo-child-run',
        parentTaskId: parent.id,
        rootTaskId: parent.id,
        title: '子对话：到货提醒',
      })
      child.messages.splice(1, 0, {
        id: 'demo-child-tool',
        role: 'agent',
        agentId: '',
        step: '',
        text: '',
        at: new Date().toISOString(),
        tools: [
          {
            kind: 'other',
            name: 'MCP__panel__start_plan',
            label: '',
            detail: '',
            input: JSON.stringify({ input: '给商品详情页加「到货提醒」' }),
            output: '',
            ms: 1200,
          },
        ],
      })
      db.tasks.push(child)
      localStorage.setItem(k, JSON.stringify(db))
    }, key)
    const gotoTask = async () => {
      await p.reload()
      await backToTask()
    }
    /** 输入框上方的「子对话」→ 全部 → 打开那个子对话 */
    const openChild = async () => {
      await gotoTask()
      // 入口按钮带 aria-expanded + aria-label；页面上还有几个禁用的「子对话」占位按钮，按名字会撞上
      await p.locator('button[aria-expanded][aria-label^="子对话"]').first().click()
      await p.getByRole('button', { name: '全部' }).click()
      await p.getByText('子对话：到货提醒').first().click()
      await p
        .locator('button[title="打开这次运行的对话"]')
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {})
    }
    // 验收 5：子对话没打开时，宽屏文件按钮的四种 openChild ? 分支不变（写反会在这里撞红）。
    // 文件面板现在默认收起（见「任务-文件面板默认收起」），这里验的是从收起到展开、再收回去这条路
    {
      // 前面的用例展开过文件面板，本地记着「展开」：清掉记录、直接重新加载，
      // 不走 gotoTask / backToTask（它们会顺手点开面板），验的才是真默认状态
      await p.evaluate(() => {
        for (const k of Object.keys(localStorage)) if (k.startsWith('task-files:')) localStorage.removeItem(k)
      })
      await p.reload()
      const token = p.getByTitle('Token 用量').first()
      if (
        !(await token.waitFor({ timeout: 5000 }).then(
          () => true,
          () => false,
        ))
      )
        await p.getByText('购物车右上角', { exact: false }).first().click()
      await token.waitFor({ timeout: 5000 }).catch(() => {})
      await settle(p)
      const aside = p.locator('[data-task-panel]')
      const open = p.getByRole('button', { name: '显示文件', exact: true })
      const fold = p.getByRole('button', { name: '收起文件面板', exact: true })
      if (!(await open.count())) errors.push('文件面板-原行为：子对话未打开时没有「显示文件」')
      else if ((await open.getAttribute('aria-expanded')) !== 'false')
        errors.push('文件面板-原行为：默认收起时按钮没标成未展开')
      else if (await aside.isVisible().catch(() => false)) errors.push('文件面板-原行为：默认就展开了文件面板')
      else {
        await open.click()
        await settle(p)
        if (!(await aside.isVisible().catch(() => false))) errors.push('文件面板-原行为：点「显示文件」后右栏没出来')
        await check(p, '文件面板-原行为-展开', ['src'])
        if (!(await fold.count())) errors.push('文件面板-原行为：展开后没有「收起文件面板」')
        else if ((await fold.getAttribute('aria-expanded')) !== 'true')
          errors.push('文件面板-原行为：面板展着时按钮没标成已展开')
        else {
          await fold.click()
          await settle(p)
          // 收起后整栏看不见（xl:hidden），按钮换成「显示文件」、标成未展开
          if (await aside.isVisible().catch(() => false)) errors.push('文件面板-原行为：点收起后右栏还占着位置')
          if ((await open.getAttribute('aria-expanded')) !== 'false')
            errors.push('文件面板-原行为：收起后按钮没标成未展开')
          await check(p, '文件面板-原行为-收起')
          await open.click()
          await settle(p)
          if (!(await aside.isVisible().catch(() => false))) errors.push('文件面板-原行为：再点一次文件面板没回来')
        }
      }
    }
    await openChild()
    await check(p, '子对话-面板', ['子对话：到货提醒'])
    // 子对话开着时标题栏的文件按钮还在：点了把文件面板盖在子对话上展开，子对话不关；再点（或「回到子对话」、Esc）回来
    {
      const aside = p.locator('[data-task-panel]')
      const fileBtn = p.getByRole('button', { name: '覆盖显示文件', exact: true })
      const back = p.getByRole('button', { name: '回到子对话', exact: true })
      /** 等覆盖层真的关上：只看 count 会漏掉正在卸载的那一瞬 */
      const gone = () =>
        back.waitFor({ state: 'detached', timeout: 3000 }).then(
          () => true,
          () => false,
        )
      /**
       * 等焦点真的回到标题栏文件按钮上。
       * 收起时焦点是在面板卸载后的下一帧（requestAnimationFrame）才还回去的（见 TaskView 的 closeChildFiles），
       * 所以 gone() 返回时读 activeElement 会读到回收之前的那一刻，并行跑时那一帧被拉长就掉到 body；
       * 这里等的是可观测结果（活动元素的 aria-label），不是等固定时长。
       * 返回 { ok } 表示等到没等到，没等到时带上实际落点给报错用。
       */
      const focusBack = (visible = false) =>
        p
          .waitForFunction(
            (needVisible) => {
              const el = document.activeElement
              if (el?.getAttribute('aria-label') !== '覆盖显示文件') return false
              return !needVisible || el.offsetParent !== null
            },
            visible,
            { timeout: 3000 },
          )
          .then(
            () => ({ ok: true, label: '覆盖显示文件' }),
            () =>
              p.evaluate(() => ({
                ok: false,
                label: document.activeElement?.getAttribute('aria-label') ?? null,
                visible: document.activeElement?.offsetParent !== null,
              })),
          )
      if (!(await fileBtn.count())) errors.push('子对话+文件面板：子对话开着时标题栏没有文件按钮')
      else if (!(await fileBtn.isVisible())) errors.push('子对话+文件面板：子对话开着时文件按钮不可见')
      else {
        // 子对话自己的标题栏（pane 里的 TaskView）不能再出现一个文件按钮
        for (const label of ['覆盖显示文件', '收起文件面板'])
          if (await aside.locator(`button[aria-label="${label}"]`).count())
            errors.push(`子对话+文件面板：子对话自己的标题栏里也有「${label}」按钮`)
        const before = await aside.boundingBox()
        await fileBtn.click()
        const shown = await back.waitFor({ timeout: 5000 }).then(
          () => true,
          () => false,
        )
        if (!shown) errors.push('子对话+文件面板：点了文件按钮没有出现文件面板')
        else {
          // 盖在子对话上：占的是子对话那一栏的位置和宽度，不是另起一栏把两边挤窄
          const after = await aside.boundingBox()
          if (!before || !after) errors.push('子对话+文件面板：量不到右栏的位置')
          else if (Math.abs(after.x - before.x) > 1 || Math.abs(after.width - before.width) > 1)
            errors.push(`子对话+文件面板：文件面板把右栏挤变了（${JSON.stringify(before)} → ${JSON.stringify(after)}）`)
          // 子对话没被关掉，文件面板真的在它上面（子对话的标题就在下面，看不见但还在）
          const under = await p.evaluate(() => {
            const box = document.querySelector('[data-task-panel]')
            const title = [...(box?.querySelectorAll('*') ?? [])].find(
              (el) => el.textContent?.trim() === '子对话：到货提醒' && el.children.length === 0,
            )
            if (!title) return null
            const r = title.getBoundingClientRect()
            return { covered: r.width > 0, box: { x: r.x, y: r.y } }
          })
          if (!under?.covered) errors.push('子对话+文件面板：盖文件的时候子对话被卸载了，收起后状态就丢了')
          await check(p, '子对话-文件覆盖', ['src'])
          if ((await fileBtn.getAttribute('aria-expanded')) !== 'true')
            errors.push('子对话+文件面板：文件开着时按钮没标成展开')
          // 「回到子对话」收起：焦点回标题栏那个按钮，键盘用户不会被丢回页面开头
          await back.click()
          if (!(await gone())) errors.push('子对话+文件面板：点「回到子对话」没有收起文件面板')
          const focus = await focusBack()
          if (!focus.ok) errors.push(`子对话+文件面板：收起后焦点没有回到文件按钮（现在在 ${focus.label ?? 'body'}）`)
          if (!(await p.getByText('子对话：到货提醒').first().count()))
            errors.push('子对话+文件面板：点了「回到子对话」后子对话没回来')
          await check(p, '子对话-文件覆盖-返回', ['子对话：到货提醒'])
          // 再用标题栏那个按钮自己开、自己关：只能开不能关的写法必须在这里撞红
          await fileBtn.click()
          if (
            !(await back.waitFor({ timeout: 5000 }).then(
              () => true,
              () => false,
            ))
          )
            errors.push('子对话+文件面板：第二次点文件按钮没有重新盖开')
          await fileBtn.click()
          if (!(await gone())) errors.push('子对话+文件面板：再点标题栏文件按钮没有收起文件面板')
          await check(p, '子对话-文件覆盖-按钮收起')
          // 子对话里开着运行视图（它自己也听 Esc）时，Esc 只收文件面板，不能把运行视图一起关掉
          await p.locator('button[title="打开这次运行的对话"]').first().click()
          await check(p, '子对话-运行视图-打开', ['第 1 次运行'])
          await fileBtn.click()
          await back.waitFor({ timeout: 5000 }).catch(() => errors.push('子对话+文件面板：运行视图上盖不开文件面板'))
          await p.keyboard.press('Escape')
          if (!(await gone())) errors.push('子对话+文件面板：按 Esc 没有收起文件面板')
          if (!(await p.getByRole('button', { name: '返回子对话', exact: true }).count()))
            errors.push('子对话+文件面板：按 Esc 收起文件时把子对话里的运行视图也关了')
          await check(p, '子对话-文件覆盖-Esc', ['第 1 次运行'])
          await p.getByRole('button', { name: '返回子对话', exact: true }).click()
          await p
            .getByRole('button', { name: '返回子对话', exact: true })
            .waitFor({ state: 'detached', timeout: 3000 })
            .catch(() => {})
        }
        // 窄屏（xl 断点以下）：子对话本身就是 fixed z-40 盖着右半屏，父对话标题栏右端那个按钮
        // 鼠标点不到（被子对话抽屉盖住，改动前就这样）；但按钮仍在无障碍树里、键盘能专注，用键盘走这条路径
        await p.setViewportSize({ width: 1024, height: 900 })
        await settle(p)
        const narrow = p.getByRole('button', { name: '覆盖显示文件', exact: true })
        if (!(await narrow.count())) errors.push('子对话+文件面板（窄屏）：标题栏没有文件按钮')
        else {
          await narrow.focus()
          await p.keyboard.press('Enter')
          const ok = await back.waitFor({ timeout: 5000 }).then(
            () => true,
            () => false,
          )
          if (!ok) errors.push('子对话+文件面板（窄屏）：用键盘按文件按钮没有出现文件面板')
          else {
            // 窄屏子对话只占半边、文件树放不下：盖上去时铺满整个屏
            const cover = p.locator('[data-cover-panel]')
            const box = await cover.boundingBox()
            if (!box || box.width < 1000)
              errors.push(`子对话+文件面板（窄屏）：文件面板没有铺满整个屏（${JSON.stringify(box)}）`)
            await check(p, '子对话-文件覆盖-窄屏')
            await back.click()
            if (!(await gone())) errors.push('子对话+文件面板（窄屏）：点「回到子对话」没有收起文件面板')
            // 窄屏收焦点收到的是窄屏那个按钮：宽屏按钮在 <1280 是 display:none，focus 不生效
            const focus = await focusBack(true)
            if (!focus.ok)
              // 焦点可能落在那个 display:none 的宽屏按钮上：它的 aria-label 也是同一个，只打 label 会变成
              // 「没有回到可见的文件按钮（现在在 覆盖显示文件）」这种自相矛盾的报错，把可见性一起带上
              errors.push(
                `子对话+文件面板（窄屏）：收起后焦点没有回到可见的文件按钮（现在在 ${focus.label ?? 'body'}${focus.visible === false ? '，但它不可见' : ''}）`,
              )
          }
        }
        await p.setViewportSize({ width: 1440, height: 900 })
        await settle(p)
      }
    }
    // 子对话的进程面板只算它自己：父对话和兄弟的进程都不能出现
    {
      const btn = p.getByRole('button', { name: '对话进程' }).last()
      await btn.click()
      const panel = p.locator('[data-radix-popper-content-wrapper]').filter({ hasText: '内存合计' }).last()
      await panel
        .getByText('本对话', { exact: true })
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {})
      const text = (await panel.textContent().catch(() => '')) ?? ''
      if (!text.includes('本对话')) errors.push('对话进程-子对话：没有「本对话」分组')
      if (text.includes('购物车右上角的数量角标')) errors.push('对话进程-子对话：显示了父对话的进程')
      if (text.includes('内存面板增加 AI 分析')) errors.push('对话进程-子对话：显示了兄弟子对话的进程')
      await check(p, '子对话-对话进程-子树')
      await p.keyboard.press('Escape')
    }
    const runTitle = p.locator('button[title="打开这次运行的对话"]')
    if (!(await runTitle.count())) errors.push('子对话：工作流那几行没有「打开这次运行的对话」的入口')
    // 点「启动工作流」这一行：面板内换成这次运行的视图，不是把内容铺在子对话里
    await runTitle.first().click()
    await check(p, '子对话-运行视图', ['子对话：到货提醒', '第 1 次运行'])
    if (!(await p.getByRole('button', { name: '返回子对话' }).count()))
      errors.push('子对话运行视图：标题栏左边没有返回子对话的按钮')
    if (!(await p.getByRole('button', { name: '关闭子对话面板' }).count()))
      errors.push('子对话运行视图：标题栏右边没有关闭子对话面板的按钮')
    // 子对话启动的工作流也能补充要求：输入框跟着放进运行视图底下，盖住的子对话里不再留一个
    {
      const box = await p.evaluate(() => {
        const view = document.querySelector('button[aria-label="返回子对话"]')?.closest('.absolute')
        return {
          inView: view?.querySelectorAll('#follow-up').length ?? 0,
          under: view?.parentElement ? [...view.parentElement.querySelectorAll('#follow-up')].length : 0,
        }
      })
      if (box.inView !== 1) errors.push(`子对话运行视图：底下应该有一个输入框（现在 ${box.inView} 个）`)
      else if (box.under !== 1) errors.push(`子对话运行视图：被盖住的子对话里还留着输入框（共 ${box.under} 个）`)
    }
    // 窄窗口：标题截断，但返回和 ✕ 不能被挤掉（手机上子对话面板占满整个宽度）
    {
      await p.setViewportSize({ width: 420, height: 860 })
      await settle(p)
      const back = await p.getByRole('button', { name: '返回子对话' }).boundingBox()
      const close = await p.getByRole('button', { name: '关闭子对话面板' }).boundingBox()
      if (!back || !close) errors.push('子对话运行视图（窄窗口）：返回或关闭按钮不见了')
      else if (back.x < 0 || close.x + close.width > 420)
        errors.push(`子对话运行视图（窄窗口）：标题把按钮挤出视口（返回 ${back.x}，关闭 ${close.x + close.width}）`)
      await check(p, '子对话-运行视图-窄窗口')
      await p.setViewportSize({ width: 1440, height: 900 })
      await settle(p)
    }
    // 返回：回到子对话，不是关掉面板
    await p.getByRole('button', { name: '返回子对话' }).click()
    await p
      .getByRole('button', { name: '返回子对话' })
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    await check(p, '子对话-返回', ['子对话：到货提醒'])
    if (await p.getByRole('button', { name: '返回子对话' }).count())
      errors.push('子对话运行视图：点了返回，运行的视图还在')
    // 这一次运行的卡片也进同一个视图
    await runTitle.last().click()
    await check(p, '子对话-运行视图-卡片')
    // ✕：关掉子对话面板本身，回到父对话的文件面板
    await p.getByRole('button', { name: '关闭子对话面板' }).click()
    await p
      .getByText('子对话：到货提醒')
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    await check(p, '子对话-关闭面板', ['购物车右上角'])
    if (await p.getByText('子对话：到货提醒').count()) errors.push('子对话运行视图：点 ✕ 后子对话面板还在')
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await gotoTask()
  }

  // 用户点「解决」时计划一并收口（见 server/tasks.ts 的 settleChildForUser）：
  // 造一条「计划 2/6 没做完、这一轮没在跑、没有独立分支要合回」的子对话，点解决后折叠头要说全部完成、
  // 「n 步没做完」的提示消失、标题栏换成「已解决」。真机上分支没合回会先被拦住，这里验的是计划收口这件事
  {
    const KEY = 'agent-panel-demo-v3'
    const TITLE = '修侧栏时间显示'
    const done = 2
    const patched = await p.evaluate(
      ([k, title, doneCount]) => {
        const db = JSON.parse(localStorage.getItem(k) ?? '{}')
        const child = (db.tasks ?? []).find((x) => x.title === title)
        if (!child) return false
        // 演示里这条是已解决的：改回未解决才有「解决」按钮可点；独立分支也去掉，
        // 只留「计划没做完」这一条原因，否则验的不是计划收口
        child.resolved = false
        child.worktree = undefined
        const at = new Date(Date.now() - 30 * 60_000).toISOString()
        child.plans = [
          {
            id: `${child.id}-plan`,
            title: '收口计划',
            createdAt: at,
            doneAt: '',
            summary: '',
            autoSummary: false,
            steps: Array.from({ length: 6 }, (_, i) => ({
              id: String(i + 1),
              title: `第 ${i + 1} 步`,
              status: i < doneCount ? 'done' : 'pending',
              note: '',
              waits: [],
              startedAt: at,
              endedAt: i < doneCount ? at : '',
              children: [],
            })),
          },
        ]
        localStorage.setItem(k, JSON.stringify(db))
        return true
      },
      [KEY, TITLE, done],
    )
    if (!patched) errors.push('点解决收口计划：演示数据里没有可用的子对话，用例前提不成立')
    else {
      await p.reload()
      await backToTask()
      // 计划没做完的算「还在进行」，运行区里要有这一行（右栏才是带「解决」按钮的那个面板）
      const openRow = p.locator(`[aria-label="运行中"] button[title*="${TITLE}"]`).first()
      const listed = await openRow.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      )
      if (!listed) errors.push(`点解决收口计划：运行区里没有「${TITLE}」这一行，用例前提不成立`)
      else {
        await openRow.click()
        const pane = 'aside[aria-label="子对话"]'
        const solve = p.locator(`${pane} button[aria-label="解决"]`).first()
        const opened = await solve.waitFor({ timeout: 10000 }).then(
          () => true,
          () => false,
        )
        if (!opened) errors.push('点解决收口计划：右栏子对话里没有「解决」按钮，用例前提不成立')
        else {
          /** 右栏子对话的计划折叠头：说了什么、还挂着几步没做完、标题栏是不是已解决 */
          const head = () =>
            p.evaluate((sel) => {
              const box = document.querySelector(`${sel} [data-status-row="plan"]`)
              const btn = box?.querySelector('button[aria-label="执行计划"]')
              return {
                text: (btn?.textContent || '').replace(/\s+/g, ' ').trim(),
                left: !!box?.querySelector('[data-plan-left]'),
                solved: !!document.querySelector(`${sel} [title="已解决"]`),
                resolveBtn: !!document.querySelector(`${sel} button[aria-label="解决"]`),
              }
            }, pane)
          const before = await head()
          if (!before.text.includes(`计划 ${done}/6`))
            errors.push(`点解决收口计划：前提不成立，折叠头是「${before.text}」，不是「计划 ${done}/6」`)
          await solve.click()
          const finished = await p
            .waitForFunction(
              (sel) => {
                const box = document.querySelector(`${sel} [data-status-row="plan"]`)
                const btn = box?.querySelector('button[aria-label="执行计划"]')
                return !!btn && (btn.textContent || '').includes('计划已完成')
              },
              pane,
              { timeout: 10000 },
            )
            .then(
              () => true,
              () => false,
            )
          const after = await head()
          if (!finished) errors.push(`点解决收口计划：点完「解决」折叠头还是「${after.text}」，没有变成计划已完成`)
          if (after.left) errors.push('点解决收口计划：还挂着「n 步没做完（已保留）」的提示')
          if (!after.solved) errors.push('点解决收口计划：点完没有换成「已解决」')
          if (after.resolveBtn) errors.push('点解决收口计划：已解决后还留着「解决」按钮')
          if (finished) await check(p, '子对话-点解决后计划全部完成', ['计划已完成', '已解决'])
        }
      }
    }
  }

  // 子对话的未读点：做完了、用户还没点开看过的那一条，行上有个橙点；点开就消失。
  // 判定在 shared/task.ts 的 childDoneDot（和侧栏橙点同一份口径）；在跑的那几条不算「没读过」，它们还没有结果
  {
    const UNREAD = '对话已完成，还没查看'
    const DONE_CHILD = '拆分规则检查脚本'
    const RUNNING_CHILD = '内存面板增加 AI 分析'
    // 前面的用例可能把右栏切到了子对话面板：先从列表点回购物车这条父对话，子对话状态行才在
    await p.getByText('购物车右上角', { exact: false }).first().click()
    // 入口按状态行定位，不按文案：跑到这一拍时子对话大多不在跑，label 是「子对话 n」而不是「n 个进行中，共 n 个」
    const bar = p.locator('[data-status-row="children"] button[aria-expanded]').first()
    const onTask = await bar.waitFor({ timeout: 15000 }).then(
      () => true,
      () => false,
    )
    if (!onTask) errors.push('子对话未读点：没有回到父对话页（找不到子对话入口），用例的前提不成立')
    else {
      // 前面几拍可能开着浮层：先按 aria-expanded 关掉，再从「运行中」重新打开
      if ((await bar.getAttribute('aria-expanded')) === 'true') {
        await bar.click()
        await settle(p)
      }
      await bar.click()
      const tray = p
        .locator('div.absolute.bottom-full')
        .filter({ has: p.getByRole('button', { name: '全部', exact: true }) })
        .first()
      const allTab = tray.getByRole('button', { name: '全部', exact: true })
      const ready = await allTab.waitFor({ timeout: 5000 }).then(
        () => true,
        () => false,
      )
      if (!ready) errors.push('子对话未读点：子对话浮层没有打开（找不到「全部」）')
      else {
        await allTab.click()
        await settle(p)
        // 按标题元素的完整文本定位：说明文字里也可能带着同名子串，hasText 会命中错行，断言就等于没测
        const row = (title) =>
          tray
            .locator('[data-child-item]')
            .filter({ has: p.getByText(title, { exact: true }) })
            .first()
        const dot = (title) => row(title).locator(`[aria-label="${UNREAD}"]`)
        const doneRow = row(DONE_CHILD)
        const listed = await doneRow.waitFor({ timeout: 5000 }).then(
          () => true,
          () => false,
        )
        if (!listed) errors.push(`子对话未读点：浮层「全部」里没有「${DONE_CHILD}」，用例的前提数据没造出来`)
        else {
          // 做完了、没点开过：有未读点；还在跑的那条是「还没有结果」，不是「没读过」
          if (!(await dot(DONE_CHILD).count()))
            errors.push(`子对话未读点：做完了没看过的「${DONE_CHILD}」行上没有未读点`)
          if (await dot(RUNNING_CHILD).count())
            errors.push(`子对话未读点：还在跑的「${RUNNING_CHILD}」行上不该有未读点`)
          await check(p, '子对话-未读点', [DONE_CHILD])
          // 点开它：右栏打开这个子对话，它自己会发 /seen；当前打开的那条不画点
          await doneRow.click()
          const pane = p.getByRole('complementary', { name: '子对话' })
          const opened = await pane.waitFor({ timeout: 10000 }).then(
            () => true,
            () => false,
          )
          if (!opened) errors.push('子对话未读点：点这一行没有在右栏打开子对话')
          else {
            const titled = await pane
              .getByText(DONE_CHILD, { exact: false })
              .first()
              .waitFor({ timeout: 10000 })
              .then(
                () => true,
                () => false,
              )
            if (!titled) errors.push(`子对话未读点：右栏打开的不是「${DONE_CHILD}」`)
            if (await dot(DONE_CHILD).count()) errors.push('子对话未读点：当前打开的这一条上还画着未读点')
            // 换开另一个子对话，再等一轮 4 秒的轮询：刚看过的那条不能又被接口数据画回未读
            await row('核对通知时序').click()
            await p.waitForTimeout(5000)
            if (await dot(DONE_CHILD).count()) errors.push('子对话未读点：点开看过以后，轮询又把未读点画回来了')
            await check(p, '子对话-未读点消失', [DONE_CHILD])
          }
        }
      }
    }
  }

  // 父对话自己在跑时运行区仍然列出子对话（从 02-task 挪过来：主题属于子对话这一片）：
  // 以前运行区绑在「最后一段」上（last 含 !working），父对话一跑整段就不渲染，子对话一条也列不出来
  // 父对话自己在跑时运行区仍然列出子对话：以前运行区绑在「最后一段」上（last 含 !working），
  // 父对话一跑整段就不渲染，子对话一条也列不出来
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k))
      const task = db.tasks.find((x) => x.title.includes('购物车'))
      task.status = 'running'
      task.working = true
      localStorage.setItem(k, JSON.stringify(db))
    }, key)
    await p.reload()
    await backToTask()
    // 子对话列表 4 秒一轮，先等运行区里真的出现子对话行再数
    const seenKids = await p
      .waitForFunction(
        () =>
          [...document.querySelectorAll('[aria-label="运行中"]')].some((box) =>
            [...box.children].some((r) => (r.innerText || '').trim().startsWith('子对话')),
          ),
        { timeout: 10000 },
      )
      .then(
        () => true,
        () => false,
      )
    if (!seenKids) errors.push('父对话在跑时运行区没有列出子对话')
    else {
      const n = await p.evaluate(
        () =>
          [...document.querySelectorAll('[aria-label="运行中"]')].flatMap((box) =>
            [...box.children].filter((r) => (r.innerText || '').trim().startsWith('子对话')),
          ).length,
      )
      if (n !== 5) errors.push(`父对话在跑时运行区列了 ${n} 个子对话，应该和弹层一样是 5 个`)
    }
    await check(p, '子对话-父对话在跑时仍列出')
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await p.reload()
    await backToTask()
  }
})
