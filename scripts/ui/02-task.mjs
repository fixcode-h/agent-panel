/**
 * 界面检查分片：任务页（核心）：加载日志、文件面板、运行区子对话、窄窗口运行区、
 * 接收消息 / 后台命令 / 发送消息、状态栏与子任务列表、Token 浮层与转成弹窗。
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 * 任务页按主题拆成 02 / 02b / 02c 三片：三片都用 scripts/ui/task-page.mjs 的同一个开场进入，
 * 各片自己重建前置状态，不依赖别的分片先跑过，任意顺序都能跑。
 */

import { runShard } from './harness.mjs'
import { closeChildTab, openCartTask, taskPageHelpers } from './task-page.mjs'

await runShard(import.meta.filename, async (api) => {
  const { base, check, errors, settle, shotOf } = api
  // 加载日志：打开对话的一瞬间才看得到，点开后立刻断言，再等输入框画出来
  const p = await openCartTask(api, {
    afterOpen: async (p) => {
      // 打开对话时先出现加载日志：逐行打出真的走了哪几步，加载完淡出卸载。
      // 这里在点开之后立刻断言（面板至少露 MIN_VISIBLE_MS，够测量和截图）
      const loadTrace = p.locator('[data-load-trace]')
      const traceShown = await loadTrace.waitFor({ timeout: 3000 }).then(
        () => true,
        () => false,
      )
      if (!traceShown) errors.push('任务-加载日志：打开对话时没有出现加载面板')
      else {
        const card = loadTrace.locator(':scope > div').first()
        if (!(await loadTrace.getByText('读取对话').count())) errors.push('任务-加载日志：面板里没有「读取对话」这一行')
        // 「渲染消息」要记到真实耗时：漏了起点（只在两帧后记完成）会恒显示 0s，
        // 这是 R1 的回归保护——单测只测 load-trace 纯逻辑，删掉 TaskView 里的 start 它照样绿
        const renderMs = await p
          .waitForFunction(
            () => {
              const el = document.querySelector('[data-trace-step="render"]')
              const ms = Number(el?.getAttribute('data-trace-ms') ?? '')
              return Number.isFinite(ms) && ms > 0
            },
            undefined,
            { polling: 'raf', timeout: 2000 },
          )
          .then(
            () => true,
            () => false,
          )
        if (!renderMs) errors.push('任务-加载日志：渲染消息没记到耗时（起点漏了会恒显示 0s）')
        // 居中要相对对话内容区（左边有侧栏，右边可能还有一栏），不是整个视口：量两边留白的差值。
        // 对话区就是这块面板的父元素（它不在 pane 里时是整个对话页的主区域），不靠 main 选择器猜
        // 面板只活约 650ms（LoadTrace 的 MIN_VISIBLE_MS + FADE_MS）：并发跑 12 片、机器慢时，
        // 量到一半就已经淡出卸载了。布局量不到就明确降级成一句提示 —— 「加载完收起」由下面那条断言覆盖，
        // 不能让它以 30 秒超时收场（那个失败形式会拖垮整片，见 docs/lessons/ui-check.md）
        const cardBox = await card.boundingBox({ timeout: 1500 }).catch(() => null)
        const areaBox = cardBox
          ? await loadTrace.evaluate((el) => {
              const r = el.parentElement?.getBoundingClientRect()
              return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
            })
          : null
        if (!cardBox || !areaBox) console.log('任务-加载日志：面板已淡出或量不到位置，跳过居中与截图检查')
        else {
          const left = cardBox.x - areaBox.x
          const right = areaBox.x + areaBox.width - (cardBox.x + cardBox.width)
          if (Math.abs(left - right) > 2)
            errors.push(`任务-加载日志：面板没有水平居中（左 ${Math.round(left)}px、右 ${Math.round(right)}px）`)
          const above = cardBox.y - areaBox.y
          const below = areaBox.y + areaBox.height - (cardBox.y + cardBox.height)
          if (Math.abs(above - below) > 2)
            errors.push(`任务-加载日志：面板没有垂直居中（上 ${Math.round(above)}px、下 ${Math.round(below)}px）`)
        }
        // 窄窗口（375）下不能横向溢出。就在这次面板还在的时候切一次宽度：
        // 另开一个 375 宽的页面从侧栏点进来是不行的，窄屏下侧栏收着，列表项点不到
        await p.setViewportSize({ width: 375, height: 820 })
        await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        if (overflow > 1) errors.push(`任务-加载日志-窄屏：出现横向滚动（多出 ${overflow}px）`)
        await p.setViewportSize({ width: 1440, height: 900 })
        await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
        // 截图同样可能在量的过程中淡出：这是产品行为（面板本来就该快速收起），不是回归
        if (!(await shotOf(p, card, '任务-加载日志'))) console.log('任务-加载日志：截图时面板已淡出，跳过这一张')
        // 加载完要淡出并卸载，不能一直盖着下面的对话
        if (
          !(await loadTrace.waitFor({ state: 'detached', timeout: 10000 }).then(
            () => true,
            () => false,
          ))
        )
          errors.push('任务-加载日志：加载完成后没有收起')
      }
    },
  })
  const { openFiles, backToTask, closed } = taskPageHelpers(p, api)

  // 宽屏右栏默认开着（重设计：固定「项目文件 / 本对话改动」两个页签），最宽 440，不和对话平分；
  // 页签条右端的按钮能收起，再点展开
  // 会话栏在中间对话的右边、同一块面板里（照 Claude Code）：环境、上下文、Token 用量、工具调用四块，上下文按块细分；
  // 右侧的文件栏照旧。标题栏的会话栏开关能收起再打开
  await check(p, '任务-会话栏', ['已使用', '消息', 'MCP 工具'])
  {
    const rail = p.locator('[data-session-rail]')
    if (!(await rail.isVisible())) errors.push('会话栏：默认没有显示')
    else {
      const main = await p.locator('main').first().boundingBox()
      const box = await rail.boundingBox()
      if (!main || !box || box.x < main.x || box.x + box.width > main.x + main.width + 1)
        errors.push('会话栏：不在中间对话那块面板里')
    }
    for (const name of ['环境', '上下文', 'Token 用量', '工具调用'])
      if (!(await rail.getByRole('region', { name, exact: true }).count())) errors.push(`会话栏：没有「${name}」这一块`)
    await p.getByRole('button', { name: '隐藏会话栏', exact: true }).click()
    if (await rail.isVisible()) errors.push('会话栏：点「隐藏会话栏」后还在')
    await p.getByRole('button', { name: '显示会话栏', exact: true }).click()
    if (!(await rail.isVisible())) errors.push('会话栏：点「显示会话栏」后没回来')
    // 1440 宽放不下会话栏 + 文件栏 + 对话：后打开的留着。点「显示文件」换成文件栏，会话栏让开
    await openFiles()
    if (await rail.isVisible()) errors.push('会话栏：放不下时点了「显示文件」，会话栏没有让开')
  }
  await check(p, '任务-文件面板默认展开')
  const filesPanel = p.locator('[data-task-panel]').first()
  if (!(await filesPanel.isVisible())) errors.push('任务：文件面板默认没有展开')
  else {
    const w = (await filesPanel.boundingBox())?.width ?? 0
    if (w > 441) errors.push(`任务：文件面板默认宽 ${Math.round(w)}，超过 440`)
  }
  for (const name of ['项目文件', '本对话改动'])
    if (!(await filesPanel.getByRole('tab', { name: new RegExp(`^${name}`) }).count()))
      errors.push(`任务：右栏没有「${name}」页签`)
  await p.getByRole('button', { name: '收起文件面板', exact: true }).click()
  if (await filesPanel.isVisible()) errors.push('任务：点「收起文件面板」后文件面板还在')
  if ((await p.getByRole('button', { name: '显示文件', exact: true }).getAttribute('aria-expanded')) !== 'false')
    errors.push('任务：文件面板收起时按钮没标成未展开')
  await openFiles()
  if (!(await filesPanel.isVisible())) errors.push('任务：点「显示文件」后文件面板没展开')
  // 右栏是文件系统（带 git 状态），启动命令是名字那行最右边的图标，上下文和用量在输入框下面
  await check(p, '任务', ['src', '命中', 'package.json'])

  // 父对话这一轮已经说完、名下还有子对话在跑：输入框要写清在等什么。
  // 旧实现一律写「继续输入要求」，和旁边的停止按钮凑成「子对话在跑、父对话却在等继续」（用户报的现象）。
  // 占位文字读 aria-placeholder：输入框是 contenteditable 的 RichInput，placeholder 只在值为空时画成一个 span
  await check(p, '输入框-等子对话')
  {
    const ph = (await p.locator('#follow-up').first().getAttribute('aria-placeholder')) || ''
    if (!ph.includes('子对话执行中'))
      errors.push(`输入框：名下还有子对话在跑时，占位文字要说明在等什么（实际「${ph}」）`)
    if (!ph.includes('可以直接输入要求')) errors.push('输入框：等子对话时要说明还能直接输入要求')
  }
  // 运行区的子对话：五个在转圈（三个在跑、一个在等后台命令、一个已标记解决但还在跑），都要列出来（见 shared/task.ts 的 visibleChildren）。
  // 在跑又带着没做完计划的也算「执行中」，不能一边转圈一边归到「未完成」。输入框上方不再有子对话栏，只看运行区
  {
    {
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
        // 运行区子对话行的详情（状态标签、当前活动）要跟在标题后面左对齐：
        // 以前标题 flex-1 占满中间，状态和活动被推到行尾，看起来像居中/靠右居中。
        // 左对齐后标题和状态两段文字不能糊成一块：中间要有分隔线，且状态不是另一个点击目标
        const align = [...document.querySelectorAll('[aria-label="运行中"]')]
          .flatMap((box) => [...box.children])
          .filter((r) => norm(r.innerText).startsWith('子对话'))
          .map((row) => {
            // openTip「在右栏打开子对话」就是标题按钮：可点的只有这一段
            const title = [...row.querySelectorAll('button')].find((b) =>
              (b.getAttribute('title') || '').includes('打开子对话'),
            )
            // 状态标签是带 text-[0.6875rem] 的 span（「子对话」动作名没有这个类；右边的耗时同字号，靠 tabular-nums 排除）
            const tags = [...row.querySelectorAll('span')]
              .filter((s) => (s.className || '').includes('text-[0.6875rem]') && !s.className.includes('tabular-nums'))
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
        return { runs, align }
      })
      if (boxes.runs.length !== 5) errors.push(`运行区：应该列出 5 个在跑的子对话，实际 ${boxes.runs.length} 个`)
      // 状态标签：计划没做完的写「计划 1/2」、在等后台命令的写「等结果」+ 在等什么、
      // 已标记解决但还在跑的仍然是「执行中」（完成标记不能盖住还在跑）
      for (const tag of ['计划 1/2', '等结果', '等 1 个后台命令', '执行中']) {
        if (!boxes.runs.some((x) => x.includes(tag))) errors.push(`运行区：没有显示「${tag}」`)
      }
      if (boxes.runs.some((x) => x.includes('已解决')))
        errors.push('运行区：已标记解决但还在跑的那条被写成了「已解决」')
      // 「已关闭」（CLI 进程回收）不能和「还在跑」的状态同屏：等后台命令的子对话在演示里进程早退了，
      // 行上如果又写「已关闭」又写「计划 / 等结果」，用户会以为它被关掉了（用户报的问题）
      const closedRows = boxes.runs.filter((x) => x.includes('已关闭'))
      if (closedRows.length) errors.push(`运行区：还在跑的对话被写成了「已关闭」：${closedRows.join(' | ')}`)
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
      await check(p, '子对话-运行区左对齐')
      // 整段文本可点：点状态标签（不只是标题）也能在右栏打开这个子对话
      {
        const clicked = await p.evaluate(() => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
          const box = [...document.querySelectorAll('[aria-label="运行中"]')].find((b) =>
            [...b.children].some((r) => norm(r.innerText).startsWith('子对话')),
          )
          const row = box ? [...box.children].find((r) => norm(r.innerText).startsWith('子对话')) : null
          // 状态标签是带 text-[0.6875rem] 的 span（「子对话」动作名没有这个类；右边的耗时同字号，靠 tabular-nums 排除）
          const tag = row
            ? [...row.querySelectorAll('span')].find(
                (s) =>
                  (s.className || '').includes('text-[0.6875rem]') &&
                  !s.className.includes('tabular-nums') &&
                  s.getBoundingClientRect().width > 0,
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
              (title) => !!document.querySelector('[data-child-view]')?.innerText.includes(title),
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
      // 运行区：有几个子对话就列几行，行前不再放切换下拉（右栏标题旁的切换下拉照旧）
      {
        if (await p.locator('[aria-label="运行中"] button[aria-label="切换子对话"]').count())
          errors.push('运行区：子对话行前面不该再有切换子对话的下拉')
        const kidRows = await p.evaluate(
          () =>
            [...document.querySelectorAll('[aria-label="运行中"]')].flatMap((b) =>
              [...b.children].filter((r) => (r.innerText || '').trim().startsWith('子对话')),
            ).length,
        )
        if (kidRows < 2) errors.push(`运行区：在跑的子对话应该一个一行，现在只有 ${kidRows} 行`)
      }
      // 右栏子对话标题行左侧的切换下拉：和运行区那处一致，Esc 关、鼠标和键盘都要真的切过去
      {
        /** 右栏标题（h2）现在的文字：切换是否生效看它 */
        const paneTitle = () =>
          p.evaluate(() => (document.querySelector('[data-child-view] h2')?.textContent || '').trim())
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
              (name) => (document.querySelector('[data-child-view] h2')?.textContent || '').trim() === name,
              title,
              { timeout: 3000 },
            )
            .then(
              () => true,
              () => false,
            )
        const trigger = p.locator('[data-child-view] button[aria-label="切换子对话"]').first()
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
          // 焦点得先落进菜单：菜单刚挂上时焦点还在按钮上，按下去的方向键会被吞掉（并发跑 12 片时常见）。
          // 等不到就关掉重开一次再等，别对着一屏没焦点的地方盲按十几次方向键
          let focused = false
          for (let attempt = 0; attempt < 2 && !focused; attempt++) {
            await openMenu()
            focused = await p
              .waitForFunction(() => !!document.activeElement?.closest('[role="menu"]'), null, { timeout: 2000 })
              .then(
                () => true,
                () => false,
              )
            if (!focused) await p.keyboard.press('Escape').catch(() => {})
          }
          let picked = ''
          for (let i = 0; i < 12 && !picked; i++) {
            await p.keyboard.press('ArrowDown')
            // 高亮是按键后下一帧才标上的：等到有一项高亮再读，不然读到的还是按键前的状态
            await p
              .waitForFunction(
                () => !!document.querySelector('[role="menu"] [data-child-item][data-highlighted]'),
                null,
                {
                  timeout: 1000,
                },
              )
              .catch(() => {})
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
          if (!(await p.locator('[data-child-view]').count())) return
          await closeChildTab(p)
            .click()
            .catch(() => errors.push('子对话：没有找到关闭按钮，后面的整段可点核对不成立'))
          // 关不掉时右栏本来就开着，后面的「打开了吗」会假通过，必须报出来
          if (
            !(await p
              .waitForFunction(() => !document.querySelector('[data-child-view]'), { timeout: 3000 })
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
            .waitForFunction((name) => !!document.querySelector('[data-child-view]')?.innerText.includes(name), title, {
              timeout: 3000,
            })
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
      if (await p.locator('[data-child-view]').count()) {
        await closeChildTab(p)
          .click()
          .catch(() => errors.push('子对话：没有找到关闭按钮'))
        await p
          .waitForFunction(() => !document.querySelector('[data-child-view]'), { timeout: 3000 })
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
          // 行宽：只用来在报错里写清楚当时的实际值，不作阈值判。
          // 行宽会随外面套几层缩进变化（运行区从回复内容里挑出来单独成块时少一层），
          // 写死像素的阈值一改布局就变成假报错
          rowWidth: rows[0] ? Math.round(rows[0].getBoundingClientRect().width) : 0,
          items: rows
            .map((row) => {
              // 一行可能有几个状态标签（「计划 1/2」+「执行中」），每个都要完整
              const tags = [...row.querySelectorAll('span')]
                .filter(
                  (s) => (s.className || '').includes('text-[0.6875rem]') && !s.className.includes('tabular-nums'),
                )
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
    await check(p, '子对话-运行区1024')
    // 文件面板默认最宽 440，挤不出窄行：先把它「拖」到 600（写本地记的宽度），测完删掉。
    // 过程行不再缩进一列头像宽度后同样的窗口里行宽多了 38px，560 时这一行已经放得下活动文字
    await p.evaluate(() => localStorage.setItem('pane:task-panel', '600'))
    await p.setViewportSize({ width: 1440, height: 900 })
    await p.reload()
    await backToTask()
    // 1280 这一格：宽窗口开着加宽的右栏再缩下来，运行区一行只剩 300 多像素；
    // 这一行窄到放不下活动文字时，状态标签也不能被裁
    await p.setViewportSize({ width: 1280, height: 900 })
    await settle(p)
    const mid = await measureNarrow()
    if (!mid.rows) errors.push('运行区（1280px）：没有列出子对话，核对不了状态标签')
    else if (mid.items.length !== mid.rows)
      errors.push(`运行区（1280px）：${mid.rows} 条子对话行里只有 ${mid.items.length} 条能测到状态标签`)
    for (const n of mid.items) if (n.clipped) errors.push(`运行区（1280px）：状态标签「${n.text}」被裁掉了`)
    // 没复现出窄行（右栏没占宽、改成单栏）时这一段等于没测到，直接报出来。
    // 按行自己的行为判，不写死像素：这一行窄于容器查询的 380px 阈值时活动文字必须隐藏，
    // 和上面 1024px 那段（行够宽、活动文字必须显示）正好是同一套判定的两边，
    // 两边都成立才说明真的复现了「放不下活动文字」的窄行；行宽写进报错方便排查
    if (mid.rows && mid.items.some((n) => n.noteShown))
      errors.push(`运行区（1280px）：行宽 ${mid.rowWidth}px，活动文字还占着宽度，没复现出右栏占宽后的窄行`)
    await p.evaluate(() => localStorage.removeItem('pane:task-panel'))
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
      // 来源带子对话标题：几个子对话的角色名相同时（都是「前端开发」），靠标题区分
      for (const title of ['压测导入大文件', '核对通知时序']) {
        const n = await p.getByText(`来自 前端开发（${title}）`, { exact: false }).count()
        if (!n) errors.push(`接收消息行没显示子对话标题「${title}」`)
      }
      // 同一子对话的同一份汇报在旧数据里写了两遍（演示数据里留了一条这样的样本）：界面上只显示一行，
      // 不同来源的汇报仍然各占一行
      const dup = await p.getByText('来自 前端开发（核对通知时序）', { exact: false }).count()
      if (dup !== 1) errors.push(`同一子对话的重复汇报应该只显示一行，实际 ${dup} 行`)
      await p.getByRole('button', { name: '已完成：合回原分支、标记完成' }).first().click()
      await check(p, '接收消息-弹窗', ['已收到', '打开子对话'])
      await p.keyboard.press('Escape')
      await closed()
    }
  }
  // 面板的 run_background：解析层对带 command 的输入存的是命令原文（不是 JSON），
  // 折叠行要靠它兜底显示命令，不能只剩「后台命令」和耗时
  {
    /**
     * 往「购物车右上角」那条父对话里注入一条运行中的后台命令（用完清掉）。
     * 不写进演示数据里：这条对话没在跑，后面的「转成弹窗」用例靠它验证浮条写「已完成」，
     * 常驻一条在跑的命令会让那条变成「执行中」
     */
    const KEY = 'agent-panel-demo-v3'
    const patchJobs = async (jobs) => {
      await p.evaluate(
        ([k, list]) => {
          const db = JSON.parse(localStorage.getItem(k))
          const parent = db.tasks.find((x) => x.title.includes('购物车'))
          // 总是写数组（没有就空数组）：删字段会被 keepLiveFields 当成「没带运行时字段」而沿用旧的
          parent.jobs = list ?? []
          localStorage.setItem(k, JSON.stringify(db))
        },
        [KEY, jobs],
      )
      await p.reload()
      await backToTask()
    }
    const command = 'npm ci > /tmp/npmci.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/npmci.log'
    await patchJobs([
      {
        // 编号和上面那个 run_background 工具行里的编号一致：两个入口（工具行、运行区的后台命令行）
        // 指的是同一条命令，真实后端里就是这么对应的
        id: '3f2a91cd',
        name: '安装依赖',
        command,
        state: 'running',
        startedAt: new Date(Date.now() - 69_500).toISOString(),
      },
    ])
    const title = p.locator('[aria-label="运行中"] button[title*="npm ci > /tmp/npmci.log"]').first()
    if (
      !(await title.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      ))
    )
      errors.push('后台命令折叠行：没有显示命令，只剩「后台命令」')
    else {
      await title.scrollIntoViewIfNeeded()
      const tip = await title.getAttribute('title')
      if (!tip?.includes('tail -20 /tmp/npmci.log')) errors.push(`后台命令折叠行：悬停提示不是完整命令（${tip}）`)
      await check(p, '后台命令-折叠行显示命令', ['后台命令', 'npm ci > /tmp/npmci.log 2>&1'])
      // 用户提的：点标题应该打开窗口看实时输出，不是只展开命令原文。
      // 工具行就是这个交互（整行点击 = 展开、点标题 = 开窗口），后台命令跟它一致
      await title.click()
      const dialog = p.getByRole('dialog').first()
      const opened = await dialog.waitFor({ timeout: 5000 }).then(
        () => true,
        () => false,
      )
      if (!opened) errors.push('后台命令：点标题没有打开命令行窗口')
      else {
        // 窗口里是实时输出，不是命令原文：等第一段输出拉回来（演示后端给的假输出里有这一行）
        const printed = await p
          .waitForFunction(
            () => {
              const d = document.querySelector('[role="dialog"]')
              return !!d && /transforming|modules transformed|agent-panel@/.test(d.innerText || '')
            },
            { timeout: 10000 },
          )
          .then(
            () => true,
            () => false,
          )
        if (!printed) errors.push('后台命令窗口：没有显示命令的输出')
        // 窗口标题是命令本身，带「执行中」阶段（命令还在跑，不能显示成完成）
        const head = await dialog.innerText()
        for (const text of ['npm ci > /tmp/npmci.log', '执行中'])
          if (!head.includes(text)) errors.push(`后台命令窗口：没有显示「${text}」`)
        await check(p, '后台命令-点标题开窗口看输出')
        // 窗口和行的关系（命令结束后行消失、窗口不能跟着关）不在这条用例里验：
        // 演示后端的任务数据在内存里缓存（demo-backend 的 load），改 localStorage 不会生效，造不出
        // 「这条 job 从 task.jobs 里消失」的推送；而在 DOM 上直接删掉那一行也证明不了什么——
        // React 不会因为 DOM 被外部改了就卸载组件。这条防线靠结构：窗口挂在 TaskView 的 jobTarget 上
        // （见 docs/modules/web/README.md），不挂在运行区那一行里
        await p.keyboard.press('Escape')
        await closed()
      }
      // 事后再想回看这条命令：运行区那一行跑完就没了，只能靠对话里那条 run_background 工具行——
      // 它的标题也要能打开同一个后台命令窗口（输出、退出码都在里面）
      await patchJobs(null)
      // 运行区那一行没了之后，只剩对话里那条 run_background 工具行的标题
      const pick = p.locator('button[title*="npm ci > /tmp/npmci.log"]').last()
      if (!(await pick.count())) errors.push('后台命令工具行：找不到那条 run_background 的标题')
      else {
        await pick.scrollIntoViewIfNeeded()
        await pick.click()
        const again = await p
          .getByRole('dialog')
          .first()
          .waitFor({ timeout: 5000 })
          .then(
            () => true,
            () => false,
          )
        if (!again) errors.push('后台命令工具行：点标题没打开命令行窗口（命令结束后就没地方回看了）')
        else {
          // 探针：看窗口拿到的是哪种状态（拉到没拉到、是不是报错）
          // 等输出拉回来（演示后端记得这条命令，行不在了也读得到）
          await p
            .waitForFunction(
              () => {
                const d = document.querySelector('[role="dialog"]')
                return !!d && /agent-panel@|transforming|EXIT=0/.test(d.innerText || '')
              },
              { timeout: 10000 },
            )
            .catch(() => {})
          // 演示后端记得这条命令，行不在了也读得到；结束的给最终输出和退出码
          const text = await p.getByRole('dialog').first().innerText()
          if (!/npm ci > \/tmp\/npmci\.log/.test(text)) errors.push('后台命令工具行窗口：没显示命令原文')
          if (!/transforming|modules transformed|agent-panel@|EXIT=0/.test(text))
            errors.push(`后台命令工具行窗口：没有显示命令输出（当前内容：${text.replace(/\s+/g, ' ').slice(0, 200)}）`)
          await check(p, '后台命令-工具行也能回看输出')
          await p.keyboard.press('Escape')
          await closed()
        }
      }
    }
    await patchJobs(null)
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
  // 同一段话逐个交给几个子对话的旧记录：合成一行「发给 3 个」，展开列出每个收件人
  {
    const row = p.getByText('发给 3 个：', { exact: false }).first()
    if (!(await row.count())) errors.push('同一段话交给几个子对话：没有合成一行「发给 3 个」')
    else {
      await row.scrollIntoViewIfNeeded()
      if ((await p.getByText('截图失败就不下视觉结论', { exact: false }).count()) !== 1)
        errors.push('同一段话交给几个子对话：还是画成了好几行')
      await row.click()
      await check(p, '发送消息-同一段话合成一行', ['发送消息', '交代任务', '发给 3 个子对话的同一条消息'])
      await row.click()
    }
  }

  // 输入框上方的状态栏照原来的三行（用户要求恢复）：计划在上、子任务中间、子对话在下
  {
    const openTask = () => backToTask()
    const missing = await p.evaluate(() =>
      ['plan', 'helpers', 'children'].filter((n) => !document.querySelector(`[data-status-row="${n}"]`)),
    )
    if (missing.length) errors.push(`状态栏：输入框上方少了 ${missing.join('、')} 这一行`)
    await check(p, '状态栏-计划子任务子对话')
    {
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
        // 计时是子任务从开始到现在（演示数据里开始得早，会是「3h 0m」这种写法）
        if (!/\d+(\.\d+)?[hms]\b/.test(subJobRow))
          errors.push(`运行区：子任务的后台命令行没有计时，现在是「${subJobRow}」`)
        // 子任务和子对话同一个样式的一行：带状态标签，最后是终止按钮；后台命令并在这一行里，不再另起一行
        if (!subJobRow.includes('执行中')) errors.push(`运行区：子任务行没有「执行中」状态，现在是「${subJobRow}」`)
        const stopInRow = await p.evaluate(() =>
          [...document.querySelectorAll('[aria-label="运行中"]')].some((b) =>
            [...b.children].some(
              (r) =>
                (r.innerText || '').includes('核对角标的订阅时机') &&
                !!r.querySelector('button[aria-label="终止子任务"]'),
            ),
          ),
        )
        if (!stopInRow) errors.push('运行区：子任务行没有终止按钮')
        await p.locator('[aria-label="运行中"]', { hasText: '核对角标的订阅时机' }).first().scrollIntoViewIfNeeded()
        await check(p, '子任务-运行区一行')
        // 整行都是打开入口（用户要求：和子对话行一样，动作名、标题、状态标签、耗时点了都开只读窗口）。
        // 以前只有标题按钮能点，详情区还 stopPropagation 拦着，点「执行中」没反应
        const rowInfo = await p.evaluate(() => {
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
          const box = [...document.querySelectorAll('[aria-label="运行中"]')].find((b) =>
            [...b.children].some((r) => norm(r.innerText).includes('核对角标的订阅时机')),
          )
          const row = box ? [...box.children].find((r) => norm(r.innerText).includes('核对角标的订阅时机')) : null
          // 详情区的状态标签：按文案取（角色名「前端开发」、后台命令名也带同一个类），原来它拦截点击
          const tag = row
            ? [...row.querySelectorAll('span')].find(
                (s) =>
                  (s.className || '').includes('text-[0.6875rem]') &&
                  s.getBoundingClientRect().width > 0 &&
                  /^(执行中|排队中|排队等 API)/.test(norm(s.innerText)),
              )
            : null
          if (!tag) return null
          const ms = [...row.querySelectorAll('span')].find((s) => (s.className || '').includes('tabular-nums'))
          return {
            title: norm(row.querySelector('button[title*="打开子任务"]')?.innerText || ''),
            tagText: norm(tag.innerText),
            // 状态标签和耗时都要跟着整行可点：手型、且不套进按钮（不出现嵌套按钮）
            tagCursor: getComputedStyle(tag).cursor,
            tagInButton: !!tag.closest('button'),
            msCursor: ms ? getComputedStyle(ms).cursor : '',
          }
        })
        if (!rowInfo) errors.push('运行区：子任务行里没找到详情区的状态标签，核对不了整行可点')
        else {
          if (rowInfo.tagCursor !== 'pointer')
            errors.push(`运行区子任务行：详情区不可点（cursor ${rowInfo.tagCursor}），整行都应该能打开子任务窗口`)
          if (rowInfo.tagInButton) errors.push('运行区子任务行：状态标签被套进了按钮，整行点击不该嵌套按钮')
          if (rowInfo.msCursor !== 'pointer')
            errors.push(`运行区子任务行：耗时不可点（cursor ${rowInfo.msCursor}），整行都应该能打开子任务窗口`)
          // 用 Playwright 的真实点击，不用 evaluate 里的 tag.click()：后者是合成事件，绕过命中测试，
          // 详情区被挡住、pointer-events-none、滚出视口这些回归它都拦不到
          const helperRow = p.locator('[aria-label="运行中"] > div').filter({ hasText: '核对角标的订阅时机' }).first()
          await helperRow
            .getByText(/^(执行中|排队中|排队等 API)/)
            .first()
            .click({ timeout: 5000 })
            .catch((e) => errors.push(`运行区：点不到子任务行的详情区（${e.message.split('\n')[0]}）`))
          // 窗口开没开看标题：这个子任务还在跑，窗口里不会有「这里只能查看」那句
          //（那句只在结束 / 失败 / 终止时才出现）
          const opened = await p
            .waitForFunction(
              (title) =>
                !!title &&
                [...document.querySelectorAll('[role="dialog"]')].some((d) => (d.innerText || '').includes(title)),
              rowInfo.title,
              { timeout: 3000 },
            )
            .then(
              () => true,
              () => false,
            )
          if (!opened) errors.push(`运行区：点详情区「${rowInfo.tagText}」后没打开子任务「${rowInfo.title}」的窗口`)
          await check(p, '子任务-整行可点')
          await p.keyboard.press('Escape')
          await closed()
        }
        // 行尾的终止按钮只终止，不连带打开窗口（RowShell 的 action 自己 stopPropagation，要保住）。
        // 注意：演示数据里这个子任务没有真在跑的进程，demo-backend 的 stopHelper 会返回 false 并报错，
        // 所以这一步只验证「点终止不打开窗口」，不验证终止真的生效；行还在，下面「1/3」的计数才成立
        {
          const stopBtn = p
            .locator('[aria-label="运行中"] > div')
            .filter({ hasText: '核对角标的订阅时机' })
            .first()
            .locator('button[aria-label="终止子任务"]')
          const stopClicked = await stopBtn.click({ timeout: 5000 }).then(
            () => true,
            () => false,
          )
          if (!stopClicked) errors.push('运行区：子任务行里找不到终止按钮')
          else {
            await settle(p)
            if (await p.getByRole('dialog').count()) errors.push('运行区：点终止按钮把子任务窗口也打开了')
            await check(p, '子任务-终止按钮不打开窗口')
            // 演示里的子任务没有真的在跑的进程，终止会弹一句报错 toast；等它自己消失，
            // 不要留给后面的用例（它会盖住右下角的浮条、截图里也多余）
            await p
              .locator('[data-sonner-toast]')
              .first()
              .waitFor({ state: 'detached', timeout: 8000 })
              .catch(() => {})
          }
        }
      }
      await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
      await p.reload()
      await openTask()
    }
  }

  // 实时更新慢不再挡内容（用户报的：任务数据和消息都画好了，加载面板还盖着等「连接实时更新」）。
  // 演示版把轮询当作实时更新：执行中的对话第一轮轮询在 700ms 后才发出，内容早就画完了，
  // 这时面板必须已经收起、对话看得见，实时更新只留在输入框上方的小胶囊里继续连。
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k))
      const task = db.tasks.find((x) => x.title.includes('购物车'))
      task.status = 'running'
      localStorage.setItem(k, JSON.stringify(db))
    }, key)
    // 整页导航：只改 hash 会被内存里的演示数据盖回去（见 docs/lessons/ui-check.md）
    await p.goto(base)
    const conv = p.getByText('购物车右上角', { exact: false }).first()
    if (
      !(await conv.waitFor({ timeout: 15000 }).then(
        () => true,
        () => false,
      ))
    )
      errors.push('任务-实时更新不挡内容：演示数据没生成出来（找不到对话列表项）')
    else {
      await conv.click()
      const pill = p.locator('[data-load-trace-pill]')
      // 胶囊只在面板收起后、后台步骤还在跑的那一小段里画出来（演示版首轮轮询约 800ms 就回来了）。
      // 所以在等到它出现的那一刻就把文案抓进页面变量：之后再单独读 DOM，可能落在它已经卸载之后
      const pillShown = await p
        .waitForFunction(
          () => {
            const el = document.querySelector('[data-load-trace-pill]')
            if (!el) return false
            window.__loadTracePill = (el.textContent || '').replace(/\s+/g, ' ').trim()
            return true
          },
          undefined,
          { timeout: 5000, polling: 'raf' },
        )
        .then(
          () => true,
          () => false,
        )
      const pillText = pillShown ? await p.evaluate(() => window.__loadTracePill ?? '') : ''
      // 胶囊出现要求面板已经收起；这里再单独确认一次，面板因为其它原因停在屏幕上时也要报出来
      if (await p.locator('[data-load-trace]').count())
        errors.push('任务-实时更新不挡内容：实时更新还没回来，加载面板就一直盖着')
      if (!pillShown) errors.push('任务-实时更新不挡内容：面板收起后，后台还在连的实时更新没有留下任何入口')
      // 胶囊写清在等哪一步，不是一句空状态
      if (pillShown && !pillText.includes('正在连接实时更新'))
        errors.push(`任务-实时更新不挡内容：胶囊没写清在等实时更新（现在是「${pillText}」）`)
      // 内容已经能用：输入框画出来了
      if (!(await p.locator('#follow-up').count()))
        errors.push('任务-实时更新不挡内容：面板收起了，但对话输入框还没出现')
      // 胶囊可能已经卸载，截不到图不算失败；这条用例的截图由下面的 check 兜底（对话内容照常显示）
      if (pillShown) await shotOf(p, pill, '任务-实时更新胶囊')
      await check(p, '任务-实时更新不挡内容')
    }
    // 改回现场：后面的用例按原本那条已完成的对话跑
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
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
  // 上下文胶囊：浮层里每个 Agent 一行；最近压缩过的那行写明多久前、压缩前后各多少
  {
    await p.getByTitle('上下文占用').first().click()
    await check(p, '任务-上下文压缩', ['小时前压缩过', '压缩前 176.0k', '压缩后 12.0k'])
    if (!(await shotOf(p, p.getByRole('dialog').first(), '任务-上下文压缩')))
      errors.push('任务-上下文压缩：没有截到上下文浮层')
    await p.keyboard.press('Escape')
  }
  // Token 胶囊：点开浮层看整个运行的合计（本对话 + 子对话 + 派出的子任务）
  {
    await p.getByTitle('Token 用量').first().click()
    await check(p, '任务-Token浮层', ['整个运行', '缓存命中'])
    await p.keyboard.press('Escape')
  }
  // 测试记录：父对话跑的和自己跑的都在，执行方、结果、真实耗时、第几次尝试都照实显示
  {
    await p.getByTitle('测试记录').first().click()
    await check(p, '任务-测试记录', [
      '测试记录',
      '端到端测试',
      '由父对话执行',
      '通过',
      '1m 34s',
      '类型检查',
      '由自己执行',
      '失败',
      '1.2s',
      '第 2 次',
    ])
    await p.keyboard.press('Escape')
  }
  // 工具与返工：任务级的调用数、失败数、探路失败分类和返工原因都在浮层里，
  // 和导出报告用同一个计数函数（shared/tool-failures.ts），不在界面上另算一套
  {
    await p.getByTitle('工具与返工').first().click()
    await check(p, '任务-工具与返工', [
      '工具与返工',
      '次调用',
      '其中探路失败',
      '路径不存在',
      '命令不存在',
      '返工',
      '同一节点重跑',
      '按节点',
      '追加要求/对话',
    ])
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

  // 页签条左边不再放项目名入口（用户要求去掉：窄的时候只剩「S...」，看不出是什么），项目从侧栏进
  if (await p.locator('header').getByRole('button', { name: '商城前台', exact: true }).count())
    errors.push('标题栏：页签条左边还有项目名入口')

  // 「转成弹窗」：标题栏把当前对话收成右下角的浮条，页面回到上一级；浮条能展开回那个对话。
  // 同时只能有一个对话浮条（再收另一个对话就换掉它）。演示数据里这个对话名下还有子对话在跑，
  // 浮条写「进行中…」（和正式后端一致：父对话的子对话在跑时父对话也算在忙；以前演示版没补 childrenWorking，
  // 这里会被前者写成「已完成」）
  {
    // 两个对话的真实标题（taskTitle 取要求的第一行、超过 32 字截断）
    const CART = '购物车右上角的数量角标偶尔不刷新，帮我看看原因'
    const RESTOCK = '商品详情页增加「到货提醒」：商品缺货时显示按钮，用户点击后登记手…'
    const dockOf = (title) => p.getByRole('group', { name: `对话：${title}`, exact: true })
    await p.goto(base)
    await p.getByText('购物车右上角', { exact: false }).first().click()
    /** 对话页签条上父对话的标题 */
    const convTitle = (s) => p.locator('[data-conv-title]').getByText(s, { exact: true })
    await convTitle(CART).waitFor({ timeout: 8000 })
    const toDock = p.getByRole('button', { name: '转成弹窗', exact: true })
    if (!(await toDock.count())) errors.push('转成弹窗：对话页标题栏没有这个按钮')
    else {
      await toDock.click()
      const first = dockOf(CART)
      await first.waitFor({ timeout: 5000 }).catch(() => errors.push('转成弹窗：没出现对话浮条'))
      // 收起后回到项目页：对话页不能和浮条同时显示同一个对话
      const hash = await p.evaluate(() => location.hash)
      if (!/^#\/projects\/[^/]+$/.test(hash)) errors.push(`转成弹窗：收起后应回到项目页，实际停在 ${hash}`)
      if (await p.getByRole('button', { name: '转成弹窗', exact: true }).count())
        errors.push('转成弹窗：收起后对话页还开着')
      await check(p, '任务-转成弹窗', [`对话：${CART}`])
      // 浮条自己的状态文字（限定在浮条里找，页面上别处也有「进行中」这类词）
      if (!(await first.getByText('进行中…', { exact: true }).count()))
        errors.push('转成弹窗：父对话名下还有子对话在跑，浮条上应写「进行中…」')
      // 浮条上的关闭按钮只在悬停时出现、位置在右上角；浮条上不能挂原生 title
      // （那个「展开」提示一悬停就弹灰框，用户嫌烦）。opacity-0 仍算 visible，所以看 opacity
      const dockClose = first.locator('[data-dock="close"]')
      const dockOpacity = () => dockClose.evaluate((el) => Number(getComputedStyle(el).opacity))
      // 浮条特写当截图证据：全页截图里浮条只在右下角一小块，看不出按钮在不在（shotOf 负责把 clip 夹进视口）
      await p.mouse.move(5, 5)
      await settle(p)
      if ((await dockOpacity()) !== 0) errors.push('转成弹窗：没悬停时浮条的关闭按钮也显示（应为 opacity 0）')
      await shotOf(p, first, '任务-转成弹窗-浮条-不悬停')
      await first.hover()
      await settle(p)
      if ((await dockOpacity()) !== 1) errors.push('转成弹窗：鼠标放到浮条上关闭按钮没出现')
      await shotOf(p, first, '任务-转成弹窗-浮条-悬停')
      const dockTitles = await first.locator('[title]').evaluateAll((els) => els.map((el) => el.getAttribute('title')))
      if (dockTitles.length) errors.push(`转成弹窗：浮条上还有原生 title 提示：${dockTitles.join('、')}`)
      // 关闭按钮在浮条右上角：量那个看得见的小圆（光看热区矩形不够，它永远贴 top-0 right-0）
      const barRect = await first.boundingBox()
      const dotRect = await dockClose.locator('span').first().boundingBox()
      if (!barRect || !dotRect) errors.push('转成弹窗：量不到浮条关闭按钮小圆的位置')
      else {
        const cx = dotRect.x + dotRect.width / 2 - barRect.x
        const cy = dotRect.y + dotRect.height / 2 - barRect.y
        if (cx < barRect.width / 2 || cy > barRect.height / 2)
          errors.push(
            `转成弹窗：关闭按钮不在浮条右上角（小圆中心 ${Math.round(cx)},${Math.round(cy)}；浮条 ${Math.round(barRect.width)}×${Math.round(barRect.height)}）`,
          )
      }
      // 点关闭仍能关掉浮条（data-dock 判定没坏），由 06 分片末尾的「AI处理-浮条让位后回来」前面那几步覆盖（那里才是点关闭就真关）
      await check(p, '任务-转成弹窗-悬停显示关闭')
      // 点关闭仍能关掉这条浮条（data-dock="close" 判定没坏）：
      // 06 分片的同类用例在 06:113 之后，那条既有超时会让它跑不到，所以这里也补一份
      await dockOf(CART).getByRole('button', { name: '关闭', exact: true }).click()
      await dockOf(CART)
        .waitFor({ state: 'detached', timeout: 5000 })
        .catch(() => errors.push('转成弹窗：点关闭后对话浮条还在（关闭被当成展开了）'))
      await check(p, '任务-转成弹窗-点关闭')
      // 再收起另一个对话：只留一个，前一条被换掉
      await p.getByText('商品详情页增加', { exact: false }).first().click()
      // 点完要等页面真的换过去：标题没出来就读标题栏，读到的是上一个对话（或项目页）
      await convTitle(RESTOCK)
        .waitFor({ timeout: 8000 })
        .catch(() => errors.push('转成弹窗：没打开第二个对话'))
      const second = p.getByRole('button', { name: '转成弹窗', exact: true })
      await second.waitFor({ timeout: 5000 }).catch(() => errors.push('转成弹窗：第二个对话页没有这个按钮'))
      if ((await second.count()) > 0) {
        await second.click()
        await dockOf(RESTOCK)
          .waitFor({ timeout: 5000 })
          .catch(() => errors.push('转成弹窗：第二个对话收起后没有浮条'))
        if (await dockOf(CART).count()) errors.push('转成弹窗：同时出现了两个对话浮条（前一条没被换掉）')
        // 点浮条展开：回到那个对话页，浮条自己收起来
        const dock = dockOf(RESTOCK)
        await dock.getByRole('button', { name: '展开', exact: true }).click()
        await convTitle(RESTOCK)
          .waitFor({ timeout: 8000 })
          .catch(() => errors.push('转成弹窗：点浮条没回到那个对话'))
        await dock.waitFor({ state: 'detached', timeout: 5000 }).catch(() => errors.push('转成弹窗：展开后浮条还在'))
        await check(p, '任务-转成弹窗只留一个并展开')
        // 从列表把同一个对话再打开：浮条必须消失（页面和浮条不能同时显示同一个对话）
        await p.getByRole('button', { name: '转成弹窗', exact: true }).click()
        await dockOf(RESTOCK)
          .waitFor({ timeout: 5000 })
          .catch(() => errors.push('转成弹窗：再次收起后没有浮条'))
        const wasHash = await p.evaluate(() => location.hash)
        if (!/^#\/projects\/[^/]+$/.test(wasHash)) errors.push(`转成弹窗：再次收起后应回到项目页，实际停在 ${wasHash}`)
        // 从项目页列表里点回同一个对话（RESTOCK），浮条应该自动让位
        await p.getByText('商品详情页增加', { exact: false }).first().click()
        await convTitle(RESTOCK)
          .waitFor({ timeout: 8000 })
          .catch(() => errors.push('转成弹窗：没从列表打开被收起的那个对话'))
        await dockOf(RESTOCK)
          .waitFor({ state: 'detached', timeout: 5000 })
          .catch(() => errors.push('转成弹窗：从列表打开对话后浮条还在（页面和浮条同时显示同一个对话）'))
        await check(p, '任务-转成弹窗-从列表打开后浮条消失')
      }
    }
  }

  // 状态行：子任务还在跑时不能说「在等你」+「空闲」（用户报的问题：对话派出的子任务在跑命令，
  // 状态行却说「等待你的下一条消息」+「空闲」）。演示数据里「后台命令弹窗实时看输出」就是那个场景：
  // 这一轮已回完、awaitingUser 和 cliAlive 都是 true，但它派出的子任务还在执行。
  // 按标题在演示数据里查 id 再拼 hash 打开：侧栏的对话列表跟着筛选和滚动，按 title 定位不稳
  {
    const openByTitle = async (title) => {
      await p.goto(base)
      const id = await p.evaluate(
        ([k, want]) => (JSON.parse(localStorage.getItem(k) ?? '{}').tasks ?? []).find((x) => x.title === want)?.id,
        ['agent-panel-demo-v3', title],
      )
      if (!id) return false
      await p.goto(`${base}#/chat/${encodeURIComponent(id)}`)
      await p
        .locator('[title="Token 用量"], [data-token-usage]')
        .first()
        .waitFor({ timeout: 10000 })
        .catch(() => {})
      return true
    }
    const opened = await openByTitle('后台命令弹窗实时看输出')
    if (!opened) errors.push('状态行：演示数据里找不到「后台命令弹窗实时看输出」这个对话')
    else {
      // 等状态行按 childWait 算出来（子任务在跑 → helpers），不是等固定时长
      const line = p.locator('[data-chat-wait]').first()
      await line.waitFor({ timeout: 10000 }).catch(() => errors.push('状态行：子任务在跑时没有显示等待行'))
      const kind = await line.getAttribute('data-chat-wait').catch(() => null)
      if (kind !== 'helpers') errors.push(`状态行：子任务在跑时等待行算成了「${kind}」，应该是 helpers`)
      const text = ((await line.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
      if (!text.includes('等待 1 个子任务完成'))
        errors.push(`状态行：子任务在跑时没写「等待 1 个子任务完成」，写的是「${text}」`)
      if (text.includes('等待你的下一条消息')) errors.push(`状态行：子任务还在跑却说「等待你的下一条消息」（${text}）`)
      // 「空闲」也不能出现：父对话没在输出，但它在等子任务，不是没事做
      if (text.includes('空闲')) errors.push(`状态行：子任务还在跑时速度位写了「空闲」（${text}）`)
      if (!text.includes('等待中')) errors.push(`状态行：子任务还在跑时速度位该写「等待中」，写的是「${text}」`)
      await check(p, '任务-等子任务时状态行')
      // 反例：真的停在等下一句（没有子任务、没有后台命令）时照旧写「等待你的下一条消息」
      const controlOpened = await openByTitle('整理一份 Claude Code 和 Codex 的能力对照')
      if (!controlOpened)
        errors.push('状态行：演示数据里找不到「整理一份 Claude Code 和 Codex 的能力对照」这个对照对话')
      else {
        const idle = p.locator('[data-chat-wait="next"]').first()
        await idle.waitFor({ timeout: 10000 }).catch(() => errors.push('状态行：真的停在等下一句时没有显示等待行'))
        const idleText = ((await idle.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
        if (!idleText.includes('等待你的下一条消息'))
          errors.push(`状态行：真的停在等下一句时没写「等待你的下一条消息」，写的是「${idleText}」`)
        await check(p, '任务-等下一句时状态行')
      }
    }
  }

  // 发送消息的一瞬间运行区不能闪没：刚发出的用户消息会自己成一段（见 TaskView 的 toBlocks），
  // 以前「最新的一轮」按最后一段算，那一轮回复就不再是最新，运行区（子对话行、后台命令行）整块消失，
  // 等 AI 开口又回来。这里用 MutationObserver 记录整个发送过程里运行区最少的子对话行数，
  // 不靠等待时序赌那一帧（等待条件用「消息出现在消息区里」这个可观测状态）。
  {
    await p.goto(base)
    await p.getByText('购物车右上角', { exact: false }).first().click()
    await p
      .locator('[title="Token 用量"], [data-token-usage]')
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {})
    // 前面的用例可能把右栏子对话留着（那样页面上有两个 #follow-up）：先关掉，输入框只留父对话那个
    const pane = p.locator('[data-child-view]')
    if (await pane.count()) {
      await closeChildTab(p)
        .click()
        .catch(() => {})
      await pane.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
    }
    /** 运行区里现在有几行子对话（见 shared/task.ts 的 visibleChildren） */
    const childRows = () =>
      p.evaluate(
        () =>
          [...document.querySelectorAll('[aria-label="运行中"]')].flatMap((box) =>
            [...box.children].filter((r) => (r.innerText || '').trim().startsWith('子对话')),
          ).length,
      )
    const listed = await p
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
    const before = await childRows()
    if (!listed || before < 2) errors.push(`发送时运行区：进入对话后运行区里只有 ${before} 行子对话，用例前提不成立`)
    else {
      // 采样器装在发送之前：从点发送到这条消息画出来，记下运行区最少的子对话行数
      await p.evaluate(() => {
        const count = () =>
          [...document.querySelectorAll('[aria-label="运行中"]')].flatMap((box) =>
            [...box.children].filter((r) => (r.innerText || '').trim().startsWith('子对话')),
          ).length
        const w = window
        w.__runningMin = Infinity
        const sample = () => {
          const n = count()
          if (n < w.__runningMin) w.__runningMin = n
        }
        sample()
        w.__runningObs?.disconnect()
        w.__runningObs = new MutationObserver(sample)
        w.__runningObs.observe(document.body, { childList: true, subtree: true, characterData: true })
      })
      const text = '发送时运行区别闪没'
      // 父对话那个输入框（右栏若还开着，同一个 id 有两个，取第一个）
      const box = p.locator('#follow-up').first()
      await box.fill(text)
      await box.press('Enter')
      // 消息区里真的画出了这条消息：输入框在消息区外面，里面的同名文字不会让它提前满足
      await p
        .waitForFunction(
          (want) => !!document.querySelector('[data-conversation-scroll="messages"]')?.innerText.includes(want),
          text,
          { timeout: 10000 },
        )
        .catch(() => errors.push('发送时运行区：消息没有出现在对话里'))
      const min = await p.evaluate(() => {
        window.__runningObs?.disconnect()
        return window.__runningMin
      })
      const after = await childRows()
      // 采样器一次也没跑到（Infinity）：说明发送没有触发任何 DOM 变化，用例没测到东西，不能当通过
      if (!Number.isFinite(min)) errors.push('发送时运行区：采样器没有采到任何变化，用例没测到东西')
      else if (min < before)
        errors.push(`发送时运行区：发送消息的过程中子对话行从 ${before} 行掉到 ${min} 行（发出去的一瞬间运行区闪没了）`)
      if (after < before)
        errors.push(`发送时运行区：发送之后运行区只剩 ${after} 行子对话（原来 ${before} 行，应该一直保持显示）`)
      await check(p, '任务-发送消息时运行区不消失', ['子对话'])
    }
  }
  // 没有压缩记录的对话不显示这一行：删掉演示数据里的压缩记录，整页导航后重新看
  // （只改 hash 会被内存里的演示数据盖回去，见 docs/lessons/ui-check.md）
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k))
      const task = db.tasks.find((x) => x.title.includes('购物车右上角'))
      for (const m of task?.messages ?? []) m.tools = (m.tools ?? []).filter((x) => x.kind !== 'compact')
      localStorage.setItem(k, JSON.stringify(db))
    }, key)
    await p.goto(base)
    await backToTask()
    await p.getByTitle('上下文占用').first().click()
    if (await p.getByText('压缩过').count()) errors.push('任务-上下文无压缩：没有压缩记录时仍显示压缩行')
    if (!(await shotOf(p, p.getByRole('dialog').first(), '任务-上下文无压缩')))
      errors.push('任务-上下文无压缩：没有截到上下文浮层')
    await p.keyboard.press('Escape')
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await p.goto(base)
    await backToTask()
  }
})
