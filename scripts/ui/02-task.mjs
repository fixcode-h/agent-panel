/**
 * 界面检查分片：任务页：子对话、子任务、Token 浮层、执行计划、文件拖入、对话进程和内存曲线、工作流任务的节点、执行中发消息、提问窗口的关闭
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await p.getByText('购物车右上角', { exact: false }).first().click()
  // 右栏是文件系统（带 git 状态），启动命令是名字那行最右边的图标，上下文和用量在输入框下面
  await check(p, '任务', ['src', '命中', 'package.json'])
  /** 刷新后回到购物车那个任务页：当前路由就是任务页，等它画出来；没回到任务页时从列表点进去 */
  const backToTask = async () => {
    const token = p.getByTitle('Token 用量').first()
    if (
      await token.waitFor({ timeout: 5000 }).then(
        () => true,
        () => false,
      )
    )
      return
    await p.getByText('购物车右上角', { exact: false }).first().click()
    await token.waitFor({ timeout: 5000 }).catch(() => {})
  }
  /** Esc 关掉弹层之后等它真的卸载，再点下面的东西 */
  const closed = () =>
    p
      .getByRole('dialog')
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
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
    /** 弹窗里各行的文字、能不能点、父对话行（不能点）是不是第一个 */
    const rows = () =>
      p.evaluate(() =>
        [...document.querySelectorAll('[data-worktree-row]')].map((el) => {
          const open = el.querySelector('button[aria-label^="在右侧打开子对话"]')
          return {
            text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
            clickable: !!open,
            cursor: open ? getComputedStyle(open).cursor : getComputedStyle(el).cursor,
          }
        }),
      )
    // 演示数据的创建顺序是 Git+worktree → ESLint → 修侧栏，创建时间正好相反
    const kids = ['修侧栏时间显示', '整理 ESLint 规则', 'Git+worktree 不再提示文件撞车']
    const checkOrder = async (where) => {
      const list = await rows()
      if (list.length !== kids.length + 1) {
        errors.push(`独立分支（${where}）：列出 ${list.length} 行，应该有父对话 + ${kids.length} 个子对话`)
        return
      }
      if (!list[0].text.includes('agent-panel/cart-badge') || list[0].clickable)
        errors.push(`独立分支（${where}）：第一行不是父对话自己（${JSON.stringify(list[0])}）`)
      if (list.slice(1).some((x) => !x.clickable)) errors.push(`独立分支（${where}）：子对话行不是可点按钮`)
      if (list.slice(1).some((x) => x.cursor !== 'pointer')) errors.push(`独立分支（${where}）：子对话行的鼠标不是手型`)
      const got = kids.map((title) => list.slice(1).findIndex((x) => x.text.includes(title)))
      if (got.some((i) => i < 0) || got.join(',') !== '0,1,2')
        errors.push(`独立分支（${where}）：没有按创建时间升序（${got.join(',')}）`)
    }
    await openEnv()
    await check(p, '独立分支-计数', ['3 个没合并'])
    await checkOrder('排序')
    await check(p, '独立分支-顺序')
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
    const target = p.getByRole('button', { name: '在右侧打开子对话「Git+worktree 不再提示文件撞车」' })
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
  // 子对话栏的计数：五个在转圈（三个在跑、一个在等后台命令、一个已标记解决但还在跑），分母是进程还活着的 5 个。
  // 在跑又带着没做完计划的也算「执行中」，不能一边转圈一边归到「未完成」
  {
    // 按 aria-label 里的计数文案定位：页面上还有别的（禁用的）按钮也写着「子对话」
    const bar = p.getByRole('button', { name: /个进行中，共 \d+ 个/ })
    if (!(await bar.count())) errors.push('子对话栏：输入框上方没有子对话入口')
    else {
      await check(p, '子对话-五个在跑', ['子对话', '5/5'])
      await bar.first().click()
      // 消息流里的运行区和弹层「运行中」是同一批条目（见 shared/task.ts 的 visibleChildren）：
      // 条数、顺序、状态标签都要对得上。以前运行区自己写 working && !resolved，
      // 在等后台命令、已解决但还在跑的子对话只在弹层里有，同一个页面对不上数。
      await p
        .waitForFunction(
          () =>
            [...document.querySelectorAll('[aria-label="运行中"]')].some((box) =>
              [...box.children].some((r) => (r.innerText || '').trim().startsWith('子对话')),
            ),
          { timeout: 10000 },
        )
        .catch(() => errors.push('运行区：消息流里没有列出子对话'))
      const boxes = await p.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
        // 运行区里子对话行以「子对话」开头（同一段里还有工具行、后台命令行）
        const runs = [...document.querySelectorAll('[aria-label="运行中"]')].flatMap((box) =>
          [...box.children].map((r) => norm(r.innerText)).filter((x) => x.startsWith('子对话')),
        )
        // 弹层「运行中」：整行宽、左对齐的按钮就是条目（顶部 tab、关闭按钮的类名不同）
        const tray = [...document.querySelectorAll('div.absolute.bottom-full')].find((d) =>
          [...d.querySelectorAll('button')].some((b) => (b.className || '').includes('text-left')),
        )
        const items = tray
          ? [...tray.querySelectorAll('button')]
              .filter((b) => (b.className || '').includes('text-left'))
              .map((b) => norm(b.innerText))
          : []
        // 运行区子对话行的详情（状态标签、当前活动）要跟在标题后面左对齐：
        // 以前标题 flex-1 占满中间，状态和活动被推到行尾，看起来像居中/靠右居中。
        // 左对齐后标题和状态两段文字不能糊成一块：中间要有分隔线，且状态不是另一个点击目标
        const align = [...document.querySelectorAll('[aria-label="运行中"]')]
          .flatMap((box) => [...box.children])
          .filter((r) => norm(r.innerText).startsWith('子对话'))
          .map((row) => {
            // openTip「在右侧打开子对话」就是标题按钮：可点的只有这一段
            const title = [...row.querySelectorAll('button')].find((b) =>
              // 「打开子对话」只有标题按钮有；切换下拉的 title 是「切换子对话」，不能选中它
              (b.getAttribute('title') || '').includes('打开子对话'),
            )
            // 状态标签是带 text-[0.6875rem] 的 span（「子对话」动作名和右边的耗时没有这个类）
            const tags = [...row.querySelectorAll('span')]
              .filter((s) => (s.className || '').includes('text-[0.6875rem]'))
              .filter((s) => s.getBoundingClientRect().width > 0)
              .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
            if (!title || !tags.length) return null
            const tag = tags[0]
            // 真正负责裁剪的那一层（详情容器）：靠类名取而不靠结构层级，多包一层也不会量错
            const clip = tag.closest('.overflow-hidden')?.getBoundingClientRect()
            const sepBox = tag.closest('.border-l')
            // 耗时是行尾那个等宽数字（tabular-nums），它要贴住行右边
            const ms = [...row.querySelectorAll('span')].find((s) => (s.className || '').includes('tabular-nums'))
            const rowRight = row.getBoundingClientRect().right
            return {
              gap: Math.round(tag.getBoundingClientRect().left - title.getBoundingClientRect().right),
              // 分隔线不只看类名：类还在但样式被覆盖时也要能发现
              sep: !!sepBox && parseFloat(getComputedStyle(sepBox).borderLeftWidth) >= 1,
              // 状态和活动文字跟着整行可点：不套进按钮（不出现嵌套按钮），鼠标是手型
              inButton: !!tag.closest('button'),
              cursor: getComputedStyle(tag).cursor,
              tags: tags.length,
              clipped: tags.some((t) => !!clip && t.getBoundingClientRect().right > clip.right + 1),
              msGap: ms ? Math.round(rowRight - ms.getBoundingClientRect().right) : null,
            }
          })
          .filter(Boolean)
        return { runs, items, align }
      })
      if (boxes.runs.length !== boxes.items.length)
        errors.push(`运行区和弹层条目数对不上：运行区 ${boxes.runs.length} 条、弹层 ${boxes.items.length} 条`)
      // 两处的状态标签一致：计划没做完的写「计划 1/2」、在等后台命令的写「等结果」+ 在等什么、
      // 已标记解决但还在跑的仍然是「执行中」（完成标记不能盖住还在跑）
      for (const tag of ['计划 1/2', '等结果', '等 1 个后台命令', '执行中']) {
        if (!boxes.runs.some((x) => x.includes(tag))) errors.push(`运行区：没有显示「${tag}」`)
        if (!boxes.items.some((x) => x.includes(tag))) errors.push(`弹层：没有显示「${tag}」`)
      }
      if (boxes.runs.some((x) => x.includes('已解决')))
        errors.push('运行区：已标记解决但还在跑的那条被写成了「已解决」')
      // 顺序也一致：正在跑的在前，同一类里按本次开启的时间倒序（两处读同一个 sortChildren）
      const titles = [
        'Git+worktree 不再提示文件撞车',
        '内存面板增加 AI 分析',
        '子任务卡片移到子对话那一栏',
        '整理 ESLint 规则',
        '压测导入大文件',
      ]
      const order = (list) =>
        titles
          .map((x) => list.findIndex((y) => y.includes(x)))
          .filter((i) => i >= 0)
          .join(',')
      if (order(boxes.runs) !== order(boxes.items))
        errors.push(`运行区和弹层的顺序不一致：运行区 ${order(boxes.runs)}、弹层 ${order(boxes.items)}`)
      // 左对齐：状态标签只隔一个分隔间距跟在标题后面，两段文字之间有分隔线，
      // 状态/活动文字跟着整行可点（不套按钮），耗时仍在行尾。
      // 不按「行宽比例」判：标题按内容宽度、上限 25%（见 RowShell），
      // 长标题的行比例本来就会偏右，拿比例当阈值会把合法布局判红
      if (!boxes.align.length) errors.push('运行区：子对话行里没找到可以核对对齐的状态标签')
      else if (boxes.align.length !== boxes.runs.length)
        errors.push(`运行区：${boxes.runs.length} 条子对话行里只有 ${boxes.align.length} 条能测到标题和状态标签`)
      // 有「计划 n/m + 执行中」这种一行两个标签的行，才算测到了真实排布
      if (boxes.align.length && !boxes.align.some((a) => a.tags > 1))
        errors.push('运行区：没有一行同时显示两个状态标签，核对不到「计划 n/m + 执行中」的排布')
      for (const a of boxes.align) {
        if (a.gap < 12 || a.gap > 24) errors.push(`运行区子对话行：状态标签距标题 ${a.gap}px，没有紧跟标题左对齐`)
        if (!a.sep) errors.push('运行区子对话行：标题和状态之间没有分隔线，两段文字连成一片')
        if (a.inButton)
          errors.push(`运行区子对话行：状态/活动文字被套进了按钮（inButton ${a.inButton}），整行点击不该嵌套按钮`)
        if (a.cursor !== 'pointer')
          errors.push(`运行区子对话行：状态/活动文字不可点（cursor ${a.cursor}），整段文本都应该能打开子对话`)
        if (a.clipped) errors.push('运行区子对话行：状态标签被详情容器裁掉了')
        // 行内边距 px-2.5 = 10px：耗时要贴住行右边，不能被详情挤出容器
        if (a.msGap === null || a.msGap > 16) errors.push(`运行区子对话行：耗时没贴住行尾（右端距行右缘 ${a.msGap}px）`)
      }
      await check(p, '子对话-运行区与弹层一致')
      await check(p, '子对话-运行区左对齐')
      await p.getByRole('button', { name: '全部' }).first().click()
      await check(p, '子对话-五个在跑-列表', ['执行中 · 5', '已完成 · 3'])
      await p.keyboard.press('Escape')
      await closed()
      // 整段文本可点：点状态标签（不只是标题）也能在右栏打开这个子对话
      {
        const clicked = await p.evaluate(() => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
          const box = [...document.querySelectorAll('[aria-label="运行中"]')].find((b) =>
            [...b.children].some((r) => norm(r.innerText).startsWith('子对话')),
          )
          const row = box ? [...box.children].find((r) => norm(r.innerText).startsWith('子对话')) : null
          // 状态标签是带 text-[0.6875rem] 的 span（「子对话」动作名和右边的耗时没有这个类）
          const tag = row
            ? [...row.querySelectorAll('span')].find(
                (s) => (s.className || '').includes('text-[0.6875rem]') && s.getBoundingClientRect().width > 0,
              )
            : null
          if (!tag) return ''
          const title = norm(row.querySelector('button[title*="打开子对话"]')?.innerText || '')
          tag.click()
          return title
        })
        if (!clicked) errors.push('运行区：没有找到状态标签，核对不了整段文本可点')
        else {
          const opened = await p
            .waitForFunction(
              (title) => !!document.querySelector('aside[aria-label="子对话"]')?.innerText.includes(title),
              clicked,
              { timeout: 3000 },
            )
            .then(
              () => true,
              () => false,
            )
          if (!opened) errors.push(`运行区：点状态标签后右栏没有打开「${clicked}」`)
          await check(p, '子对话-整段文本可点')
        }
      }
      // 标题左边的切换下拉：列出全部子对话，当前项带选中标记，点另一项就切换
      {
        const trigger = p.locator('[aria-label="运行中"] button[aria-label="切换子对话"]').first()
        if (!(await trigger.count())) errors.push('运行区：子对话行左边没有切换子对话的按钮')
        else {
          await trigger.click()
          await p
            .locator('[role="menu"] [data-child-item]')
            .first()
            .waitFor({ timeout: 3000 })
            .catch(() => {})
          const count = await p.locator('[role="menu"] [data-child-item]').count()
          if (count < 2) errors.push(`切换子对话：下拉里只有 ${count} 项，应该列出全部子对话`)
          if (!(await p.locator('[role="menu"] [data-current]').count()))
            errors.push('切换子对话：下拉里没有标出当前打开的那一项')
          await check(p, '子对话-切换下拉')
          const next = p.locator('[role="menu"] [data-child-item]:not([data-current])').first()
          const title = await next
            .evaluate((el) => (el.querySelector('span.truncate')?.textContent || '').trim())
            .catch(() => '')
          if (!title) errors.push('切换子对话：下拉里没有可以切换的另一项')
          else {
            await next.click()
            const switched = await p
              .waitForFunction(
                (name) => {
                  const menu = document.querySelector('[role="menu"]')
                  const pane = document.querySelector('aside[aria-label="子对话"]')
                  return !menu && !!pane && (pane.innerText || '').includes(name)
                },
                title,
                { timeout: 3000 },
              )
              .then(
                () => true,
                () => false,
              )
            if (!switched) errors.push(`切换子对话：选了「${title}」后下拉没关或右栏没有切换过去`)
            await check(p, '子对话-切换下拉-打开')
          }
        }
      }
      // 右栏子对话标题行左侧的切换下拉：和运行区那处一致，Esc 关、鼠标和键盘都要真的切过去
      {
        /** 右栏标题（h2）现在的文字：切换是否生效看它 */
        const paneTitle = () =>
          p.evaluate(() => (document.querySelector('aside[aria-label="子对话"] h2')?.textContent || '').trim())
        /** 菜单里的条目：标题、选中标记、键盘高亮 */
        const menuItems = () =>
          p.evaluate(() =>
            [...document.querySelectorAll('[role="menu"] [data-child-item]')].map((e) => ({
              title: (e.querySelector('span.truncate')?.textContent || '').trim(),
              current: e.hasAttribute('data-current'),
              highlighted: e.hasAttribute('data-highlighted'),
            })),
          )
        /** 等右栏标题真的变成目标子对话 */
        const switchedTo = (title) =>
          p
            .waitForFunction(
              (name) => (document.querySelector('aside[aria-label="子对话"] h2')?.textContent || '').trim() === name,
              title,
              { timeout: 3000 },
            )
            .then(
              () => true,
              () => false,
            )
        const trigger = p.locator('aside[aria-label="子对话"] button[aria-label="切换子对话"]').first()
        const openMenu = async () => {
          await trigger.click()
          await p
            .locator('[role="menu"] [data-child-item]')
            .first()
            .waitFor({ timeout: 3000 })
            .catch(() => {})
          return menuItems()
        }
        if (!(await trigger.count())) errors.push('右栏子对话标题左边没有切换子对话的按钮')
        else {
          const currentTitle = await paneTitle()
          const items = await openMenu()
          const marked = items.find((x) => x.current)
          if (!items.length) errors.push('右栏切换下拉：没有列出子对话')
          if (!marked) errors.push('右栏切换下拉：没有标出当前打开的那一项')
          else if (currentTitle && marked.title !== currentTitle)
            errors.push(`右栏切换下拉：选中标记在「${marked.title}」，右栏打开的是「${currentTitle}」`)
          await check(p, '子对话-右栏切换下拉')
          // 鼠标点一个不是当前项的条目：右栏要真的切过去、菜单关闭，而不只是菜单关掉
          const target = items.find((x) => !x.current)
          if (!target) errors.push('右栏切换下拉：没有可以切换的另一项，核对不了切换')
          else {
            await p.locator('[role="menu"] [data-child-item]:not([data-current])').first().click()
            if (!(await switchedTo(target.title))) errors.push(`右栏切换下拉：点了「${target.title}」后右栏没有切过去`)
            if (await p.locator('[role="menu"]').count()) errors.push('右栏切换下拉：点了条目后菜单还开着')
            await check(p, '子对话-右栏切换下拉-点选')
          }
          // Esc 关
          await openMenu()
          await p.keyboard.press('Escape')
          if (
            !(await p
              .waitForFunction(() => !document.querySelector('[role="menu"]'), { timeout: 3000 })
              .then(
                () => true,
                () => false,
              ))
          )
            errors.push('右栏切换下拉：按 Escape 没有关闭')
          // 键盘：方向键走到一个不是当前项的条目，回车切换
          const nowTitle = await paneTitle()
          await openMenu()
          let picked = ''
          for (let i = 0; i < 12 && !picked; i++) {
            await p.keyboard.press('ArrowDown')
            const hi = (await menuItems()).find((x) => x.highlighted)
            if (hi && hi.title !== nowTitle) picked = hi.title
          }
          if (!picked) errors.push('右栏切换下拉：方向键没有走到别的子对话')
          else {
            await p.keyboard.press('Enter')
            if (!(await switchedTo(picked))) errors.push(`右栏切换下拉：方向键 + 回车没有切到「${picked}」`)
            await check(p, '子对话-右栏切换下拉-键盘')
          }
        }
      }
      // 整段文本的其它区域也能点：耗时文字、动作名；键盘 Enter 也能打开（不只是状态标签）
      {
        /** 右栏开着就先关掉，等它卸载 */
        const closePane = async () => {
          if (!(await p.locator('aside[aria-label="子对话"]').count())) return
          await p
            .getByRole('button', { name: '关闭子对话', exact: true })
            .first()
            .click()
            .catch(() => errors.push('子对话：没有找到关闭按钮，后面的整段可点核对不成立'))
          // 关不掉时右栏本来就开着，后面的「打开了吗」会假通过，必须报出来
          if (
            !(await p
              .waitForFunction(() => !document.querySelector('aside[aria-label="子对话"]'), { timeout: 3000 })
              .then(
                () => true,
                () => false,
              ))
          )
            errors.push('子对话：点了关闭后右栏还开着，后面的整段可点核对不成立')
        }
        const rowInfo = () =>
          p.evaluate(() => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
            const box = [...document.querySelectorAll('[aria-label="运行中"]')].find((b) =>
              [...b.children].some((r) => norm(r.innerText).startsWith('子对话')),
            )
            const row = box ? [...box.children].find((r) => norm(r.innerText).startsWith('子对话')) : null
            return { title: norm(row?.querySelector('button[title*="打开子对话"]')?.innerText || ''), hasRow: !!row }
          })
        const openedFor = (title) =>
          p
            .waitForFunction(
              (name) => !!document.querySelector('aside[aria-label="子对话"]')?.innerText.includes(name),
              title,
              { timeout: 3000 },
            )
            .then(
              () => true,
              () => false,
            )
        const info = await rowInfo()
        if (!info.hasRow || !info.title) errors.push('运行区：没有找到子对话行，核对不了整段文本可点')
        else {
          await closePane()
          await p.evaluate(() => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
            const box = [...document.querySelectorAll('[aria-label="运行中"]')].find((b) =>
              [...b.children].some((r) => norm(r.innerText).startsWith('子对话')),
            )
            const row = box ? [...box.children].find((r) => norm(r.innerText).startsWith('子对话')) : null
            // 耗时是行尾那个等宽数字（tabular-nums）
            const ms = [...(row?.querySelectorAll('span') || [])].find((s) =>
              (s.className || '').includes('tabular-nums'),
            )
            ms?.click()
          })
          if (!(await openedFor(info.title))) errors.push('运行区：点耗时文字没有打开子对话')
          await check(p, '子对话-整段文本可点-耗时')
          await closePane()
          await p.evaluate(() => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
            const box = [...document.querySelectorAll('[aria-label="运行中"]')].find((b) =>
              [...b.children].some((r) => norm(r.innerText).startsWith('子对话')),
            )
            const row = box ? [...box.children].find((r) => norm(r.innerText).startsWith('子对话')) : null
            // 动作名按钮带 aria-label、没有 title；标题按钮两个都有
            row?.querySelector('button[aria-label*="打开子对话"]:not([title])')?.click()
          })
          if (!(await openedFor(info.title))) errors.push('运行区：点动作名没有打开子对话')
          await check(p, '子对话-整段文本可点-动作名')
          await closePane()
          await p.evaluate(() => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
            const box = [...document.querySelectorAll('[aria-label="运行中"]')].find((b) =>
              [...b.children].some((r) => norm(r.innerText).startsWith('子对话')),
            )
            const row = box ? [...box.children].find((r) => norm(r.innerText).startsWith('子对话')) : null
            row?.querySelector('button[title*="打开子对话"]')?.focus()
          })
          await p.keyboard.press('Enter')
          if (!(await openedFor(info.title))) errors.push('运行区：焦点在标题上按 Enter 没有打开子对话')
          await check(p, '子对话-整段文本可点-键盘')
        }
      }
      // 收掉右栏：后面窄窗口那几段用 reload 测行宽，右栏开着会盖住整个窄屏
      if (await p.locator('aside[aria-label="子对话"]').count()) {
        await p
          .getByRole('button', { name: '关闭子对话', exact: true })
          .first()
          .click()
          .catch(() => errors.push('子对话：没有找到关闭按钮'))
        await p
          .waitForFunction(() => !document.querySelector('aside[aria-label="子对话"]'), { timeout: 3000 })
          .catch(() => errors.push('子对话：点了关闭后右栏还开着'))
      }
    }
  }
  // 窄窗口：子对话行的状态标签不能被裁，「计划 1/2」不能变成「计划 1」；
  // 活动文字是补充信息，窄屏藏起来，宽度留给标签和耗时
  {
    await p.setViewportSize({ width: 375, height: 820 })
    await p.reload()
    await backToTask()
    /** 等运行区里出现子对话行（窄屏藏了动作名，按标题按钮的 openTip 定位） */
    const waitRows = () =>
      p
        .waitForFunction(
          () =>
            [...document.querySelectorAll('[aria-label="运行中"]')].some((box) =>
              [...box.children].some((r) => !!r.querySelector('button[title*="打开子对话"]')),
            ),
          { timeout: 10000 },
        )
        .catch(() => {})
    const measureNarrow = () =>
      p.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const rows = [...document.querySelectorAll('[aria-label="运行中"]')]
          .flatMap((b) => [...b.children])
          .filter((r) => !!r.querySelector('button[title*="打开子对话"]'))
        return {
          rows: rows.length,
          // 行宽：1280 那段靠它确认真的复现出了「开着右栏再缩窗」的窄行，
          // 默认右栏改成关闭时这里会变宽，断言就不会再静默通过
          rowWidth: rows[0] ? Math.round(rows[0].getBoundingClientRect().width) : 0,
          items: rows
            .map((row) => {
              // 一行可能有几个状态标签（「计划 1/2」+「执行中」），每个都要完整
              const tags = [...row.querySelectorAll('span')]
                .filter((s) => (s.className || '').includes('text-[0.6875rem]'))
                .filter((s) => s.getBoundingClientRect().width > 0)
              if (!tags.length) return null
              // 真正裁剪的那一层（overflow-hidden）：标签超出它就会被裁掉
              const clip = tags[0].closest('.overflow-hidden')?.getBoundingClientRect()
              return {
                text: tags.map((t) => norm(t.innerText)).join(' + '),
                clipped: tags.some((t) => !!clip && t.getBoundingClientRect().right > clip.right + 1),
                // 活动文字（带 truncate 的那一段）在窄屏要隐藏
                noteShown: [...row.querySelectorAll('span')].some(
                  (s) =>
                    (s.className || '').includes('font-sans') &&
                    (s.className || '').includes('truncate') &&
                    getComputedStyle(s).display !== 'none',
                ),
              }
            })
            .filter(Boolean),
        }
      })
    // 375 截图留证据（含两标签的行都要在画面里）；320 更窄，一个标签也不能裁
    for (const width of [375, 320]) {
      await p.setViewportSize({ width, height: 820 })
      await p.reload()
      await backToTask()
      await waitRows()
      const narrow = await measureNarrow()
      if (!narrow.rows) errors.push(`运行区（${width}px）：没有列出子对话，核对不了状态标签`)
      else if (narrow.items.length !== narrow.rows)
        errors.push(`运行区（${width}px）：${narrow.rows} 条子对话行里只有 ${narrow.items.length} 条能测到状态标签`)
      for (const n of narrow.items) {
        if (n.clipped) errors.push(`运行区（${width}px）：状态标签「${n.text}」被裁掉了`)
        if (n.noteShown) errors.push(`运行区（${width}px）：活动文字还占着宽度，状态标签会被挤掉`)
      }
      if (width === 375) {
        // 运行区在消息流里往往滚在视口外：先滚到它，截图里才看得到全部子对话行
        await p
          .locator('[aria-label="运行中"]')
          .first()
          .scrollIntoViewIfNeeded()
          .catch(() => {})
        await check(p, '子对话-运行区窄窗口')
      }
    }
    // 1024：右栏收着，这一行有 700 多像素宽，活动文字不能跟着窄屏一起藏起来。
    // 显隐按这一行自己的宽度（容器查询），不是按视口断点
    await p.setViewportSize({ width: 1024, height: 900 })
    await p.reload()
    await backToTask()
    await waitRows()
    const midWide = await measureNarrow()
    if (!midWide.rows) errors.push('运行区（1024px）：没有列出子对话')
    else if (!midWide.items.some((n) => n.noteShown)) errors.push('运行区（1024px）：行够宽，活动文字却不见了')
    if (
      !(await p.evaluate(() =>
        [...document.querySelectorAll('[aria-label="运行中"] button[aria-label="切换子对话"]')].some(
          (b) => b.getBoundingClientRect().width > 0,
        ),
      ))
    )
      errors.push('运行区（1024px）：行够宽，左边的切换下拉却不见了')
    await check(p, '子对话-运行区1024')
    await p.setViewportSize({ width: 1440, height: 900 })
    await p.reload()
    await backToTask()
    // 1280 这一格：宽窗口开着右栏再缩下来，运行区一行只剩 300 多像素；
    // 这一行窄到放不下活动文字时，状态标签也不能被裁
    await p.setViewportSize({ width: 1280, height: 900 })
    await settle(p)
    const mid = await measureNarrow()
    if (!mid.rows) errors.push('运行区（1280px）：没有列出子对话，核对不了状态标签')
    else if (mid.items.length !== mid.rows)
      errors.push(`运行区（1280px）：${mid.rows} 条子对话行里只有 ${mid.items.length} 条能测到状态标签`)
    for (const n of mid.items) if (n.clipped) errors.push(`运行区（1280px）：状态标签「${n.text}」被裁掉了`)
    // 没复现出窄行（右栏没占宽、改成单栏）时这一段等于没测到，直接报出来
    if (mid.rowWidth > 340)
      errors.push(`运行区（1280px）：行宽 ${mid.rowWidth}px，没复现出右栏占宽后的窄行（应该 <340）`)
    // 运行区可能在视口外：截之前先滚到它，图里才看得到行宽 300 多像素时的真实排布
    await p
      .locator('[aria-label="运行中"]')
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {})
    await check(p, '子对话-运行区1280')
    await p.setViewportSize({ width: 1440, height: 900 })
    await settle(p)
  }
  // 子对话交回的状态不再藏起来：画成「接收消息 + 类型 + 内容标题」，点标题弹窗看全文
  {
    const row = p.getByText('接收消息', { exact: true }).first()
    if (!(await row.count())) errors.push('父对话里没有「接收消息」行：子对话交回的上报被藏起来了')
    else {
      await row.scrollIntoViewIfNeeded()
      await check(p, '接收消息-子对话上报', ['接收消息', '汇报', '已完成：合回原分支'])
      await p.getByRole('button', { name: '已完成：合回原分支、标记完成' }).first().click()
      await check(p, '接收消息-弹窗', ['已收到', '打开子对话'])
      await p.keyboard.press('Escape')
      await closed()
    }
  }
  // 面板的 run_background：解析层对带 command 的输入存的是命令原文（不是 JSON），
  // 折叠行要靠它兜底显示命令，不能只剩「后台命令」和耗时
  {
    const title = p.locator('button[title*="npm ci > /tmp/npmci.log"]').first()
    if (!(await title.count())) errors.push('后台命令折叠行：没有显示命令，只剩「后台命令」')
    else {
      await title.scrollIntoViewIfNeeded()
      const tip = await title.getAttribute('title')
      if (!tip?.includes('tail -20 /tmp/npmci.log')) errors.push(`后台命令折叠行：悬停提示不是完整命令（${tip}）`)
      await check(p, '后台命令-折叠行显示命令', ['后台命令', 'npm ci > /tmp/npmci.log 2>&1'])
    }
  }
  // 发出去的消息也是工具行：父对话里画成「发送消息 · 传话」，不把正文铺成居中的系统块
  {
    const row = p.getByText('发送消息', { exact: true }).first()
    if (!(await row.count())) errors.push('父对话里没有「发送消息」行：send_message 又被铺成居中的说明块')
    else {
      await row.scrollIntoViewIfNeeded()
      await check(p, '发送消息-传话', ['发送消息', '传话', '核对通知时序'])
    }
  }
  // 派出的子任务不再铺在消息流里：入口在输入框上方单独一行，点开是列表和只读窗口
  {
    const openTask = () => backToTask()
    // 折叠行「派出 3 个子任务」也是一个按钮；入口按钮的 aria-label 就是「子任务」。
    // 按 aria-label 定位，不按可见名字：运行区里子任务起的后台命令行首也写「子任务」，按名字会选错那一行
    const subBar = () => p.locator('button[aria-label="子任务"]')
    const bar = subBar()
    if (!(await bar.count())) errors.push('子任务栏：输入框上方没有「子任务」入口')
    else {
      // 数字和子对话一个写法：在跑时「运行中/总数」，没在跑时只写总数（这一份全做完了）
      const doneLabel = (await bar.first().innerText()).replace(/\s+/g, ' ').trim()
      if (!/^子任务 \d+$/.test(doneLabel)) errors.push(`子任务栏：没在跑时应该只写总数，现在是「${doneLabel}」`)
      if (await p.getByText('核对角标的订阅时机', { exact: false }).count())
        errors.push('子任务栏：消息流里还画着子任务卡片')
      // 状态栏固定三行：计划在上、子任务中间、子对话在下；每行只占一行、不换行，
      // 子对话小块放不下时收成「+N」，不折到下一行去挤别的行
      const measureBars = () =>
        p.evaluate(() => {
          const row = (name) => {
            const el = document.querySelector(`[data-status-row="${name}"]`)
            if (!el) return null
            const r = el.getBoundingClientRect()
            const kids = [...el.children].map((c) => c.getBoundingClientRect())
            // 行内元素按 items-center 对齐，高度不同时 top 本来就会差一两像素：
            // 比竖直中心，换行时掉下去的那一块中心和第一块差一行高
            const mid = (k) => k.top + k.height / 2
            return {
              top: Math.round(r.top),
              bottom: Math.round(r.bottom),
              height: Math.round(r.height),
              sameTop: kids.every((k) => Math.abs(mid(k) - mid(kids[0])) < 4),
            }
          }
          const children = document.querySelector('[data-status-row="children"]')
          const cards = children
            ? [...children.querySelectorAll('[data-child-card]')].map((c) => c.getBoundingClientRect())
            : []
          const more = children?.querySelector('[data-child-more]')
          const room = children?.querySelector('[data-child-cards]')?.getBoundingClientRect()
          const moreBox = more?.getBoundingClientRect()
          return {
            plan: row('plan'),
            children: row('children'),
            helpers: row('helpers'),
            cards: cards.length,
            cardW: cards.length ? Math.round(cards[0].width) : 0,
            hidden: more ? Number((more.textContent || '').replace(/[^\d]/g, '')) : 0,
            cardRight: cards.length ? Math.round(Math.max(...cards.map((c) => c.right))) : 0,
            roomW: room ? Math.round(room.width) : 0,
            roomLeft: room ? Math.round(room.left) : 0,
            roomRight: room ? Math.round(room.right) : 0,
            moreW: moreBox ? Math.round(moreBox.width) : 0,
            moreLeft: moreBox ? Math.round(moreBox.left) : 0,
            moreRight: moreBox ? Math.round(moreBox.right) : 0,
          }
        })
      /** 三行的顺序、单行不换行、小块 + 隐藏数 = 在跑的子对话数 */
      const checkBars = async (where, busy) => {
        const b = await measureBars()
        if (!b.plan || !b.children || !b.helpers) {
          errors.push(`状态栏（${where}）：没有同时出现计划、子对话、子任务三行`)
          return b
        }
        // 顺序：计划 → 子任务 → 子对话
        if (b.plan.bottom > b.helpers.top + 1 || b.helpers.bottom > b.children.top + 1)
          errors.push(
            `状态栏（${where}）：三行顺序不对，应该是计划 → 子任务 → 子对话（计划 ${b.plan.top}-${b.plan.bottom}、子任务 ${b.helpers.top}-${b.helpers.bottom}、子对话 ${b.children.top}-${b.children.bottom}）`,
          )
        for (const [name, r] of [
          ['计划', b.plan],
          ['子任务', b.helpers],
          ['子对话', b.children],
        ]) {
          if (!r.sameTop) errors.push(`状态栏（${where}）：「${name}」这一行换行了`)
          if (r.height > 40) errors.push(`状态栏（${where}）：「${name}」这一行占了 ${r.height}px，不是单行`)
        }
        if (b.cards + b.hidden !== busy)
          errors.push(`状态栏（${where}）：子对话小块 ${b.cards} 个 + 隐藏 ${b.hidden} 个，应该等于在跑的 ${busy} 个`)
        if (b.cards && b.cardW < 200) errors.push(`状态栏（${where}）：子对话小块被压到 ${b.cardW}px，不是固定宽度`)
        if (b.hidden > 0) {
          // 数字必须真的看得见：容器被挤成 0 宽时，overflow-hidden 会把「+N」整个裁掉
          if (b.roomW < 1) errors.push(`状态栏（${where}）：卡片容器宽 0，「+N」没有位置，用户看不到隐藏数`)
          else if (b.moreLeft < b.roomLeft - 1 || b.moreRight > b.roomRight + 1)
            errors.push(
              `状态栏（${where}）：「+N」超出卡片容器被裁掉（容器 ${b.roomLeft}-${b.roomRight}、+N ${b.moreLeft}-${b.moreRight}）`,
            )
          if (b.cards && b.cardRight > b.moreLeft) errors.push(`状态栏（${where}）：小块压到「+N」上`)
        }
        return b
      }
      // 在跑的子对话数从入口按钮的 aria-label 读，跟着演示数据走，不写死 5
      const childLabel =
        (await p.locator('button[aria-expanded][aria-label^="子对话"]').first().getAttribute('aria-label')) ?? ''
      const busy = Number(childLabel.match(/(\d+) 个进行中/)?.[1] ?? 0)
      if (!busy) errors.push(`状态栏：子对话入口没写「n 个进行中」（现在是「${childLabel}」），核对不了小块个数`)
      // 先量宽窗口：左右两栏都在，1920 时中间还有位置放小块
      await p.setViewportSize({ width: 1920, height: 900 })
      await settle(p)
      const wide = await checkBars('1920', busy)
      if (wide && busy && !wide.cards) errors.push('状态栏（1920）：宽窗口里一个小块都没显示，+N 没有按可用宽度让位')
      await check(p, '状态栏-三行')
      // 验收标准 2 的后半句：点「+N」还是能看到全部，不只是个数字
      if (wide && wide.hidden > 0) {
        await p.locator('[data-child-more]').click()
        const listed = await p.evaluate(
          () => document.querySelectorAll('div.absolute.bottom-full [data-child-item]').length,
        )
        if (listed !== busy)
          errors.push(`状态栏（1920）：点「+${wide.hidden}」后浮层里列了 ${listed} 个子对话，应该是在跑的 ${busy} 个`)
        await check(p, '状态栏-三行-展开全部')
        await p.keyboard.press('Escape')
        await p
          .waitForFunction(() => !document.querySelector('div.absolute.bottom-full'), { timeout: 3000 })
          .catch(() => {})
      }
      // 缩窄窗口：「+N」跟着变大、小块变少，三行仍然各自一行（不重新加载，量的是同一条状态栏）
      await p.setViewportSize({ width: 1440, height: 900 })
      await settle(p)
      const mid = await checkBars('1440', busy)
      if (mid && wide && wide.hidden > 0 && !(mid.hidden > wide.hidden))
        errors.push(`状态栏（1440）：窗口变窄后隐藏数没变多（1920 是 ${wide.hidden} 个、1440 是 ${mid.hidden} 个）`)
      await check(p, '状态栏-三行-1440')
      await p.setViewportSize({ width: 375, height: 820 })
      await settle(p)
      const narrow = await checkBars('375', busy)
      if (narrow && mid && !(narrow.hidden >= mid.hidden))
        errors.push(`状态栏（375）：窗口变窄后隐藏数反而变少（1440 是 ${mid.hidden} 个、375 是 ${narrow.hidden} 个）`)
      await check(p, '状态栏-三行-375')
      await p.setViewportSize({ width: 1440, height: 900 })
      await p.reload()
      await openTask()
      await bar.first().click()
      // 这个示例对话本来就有 2 个子角色，演示数据又添了 1 个
      await check(p, '子任务-列表', ['共 3 个', '已完成', '核对角标的订阅时机', '8.6s'])
      await p.getByRole('button', { name: /核对角标的订阅时机/ }).click()
      await check(p, '子任务-窗口', ['问题在', '这里只能查看'])
      await p.keyboard.press('Escape')
      await closed()
      // 执行中的子任务只在按钮上标 x/y，不再在旁边排成「标题 + 耗时」的运行卡片（那种卡片只给子对话）
      const key = 'agent-panel-demo-v3'
      const saved = await p.evaluate((k) => localStorage.getItem(k), key)
      await p.evaluate((k) => {
        const db = JSON.parse(localStorage.getItem(k))
        const parent = db.tasks.find((x) => x.title.includes('购物车'))
        // 按标题挑那一个：主对话里还有模拟执行派出的子任务（复现问题…），取第一个会插到别的行上
        const sub = parent.steps.find((x) => x.slot === 'sub' && x.title === '核对角标的订阅时机')
        if (!sub) throw new Error('演示数据里找不到「核对角标的订阅时机」这个子任务')
        sub.status = 'running'
        sub.endedAt = ''
        // 子任务起了一条还在跑的后台命令：运行区要按「子任务 + 命令名」列出来（老数据没有 jobs 字段）
        parent.jobs = [
          {
            id: 'job-ui-sub',
            step: sub.id,
            name: '单测',
            command: 'npm run test:unit',
            state: 'running',
            startedAt: new Date(Date.now() - 65_000).toISOString(),
          },
        ]
        localStorage.setItem(k, JSON.stringify(db))
      }, key)
      await p.reload()
      await openTask()
      await check(p, '子任务-执行中只留计数', ['子任务', '1/3'])
      // 运行区：子任务起的后台命令单独一行（行首「子任务」、标题是那一步、后面跟命令名和耗时），
      // 计时和父对话的后台命令同一个（RowShell 里的 fmtDuration）
      const subJobShown = await p
        .waitForFunction(
          () =>
            [...document.querySelectorAll('[aria-label="运行中"]')].some((box) =>
              [...box.children].some((r) => {
                // innerText 里「子任务」和标题之间是换行：先压成单个空格再比值
                const x = (r.innerText || '').replace(/\s+/g, ' ').trim()
                return x.startsWith('子任务 核对角标的订阅时机')
              }),
            ),
          { timeout: 10000 },
        )
        .then(
          () => true,
          () => false,
        )
      const subJobRow = subJobShown
        ? await p.evaluate(() => {
            const box = [...document.querySelectorAll('[aria-label="运行中"]')].find((b) =>
              [...b.children].some((r) => (r.innerText || '').trim().startsWith('子任务')),
            )
            return (box ? [...box.children] : [])
              .map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim())
              .find((x) => x.startsWith('子任务') && x.includes('核对角标的订阅时机'))
          })
        : ''
      if (!subJobRow) {
        // 失败时把运行区实际画了什么都带上：分不清是数据没到、没归到子任务，还是根本没渲染
        const drawn = await p.evaluate(() =>
          [...document.querySelectorAll('[aria-label="运行中"]')].flatMap((b) =>
            [...b.children].map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()),
          ),
        )
        errors.push(`运行区：子任务起的后台命令没有按「子任务 + 标题」列出来（当前行：${drawn.join(' | ') || '无'}）`)
      } else {
        if (!subJobRow.includes('单测')) errors.push(`运行区：子任务的后台命令没显示命令名，现在是「${subJobRow}」`)
        if (!/(\d+m )?\d+(\.\d+)?s/.test(subJobRow))
          errors.push(`运行区：子任务的后台命令行没有计时，现在是「${subJobRow}」`)
      }
      // 在跑时按钮上是「运行中/总数」，和子对话那一栏同一个写法（按 aria-label 定位输入框上方的入口）
      const runLabel = (await subBar().first().innerText()).replace(/\s+/g, ' ').trim()
      if (!/^子任务 1\/3$/.test(runLabel)) errors.push(`子任务栏：执行中应该写「运行中/总数」，现在是「${runLabel}」`)
      const rowText = await p.evaluate(() => {
        const sub = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '子任务')
        const row = sub?.parentElement?.parentElement
        return row ? [...row.querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\s+/g, ' ')) : []
      })
      if (rowText.some((x) => x.includes('核对角标的订阅时机')))
        errors.push('子任务栏：执行中的子任务又排成了「标题 + 耗时」卡片')
      await check(p, '子任务-执行中')
      await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
      await p.reload()
      await openTask()
      // 窄窗口：两个计数入口各自占一行、都要保留，不能被挤没
      await p.setViewportSize({ width: 900, height: 800 })
      await p.reload()
      await openTask()
      // 子对话列表是异步取的（4 秒一轮），刷新后要等它回来再判断，不能立刻 count
      const seen = (locator) =>
        locator
          .first()
          .waitFor({ timeout: 5000 })
          .then(
            () => true,
            () => false,
          )
      if (!(await seen(subBar()))) errors.push('子任务栏：窄窗口里入口不见了')
      if (!(await seen(p.getByRole('button', { name: /^子对话/ })))) errors.push('子对话栏：窄窗口里入口不见了')
      await check(p, '子任务-窄窗口')
      await p.setViewportSize({ width: 1440, height: 900 })
      await p.reload()
      await openTask()
    }
  }

  // 差异窗口：文件头带统计和上一个/下一个文件，左右对照有行内高亮，可切上下对照
  {
    await backToTask()
    await p.getByRole('tab', { name: /改动/ }).click()
    await check(p, '改动-文件列表', ['改动 2 个文件', 'CartBadge.tsx', 'RestockButton.tsx'])
    await p.getByTitle('查看「src/components/CartBadge.tsx」的改动', { exact: true }).click()
    await check(p, '差异-左右对照', ['CartBadge.tsx', '处改动', '+5', '-3', '1 / 2', 'items.reduce'])
    // 修改行要标出行内改动（整行底色之外还有更深的一小段）
    if (!(await p.locator('[role="dialog"] [class*="rounded-[2px]"]').count()))
      errors.push('差异窗口：修改行没有行内高亮')
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

  // 实时推送时输入框不能被重新挂载、不能丢焦点：演示任务改成执行中，打字期间会不停推快照
  // （一次推送整页重渲染时，输入框如果跟着重挂载或重画，用户打一半就会失焦、字也会跳）
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    const openTask = async () => {
      await p.reload()
      await backToTask()
    }

    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k))
      const task = db.tasks.find((x) => x.title.includes('购物车'))
      task.status = 'running'
      localStorage.setItem(k, JSON.stringify(db))
    }, key)
    await openTask()
    const before = await p.evaluate(() => {
      window.__composer = document.querySelector('#follow-up')
      return { id: window.__composer?.id ?? '' }
    })
    await p.locator('#follow-up').click()
    await p.keyboard.type('实时推送时输入的内容')
    await p.waitForTimeout(1600)
    const after = await p.evaluate(() => {
      const el = document.querySelector('#follow-up')
      return {
        same: el === window.__composer,
        focused: el === document.activeElement,
        active: document.activeElement?.id ?? document.activeElement?.tagName ?? '',
        text: el?.textContent ?? '',
      }
    })
    if (before.id !== 'follow-up') errors.push('任务页没有找到输入框')
    else {
      if (!after.same) errors.push('实时推送时输入框被重新挂载')
      if (!after.focused) errors.push(`实时推送时输入框丢了焦点（焦点在 ${after.active}）`)
      if (!after.text.includes('实时推送时输入的内容')) errors.push('实时推送时输入的文字丢了')
    }
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await openTask()
  }
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
  // Token 胶囊：点开浮层看整个运行的合计（本对话 + 子对话 + 派出的子任务）
  {
    await p.getByTitle('Token 用量').first().click()
    await check(p, '任务-Token浮层', ['整个运行', '缓存命中'])
    await p.keyboard.press('Escape')
  }
  // 浮层里的速度只算正在输出的：造两种数据各截一张（演示数据用完改回去，不影响后面的截图）
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    /** writing：父对话在写、子对话和子任务都停了（留着上一轮很高的速度）；idle：全都没在输出 */
    const setup = (mode) =>
      p.evaluate(
        ([k, m]) => {
          const db = JSON.parse(localStorage.getItem(k))
          const parent = db.tasks.find((x) => x.title.includes('购物车'))
          const agent = (tps, lastTps) => ({
            context: 96000,
            window: 200000,
            model: 'claude-sonnet-5-5',
            tps,
            lastTps,
            outputTokens: 1000,
            genMs: 1000,
          })
          // 自己的步骤和派出的子任务分开用两个角色，界面才能把两层的速度拆开
          for (const s of parent.steps) s.agentId = s.slot === 'sub' ? 'demo-helper' : 'demo-own'
          parent.status = m === 'writing' ? 'running' : 'done'
          parent.usage.agents = {
            'demo-own': agent(m === 'writing' ? 42 : 0, m === 'writing' ? 42 : 900),
            // 已经停下的子任务：lastTps 还留着 2041.7，不能算进速度
            'demo-helper': agent(0, 2041.7),
          }
          db.tasks = db.tasks.filter((x) => !x.id.startsWith('demo-speed-'))
          for (const [i, id] of ['demo-speed-c1', 'demo-speed-c2'].entries()) {
            db.tasks.push({
              ...structuredClone(parent),
              id,
              parentTaskId: i ? 'demo-speed-c1' : parent.id,
              rootTaskId: parent.id,
              title: i ? '子对话：核对通知时序' : '子对话：角标订阅',
              status: 'done',
              steps: [],
              messages: [],
              usage: {
                agents: { 'demo-child': agent(0, 3000) },
                inputTokens: 2000,
                outputTokens: 200,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0.01,
              },
            })
          }
          localStorage.setItem(k, JSON.stringify(db))
        },
        [key, mode],
      )
    // 重新加载后回到任务页（当前路由就是任务页，不用再点头部）
    const gotoTask = async () => {
      await p.reload()
      await backToTask()
    }
    const openToken = async () => {
      await gotoTask()
      await p.getByTitle('Token 用量').first().click()
      await p.getByRole('dialog').last().waitFor({ timeout: 5000 })
    }
    const popover = async () => (await p.getByRole('dialog').last().innerText()).replace(/\s+/g, ' ')
    // 父对话在写：整体 = 本对话，子任务与子对话那行是「空闲」
    await setup('writing')
    await openToken()
    await check(p, '任务-Token浮层-父对话在写', ['整个运行', '空闲', '42.0 token/s'])
    const writing = await popover()
    if (/2041\.7|3000\.0/.test(writing)) errors.push(`Token 浮层：停下的子任务还在贡献速度（${writing}）`)
    await p.keyboard.press('Escape')
    // 全都没在输出：不显示任何残留速度
    await setup('idle')
    await openToken()
    await check(p, '任务-Token浮层-全都空闲', ['整个运行', '空闲'])
    const idle = await popover()
    if (/token\/s/.test(idle)) errors.push(`Token 浮层：全都空闲时还显示速度（${idle}）`)
    await p.keyboard.press('Escape')
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await gotoTask()
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
        return {
          total: norm(total?.textContent),
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
      // fmtDuration 的几种写法：秒、分+秒、时+分、天+时、毫秒级
      const duration = (text) => /^(<0\.1s|(\d+d )?\d+h \d+m|\d+d \d+h|(\d+m )?\d+(\.\d+)?s)$/.test(text)
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
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await p.reload()
    await backToTask()
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
    await openChild()
    await check(p, '子对话-面板', ['子对话：到货提醒'])
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
      // 行首的 @ 用等宽字体造形，不能是「图标和文字叠在一起」那个坏字形
      const atW = await p.evaluate(() => {
        const el = document.querySelector('#follow-up')
        const node = el?.firstChild
        if (!node || node.nodeType !== Node.TEXT_NODE) return 0
        const r = document.createRange()
        r.setStart(node, 0)
        r.setEnd(node, 1)
        return r.getBoundingClientRect().width
      })
      if (atW < 6 || atW > 11) errors.push(`长按拖入：@ 的宽度是 ${atW}，不像正常等宽字形`)
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
    // 合计行要说明是哪些加起来：这个会话树上全部进程（含子对话）
    '这个会话树上全部进程的合计，含子对话',
    '下面按归属分组',
  ])
  // 子对话的进程只算它自己：组头分别标出本对话 / 子对话，内存读不到的写未采集
  await check(p, '任务-对话进程-归属', ['本对话', '子对话'])
  // 内存曲线：原有左右拖动和悬停读数保留；右键也能拖，拖过之后出现「回到最新」
  await p.getByRole('button', { name: '内存曲线', exact: true }).click()
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
  await p.getByRole('button', { name: '内存曲线', exact: true }).click()
  await p.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await p
    .getByRole('heading', { name: 'AI 排查：会话内存分析' })
    .last()
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('任务-内存曲线：点 AI 分析没有新建排查对话'))
  await check(p, '任务-内存曲线-AI分析', ['这次要做的：看一下这个会话的内存'])
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
  // 标题栏左上角的项目名：点开是项目下的对话，点一项就地打开，Esc 关闭，「打开项目」还在
  {
    const projBtn = p.locator('header').getByRole('button', { name: '商城前台', exact: true })
    if (
      !(await projBtn
        .first()
        .waitFor({ timeout: 10000 })
        .then(
          () => true,
          () => false,
        ))
    )
      errors.push('标题栏：左上角没有项目名入口')
    else {
      // 页面上可能还留着别的弹层：按浮层独有的「打开项目」认这一个
      const pop = p.getByRole('dialog').filter({ hasText: '打开项目' })
      const title = () => p.locator('header nav h2').first().innerText()
      await projBtn.first().click()
      if (
        !(await pop.waitFor({ state: 'visible', timeout: 3000 }).then(
          () => true,
          () => false,
        ))
      )
        errors.push('标题栏：点项目名没有弹出对话列表')
      else {
        const text = (await pop.innerText()).replace(/\s+/g, ' ')
        if (!text.includes('购物车右上角')) errors.push(`标题栏浮层：没有列出当前对话（${text}）`)
        if (!text.includes('商品详情页')) errors.push(`标题栏浮层：没有列出项目下的其他对话（${text}）`)
        if (!text.includes('打开项目')) errors.push('标题栏浮层：没有「打开项目」入口')
        if (!(await pop.locator('[aria-current="true"]').count())) errors.push('标题栏浮层：当前对话没有高亮')

        // 重新点开浮层；没打开就记错误，后面的断言照常跑。
        // 先等页面稳定：上一步的导航会让标题栏重渲染，紧接着点击可能落在正在换掉的节点上
        const reopen = async (what) => {
          await p.waitForTimeout(200)
          if (await pop.isVisible().catch(() => false)) {
            await p.keyboard.press('Escape')
            await pop.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
          }
          await projBtn.first().click()
          const ok = await pop.waitFor({ state: 'visible', timeout: 3000 }).then(
            () => true,
            () => false,
          )
          if (!ok) errors.push(`标题栏浮层：${what}时浮层没有重新打开`)
          // 方向键的监听挂在浮层里那层 tabIndex=-1 的容器上，Radix 打开时先聚焦 Content，
          // 下一帧才轮到它。Visible 之后立刻按键会落在 Content 上，方向键不动（真人不会在 16ms 内按）
          if (ok)
            await p
              .waitForFunction(
                () => {
                  const a = document.activeElement
                  return !!a && a.classList.contains('outline-none') && !!a.closest('[role="dialog"]')
                },
                { timeout: 1000 },
              )
              .catch(() => errors.push(`标题栏浮层：${what}时焦点没有落到列表上`))
          return ok
        }

        // 鼠标点另一条：就地打开，浮层收起
        await pop
          .getByRole('button', { name: /商品详情页/ })
          .first()
          .click({ timeout: 10000 })
        if (
          !(await pop.waitFor({ state: 'detached', timeout: 3000 }).then(
            () => true,
            () => false,
          ))
        )
          errors.push('标题栏浮层：点一条对话后没有关闭')
        const opened = await title().catch(() => '')
        if (!opened.includes('商品详情页'))
          errors.push(`标题栏浮层：点「商品详情页…」后没有打开那个对话（标题是「${opened}」）`)
        await check(p, '任务-项目对话浮层-打开另一条')

        // 键盘：上下选择 + Enter 回到购物车那条。中间等一轮摘要刷新（2.5s），
        // 打开期间任务列表换新数组时不能把用户选中的位置拨回当前对话。
        // Radix 打开后要等下一帧才把焦点移到监听方向键的那层，浮层刚可见时按键会丢，先等焦点到位
        await reopen('键盘测试')
        const focused = await p
          .waitForFunction(
            () => {
              const el = document.activeElement
              return !!el && el.getAttribute('tabindex') === '-1' && !!el.closest('[role="dialog"]')
            },
            { timeout: 3000 },
          )
          .then(
            () => true,
            () => false,
          )
        if (!focused) errors.push('标题栏浮层：打开后键盘焦点没有落到列表上')
        await p.keyboard.press('ArrowDown')
        await p.waitForTimeout(3000)
        await p.keyboard.press('Enter')
        if (
          !(await pop.waitFor({ state: 'detached', timeout: 3000 }).then(
            () => true,
            () => false,
          ))
        )
          errors.push('标题栏浮层：键盘 Enter 后没有关闭')
        const back = await title().catch(() => '')
        if (!back.includes('购物车右上角'))
          errors.push(`标题栏浮层：键盘上下选择后没有回到购物车那条（标题是「${back}」）`)

        // Esc 关闭
        await reopen('Esc 测试')
        await p.keyboard.press('Escape')
        if (
          !(await pop.waitFor({ state: 'detached', timeout: 3000 }).then(
            () => true,
            () => false,
          ))
        )
          errors.push('标题栏浮层：按 Esc 没有关闭')
        else await check(p, '任务-项目对话浮层-Esc关闭')

        // 原来的「打开项目」入口还在：底部的这一项进项目页
        await reopen('「打开项目」测试')
        await pop.getByRole('button', { name: '打开项目', exact: true }).click({ timeout: 10000 })
        if (
          !(await p
            .waitForFunction(() => /^#\/projects\/[^/]+$/.test(location.hash), { timeout: 5000 })
            .then(
              () => true,
              () => false,
            ))
        )
          errors.push('标题栏浮层：点「打开项目」没有回到项目页')
        else await check(p, '任务-项目对话浮层-打开项目')
      }
    }
  }
  // 浮层的截图放在所有交互之后：重新进任务页、打开浮层再截图。
  // 截图前的等待（布局、动画）不依赖后面还有交互，避免偶发的焦点变化把截图和断言搅在一起
  {
    await p.goto(base)
    await p.getByText('购物车右上角', { exact: false }).first().click()
    await p
      .getByTitle('Token 用量')
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {})
    const projBtn = p.locator('header').getByRole('button', { name: '商城前台', exact: true })
    await projBtn.first().click()
    await p.waitForTimeout(200)
    // 页面刚导航完时偶尔第一次点击没展开：没开时补点一次，已打开的不再点（避免反而关掉）
    const pop = p.getByRole('dialog').filter({ hasText: '打开项目' })
    if (!(await pop.isVisible().catch(() => false))) await projBtn.first().click()
    await pop.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
    await check(p, '任务-项目对话浮层', ['商城前台', '购物车右上角', '商品详情页', '打开项目'])
  }
})
