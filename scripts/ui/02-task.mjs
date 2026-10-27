/**
 * 界面检查分片：任务页（核心）：加载日志、文件面板、运行区与弹层一致、窄窗口运行区、
 * 接收消息 / 后台命令 / 发送消息、状态栏与子任务列表、Token 浮层、项目对话浮层与转成弹窗。
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 * 任务页按主题拆成 02 / 02b / 02c 三片：三片都用 scripts/ui/task-page.mjs 的同一个开场进入，
 * 各片自己重建前置状态，不依赖别的分片先跑过，任意顺序都能跑。
 */

import { runShard } from './harness.mjs'
import { openCartTask, taskPageHelpers } from './task-page.mjs'

/** 判定「窗口停在顶部」的 scrollTop 容差：滚动条贴顶时就是 0，留一点给像素取整 */
const SCROLL_TOP_EPS = 2

/**
 * 判「卡片已经滚出视野」时要求可滚量比卡片高出的余量：
 * 刚好等于卡片高时卡片下边缘正好贴着容器顶，属于临界值，多留几像素才算真的滚出去
 */
const SCROLL_OUT_EPS = 2

/**
 * 造「内容超过一屏」用的视口高度档位（从大到小试，够了就停）。
 * 子任务窗口高度是 `min(820px, 100dvh-2rem)`，视口越矮内容区越小；演示数据的对话流长度不一，
 * 固定一档可能仍不足一屏，那样「滚到底卡片该滚出视野」的断言会空转
 */
