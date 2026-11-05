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
import { childView, closeChildTab, openCartTask, taskPageHelpers } from './task-page.mjs'

await runShard(import.meta.filename, async (api) => {
  const { base, page, check, errors, settle } = api
  const p = await openCartTask(api)
  const { backToTask } = taskPageHelpers(p, api)

  // 父对话里子对话结果的卡片：标题链到子对话，点了在右栏打开它并滚到它的详细总结；
  // 子对话里的总结照普通 Markdown 显示（标题、分段），不画成卡片
  {
    const link = p.locator('.md-card-link').first()
    if (!(await link.count())) errors.push('子对话结果卡片：父对话里没有链到子对话的卡片标题')
    else {
      await link.click()
      const head = childView(p).locator('[data-summary-flash]')
      await head.waitFor({ timeout: 5000 }).catch(() => errors.push('子对话结果卡片：点标题后没有定位到子对话的总结'))
      // 跳转在面板打开后的几帧里对齐，等它停下再量
      await p.waitForTimeout(600)
      const r = await p.evaluate(() => {
        const v = document.querySelector('[data-child-view]')
        const sc = v?.querySelector('[data-conversation-scroll]')
        const h = v?.querySelector('[data-summary-flash]')
        if (!sc || !h) return null
        const cover = sc.querySelector('[data-reply-head="sticky"]')?.offsetHeight ?? 0
        return {
          tag: h.tagName,
          off: Math.round(h.getBoundingClientRect().top - sc.getBoundingClientRect().top - cover),
          cards: v.querySelectorAll('.md-card').length,
        }
      })
      if (r && r.tag !== 'H2') errors.push(`子对话结果卡片：子对话的总结标题应是普通的二级标题，实际是 ${r.tag}`)
      if (r && (r.off < 0 || r.off > 24)) errors.push(`子对话结果卡片：总结标题没停在面板顶上（离顶 ${r.off}px）`)
      if (r?.cards) errors.push('子对话结果卡片：子对话里的总结不该画成卡片')
      await check(p, '子对话结果卡片-跳到总结', ['问题', '修改方案'])
      await closeChildTab(p).click()
    }
  }

  // 环境弹窗里的「独立分支」：父对话在最前、其余按创建时间从早到晚（演示数据的创建顺序和时间故意不一致）；
  // 点中间那行在右栏打开对应子对话，合并/删除按钮各管各的，父对话自己那行点不了
  {
    const env = p.locator('button[aria-label="环境"]').first()
    /** 右栏是不是开着子对话 */
    const paneOpen = () => childView(p).count()
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
            const open = el.querySelector('button[aria-label^="在右栏打开子对话"]')
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
      .getByRole('button', { name: '在右栏打开子对话「Git+worktree 不再提示文件撞车」' })
    await target.focus()
    await p.keyboard.press('Enter')
    // 子对话在右栏开页签，关闭按钮在右栏页签条上（子对话栏的卡片里也有同名按钮，限定在页签条里）
    const closePane = closeChildTab(p)
    const pane = await closePane.waitFor({ timeout: 5000 }).then(
      () => true,
      () => false,
    )
    if (!pane) errors.push('独立分支：用键盘在行上按 Enter 没有打开子对话')
    else {
      // 面板先出来、子对话内容后加载：等标题真的画出来再判断打开的是哪一个
      // 标题在右栏的子对话页签上（ADR 0047）
      const rightTitle = await p
        .locator('[data-child-tab]')
        .getByText('Git+worktree 不再提示文件撞车')
        .first()
        .waitFor({ timeout: 5000 })
        .then(
          () => true,
          () => false,
        )
      if (!rightTitle) errors.push('独立分支：中间打开的不是对应的子对话')
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
    const token = d.locator('[title="Token 用量"], [data-token-usage]').first()
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
      const wf = db.tasks.find(
        (x) => x.mode === 'workflow' && !x.flowRun?.owner && x.runs?.length && x.projectId === parent.projectId,
      )
      if (!wf) return
      db.tasks = db.tasks.filter((x) => x.id !== 'demo-child-run')
      const child = structuredClone(wf)
      Object.assign(child, {
        id: 'demo-child-run',
        parentTaskId: parent.id,
        rootTaskId: parent.id,
        title: '子对话：到货提醒',
      })
      // 照的是工作流运行，造的是子对话：去掉运行的归属，不然按运行画、没有对话里那行「启动工作流」
      delete child.flowRun
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
    /** 打开那个子对话：父对话里不再列全部子对话，先写好「这个对话开着哪个子对话」的本地记录（task-child:<父 id>）再加载 */
    const openChild = async () => {
      await p.evaluate((k) => {
        const parent = JSON.parse(localStorage.getItem(k)).tasks.find((x) => x.title.includes('购物车'))
        localStorage.setItem(`task-child:${parent.id}`, 'demo-child-run')
        localStorage.removeItem(`task-run:${parent.id}`)
      }, key)
      await gotoTask()
      // 重新加载后子对话还开在右栏的页签里（右栏页签条上有它，并且在前台）
      await p
        .getByRole('tablist', { name: '文件视图' })
        .getByRole('tab', { name: /到货提醒/ })
        .waitFor({ timeout: 10000 })
        .catch(() => errors.push('子对话：重新加载后右栏页签条上没有「到货提醒」页签'))
      await p
        .locator('button[title="打开这次运行的对话"]')
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {})
    }
    // 右栏文件面板（项目文件 / 本对话改动）默认开着：清掉本地记录、直接重新加载，验的才是真默认状态；
    // 收起后按钮标成未展开，再点回来
    {
      await p.evaluate(() => {
        for (const k of Object.keys(localStorage)) if (k.startsWith('task-files:')) localStorage.removeItem(k)
        // 只验文件栏：会话栏关着，1440 宽才放得下文件栏（两个都开时后打开的留着，见 02-task）
        localStorage.setItem('task-session-bar', 'closed')
      })
      await p.reload()
      const token = p.locator('[title="Token 用量"], [data-token-usage]').first()
      if (
        !(await token.waitFor({ timeout: 5000 }).then(
          () => true,
          () => false,
        ))
      )
        await p.getByText('购物车右上角', { exact: false }).first().click()
      await token.waitFor({ timeout: 5000 }).catch(() => {})
      await settle(p)
      // 会话栏收起时，它的上下文细分挪到输入框下面那一排：小块在，点开是同一份细分
      {
        const chip = p.locator('[data-context-chip]')
        if (!(await chip.isVisible().catch(() => false))) errors.push('会话栏收起：输入框下面没有上下文小块')
        else {
          await chip.click()
          await settle(p)
          await check(p, '上下文小块-会话栏收起', ['已使用', '空闲空间', '距自动压缩还剩'])
          await p.keyboard.press('Escape')
          await settle(p)
        }
      }
      // 弹出提问（子对话请用户决定）时输入框让位给选择弹窗：上下文圆环不能回落到这一排、和小块并排成两个
      {
        const key = 'agent-panel-demo-v3'
        const saved = await p.evaluate((k) => localStorage.getItem(k), key)
        await p.evaluate((k) => {
          const db = JSON.parse(localStorage.getItem(k))
          const task = db.tasks.find((x) => x.title.includes('购物车右上角'))
          task.parentAsks = [{ id: 'demo-ask', question: '角标用红色还是主题色？', options: ['红色', '主题色'] }]
          localStorage.setItem(k, JSON.stringify(db))
        }, key)
        await p.reload()
        const chip = p.locator('[data-context-chip]')
        if (
          !(await chip.waitFor({ timeout: 10000 }).then(
            () => true,
            () => false,
          ))
        )
          await p.getByText('购物车右上角', { exact: false }).first().click()
        await chip.waitFor({ timeout: 5000 }).catch(() => {})
        await settle(p)
        const rings = await p.locator('[title="上下文占用"]:visible').count()
        if (rings !== 1) errors.push(`弹出提问时：上下文圆环应只有 1 个，实际 ${rings} 个`)
        await check(p, '上下文小块-弹出提问')
        await p.evaluate(([k, v]) => localStorage.setItem(k, v), [key, saved])
        await p.reload()
        await p
          .getByText('购物车右上角', { exact: false })
          .first()
          .click()
          .catch(() => {})
        await settle(p)
      }
      const aside = p.locator('[data-task-panel]')
      const open = p.getByRole('button', { name: '显示文件', exact: true })
      const fold = p.getByRole('button', { name: '收起文件面板', exact: true })
      // 等对话加载完再看右栏：非开发者模式下加载时只有一个转圈（无限动画），settle 不会替我们等到加载结束
      // （以前分步加载日志的淡入淡出是有限动画，碰巧把这段时间等过去了）
      const asideShown = await aside.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      )
      if (!asideShown) errors.push('文件面板：默认没有展开')
      else if (!(await fold.count())) errors.push('文件面板：展开时没有「收起文件面板」')
      else {
        await check(p, '文件面板-默认展开', ['src'])
        await fold.click()
        await settle(p)
        if (await aside.isVisible().catch(() => false)) errors.push('文件面板：点收起后右栏还占着位置')
        if ((await open.getAttribute('aria-expanded')) !== 'false') errors.push('文件面板：收起后按钮没标成未展开')
        await open.click()
        await settle(p)
        if (!(await aside.isVisible().catch(() => false))) errors.push('文件面板：再点一次文件面板没回来')
      }
    }
    await openChild()
    await check(p, '子对话-面板', ['子对话：到货提醒'])
    // 子对话在右栏开页签（和项目文件、本对话改动并排），中间还是父对话；
    // 切到项目文件页签时子对话藏起来但页签留着，再点子对话页签回来
    {
      const aside = p.locator('[data-task-panel]')
      if (!(await aside.isVisible().catch(() => false))) errors.push('子对话页签：打开子对话后右栏没有显示')
      const tabs = p.getByRole('tablist', { name: '文件视图' })
      const childTab = tabs.getByRole('tab', { name: /到货提醒/ })
      if (
        !(await aside
          .locator('[data-child-view]')
          .isVisible()
          .catch(() => false))
      )
        errors.push('子对话页签：子对话没有在右栏显示')
      if (!(await childTab.count())) errors.push('子对话页签：右栏页签条上没有子对话的页签')
      else {
        // 页签条右端的工具区跟着页签换（ADR 0047）：子对话页只有子对话的按钮，文件页只有文件页的按钮
        const tools = (name) => p.getByRole('toolbar', { name })
        const has = (name, btn) =>
          tools(name).getByRole('button', { name: btn, exact: true }).filter({ visible: true }).count()
        if (!(await has('子对话操作', '更多操作'))) errors.push('工具区：子对话页签上没有子对话的「更多操作」')
        if (await has('子对话操作', '查找文件')) errors.push('工具区：子对话页签上出现了文件页的「查找文件」')
        if (await aside.locator('[data-child-view] header[class*="group/hdr"]').count())
          errors.push('子对话页签：子对话面板里还画着自己的标题栏')
        await tabs.getByRole('tab').first().click()
        await settle(p)
        if (await childView(p).count()) errors.push('子对话页签：点项目文件页签后还显示子对话')
        if (!(await childTab.count())) errors.push('子对话页签：切到项目文件后子对话页签被关掉了')
        if (!(await has('文件操作', '查找文件'))) errors.push('工具区：项目文件页签上没有「查找文件」')
        if (await has('文件操作', '更多操作')) errors.push('工具区：项目文件页签上还显示子对话的「更多操作」')
        await childTab.click()
        await settle(p)
        if (!(await childView(p).count())) errors.push('子对话页签：点子对话页签没切回子对话')
        // 双击子对话页签就地改名，Esc 取消
        await childTab.dblclick()
        const box = p.getByRole('textbox', { name: '子对话标题' })
        if (
          !(await box.waitFor({ timeout: 3000 }).then(
            () => true,
            () => false,
          ))
        )
          errors.push('子对话页签：双击页签没有出现改名输入框')
        else {
          await p.keyboard.press('Escape')
          if (
            !(await box.waitFor({ state: 'detached', timeout: 3000 }).then(
              () => true,
              () => false,
            ))
          )
            errors.push('子对话页签：改名时按 Esc 没有取消')
        }
      }
      await check(p, '子对话-页签')
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
    // 运行页能切到流程图（ADR 0044）：标题栏的「输出 / 流程图」切换，流程图页画这次运行的节点，再切回输出
    {
      const tabs = p.getByRole('radiogroup', { name: '运行的视图' })
      if (!(await tabs.count())) errors.push('子对话运行视图：标题栏没有「输出 / 流程图」切换')
      else {
        await tabs.getByRole('radio', { name: '流程图' }).click()
        await p
          .locator('.react-flow')
          .first()
          .waitFor({ timeout: 10000 })
          .catch(() => errors.push('子对话运行视图：切到流程图后没有画出流程图'))
        await settle(p)
        await check(p, '子对话-运行视图-流程图')
        await tabs.getByRole('radio', { name: '输出' }).click()
        await settle(p)
        if (await p.locator('.react-flow').count()) errors.push('子对话运行视图：切回输出后流程图还在')
      }
    }
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
        // CLI 停在等下一句上（进程还活着）：计划没做完、进程已回收的不再列进运行区（见 shared/task.ts 的 childIcon），
        // 这里要的是「还在进行、能点解决」的那一行
        child.awaitingUser = true
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
      // 计划没做完、CLI 还活着的算「还在进行」，运行区里要有这一行（右栏才是带「解决」按钮的那个面板）
      const openRow = p.locator(`[aria-label="运行中"] button[title*="${TITLE}"]`).first()
      const listed = await openRow.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      )
      if (!listed) errors.push(`点解决收口计划：运行区里没有「${TITLE}」这一行，用例前提不成立`)
      else {
        await openRow.click()
        const pane = '[data-child-view]'
        // 子对话的按钮在右栏页签条右端的工具区（ADR 0047），不在子对话面板里
        const tools = '[role="toolbar"][aria-label="子对话操作"]'
        const solve = p.locator(`${tools} button[aria-label="解决"]`).first()
        const opened = await solve.waitFor({ timeout: 10000 }).then(
          () => true,
          () => false,
        )
        if (!opened) errors.push('点解决收口计划：右栏子对话里没有「解决」按钮，用例前提不成立')
        else {
          /** 右栏子对话的计划折叠头：说了什么、还挂着几步没做完、标题栏是不是已解决 */
          const head = () =>
            p.evaluate(
              ([sel, bar]) => {
                const box = document.querySelector(`${sel} [data-status-row="plan"]`)
                const btn = box?.querySelector('button[aria-label="执行计划"]')
                return {
                  text: (btn?.textContent || '').replace(/\s+/g, ' ').trim(),
                  left: !!box?.querySelector('[data-plan-left]'),
                  solved: !!document.querySelector(`${bar} [title="已解决"]`),
                  resolveBtn: !!document.querySelector(`${bar} button[aria-label="解决"]`),
                }
              },
              [pane, tools],
            )
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

  // 父对话自己在跑时运行区仍然列出子对话（从 02-task 挪过来：主题属于子对话这一片）：
  // 以前运行区绑在「最后一段」上（last 含 !working），父对话一跑整段就不渲染，子对话一条也列不出来
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
      // 运行区列出的子对话标题（按显示顺序）：取行上的读屏名「在右栏打开子对话「标题」」
      const runTitles = await p.evaluate(() =>
        [...document.querySelectorAll('[aria-label="运行中"]')].flatMap((box) =>
          [...box.children]
            .filter((r) => (r.innerText || '').trim().startsWith('子对话'))
            .map((r) => {
              const sel = '[aria-label^="在右栏打开子对话「"]'
              const el = r.matches(sel) ? r : r.querySelector(sel)
              return (el?.getAttribute('aria-label') || '').replace(/^在右栏打开子对话「/, '').replace(/」$/, '')
            }),
        ),
      )
      // 对照口径：子对话弹层「全部」里按状态分组的「执行中 · N」那一组。分组走 childStage，
      // 运行区走 visibleChildren，不是同一个函数，所以逐项对上才算数。以前写死「正好 5 个」，
      // 演示数据一改就误报；和弹层「运行中」页签比条数又是同一份数据自己比自己，测不出东西
      await p.locator('[data-status-row="children"] button[aria-expanded]').first().click()
      const popped = await p
        .locator('[data-child-summary]')
        .first()
        .waitFor({ timeout: 3000 })
        .then(
          () => true,
          () => false,
        )
      if (!popped) errors.push('父对话在跑时：点「子对话」没有打开子对话弹层，没法对照运行区')
      else {
        await p.getByRole('button', { name: '全部', exact: true }).first().click()
        /** 弹层里的分组：标题「执行中 · N」写的个数和组里实际列出的标题 */
        const groups = await p.evaluate(() => {
          const list = document.querySelector('[data-child-item]')?.parentElement?.parentElement
          const out = []
          for (const el of list?.children ?? []) {
            const head = el.tagName === 'P' ? /^(.+?) · (\d+)$/.exec((el.textContent || '').trim()) : null
            if (head) out.push({ label: head[1], count: Number(head[2]), titles: [] })
            const item = el.querySelector('[data-child-item]')
            if (item && out.length)
              out[out.length - 1].titles.push((item.querySelector('span.text-body')?.textContent || '').trim())
          }
          return out
        })
        const running = groups.find((g) => g.label === '执行中')
        if (!running) errors.push(`父对话在跑时：子对话弹层「全部」里没有「执行中」分组（${JSON.stringify(groups)}）`)
        else {
          if (running.titles.length !== running.count)
            errors.push(`子对话弹层：「执行中 · ${running.count}」下面实际列了 ${running.titles.length} 个`)
          // 前提：至少两个在跑，才测得出「运行区把在跑的全列出来，不只第一个」
          if (running.count < 2)
            errors.push(`父对话在跑时：演示数据只有 ${running.count} 个执行中的子对话，用例前提不成立`)
          if (runTitles.join('\n') !== running.titles.join('\n'))
            errors.push(
              `父对话在跑时运行区列的子对话（${runTitles.length} 个：${runTitles.join('、')}）和弹层「执行中 · ${running.count}」（${running.titles.join('、')}）对不上`,
            )
        }
      }
      await p.keyboard.press('Escape')
    }
    await check(p, '子对话-父对话在跑时仍列出')
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await p.reload()
    await backToTask()
  }

  // Bug 诊断报告（ADR 0045）：等确认期间子对话算执行中（父对话页不单独放按钮），
  // 「查看报告」只在子对话里交报告的那一行工具调用上；点开审阅弹窗：多版切换、标注能选「疑问 / 改方案 / 补充信息」
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k))
      const parent = db.tasks.find((x) => x.title.includes('购物车右上角'))
      // 用一个已经停下的子对话（演示里在跑的子对话会被模拟执行改写消息）：解决标记去掉，等确认期间算执行中
      const kid = db.tasks.find((x) => x.parentTaskId === parent.id && x.title.includes('修侧栏时间显示'))
      Object.assign(kid, { resolved: false, status: 'done', working: false })
      const at = new Date().toISOString()
      const base = {
        at,
        symptom: '购物车角标在删除最后一件商品后仍显示 1',
        repro: '加入一件商品后删除，角标停在 1',
        location: 'web/src/cart/badge.ts:21 count() → store.ts:48 items',
        evidence: '日志「[cart] remove id=3 left=0」← store.ts:52 删除后没有派发 change 事件',
        rootCause: 'store.ts 删除最后一件时提前 return，没有通知订阅者',
        confirmed: true,
        excluded: '接口返回：删除接口返回的列表已经是空的',
        fix: 'store.ts:52 去掉提前 return，统一在末尾派发 change',
        files: ['web/src/cart/store.ts'],
        risk: '只影响购物车的删除',
        verify: 'store.test.ts 新增「删除最后一件后角标归零」，改前失败、改后通过',
        answers: [],
        overall: '',
        before: [],
        // ADR 0046 的档案字段：调用栈、时间线、引入点、影响面、候选方案
        level: 'standard',
        stack: [
          { file: 'web/src/cart/badge.ts', line: 21, fn: 'count', note: '读购物车数量' },
          { file: 'web/src/cart/store.ts', line: 52, fn: 'remove', note: '删除最后一件时提前 return' },
        ],
        timeline: [
          { at: '2026-10-27', source: 'c0ffee1', kind: 'change', text: '购物车删除重构：派发挪进循环', abnormal: true },
          { at: '10:02:01', source: 'store.ts:52', kind: 'event', text: '[cart] remove id=3 left=0' },
        ],
        attribution: {
          category: 'recent',
          change: 'c0ffee1',
          author: '李四',
          date: '2026-10-27',
          title: '购物车删除重构',
          how: 'blame',
          confidence: 'high',
          note: 'blame 指到这次提交，前一版跑复现用例通过',
        },
        consistency: [{ observation: '只在删最后一件时出现', explanation: '只有 left=0 时提前 return' }],
        impact: [{ area: '购物车角标', effect: '删除后刷新', verify: 'store.test.ts' }],
        options: [
          {
            id: 'A',
            title: '去掉提前 return',
            change: 'store.ts:52',
            files: ['web/src/cart/store.ts'],
            covers: '角标',
          },
          {
            id: 'B',
            title: '角标自己轮询数量',
            change: 'badge.ts 定时读',
            files: ['web/src/cart/badge.ts'],
            covers: '角标',
            misses: '别的订阅者',
          },
        ],
        chosen: { id: 'A', why: '修在源头', whyNotOthers: 'B 只是绕过，别的订阅者照样收不到' },
      }
      kid.bug = true
      kid.diagnoses = [
        {
          ...base,
          version: 1,
          status: 'superseded',
          notes: [{ id: 1, quote: '提前 return', kind: 'question', comment: '为什么以前没出现？' }],
        },
        {
          ...base,
          version: 2,
          status: 'pending',
          notes: [],
          answers: [{ id: 1, answer: '上周的重构把派发挪进了循环里' }],
        },
      ]
      kid.requests = []
      kid.messages.push({
        id: 'demo-diag-tool',
        role: 'agent',
        agentId: '',
        step: '',
        text: '',
        at,
        tools: [
          {
            kind: 'other',
            name: 'MCP__panel__submit_diagnosis',
            label: '',
            detail: '',
            input: JSON.stringify({ rootCause: 'store.ts 删除最后一件时提前 return', fix: '去掉提前 return' }),
            output: '已交诊断报告第 2 版，等用户确认。现在结束这一轮回复，确认之前不要改任何文件。',
            ms: 800,
          },
        ],
      })
      localStorage.setItem(`task-child:${parent.id}`, kid.id)
      localStorage.removeItem(`task-run:${parent.id}`)
      localStorage.setItem(k, JSON.stringify(db))
    }, key)
    await p.reload()
    await backToTask()
    // 父对话不为它单独放一行：等报告期间它照常是在跑的子对话，那一行的说明写在等什么
    if (await p.locator('[data-child-request]').count())
      errors.push('诊断报告：父对话页不该为等确认的诊断报告单独放一行')
    await p
      .getByText('等你查看诊断报告第 2 版', { exact: false })
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('诊断报告：父对话里在跑的子对话那一行没有写「等你查看诊断报告第 2 版」'))
    if (!(await p.getByText('报告待确认', { exact: true }).count()))
      errors.push('诊断报告：父对话里那一行没有用「报告待确认」和别的执行中区分开')
    // 报告交上来时自动弹一次审阅弹窗（每一版只弹一次，关掉后不再弹）
    await p
      .getByRole('dialog')
      .getByRole('button', { name: '确认方案，开始修' })
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('诊断报告：交上来时没有自动弹出审阅弹窗'))
    await p.keyboard.press('Escape')
    await settle(p)
    if (await p.getByRole('dialog').getByRole('button', { name: '确认方案，开始修' }).count())
      errors.push('诊断报告：自动弹出的审阅弹窗关掉后又弹了一次')
    // 子对话页：等确认的报告像子任务一样放在最下面的运行区，不跟着交报告那一行收进工具的折叠里
    if (!(await childView(p).locator('.proc-list').getByText('诊断报告', { exact: true }).count()))
      errors.push('诊断报告：子对话最下面的运行区没有等确认的报告那一行')
    // 父对话页上也有入口：不用先进子对话找交报告那一行
    if (!(await p.locator('.proc-list').getByRole('button', { name: '查看报告' }).count()))
      errors.push('诊断报告：父对话页「正在运行」里那个子对话的行上没有「查看报告」')
    const open = childView(p).getByRole('button', { name: '查看报告' })
    await open
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('诊断报告：子对话里交报告的那一行工具调用上没有「查看报告」'))
    await check(p, '诊断报告-子对话里的工具行')
    if (!(await childView(p).getByText('等你查看报告').count()))
      errors.push('诊断报告：交报告那一行没有写「等你查看报告」')
    if (await open.count()) {
      await open.first().click()
      const dlg = p.getByRole('dialog')
      await dlg
        .getByRole('button', { name: '确认方案，开始修' })
        .waitFor({ timeout: 10000 })
        .catch(() => errors.push('诊断报告：弹窗里没有「确认方案，开始修」'))
      if (!(await dlg.getByRole('radiogroup', { name: '版本' }).count())) errors.push('诊断报告：有两版却没有版本切换')
      if (!(await dlg.getByText('上周的重构把派发挪进了循环里').count()))
        errors.push('诊断报告：第 2 版没有显示对上一版意见的回答')
      // 选中根因那段文字标注：标注能选种类，「有疑问，再查」随之可点
      // 和阶段确认那一步（02d）一样用真实的鼠标拖选：程序化选区不会触发弹窗里的 mouseup
      await settle(p)
      // 报告加了时间线、引入点、候选方案后变长了：根因那段可能在可视区外，先滚进来再拖
      const cause = dlg.getByText('store.ts 删除最后一件时提前 return', { exact: false }).first()
      await cause.scrollIntoViewIfNeeded().catch(() => {})
      await settle(p)
      const b = await cause.boundingBox()
      if (b) {
        await p.mouse.move(b.x + 2, b.y + b.height / 2)
        await p.mouse.down()
        await p.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 5 })
        await p.mouse.up()
      }
      const mark = p.getByRole('button', { name: '标注', exact: true })
      const shown = await mark.waitFor({ timeout: 3000 }).then(
        () => true,
        () => false,
      )
      if (shown) {
        await mark.click()
        if (!(await dlg.getByRole('radiogroup', { name: '标注 1 的种类' }).count()))
          errors.push('诊断报告：标注上没有「疑问 / 改方案 / 补充信息」的选择')
        await dlg.getByRole('radio', { name: '改方案' }).first().click()
        await dlg.getByLabel('标注 1 的意见').fill('顺便看看结算页的角标')
        if (await dlg.getByRole('button', { name: '有疑问，再查' }).isDisabled())
          errors.push('诊断报告：标注了还不能点「有疑问，再查」')
      } else errors.push('诊断报告：选中文字后没有出现「标注」按钮')
      // ADR 0046：引入点、时间线、候选方案画出来；没选的方案能一键加「改方案」意见
      for (const text of ['引入于', '购物车删除重构', '方案 B：角标自己轮询数量'])
        if (!(await dlg.getByText(text, { exact: false }).count())) errors.push(`诊断报告：没有显示「${text}」`)
      const useB = dlg.getByRole('button', { name: '改用方案 B' })
      if (!(await useB.count())) errors.push('诊断报告：没有「改用方案 B」')
      else {
        await useB.click()
        if (!(await dlg.getByText('方案 B：角标自己轮询数量', { exact: false }).count()))
          errors.push('诊断报告：点「改用方案 B」后标注里没有这一条')
      }
      await check(p, '诊断报告-审阅弹窗', ['诊断报告', '候选方案'])
      // 切到第 1 版：只读，按钮收起
      await dlg.getByRole('radio', { name: '第 1 版' }).click()
      await settle(p)
      if (
        await dlg
          .getByRole('button', { name: '确认方案，开始修' })
          .isVisible()
          .catch(() => false)
      )
        errors.push('诊断报告：切到旧的一版还能确认')
      await check(p, '诊断报告-旧版只读')
      // 取消修复：先确认，确认后弹窗关掉，对话里记一行「你取消了…」，不再等确认
      await dlg.getByRole('radio', { name: '第 2 版' }).click()
      await settle(p)
      const cancel = dlg.getByRole('button', { name: '取消修复' })
      if (!(await cancel.count())) errors.push('诊断报告：最新一版没有「取消修复」')
      else {
        await cancel.click()
        const ask = p.getByRole('dialog', { name: '取消这次修复？' })
        await ask.waitFor({ timeout: 5000 }).catch(() => errors.push('诊断报告：点「取消修复」没有先弹确认框'))
        await check(p, '诊断报告-取消修复确认')
        await ask.getByRole('button', { name: '不修了' }).click()
        await childView(p)
          .getByText('你取消了诊断报告第 2 版', { exact: false })
          .waitFor({ timeout: 10000 })
          .catch(() => errors.push('诊断报告：取消后对话里没有「你取消了诊断报告第 2 版」那一行'))
        if (await p.getByRole('button', { name: '确认方案，开始修' }).count())
          errors.push('诊断报告：取消后审阅弹窗还开着')
        if (await childView(p).getByText('等你查看报告').count())
          errors.push('诊断报告：取消后交报告那一行还写着「等你查看报告」')
      }
      await p.keyboard.press('Escape')
    }
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await p.reload()
    await backToTask()
  }

  // 名下的工作流运行（不是子对话）：运行区里子对话那几行下面、隔一条分割线，一次运行一张卡片；
  // 节点等确认时确认就在卡片上做（查看结果、追问、交给父对话）
  {
    const row = p.locator('[role="group"][aria-label="工作流运行"] [data-run-card]').first()
    await row.scrollIntoViewIfNeeded().catch(() => {})
    await row.waitFor({ timeout: 8000 }).catch(() => errors.push('工作流栏：运行区里没有名下工作流运行的卡片'))
    if (await row.count()) {
      for (const label of ['查看结果', '追问', '交给父对话'])
        if (!(await row.locator('button', { hasText: label }).count()))
          errors.push(`工作流栏：等确认的运行没有「${label}」`)
      await check(p, '工作流栏-等确认', ['角标订阅购物车数据', '「方案」等你确认'])
      await row.locator('button', { hasText: '追问' }).click()
      await p
        .getByPlaceholder('想先问清楚什么？（只回答，不改结果）')
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push('工作流栏：点「追问」没有弹出输入框'))
      await check(p, '工作流栏-追问')
      await p.keyboard.press('Escape')
      await row.locator('button', { hasText: '查看结果' }).click()
      await p
        .getByRole('button', { name: '确认', exact: true })
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push('工作流栏：点「查看结果」没有打开审阅弹窗'))
      await check(p, '工作流栏-查看结果', ['方案：购物车角标改成订阅购物车数据'])
      await p.keyboard.press('Escape')
    }
  }
})