const VIEWPORT_SHRINK_STEPS = [480, 400, 340, 280, 240]

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

  // 宽屏右栏默认收起，不占掉一半宽度（用户提的「分析弹窗一打开就占一半」）；按钮在标题栏，点一下展开
  await check(p, '任务-文件面板默认收起')
  const filesPanel = p.locator('[data-task-panel]').first()
  if (await filesPanel.isVisible()) errors.push('任务：文件面板默认就展开了，挡住了对话')
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
  // 子对话栏的计数：五个在转圈（三个在跑、一个在等后台命令、一个已标记解决但还在跑），分母是进程还活着的 5 个。
  // 在跑又带着没做完计划的也算「执行中」，不能一边转圈一边归到「未完成」
  {
    // 按 aria-label 里的计数文案定位：页面上还有别的（禁用的）按钮也写着「子对话」
    const bar = p.getByRole('button', { name: /个进行中，共 \d+ 个/ })
    if (!(await bar.count())) errors.push('子对话栏：输入框上方没有子对话入口')
    else {
      // 分子 5 = 在转圈的；分母是进程还活着的（演示里「整理 ESLint 规则」在等后台命令、CLI 已回收，不算进去），
      // 分母比分子少时兜底取分子，所以仍是 5/5（见 shared/task.ts 的 childCounts）
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
      // 「已关闭」（CLI 进程回收）不能和「还在跑」的状态同屏：等后台命令的子对话在演示里进程早退了，
      // 行上如果又写「已关闭」又写「计划 / 等结果」，用户会以为它被关掉了（用户报的问题）
      for (const [where, list] of [
        ['运行区', boxes.runs],
        ['弹层', boxes.items],
      ]) {
        const closed = list.filter((x) => x.includes('已关闭'))
        if (closed.length) errors.push(`${where}：还在跑的对话被写成了「已关闭」：${closed.join(' | ')}`)
      }
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
      // 「已完成」里含演示数据那条「拆分规则检查脚本」（做完、没点开看过，行上带未读点，断言在 02b 分片）
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
          // 行宽：只用来在报错里写清楚当时的实际值，不作阈值判。
          // 行宽会随外面套几层缩进变化（运行区从回复内容里挑出来单独成块时少一层），
          // 写死像素的阈值一改布局就变成假报错
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
    // 没复现出窄行（右栏没占宽、改成单栏）时这一段等于没测到，直接报出来。
    // 按行自己的行为判，不写死像素：这一行窄于容器查询的 380px 阈值时活动文字必须隐藏，
    // 和上面 1024px 那段（行够宽、活动文字必须显示）正好是同一套判定的两边，
    // 两边都成立才说明真的复现了「放不下活动文字」的窄行；行宽写进报错方便排查
    if (mid.rows && mid.items.some((n) => n.noteShown))
      errors.push(`运行区（1280px）：行宽 ${mid.rowWidth}px，活动文字还占着宽度，没复现出右栏占宽后的窄行`)
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

  // 派出的子任务不再铺在消息流里：入口在输入框上方单独一行（状态栏三行），点开是列表和只读窗口
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
      // 列表里最新的在最上面（用户报的：派出的最后一个排在最下面）：演示数据里「核对角标的订阅时机」是最后派出的，
      // 按开始时间应该排在「已完成」组的第一行。读的是这一行的实际顺序，不是按标题挑元素
      const helperOrder = await p.evaluate(() => {
        const tray = [...document.querySelectorAll('div.absolute.bottom-full')].find((d) =>
          (d.innerText || '').includes('已完成'),
        )
        if (!tray) return null
        return [...tray.querySelectorAll('button')]
          .map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim())
          .filter((x) => x && !x.startsWith('终止'))
      })
      if (!helperOrder) errors.push('子任务-列表：找不到子任务浮层')
      else {
        const at = helperOrder.findIndex((x) => x.includes('核对角标的订阅时机'))
        const first = helperOrder.findIndex((x) => x.includes('复现问题') || x.includes('查找相关代码'))
        if (at < 0) errors.push('子任务-列表：列表里没有「核对角标的订阅时机」')
        else if (first >= 0 && at > first)
          errors.push(`子任务-列表：最新派出的「核对角标的订阅时机」没排在最上面（顺序：${helperOrder.join(' | ')}）`)
      }
      await check(p, '子任务-列表-最新在上')
      await p.getByRole('button', { name: /核对角标的订阅时机/ }).click()
      await check(p, '子任务-窗口', ['问题在', '这里只能查看'])
      // 窗口最上面那块「派给它的要求」：派发时交给它的原文，按 `##` 小节排开（要做的事在前、验收标准在后）。
      // 它是滚动区里的第一块普通内容、不吸顶（用户报的「不要悬浮在那」），打开时能看到它靠的是
      // 窗口在有要求时按 startAt: 'top' 打开停在顶部，不是靠 sticky
      {
        const w = p.getByRole('dialog').last()
        const card = w.getByRole('region', { name: '派给它的要求' })
        if (!(await card.count())) errors.push('子任务-窗口：最上面没有「派给它的要求」')
        else {
          // 收起态：只剩摘要一句，正文收着
          if (!(await card.getByText('查清购物车角标', { exact: false }).count()))
            errors.push('子任务-窗口：有对话流时初始要求没收成摘要一句')
          if (await card.getByText('只读不改代码', { exact: false }).count())
            errors.push('子任务-窗口：有对话流时初始要求默认没收起')
          /** 卡片和它所在滚动容器的位置关系：窗口打开就该停在顶部，卡片完整落在容器里 */
          const place = () =>
            card.evaluate((el) => {
              const sc = el.closest('.overflow-y-auto')
              if (!(sc instanceof HTMLElement) || !(el instanceof HTMLElement)) return null
              const a = sc.getBoundingClientRect()
              const b = el.getBoundingClientRect()
              // 卡片下面紧接着的那块（对话流）是不是被卡片盖住：两者矩形相交就说明卡片浮在上面
              const next = el.nextElementSibling
              const cover = next instanceof HTMLElement ? Math.round(b.bottom - next.getBoundingClientRect().top) : 0
              return {
                inView: b.top >= a.top - 1 && b.bottom <= a.bottom + 1,
                gap: Math.round(b.top - a.top),
                top: Math.round(sc.scrollTop),
                cover,
              }
            })
          // 打开时停在顶部：卡片在视野内、贴着容器顶，滚动位置在 0 附近（贴底的话卡片会被推到视野之上）
          const atTop = await place()
          if (!atTop) errors.push('子任务-窗口：没找到初始要求所在的滚动容器')
          else {
            if (!atTop.inView) errors.push(`子任务-窗口：打开时初始要求不在视野内（距容器顶 ${atTop.gap}px）`)
            if (atTop.top > SCROLL_TOP_EPS)
              errors.push(`子任务-窗口：打开时没停在顶部，初始要求被顶上去（scrollTop ${atTop.top}px）`)
            if (atTop.cover > 1) errors.push(`子任务-窗口：初始要求盖住了下面的对话流（压住 ${atTop.cover}px）`)
          }
          await check(p, '子任务-窗口-初始要求', ['派给它的要求', '查清购物车角标'])
          // 展开：按小节排开，要做的事在前、验收标准在后，两节正文都显示
          const toggle = card.getByRole('button', { name: /派给它的要求/ }).first()
          await toggle.click()
          await settle(p)
          await check(p, '子任务-窗口-初始要求-展开', ['要做的事', '验收标准'])
          // 关键：展开后卡片必须在视野内。只断言文本存在拦不住：Playwright 的 visible 不判视口，
          // 正文被跟随底部顶到视野之上时照样算 visible（旧写法就是这么漏的）
          const opened = await place()
          if (!opened) errors.push('子任务-窗口：展开后没找到初始要求所在的滚动容器')
          else if (!opened.inView)
            errors.push(`子任务-窗口：展开后初始要求被滚出视野（卡片顶距容器顶 ${opened.gap}px）`)
          else if (opened.cover > 1)
            errors.push(`子任务-窗口：展开后初始要求盖住了下面的对话流（压住 ${opened.cover}px）`)
          const heads = await card.evaluate((el) =>
            [...el.querySelectorAll(':scope > div > section > p')].map((x) => x.textContent?.trim() ?? ''),
          )
          if (heads.indexOf('要做的事') < 0 || heads.indexOf('验收标准') < 0)
            errors.push(`子任务-窗口：初始要求没按小节显示（当前小节：${heads.join(' / ') || '无'}）`)
          else if (heads.indexOf('要做的事') > heads.indexOf('验收标准'))
            errors.push(`子任务-窗口：小节顺序不对，要做的事应该在验收标准前面（当前：${heads.join(' / ')}）`)
          if (!(await card.getByText('只读不改代码', { exact: false }).count()))
            errors.push('子任务-窗口：初始要求没有显示验收标准的内容')
          // 再收起：正文收回去，摘要回来
          await toggle.click()
          await settle(p)
          if (await card.getByText('只读不改代码', { exact: false }).count())
            errors.push('子任务-窗口：再收起初始要求后正文还显示着')
          if (!(await card.getByText('查清购物车角标', { exact: false }).count()))
            errors.push('子任务-窗口：再收起初始要求后没有留下摘要一句')
          // 滚到底部附近之后恢复跟随：新内容进来窗口仍停在最新输出（停在顶部不能变成「再也不跟」）
          await w.evaluate((el) => {
            const sc = el.querySelector('.overflow-y-auto')
            if (sc instanceof HTMLElement) sc.scrollTop = sc.scrollHeight
          })
          await settle(p)
          const followed = await w.evaluate((el) => {
            const sc = el.querySelector('.overflow-y-auto')
            return sc ? sc.scrollHeight - sc.scrollTop - sc.clientHeight : null
          })
          if (followed !== null && followed > 40)
            errors.push(`子任务-窗口：滚到底部后没接着跟最新输出（离底部 ${Math.round(followed)}px）`)
          // 不吸顶：卡片是滚动区里的普通一块，滚到底部就该跟着滚出视野。
          // 上面几条在「内容不足一屏」时区分不出 sticky 和普通块（scrollTop 恒为 0，两种写法都过），
          // 所以要先造出可滚动：窗口高度是 min(820px, 100dvh-2rem)，矮视口能让内容区小于内容。
          // 演示数据的对话流长度不等，固定一个高度不一定够，所以逐档压矮到能滚出比卡片还高的一段为止
          const cardH = await card.evaluate((el) => Math.round(el.getBoundingClientRect().height))
          let scrolled = null
          for (const height of VIEWPORT_SHRINK_STEPS) {
            await p.setViewportSize({ width: 1440, height })
            await settle(p)
            scrolled = await w.evaluate((el) => {
              const sc = el.querySelector('.overflow-y-auto')
              if (!(sc instanceof HTMLElement)) return null
              return { scrollable: Math.round(sc.scrollHeight - sc.clientHeight) }
            })
            if (scrolled && scrolled.scrollable >= cardH + SCROLL_OUT_EPS) break
          }
          if (!scrolled) errors.push('子任务-窗口：没找到初始要求所在的滚动容器')
          else if (scrolled.scrollable < cardH + SCROLL_OUT_EPS)
            // 内容没超过一屏就没有「滚出视野」可言，这条断言会假绿，所以前置条件不满足时直接报出来
            errors.push(
              `子任务-窗口：压矮到 ${VIEWPORT_SHRINK_STEPS.at(-1)}px 后仍滚不满一张卡片，验证不了不吸顶` +
                `（可滚 ${scrolled.scrollable}px，卡片高 ${cardH}px）`,
            )
          else {
            await w.evaluate((el) => {
              const sc = el.querySelector('.overflow-y-auto')
              if (sc instanceof HTMLElement) sc.scrollTop = sc.scrollHeight
            })
            await settle(p)
            const scrolledOut = await place()
            if (!scrolledOut) errors.push('子任务-窗口：滚到底后没找到初始要求所在的滚动容器')
            else if (scrolledOut.inView)
              errors.push(`子任务-窗口：滚到底后初始要求还浮在容器顶部（距容器顶 ${scrolledOut.gap}px），卡片不该吸顶`)
          }
          await p.setViewportSize({ width: 1440, height: 900 })
          await settle(p)
          // 截图留在正常尺寸上：截图档案是给人看的，矮窗口里看不出卡片有没有被下面的内容压住
          await check(p, '子任务-窗口-初始要求-不吸顶')
          // 没有要求（旧记录：schema 加 brief 之前落盘的 step）时卡片整块不渲染，
          // 滚动区第一块就是对话流，这时窗口照旧贴底看最新输出——停在顶部会让最新的结果要自己滚下去才看得到
          // 先记下窗口本身，跑完要把它关掉再重新打开，不然后面的「AI 分析」用例找不到还开着的窗口
          await p.getByRole('button', { name: '关闭', exact: true }).last().click()
          await settle(p)
          // 原值要带回 Node 侧：页面里的 window 属性活不过 p.reload()，挂在那里写回时已经丢了
          const savedBrief = await p.evaluate((k) => {
            const db = JSON.parse(localStorage.getItem(k))
            const parent = db.tasks.find((x) => x.title.includes('购物车'))
            const sub = parent.steps.find((x) => x.slot === 'sub' && x.title === '核对角标的订阅时机')
            if (!sub) throw new Error('演示数据里找不到「核对角标的订阅时机」这个子任务')
            const before = sub.brief
            sub.brief = ''
            localStorage.setItem(k, JSON.stringify(db))
            // 不写死一份 brief：演示数据改了这条用例不用跟
            return before
          }, 'agent-panel-demo-v3')
          await p.reload()
          await openTask()
          await bar.first().click()
          await p.getByRole('button', { name: /核对角标的订阅时机/ }).click()
          await settle(p)
          const noBrief = p.getByRole('dialog').last()
          if (await noBrief.getByRole('region', { name: '派给它的要求' }).count())
            errors.push('子任务-窗口：没有 brief 的旧记录不该画出「派给它的要求」')
          // 造出可滚动再量：内容不足一屏时 gap 恒为 0，这条断言会空转（和上面「不吸顶」同一个道理）
          let noBriefPos = null
          for (const height of VIEWPORT_SHRINK_STEPS) {
            await p.setViewportSize({ width: 1440, height })
            await settle(p)
            noBriefPos = await noBrief.evaluate((el) => {
              const sc = el.querySelector('.overflow-y-auto')
              if (!(sc instanceof HTMLElement)) return null
              return {
                over: Math.round(sc.scrollHeight - sc.clientHeight),
                gap: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight),
              }
            })
            if (noBriefPos && noBriefPos.over > SCROLL_TOP_EPS) break
          }
          await p.setViewportSize({ width: 1440, height: 900 })
          await settle(p)
          // 截图留在正常尺寸上：矮窗口里看不出窗口真实形态（断言用的 noBriefPos 上面已量完）
          await check(p, '子任务-窗口-无要求仍贴底')
          if (!noBriefPos) errors.push('子任务-窗口：没有 brief 的旧记录找不到滚动容器')
          else if (noBriefPos.over <= SCROLL_TOP_EPS)
            errors.push(
              `子任务-窗口：压矮到 ${VIEWPORT_SHRINK_STEPS.at(-1)}px 后没有 brief 的旧记录仍不足一屏，验证不了贴底性`,
            )
          else if (noBriefPos.gap > SCROLL_TOP_EPS)
            errors.push(
              `子任务-窗口：没有 brief 的旧记录打开没贴在最新输出（离底部 ${noBriefPos.gap}px，可滚 ${noBriefPos.over}px）`,
            )
          // 恢复现场：把 brief 写回去、重新打开那个子任务窗口，后面的「AI 分析」接着用它
          await p.getByRole('button', { name: '关闭', exact: true }).last().click()
          await settle(p)
          await p.evaluate(
            ([k, v]) => {
              const db = JSON.parse(localStorage.getItem(k))
              const parent = db.tasks.find((x) => x.title.includes('购物车'))
              const sub = parent.steps.find((x) => x.slot === 'sub' && x.title === '核对角标的订阅时机')
              // 原值是 undefined（旧记录本来就没这个字段）时也原样写回，不要变成空字符串
              if (sub) sub.brief = v
              localStorage.setItem(k, JSON.stringify(db))
            },
            ['agent-panel-demo-v3', savedBrief],
          )
          await p.reload()
          await openTask()
          await bar.first().click()
          await p.getByRole('button', { name: /核对角标的订阅时机/ }).click()
          await settle(p)
          // 复原真的生效了吗：卡片回来了才算恢复现场（这段写回之前是死代码，重载后丢失，这里就是拦它的）
          if (!(await p.getByRole('dialog').last().getByRole('region', { name: '派给它的要求' }).count()))
            errors.push('子任务-窗口：清空 brief 的用例跑完后没把要求写回去（后面的用例会看不到要求）')
          await settle(p)
        }
      }
      // 子任务窗口头部的「AI 分析」：弹的是执行记录那一套弹窗（同样的 focus 输入和「开始分析」），
      // 只把范围收窄到这一步。按弹窗作用域找，页面上别处（内存曲线那边）也有「AI 分析」
      const win = p.getByRole('dialog').last()
      const analyzeBtn = win.getByRole('button', { name: 'AI 分析', exact: true })
      if (!(await analyzeBtn.count())) errors.push('子任务-窗口：头部没有「AI 分析」按钮')
      else {
        await analyzeBtn.first().click()
        const dlg = p.getByRole('dialog').last()
        await dlg
          .getByRole('button', { name: '开始分析' })
          .waitFor({ timeout: 5000 })
          .catch(() => errors.push('子任务-窗口：点 AI 分析没有弹出分析弹窗'))
        const dialogText = (await dlg.textContent().catch(() => '')) ?? ''
        if (!dialogText.includes('AI 分析这个子任务'))
          errors.push(`子任务-窗口：弹窗标题不是「AI 分析这个子任务」（当前：${dialogText.slice(0, 60)}）`)
        if (!dialogText.includes('只读这一个子任务')) errors.push('子任务-窗口：弹窗里没有说明只分析这一步')
        await check(p, '子任务-窗口-分析弹窗')
        const before = p.url()
        const known = await p.evaluate(
          (k) => (JSON.parse(localStorage.getItem(k) ?? '{}').tasks ?? []).map((x) => x.id),
          'agent-panel-demo-v3',
        )
        await dlg.getByRole('button', { name: '开始分析' }).click()
        await p
          .getByText('优化空间', { exact: false })
          .first()
          .waitFor({ timeout: 20000 })
          .catch(() => errors.push('子任务-窗口：开始分析后没有新建分析对话'))
        await check(p, '子任务-窗口-分析结果', ['耗时', '是否符合角色', '优化空间'])
        // 分析对话按归属开在项目层级（顶层项目对话的分析不再挂成它自己的子对话），
        // 显示在统一的 AI 分析窗口里，页面不跳走
        if (p.url() !== before) errors.push(`子任务-窗口：分析不该跳走页面（URL 变成了 ${p.url()}）`)
        if (!(await p.getByRole('button', { name: '在项目对话里打开' }).count()))
          errors.push('子任务-窗口：分析窗口没有「在项目对话里打开」（分析对话没开在项目层级）')
        // 回到购物车那个任务页接着核对后面的项：分析对话同样有「Token 用量」，backToTask() 会以为已经在任务页。
        // 先把刚建的分析对话从演示数据里去掉，免得后面按文字找元素时命中它的内容。
        // 要等它真的跑完再改：演示版模块级的 db 还是旧对象，它每 800ms 的 changed 和 finally 里的 persist()
        // 会把含分析对话的 db 写回 localStorage，改早了会被覆盖
        await p
          .waitForFunction(
            ([k, ids]) => {
              const db = JSON.parse(localStorage.getItem(k) ?? '{"tasks":[]}')
              // 只等新出现的任务（分析对话）：known 里的演示数据本身就有故意停在 running 的对话
              // （状态行的正例 / 反例，见 seedTasks），算进去会一直等不到
              return !(db.tasks ?? []).some((x) => !ids.includes(x.id) && x.status === 'running')
            },
            ['agent-panel-demo-v3', known],
            { timeout: 30000 },
          )
          .catch(() => errors.push('子任务-窗口：分析对话一直没跑完，后面的核对会受它干扰'))
        // 分析跑完了：关掉 AI 分析窗口再清数据
        await p.getByRole('button', { name: '关闭', exact: true }).last().click()
        await p.evaluate(
          ([k, ids]) => {
            const db = JSON.parse(localStorage.getItem(k))
            db.tasks = db.tasks.filter((x) => ids.includes(x.id))
            localStorage.setItem(k, JSON.stringify(db))
          },
          ['agent-panel-demo-v3', known],
        )
        await p.goto(base)
        await p.getByText('购物车右上角', { exact: false }).first().click()
        await p
          .getByTitle('Token 用量')
          .first()
          .waitFor({ timeout: 10000 })
          .catch(() => {})
      }
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
      // 上一步的 reload / 导航会让标题栏重渲染，紧接着那一下点击可能落在正在换掉的节点上而不展开。
      // 没展开就补点一次（和本文件最后截图那段同一个做法），避免反而关掉已打开的浮层。
      // 判据看触发按钮自己的展开状态（ProjectSwitch 的 PopoverTrigger 带 data-state），
      // 不看浮层内容可见：打开后拉列表是 effect，内容晚一帧才齐，拿内容判会误把「已打开」当成「没打开」再点一下关掉
      const expanded = () =>
        projBtn
          .first()
          .getAttribute('data-state')
          .then((s) => s === 'open')
          .catch(() => false)
      if (!(await expanded())) {
        await p.waitForTimeout(300)
        if (!(await expanded())) await projBtn.first().click()
      }
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

        // 鼠标点另一条：就地打开，浮层收起。
        // 浮层列表跟着任务刷新（每 4 秒）重新渲染，全量并行跑时按钮会一直「不稳定」甚至被换掉，
        // 鼠标点会被 Playwright 的稳定性检查卡住：点不动就退回键盘聚焦 + Enter，要验的是「打开了另一条」
        const another = pop.getByRole('button', { name: /商品详情页/ }).first()
        const clicked = await another.click({ timeout: 4000 }).then(
          () => true,
          () => false,
        )
        if (!clicked) {
          await another.focus({ timeout: 4000 }).catch(() => {})
          await p.keyboard.press('Enter')
        }
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
              const dialog = el?.closest('[role="dialog"]')
              // Radix 的 Content 自己也是 role=dialog、tabIndex=-1：要的是它里面监听方向键的那层
              return !!el && el.getAttribute('tabindex') === '-1' && !!dialog && el !== dialog
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
    await p.getByRole('heading', { name: CART, exact: true }).waitFor({ timeout: 8000 })
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
      await p
        .getByRole('heading', { name: RESTOCK, exact: true })
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
        await p
          .getByRole('heading', { name: RESTOCK, exact: true })
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
        await p
          .getByRole('heading', { name: RESTOCK, exact: true })
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
        .getByTitle('Token 用量')
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

  // 发送消息的一瞬间运行区不能闪没：刚发出的用户消息会自己成一段（见 TaskView 的 toBlocks），
  // 以前「最新的一轮」按最后一段算，那一轮回复就不再是最新，运行区（子对话行、后台命令行）整块消失，
  // 等 AI 开口又回来。这里用 MutationObserver 记录整个发送过程里运行区最少的子对话行数，
  // 不靠等待时序赌那一帧（等待条件用「消息出现在消息区里」这个可观测状态）。
  {
    await p.goto(base)
    await p.getByText('购物车右上角', { exact: false }).first().click()
    await p
      .getByTitle('Token 用量')
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {})
    // 前面的用例可能把右栏子对话留着（那样页面上有两个 #follow-up）：先关掉，输入框只留父对话那个
    const pane = p.locator('aside[aria-label="子对话"]')
    if (await pane.count()) {
      await p
        .getByRole('button', { name: '关闭子对话', exact: true })
        .first()
        .click()
        .catch(() => {})
      await pane.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
    }
    /** 运行区里现在有几行子对话（和弹层「运行中」是同一批，见 shared/task.ts 的 visibleChildren） */
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
})
