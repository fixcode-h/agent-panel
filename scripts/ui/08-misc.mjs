/**
 * 界面检查分片：ComfyUI 模板商店与工作流链、统一的悬停提示、计划面板、工作总结（报告树、提炼、采纳）。
 *
 * 这四块各自只有 8~13 步（8 + 9 + 10 + 13 = 40），固定开销（起静态服务 + 开浏览器）就占掉一半：
 * 以前是四个分片、四个浏览器，现在合成一片按顺序跑，断言一条不少。
 * 每一块自己开页面（见 harness.mjs 的 page()）：演示数据各在自己的浏览器上下文里，互不影响。
 */
import { runShard } from './harness.mjs'

/**
 * 和 web/src/components/ui/hint.tsx 里的 SKIP_TAGS 一致：
 * 这些原生元素的 title 是浏览器自己的语义，实现不接管，用例也不该拿它们当目标。
 */
const SKIP_TITLE_TAGS = new Set(['IFRAME', 'OPTION', 'OPTGROUP', 'TITLE', 'STYLE', 'SCRIPT'])

// 计划面板在演示版里的数据库键（改完要整页重载才会读到，见下面的用例）
const KEY = 'agent-panel-demo-v3'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  // ---- ComfyUI 工作流和模板商店 ----
  {
    const p = await page({ width: 1440, height: 900 })
    await p.goto(base + '#/comfy')
    await p.getByRole('button', { name: '模板商店', exact: true }).click()
    await check(p, '模板商店', ['所有模板', '面板内置', 'Z-Image Turbo · 文本生图', 'SDXL1.0: Text to Image (Simple)'])

    // 搜索：只剩含 SDXL 的模板，内置的 Z-Image 不再出现
    await p.getByLabel('搜索模板').fill('SDXL')
    await settle(p)
    if (await p.getByText('Z-Image Turbo · 文本生图', { exact: false }).count())
      errors.push('模板商店：搜索 SDXL 后 Z-Image 还在')
    await check(p, '模板商店-搜索', ['SDXL1.0: Text to Image (Simple)', '2 个模板'])

    // 详情：节点图、依赖文件、添加按钮
    await p.getByRole('button').filter({ hasText: 'SDXL1.0: Text to Image (Simple)' }).first().click()
    await check(p, '模板详情', ['节点图', '依赖的模型文件', 'sd_xl_base_1.0.safetensors', '添加为工作流'])

    // 添加为工作流：回到工作流页，左侧出现新工作流
    await p.getByRole('button', { name: '添加为工作流', exact: true }).click()
    await p
      .getByText('SDXL1.0: Text to Image (Simple)（副本）', { exact: false })
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('模板商店：添加后没有回到工作流页并选中新工作流'))
    await check(p, '模板添加为工作流')
    // 模板商店加的算「导入的」：筛「导入的」时还在，筛「我的」时不在
    await p.getByRole('radio', { name: '导入的', exact: true }).click()
    await check(p, '工作流-导入的', ['SDXL1.0: Text to Image (Simple)（副本）'])
    await p.getByRole('radio', { name: '我的', exact: true }).click()
    // 只在列表里找：画布标题还是选中的那个工作流
    if (
      await p
        .locator('section[aria-label="工作流列表"]')
        .getByText('SDXL1.0: Text to Image (Simple)（副本）', { exact: false })
        .count()
    )
      errors.push('ComfyUI 工作流：模板商店加的工作流不该出现在「我的」里')
    await p.getByRole('radio', { name: '全部', exact: true }).click()
    // 试生成条：尺寸、张数可选
    await p.getByRole('button', { name: '试生成的张数' }).click()
    await p.getByRole('menuitemradio', { name: '× 2' }).click()
    await check(p, '试生成-张数', ['× 2', '1024²'])

    // 手机宽度：分类、筛选和卡片都不出横向滚动
    const m = await page({ width: 390, height: 844 })
    await m.goto(base + '#/comfy')
    await m.getByRole('button', { name: '模板商店', exact: true }).click()
    await check(m, '模板商店-手机', ['所有模板', 'SDXL1.0: Text to Image (Simple)'])

    // 工作流链：能建链、选段、看到预览区（演示版没有 ComfyUI，试跑会给出说明）
    // check() 断言的是界面上真看得见的文字；段的下拉框只有 aria-label，用 getByLabel 查
    await p.goto(base + '#/comfy/game')
    // 运行队列和工作流链在右栏的「队列」页签里
    await p.getByRole('tab', { name: '队列', exact: true }).click()
    await check(p, '工作流链', ['工作流链', '新建链'])
    await p.getByRole('button', { name: '新建链', exact: true }).click()
    await check(p, '工作流链-新建', ['加一段', '试跑', '选原图'])
    await p
      .getByLabel('第 1 段的工作流')
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('工作流链：新建后没有第一段的工作流选择器'))
    await p.getByRole('button', { name: '加一段', exact: true }).click()
    await p
      .getByLabel('第 2 段的工作流')
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('工作流链：加一段后没有第二段'))
    await check(p, '工作流链-两段')
  }

  // ---- 统一的悬停提示（web/src/components/ui/hint.tsx）----
  {
    const p = await page({ width: 1440, height: 900 })
    await p.goto(base)
    await settle(p)

    const tooltip = p.getByRole('tooltip')

    /** 把指针停到元素正中，等提示浮层出现（悬停有 150ms 延时） */
    const hoverCenter = async (locator) => {
      const box = await locator.boundingBox()
      if (!box) return null
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      return box
    }
    /** 把指针挪到页面空白处，等提示消失 */
    const moveAway = async () => {
      await p.mouse.move(800, 700)
      await p.waitForTimeout(500)
    }

    // 悬停时实现会把 title 暂存到 data-hint（不然浏览器还会弹它自己那条黑条），两种写法都能定位
    const newProject = p.locator('button[title="新建项目"], button[data-hint="新建项目"]').first()
    if (!(await newProject.count())) errors.push('提示-悬停：侧栏找不到「新建项目」按钮')
    else {
      // 静态 DOM 里 title 还在：界面检查和其他用例靠它定位，摘掉只在悬停那一刻发生
      if (!(await newProject.getAttribute('title'))) errors.push('提示-悬停：没悬停时 title 属性就被提前摘掉了')

      await hoverCenter(newProject)
      await tooltip
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push('提示-悬停：鼠标停上去没有出现提示浮层'))
      const text = ((await tooltip.first().textContent()) ?? '').trim()
      if (text !== '新建项目') errors.push(`提示-悬停：浮层文字是「${text}」，不是按钮的 title`)
      // 悬停期间 title 要摘掉，否则浏览器还会弹它自己那条黑条
      if (await newProject.getAttribute('title')) errors.push('提示-悬停：浮层出来了但 title 还在，原生黑条会一起出现')
      // 悬停提示不放关闭按钮
      if (await tooltip.first().getByRole('button').count()) errors.push('提示-悬停：悬停提示里不该有关闭按钮')
      await check(p, '提示-悬停出浮层')

      // 鼠标移开：自己消失，不需要点任何按钮
      await moveAway()
      if (await tooltip.count()) errors.push('提示-消失：鼠标移开后浮层没有自己消失')
      // 消失后 title 要还原：静态 DOM 回到原样，界面检查按 title 定位才不受影响
      if ((await newProject.getAttribute('title')) !== '新建项目')
        errors.push('提示-消失：移开后 title 没有还原，界面检查按 title 定位会失效')
      await check(p, '提示-移开后自动消失并还原')

      // 回来还能再出现（每次悬停都算新的一次）
      await hoverCenter(newProject)
      await tooltip
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push('提示-再次悬停：移开后再悬停没有重新出现浮层'))
      await check(p, '提示-再次悬停能再出来')

      // Esc 也能关掉（键盘用户不用非得把鼠标挪走）
      await p.keyboard.press('Escape')
      await tooltip
        .first()
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => errors.push('提示-Esc：按 Esc 浮层没消失'))
      await check(p, '提示-Esc关闭')
    }

    // 浮层不能挡鼠标：原生 title 从不拦点击，换成浮层后鼠标下面的按钮还得点得到
    {
      await moveAway()
      const box = await hoverCenter(newProject)
      await tooltip
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {})
      if (box && (await tooltip.count())) {
        // 直接点触发元素自己的位置：浮层如果吃指针事件，点到的就是浮层
        await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await settle(p)
        if (!(await p.getByRole('dialog').count()))
          errors.push('提示-不吃点击：浮层挡住时点按钮没反应（浮层拦截了鼠标事件）')
        await check(p, '提示-浮层不拦点击')
        await p.keyboard.press('Escape')
        await settle(p)
      }
    }

    // disabled 的元素：原生 title 在 disabled 上也显示，换成浮层后要还在。
    // 这里的按钮常带 pointer-events: none，按坐标取元素会跳过它 —— 以前改成「没有就跳过」，
    // 结果真坏了也照样通过，所以现在找不到元素就直接算失败。
    {
      await moveAway()
      const n = await p.locator('[title][disabled]').count()
      if (!n) errors.push('提示-disabled：页面上找不到 disabled 的 title 元素，这条用例失去意义')
      else {
        const target = p.locator('[title][disabled]').first()
        const pe = await target.evaluate((el) => getComputedStyle(el).pointerEvents)
        const shown = await hoverCenter(target)
        const ok = await tooltip
          .first()
          .waitFor({ timeout: 5000 })
          .then(() => true)
          .catch(() => false)
        if (!ok)
          errors.push(
            `提示-disabled：disabled 的元素上没有出现提示（pointer-events=${pe}，这正是按坐标取元素会踩的坑）`,
          )
        if (shown && ok) await check(p, '提示-disabled元素')
        await moveAway()
      }
    }

    // 长文字：浮层不冒出视口、不超过最大宽度。
    // 和 disabled 那条一样，找不到目标就算失败：以前「没有就跳过」会让这条用例在改版后静默通过。
    {
      await moveAway()
      // 挑页面上最长的一个 title：不写死某个元素，界面改版后换地方也照样能测到
      // 要跳过的标签名作为参数传进去：p.evaluate 在浏览器里跑，读不到这里的常量
      const target = await p.evaluate(
        (skipTags) => {
          const skip = new Set(skipTags)
          const all = [...document.querySelectorAll('[title]')]
          let best = null
          let bestLen = 0
          all.forEach((el, i) => {
            const text = el.getAttribute('title') ?? ''
            if (text.length <= 30 || skip.has(el.tagName)) return
            if (text.length > bestLen) {
              bestLen = text.length
              best = i
            }
          })
          return best === null ? null : { index: best, len: bestLen }
        },
        [...SKIP_TITLE_TAGS],
      )
      if (!target) errors.push('提示-长文字：页面上找不到长度超过 30 的 title 元素，这条用例失去意义')
      else {
        // 元素可能在滚动容器外面：先滚进视口再悬停，不能因此跳过
        const el = p.locator('[title]').nth(target.index)
        await el.scrollIntoViewIfNeeded()
        await settle(p)
        const box = await el.boundingBox()
        if (!box) errors.push('提示-长文字：滚动后仍然量不到目标元素')
        else {
          await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await p.waitForTimeout(500)
          const tb = await tooltip
            .first()
            .boundingBox()
            .catch(() => null)
          if (!tb) errors.push('提示-长文字：悬停长文案元素没有出现提示浮层')
          else {
            if (tb.width > 321) errors.push(`提示-长文字：浮层宽 ${tb.width}，超过 320`)
            if (tb.x < 0 || tb.x + tb.width > 1441)
              errors.push(`提示-长文字：浮层跑出视口（x=${tb.x}, 宽=${tb.width}）`)
            // 长文案要真的换行：只允许它比最大宽度窄，不能撑开成一整行横贯页面
            await check(p, '提示-长文字')
          }
        }
        await moveAway()
      }
    }

    // 窄屏：浮层不能被视口切掉
    {
      await p.setViewportSize({ width: 390, height: 780 })
      await settle(p)
      await p.mouse.move(200, 700)
      await p.waitForTimeout(300)
      const box = await hoverCenter(p.locator('[title]').first())
      if (box) {
        await p.waitForTimeout(500)
        const tb = await tooltip
          .first()
          .boundingBox()
          .catch(() => null)
        if (tb && (tb.x < -1 || tb.x + tb.width > 391))
          errors.push(`提示-窄屏：浮层超出视口（x=${tb.x}, 右=${tb.x + tb.width}）`)
        await check(p, '提示-窄屏')
      }
      await p.setViewportSize({ width: 1440, height: 900 })
      await settle(p)
    }

    // 弹窗里的帮助问号：浮层必须贴着它。
    // 弹窗用 -translate-x-1/2 居中，position: fixed 的包含块会跟着变；
    // 浮层如果还渲染在弹窗内部，算好的视口坐标就会被相对弹窗解释，偏到别处甚至被裁掉。
    {
      await moveAway()
      await p.goto(base)
      await settle(p)
      await p.locator('aside').getByText('商城前台').first().click({ button: 'right' })
      await p
        .getByRole('menuitem', { name: '项目设置' })
        .first()
        .click()
        .catch(() => errors.push('提示-弹窗内对齐：打不开项目设置'))
      await settle(p)
      const help = p.getByRole('img', { name: '说明' }).first()
      if (!(await help.count())) errors.push('提示-弹窗内对齐：弹窗里没有帮助问号')
      else {
        await help.scrollIntoViewIfNeeded()
        // 弹窗有入场动画（-translate 从缩放/位移过来），动画过程中量位置会读到中间态，先等它播完
        await settle(p)
        await p.waitForTimeout(300)
        // 先把指针挪到别处再移回来：悬停提示要求「指针刚动过」，停在原地重复 hover 不会触发 pointermove
        await p.mouse.move(900, 150)
        await p.waitForTimeout(250)
        await help.hover()
        const appeared = await tooltip
          .first()
          .waitFor({ timeout: 5000 })
          .then(() => true)
          .catch(() => false)
        if (!appeared) errors.push('提示-弹窗内对齐：弹窗里的问号没有出现提示')
        else {
          // 弹窗打开时不能残留上一个页面的提示：内容会和眼前的界面无关
          const tips = await tooltip.count()
          if (tips > 1) errors.push(`提示-弹窗内对齐：同时有 ${tips} 个提示浮层（弹窗打开时上一个没关掉）`)
          // 浮层也是定位后再显形，等它稳定下来再量
          await settle(p)
          await p.waitForTimeout(150)
          // 必须量「真的被悬停的那个问号」：弹窗里有好几个说明问号，直接取第一个会和浮层配不上对。
          // 做法是拿浮层的水平位置反查：浮层默认与触发元素左对齐，取水平距离最近的那个问号。
          const m = await p.evaluate(() => {
            const t = document.querySelector('[role="tooltip"]')
            if (!t) return null
            const tr = t.getBoundingClientRect()
            const helps = [...document.querySelectorAll('[role="img"][aria-label="说明"]')]
            if (!helps.length) return null
            let best = null
            let bestGap = Infinity
            for (const h of helps) {
              const hr = h.getBoundingClientRect()
              // 只考虑竖直方向上挨着浮层的那个（浮层在它上方或下方 40px 内）
              const dy = Math.min(Math.abs(hr.top - tr.bottom), Math.abs(hr.bottom - tr.top))
              if (dy > 60) continue
              const gap = Math.abs(hr.x - tr.x)
              if (gap < bestGap) {
                bestGap = gap
                best = hr
              }
            }
            if (!best) return null
            return { hx: best.x, hy: best.y, tx: tr.x, ty: tr.y, th: tr.height, tw: tr.width }
          })
          if (!m) errors.push('提示-弹窗内对齐：量不到位置（找不到被悬停的问号或浮层）')
          else {
            // 浮层默认在问号上方、左对齐：水平差应在几个像素内
            const dx = Math.abs(m.tx - m.hx)
            // 垂直方向：浮层底边在问号上方 6px 左右；放不下会翻到下方，这里只要求别偏出太多
            const gapAbove = m.hy - (m.ty + m.th)
            const gapBelow = m.ty - m.hy
            if (dx > 8)
              errors.push(
                `提示-弹窗内对齐：浮层水平偏了 ${Math.round(dx)}px（问号 x=${Math.round(m.hx)}，浮层 x=${Math.round(m.tx)}）`,
              )
            if (gapAbove > 40 && gapBelow > 40)
              errors.push(
                `提示-弹窗内对齐：浮层离问号太远（上方 ${Math.round(gapAbove)}px，下方 ${Math.round(gapBelow)}px）`,
              )
            await check(p, '提示-弹窗内对齐')
          }
        }
      }
      await p.keyboard.press('Escape')
      await settle(p)
    }

    // 同屏只能有一个提示浮层
    {
      await moveAway()
      await hoverCenter(p.locator('button[title="新建项目"], button[data-hint="新建项目"]').first())
      await p.waitForTimeout(400)
      const second = p.locator('button[title="更多"], button[data-hint="更多"]').first()
      if (await second.count()) await hoverCenter(second)
      await p.waitForTimeout(500)
      const n = await tooltip.count()
      if (n > 1) errors.push(`提示-同屏：同时出现了 ${n} 个提示浮层`)
      await check(p, '提示-同屏只有一个')
    }
  }

  // ---- 计划面板 ----
  {
    const p = await page({ width: 1440, height: 900 })
    await p.goto(base + '#/schedules')
    // 默认是周视图（照设计稿）：先看日历和右侧详情，再切到「列表」检查按状态分组的卡片
    await check(p, '计划周视图', ['计划', '本周', '第', '新建计划', '接下来', '运行记录', '现在运行一次'])
    if (!(await p.getByRole('region', { name: '周视图' }).count())) errors.push('计划周视图：没有「周视图」区域')
    if (!(await p.getByRole('complementary', { name: '计划详情' }).count()))
      errors.push('计划周视图：宽屏右侧没有「计划详情」面板')

    // 详情面板直接改（照设计稿）：没改时「保存」不可点；改了要做什么、选「到某天」结束后保存，
    // 走和编辑弹窗同一套校验——结束日期早于第一次执行时拦下并提示
    {
      const detail = p.getByRole('complementary', { name: '计划详情' })
      const saveBtn = detail.getByRole('button', { name: '保存', exact: true })
      // 演示预置的运行记录：跑完的写耗时（72 秒 → 1:12），启动失败的给「AI 分析」
      await check(p, '计划详情-运行记录', ['1:12', '0:58', '失败 · AI 分析'])
      if (!(await saveBtn.isDisabled())) errors.push('计划详情：没改动时「保存」也能点')
      await detail.getByLabel('要做什么').fill('总结今天做的工作，列出明天要接着做的事')
      if (await saveBtn.isDisabled()) errors.push('计划详情：改了要做什么之后「保存」还是不能点')
      const ymdOf = (ms) => {
        const d = new Date(ms)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }
      const endGroup = detail.getByRole('radiogroup', { name: '结束' })
      await endGroup.getByRole('radio', { name: '到某天' }).click()
      const endInput = detail.getByLabel('结束日期')
      await endInput.waitFor({ timeout: 3000 }).catch(() => errors.push('计划详情：选「到某天」后没有出现结束日期'))
      // 结束日期早于第一次执行：保存被拦下，原因直接显示
      await endInput.fill(ymdOf(Date.now() - 2 * 86_400_000))
      await saveBtn.click()
      await p
        .getByText('结束日期早于第一次执行，计划一次也不会执行')
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push('计划详情：结束日期早于第一次执行时没有拦下保存'))
      const endDate = ymdOf(Date.now() + 10 * 86_400_000)
      await endInput.fill(endDate)
      await saveBtn.click()
      await p
        .getByText('计划已保存')
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push('计划详情：保存后没有提示「计划已保存」'))
      await p
        .waitForFunction((btn) => btn?.disabled, await saveBtn.elementHandle(), { timeout: 5000 })
        .catch(() => errors.push('计划详情：保存后「保存」还能点（改动没有落下）'))
      const stored = await p.evaluate((key) => {
        const db = JSON.parse(localStorage.getItem(key) || '{}')
        const s = (db.schedules || []).find((x) => x.name === '今日工作')
        return s ? { endDate: s.endDate, prompt: s.prompt } : null
      }, KEY)
      if (stored?.endDate !== endDate) errors.push(`计划详情：结束日期没有存下来（${JSON.stringify(stored)}）`)
      if (stored?.prompt !== '总结今天做的工作，列出明天要接着做的事')
        errors.push(`计划详情：要做什么没有存下来（${JSON.stringify(stored)}）`)
      await check(p, '计划详情-保存后', ['到某天', '接下来'])

      // 有没保存的改动时切到列表：先确认，确认放弃才切过去
      await detail.getByLabel('要做什么').fill('改到一半')
      await p.getByRole('radiogroup', { name: '视图' }).getByRole('radio', { name: '列表' }).click()
      const discard = p.getByRole('dialog').filter({ hasText: '放弃没有保存的改动？' })
      await discard.waitFor({ timeout: 3000 }).catch(() => errors.push('计划详情：有未保存的改动时切走没有确认'))
      if (await discard.count()) await discard.getByRole('button', { name: '放弃改动' }).click()
      await p.getByRole('radiogroup', { name: '视图' }).getByRole('radio', { name: '周' }).click()
    }

    // 周视图的直接操作：拖动还没到的那一次改时间（每天的计划只换时分）、拖底边改时长，都按半小时对齐；
    // 空白格右键是「在某时新建计划」，点了弹出新建窗口，时长默认一小时
    {
      const stored = (n) =>
        p.evaluate(
          ([key, name]) => (JSON.parse(localStorage.getItem(key) || '{}').schedules || []).find((x) => x.name === name),
          [KEY, n],
        )
      const occ = p.locator('[data-occ="今日工作"]').last()
      const before = await stored('今日工作')
      const slot = (await p.locator('[data-slot]').nth(1).boundingBox())?.height ?? 0
      // 周视图打开时滚到「现在的前一小时」：凌晨跑检查时 19:00 那一块在滚动区外面，按坐标拖会落空（检查时好时坏）。
      // 先把它滚进可视区再取位置
      await occ.scrollIntoViewIfNeeded().catch(() => {})
      const box = await occ.boundingBox()
      if (!box || !slot) errors.push('计划拖动：周视图里找不到「今日工作」或时间格')
      else {
        await p.mouse.move(box.x + box.width / 2, box.y + 8)
        await p.mouse.down()
        await p.mouse.move(box.x + box.width / 2, box.y + 8 + slot * 2, { steps: 8 })
        await p.mouse.up()
        await p
          .waitForFunction(
            ([key, at]) =>
              (JSON.parse(localStorage.getItem(key) || '{}').schedules || []).find((x) => x.name === '今日工作')?.at !==
              at,
            [KEY, before.at],
            { timeout: 5000 },
          )
          .catch(() => {})
        const moved = await stored('今日工作')
        const hour = (iso) => new Date(iso).getHours() + new Date(iso).getMinutes() / 60
        if (hour(moved.at) - hour(before.at) !== 1)
          errors.push(`计划拖动：往下拖两格应该晚一小时（${before.at} → ${moved.at}）`)
        if (Date.parse(moved.at) - Date.parse(before.at) > 86_400_000)
          errors.push(`计划拖动：每天的计划拖了最后一格，下一次被推到了好几天后（${moved.at}）`)
        await p
          .locator('[data-occ="今日工作"]')
          .last()
          .scrollIntoViewIfNeeded()
          .catch(() => {})
        const b2 = await p.locator('[data-occ="今日工作"]').last().boundingBox()
        await p.mouse.move(b2.x + b2.width / 2, b2.y + b2.height - 2)
        await p.mouse.down()
        await p.mouse.move(b2.x + b2.width / 2, b2.y + b2.height - 2 + slot, { steps: 6 })
        await p.mouse.up()
        await p.waitForTimeout(500)
        const resized = await stored('今日工作')
        if (resized.durationMin !== moved.durationMin + 30)
          errors.push(`计划拉伸：拖底边一格应该多半小时（${moved.durationMin} → ${resized.durationMin}）`)
      }
      const cell = await p.locator('[data-slot="10:30"]').nth(5).boundingBox()
      await p.mouse.click(cell.x + cell.width / 2, cell.y + cell.height / 2, { button: 'right' })
      const item = p.getByRole('menuitem', { name: /在 周六 10:30 新建计划/ })
      await item
        .waitFor({ timeout: 3000 })
        .catch(() => errors.push('计划右键：空白格右键没有「在 周六 10:30 新建计划」'))
      await check(p, '计划周视图-右键新建')
      if (await item.count()) {
        await item.click()
        const dlg = p.getByRole('dialog').filter({ hasText: '新建计划' })
        await check(p, '计划周视图-右键新建弹窗', ['时长', '1 小时', '不重复'])
        await dlg.getByRole('button', { name: '取消' }).click()
      }
    }
    /** 切到列表视图：视图记在本机，重载后还在列表；每次都点一下更稳 */
    const listView = async () => {
      await p.getByRole('radiogroup', { name: '视图' }).getByRole('radio', { name: '列表' }).click()
      await p.getByRole('region', { name: '计划概览' }).or(p.getByText('还没有计划')).first().waitFor({ timeout: 5000 })
    }
    await p.getByRole('radiogroup', { name: '视图' }).getByRole('radio', { name: '月' }).click()
    await check(p, '计划月视图', ['本月', '今日工作'])
    await listView()
    // 页头一条概览（下一次是谁、什么时候，待执行 / 出过问题计数），下面按四组列卡片
    await check(p, '计划列表', [
      '计划',
      '今日工作',
      '新建计划',
      '下一次执行',
      '待执行',
      '出过问题',
      '即将执行',
      '下次执行',
      '每天',
    ])
    // 概览用 aria-label 标识区域，不是可见文字
    if (!(await p.getByRole('region', { name: '计划概览' }).count())) errors.push('计划列表：没有「计划概览」区域')

    /** 分组标题（h2 的文字里带着数量） */
    const groupHeading = (name) => p.getByRole('heading', { name: new RegExp(`^${name}`) })
    /** 某一组的卡片里看到的文字（空白压成一行，方便断言） */
    const groupText = async (name) =>
      (await p.locator('section').filter({ hasText: name }).first().innerText()).replace(/\s+/g, ' ')
    /** 组标题上的数量 */
    const groupCount = async (name) => {
      const h = groupHeading(name).first()
      await h.waitFor({ timeout: 5000 })
      const text = (await h.innerText()).replace(/\s+/g, ' ').trim()
      return Number(text.slice(name.length).trim())
    }

    // 即将执行：预置的今日工作在最上面，下次执行写清绝对时间和相对时间
    if ((await groupCount('即将执行')) !== 1) errors.push('计划列表：「即将执行」组的数量不是 1')
    const upcoming = await groupText('即将执行')
    if (!/下次执行/.test(upcoming)) errors.push('计划列表：卡片上没有「下次执行」')
    if (!/19:00/.test(upcoming)) errors.push('计划列表：今日工作没有显示 19:00 这个时间')
    if (!/（[^）]*(后|到点)[^）]*）/.test(upcoming))
      errors.push(`计划列表：下次执行没有相对时间：${upcoming.slice(0, 80)}`)

    // 新建：弹窗分「什么时候跑 / 跑什么 / 在哪跑 / 更多设置」四段；默认已按「今日工作」填好
    await p.getByRole('button', { name: '新建计划' }).click()
    const dlg = p.getByRole('dialog')
    await check(p, '新建计划', [
      '填入「今日工作」模板',
      '执行时间',
      '重复',
      '用哪个角色',
      '在哪个项目里执行',
      '到点后执行的对话内容',
    ])
    const name = await dlg.getByLabel('名称').inputValue()
    if (name !== '今日工作') errors.push(`新建计划：名称默认是「${name}」，不是「今日工作」`)
    /** 重复规则是分段单选：当前选中的那一项 */
    const repeatGroup = dlg.getByRole('radiogroup', { name: '重复' })
    const checkedRepeat = async () => (await repeatGroup.getByRole('radio', { checked: true }).innerText()).trim()
    if ((await checkedRepeat()) !== '每天') errors.push(`新建计划：重复默认不是「每天」（${await checkedRepeat()}）`)
    const atValue = await dlg.getByLabel('执行时间').inputValue()
    if (!/^\d{4}-\d{2}-\d{2}T19:00$/.test(atValue)) errors.push(`新建计划：执行时间默认不是 19:00（${atValue}）`)
    // 实时预览：保存后会什么时候、在哪个项目新建对话
    if (!(await dlg.getByText(/保存后：.+新建一个对话/).count()))
      errors.push('新建计划：没有显示「保存后会在哪里新建对话」的预览')
    // 执行时间改到过去：预览要说明保存后会记为错过，不能承诺新建对话（和服务端 pickDue 同一口径）
    const past = new Date(Date.now() - 2 * 86_400_000)
    const pad = (n) => String(n).padStart(2, '0')
    await dlg
      .getByLabel('执行时间')
      .fill(`${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T09:00`)
    await dlg
      .getByText(/这个时间已经过去/)
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('新建计划：执行时间改到过去后，预览没有提示会记为错过'))
    // 改乱之后一键填回模板（同时把上面改过去的执行时间填回 19:00）
    await dlg.getByLabel('名称').fill('随便写')
    await repeatGroup.getByRole('radio', { name: '不重复' }).click()
    await dlg.getByRole('button', { name: '填入「今日工作」模板' }).click()
    if ((await dlg.getByLabel('名称').inputValue()) !== '今日工作') errors.push('填入模板：名称没有填回「今日工作」')
    if ((await checkedRepeat()) !== '每天') errors.push('填入模板：重复没有填回「每天」')

    // 每周：切到「每周」后出现星期多选，默认选上执行时间那天，可以再勾几天（多选）
    await repeatGroup.getByRole('radio', { name: '每周' }).click()
    const weekdays = dlg.getByRole('group', { name: '每周哪几天' })
    await weekdays.waitFor({ timeout: 3000 }).catch(() => errors.push('新建计划：选「每周」后没有出现星期选择'))
    if (await weekdays.count()) {
      const pressed = await weekdays.getByRole('button', { pressed: true }).count()
      if (pressed !== 1) errors.push(`新建计划：每周默认应该选中执行时间那天（实际 ${pressed} 天）`)
      for (const day of ['周一', '周三', '周五']) {
        await weekdays
          .getByRole('button', { name: day, exact: true })
          .click()
          .catch(() => errors.push(`新建计划：星期选择里没有「${day}」`))
      }
    }
    await dlg.getByLabel('名称').fill('下午茶提醒')
    await dlg.getByLabel('到点后执行的对话内容').fill('提醒大家喝水和起来走走')
    await dlg.getByRole('button', { name: '保存' }).click()
    await dlg.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => errors.push('新建计划：保存后弹窗没有关上'))
    await check(p, '新建后', ['下午茶提醒'])
    // 每周计划的徽标：卡片上看得到「每周」，不再显示成「每天」或「单次」
    const weeklyCard = p.locator('li', { hasText: '下午茶提醒' })
    const weeklyText = await weeklyCard.innerText().catch(() => '')
    if (!weeklyText.includes('每周')) errors.push(`新建计划：每周计划的徽标不是「每周」（${weeklyText.slice(0, 80)}）`)
    if (weeklyText.includes('单次')) errors.push('新建计划：每周计划还显示「单次」徽标')

    const row = p.locator('li', { hasText: '下午茶提醒' })
    // 编辑收在「计划操作」菜单里：改完名字列表跟着变
    await row.getByRole('button', { name: '计划操作' }).click()
    await p.getByRole('menuitem', { name: '编辑' }).click()
    await p.getByRole('dialog').getByLabel('名称').fill('下午茶时间')
    await p.getByRole('dialog').getByRole('button', { name: '保存' }).click()
    await p
      .getByRole('dialog')
      .waitFor({ state: 'hidden', timeout: 15000 })
      .catch(() => errors.push('编辑：保存后弹窗没有关上'))
    await check(p, '编辑后', ['下午茶时间'])
    if (await p.getByText('下午茶提醒', { exact: true }).count()) errors.push('编辑后：旧名字还在列表里')

    // 立即执行：演示版不会真的启动对话，但最近一次结果照正式后端的字段更新
    const fresh = p.locator('li', { hasText: '下午茶时间' })
    await fresh.getByRole('button', { name: '立即执行' }).click()
    await check(p, '立即执行提示', ['在线演示里不会真的启动对话'])
    // 限定在这张卡片里：预置的今日工作带着运行记录，本身就显示「已启动」
    await fresh
      .getByText('已启动', { exact: true })
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('立即执行后：最近一次结果没有显示「已启动」'))

    // 停用：开关关掉后卡片移到「已停用」组，下次执行显示「不会再次执行」
    await fresh.getByRole('switch', { name: '停用' }).click()
    await groupHeading('已停用')
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('停用后：没有出现「已停用」分组'))
    if (!(await groupText('已停用')).includes('下午茶时间')) errors.push('停用后：卡片没有归到「已停用」组')
    if (!(await fresh.innerText()).includes('不会再次执行')) errors.push('停用后：没有显示「不会再次执行」')
    if ((await fresh.innerText()).includes('下次执行')) errors.push('停用后：还显示「下次执行」')

    // 删除也收在「计划操作」菜单里：先确认再删，确认前列表里还有
    await fresh.getByRole('button', { name: '计划操作' }).click()
    await p.getByRole('menuitem', { name: '删除' }).click()
    await check(p, '删除确认', ['删除计划「下午茶时间」？', '删除后不会再执行'])
    if (!(await p.getByText('下午茶时间', { exact: true }).count())) errors.push('删除确认：还没确认就把计划删掉了')
    await p.getByRole('dialog').getByRole('button', { name: '删除' }).click()
    await p
      .getByText('下午茶时间', { exact: true })
      .waitFor({ state: 'detached', timeout: 10000 })
      .catch(() => errors.push('删除后：列表里还有这条计划'))
    await check(p, '删除后', ['今日工作'])

    // 造两条出过问题的计划（错过 / 启动失败）和一条已停用的，验证分组和「最近一次结果」
    await p.evaluate((key) => {
      const db = JSON.parse(localStorage.getItem(key))
      const now = Date.now()
      const day = 86_400_000
      const iso = (ms) => new Date(ms).toISOString()
      const at19 = (ms) => {
        const d = new Date(ms)
        d.setHours(19, 0, 0, 0)
        return d.toISOString()
      }
      const base = {
        prompt: '总结今天做的工作',
        projectId: '',
        agentId: '',
        repeat: 'daily',
        enabled: true,
        status: 'pending',
        lastRunAt: '',
        lastTaskId: '',
        missedAt: '',
        lastError: '',
        runs: [],
        createdAt: iso(now),
        updatedAt: iso(now),
      }
      // 预置的今日工作推到 3 天后：让「每日站会」成为更早的那条，验证概览的「下一次执行」
      // 是从所有还会跑的计划里取最早的，而不是只从「即将执行」组取
      const daily = db.schedules.find((s) => s.name === '今日工作')
      if (daily) daily.at = iso(now + 3 * day)
      db.schedules.push(
        // 错过：下次执行还在（一小时后），最近一次结果是昨天那次没跑；带一条旧错误，
        // 验证「上次启动失败：」前缀后仍能展开。
        // runs 里放两条历史：一次启动成功、一次错过，验证「运行记录」能展开看到
        {
          ...base,
          id: 'ui-missed',
          name: '每日站会',
          at: iso(now + 3_600_000),
          missedAt: at19(now - day),
          lastError: '项目「老项目」已经不存在，到点启动会失败，请重新选择',
          runs: [
            {
              at: at19(now - day),
              happenedAt: iso(now - day + 60_000),
              event: 'miss',
              manual: false,
              taskId: '',
              error: '',
            },
            {
              at: at19(now - 2 * day),
              happenedAt: iso(now - 2 * day + 1_000),
              event: 'run',
              manual: false,
              taskId: '',
              error: '',
            },
          ],
        },
        // 启动失败：单次已经跳过，错误原文比一行长，能展开
        {
          ...base,
          id: 'ui-failed',
          name: '周报提醒',
          repeat: 'once',
          status: 'skipped',
          at: iso(now - day),
          lastError: '项目「老项目」已经不存在：它在项目页里被删掉了，这条计划没法启动对话，重新选一个项目再保存。',
        },
        { ...base, id: 'ui-off', name: '旧提醒', enabled: false, at: iso(now - day) },
      )
      localStorage.setItem(key, JSON.stringify(db))
    }, KEY)
    // 演示后端把数据缓存在内存里，只改 localStorage 不重载会被它覆盖回去
    await p.reload()
    await listView()

    await check(p, '出过问题', ['出过问题', '错过', '面板当时没在跑', '启动失败', '项目「老项目」已经不存在'])
    // 概览的「待执行」是会再自动执行的计划数：出过问题但没停用的也算，允许和「出过问题」重叠
    const overviewText = (await p.getByRole('region', { name: '计划概览' }).innerText()).replace(/\s+/g, ' ')
    if (!overviewText.includes('待执行 2')) errors.push(`计划概览：待执行计数不是 2（${overviewText}）`)
    // 「下一次执行」和计数读同一个集合：出过问题但还会跑的「每日站会」一小时后跑，
    // 比推到 3 天后的今日工作早，必须成为下一次；不能只从「即将执行」组取
    if (!overviewText.includes('每日站会'))
      errors.push(`计划概览：下一次执行不是更早到点的「每日站会」（${overviewText}）`)
    if (overviewText.includes('没有待执行的计划')) errors.push('计划概览：还有会跑的计划时仍写「没有待执行的计划」')
    if ((await groupCount('出过问题')) !== 2)
      errors.push(`出过问题：分组数量不是 2（实际 ${await groupCount('出过问题')}）`)
    if ((await groupCount('已停用')) !== 1) errors.push('已停用：分组数量不是 1（旧提醒应该在停用组）')
    if (!(await groupText('已停用')).includes('旧提醒')) errors.push('已停用：旧提醒没有归到停用组')
    const missed = p.locator('li', { hasText: '每日站会' })
    if (!(await missed.innerText()).includes('下次执行')) errors.push('错过的计划：每天的计划还应该显示下次执行')
    // 错过 + 旧错误：渲染文本带「上次启动失败：」前缀，超过 30 字时必须有「展开全文」
    await missed
      .getByRole('button', { name: '展开全文', exact: true })
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('错过 + 旧错误：前缀加进去后被截断却没有「展开全文」'))
    // 运行记录：默认收起，展开后能看到每次的结果（成功 / 错过各一条）
    await missed.getByRole('button', { name: /运行记录/ }).click()
    const history = missed.locator('ul')
    await history
      .getByText('启动成功', { exact: true })
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('运行记录：展开后没有「启动成功」这条历史'))
    await history
      .getByText('错过', { exact: true })
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('运行记录：展开后没有「错过」这条历史'))
    // 错过没有存下来的原因：界面要补一句「面板当时没在跑，不补跑」，否则只剩一个时间
    await history
      .getByText('面板当时没在跑，不补跑')
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('运行记录：错过的那条没有说明为什么没跑'))
    // 「收起」这类词页面上别处也有（name 默认是子串匹配），限定到这张卡片里并精确匹配
    const failedCard = p.locator('li', { hasText: '周报提醒' })
    await failedCard
      .getByRole('button', { name: '展开全文', exact: true })
      .click({ timeout: 5000 })
      .catch(() => errors.push('启动失败：长错误没有「展开全文」'))
    await failedCard
      .getByRole('button', { name: '收起', exact: true })
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('启动失败：展开后没有「收起」'))

    // 演示版的「立即执行」和正式后端同一个口径：不改排期，只记下这次启动并清掉上次错误
    await failedCard.getByRole('button', { name: '立即执行' }).click()
    await failedCard
      .getByText('已启动', { exact: true })
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('立即执行后：单次计划没有变成「已启动」'))
    if (!(await failedCard.innerText()).includes('不会再次执行'))
      errors.push('立即执行后：单次计划没有归到「不会再执行」')
    if ((await groupCount('出过问题')) !== 1) errors.push('立即执行后：失败的卡片没有离开「出过问题」组')

    // 窄窗口：卡片和操作按钮都放得下，不出现横向滚动（check 里会断言）
    for (const width of [375, 1024]) {
      await p.setViewportSize({ width, height: 820 })
      await p.reload()
      await listView()
      await check(p, `计划-${width} 宽度`, ['出过问题', '错过', '新建计划'])
    }

    // 空状态：清掉计划后给出「到点 → 新建对话 → 在项目里执行」三步和两个入口
    await p.setViewportSize({ width: 1440, height: 900 })
    await p.evaluate((key) => {
      const db = JSON.parse(localStorage.getItem(key))
      db.schedules = []
      localStorage.setItem(key, JSON.stringify(db))
    }, KEY)
    await p.reload()
    await check(p, '计划空状态', ['还没有计划', '到点', '新建对话', '在项目里执行', '新建今日工作', '新建空白计划'])
    // 空白计划：名称不预填模板，用户自己写
    await p.getByRole('button', { name: '新建空白计划' }).click()
    const blankDlg = p.getByRole('dialog')
    const blankName = await blankDlg.getByLabel('名称').inputValue()
    if (blankName !== '') errors.push(`新建空白计划：名称不是空的（${blankName}）`)
    await blankDlg.getByRole('button', { name: '取消' }).click()
  }

  // ---- 工作总结 ----
  // 左边是按日期归档的报告树，右边是提炼面板：来源（报告 / 对话）→ 按天 / 按周 → 项目 → 提炼 → 逐项采纳 → 确认生成
  {
    const p = await page({ width: 1440, height: 900 })
    await p.goto(base + '#/summary')

    await p
      .getByRole('button', { name: '工作总结' })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('工作总结：左侧导航里没有入口'))
    await check(p, '工作总结-提炼面板', ['工作总结', '提炼工作总结', '来源', '日期', '项目'])

    // 报告树：演示版预置了几份报告，按日期分组（同一天两份在一个组里），周报在「第 n 周」组里
    const tree = p.getByRole('region', { name: '工作总结列表' })
    await tree
      .getByRole('group')
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('工作总结：左侧没有按日期分组的报告树'))
    if (!(await tree.getByRole('group', { name: /^昨天 · / }).count()))
      errors.push('工作总结：报告树里没有「昨天」这一组')
    else if (
      (await tree
        .getByRole('group', { name: /^昨天 · / })
        .getByRole('button')
        .count()) < 3
    )
      errors.push('工作总结：同一天的两份报告没有挂在同一个日期下')
    if (!(await tree.getByRole('group', { name: /^第 \d+ 周/ }).count()))
      errors.push('工作总结：报告树里没有按周的分组')
    await check(p, '工作总结-报告树')

    // 来源在最上面，默认是「对话」；粒度和 Token 用量一样有按天 / 按周和月历
    const source = p.getByRole('radiogroup', { name: '报告来源' })
    if ((await source.getByRole('radio', { name: '对话' }).getAttribute('aria-checked')) !== 'true')
      errors.push('工作总结：默认来源不是「对话」')
    const grain = p.getByRole('radiogroup', { name: '报告粒度' })
    await grain.getByRole('radio', { name: '按周' }).click()
    await p
      .getByRole('button', { name: /选择时间范围（第 \d+ 周/ })
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：切到按周后时间按钮没有显示「第 n 周」'))
    await grain.getByRole('radio', { name: '按天' }).click()

    // 加项目：弹层里点一个就加进来，加过的项目留在面板上（不用再挑对话）
    const add = p.getByRole('button', { name: '添加项目' })
    for (let i = 0; i < 2; i++) {
      await add.click()
      await p.locator('[data-radix-popper-content-wrapper] button').first().click()
    }
    if ((await p.locator('[data-summary-project]').count()) !== 2) errors.push('工作总结：添加两个项目后面板上不是两个')
    await check(p, '工作总结-添加项目')
    // 切走再回来：加过的项目还在
    await p.getByRole('button', { name: '计划', exact: true }).first().click()
    await p.getByRole('button', { name: '工作总结', exact: true }).first().click()
    await p
      .locator('[data-summary-project]')
      .nth(1)
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('工作总结：切页面回来后加过的项目没了'))

    // 提炼：出来的是一条条分项，需求和 Bug 分组，每条有「采纳」
    await p.getByRole('button', { name: '开始提炼' }).click()
    const adopt = p.getByRole('button', { name: /^采纳「/ })
    await adopt
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => errors.push('工作总结：提炼完没有出现可以采纳的分项'))
    for (const g of ['需求', 'Bug'])
      if (!(await p.getByRole('region', { name: g, exact: true }).count()))
        errors.push(`工作总结：分项里没有「${g}」这一组`)
    const confirm = p.getByRole('button', { name: '确认生成报告' })
    if (!(await confirm.isDisabled())) errors.push('工作总结：一条都没采纳时「确认生成报告」可以点')
    await check(p, '工作总结-分项')

    // 采纳一条需求、一条 Bug，确认后报告里只有这两条
    const needTitle = await p
      .getByRole('region', { name: '需求', exact: true })
      .locator('[data-summary-entry] p')
      .first()
      .textContent()
    const skipped = await p
      .getByRole('region', { name: '需求', exact: true })
      .locator('[data-summary-entry] p')
      .nth(2)
      .textContent()
      .catch(() => '')
    await p
      .getByRole('region', { name: '需求', exact: true })
      .getByRole('button', { name: /^采纳「/ })
      .first()
      .click()
    await p
      .getByRole('region', { name: 'Bug', exact: true })
      .getByRole('button', { name: /^采纳「/ })
      .first()
      .click()
    await p
      .getByText('已采纳 2 项', { exact: false })
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：采纳两条后确认栏没有显示「已采纳 2 项」'))
    await check(p, '工作总结-采纳')
    await confirm.click()
    const view = p.getByRole('main', { name: '报告' })
    await view.waitFor({ timeout: 8000 }).catch(() => errors.push('工作总结：确认后没有打开生成的报告'))
    for (const heading of ['一、需求', '二、Bug'])
      if (!(await view.getByText(heading, { exact: false }).count())) errors.push(`工作总结：报告里没有「${heading}」`)
    if (needTitle && !(await view.getByText(needTitle, { exact: false }).count()))
      errors.push('工作总结：采纳的需求没有写进报告')
    if (skipped && skipped !== needTitle && (await view.getByText(skipped, { exact: true }).count()))
      errors.push('工作总结：没采纳的分项也写进了报告')
    if (!(await tree.getByRole('group', { name: /^今天 · / }).count()))
      errors.push('工作总结：新报告没有出现在「今天」这一组')
    await check(p, '工作总结-报告')

    // 编辑：Markdown 正文，原因 / 修复写在 Bug 条目下
    await view.getByRole('radio', { name: '编辑' }).click()
    const text = await view
      .getByLabel('报告正文')
      .inputValue()
      .catch(() => '')
    if (!/^# \d{4}-\d{2}-\d{2} 工作总结/.test(text))
      errors.push(`工作总结：报告第一行不是日期标题（${text.slice(0, 30)}）`)
    if (!/原因：[\s\S]*修复：/.test(text)) errors.push('工作总结：Bug 条目没有写原因和修复')
    await view.getByRole('radio', { name: '预览' }).click()

    // 复制：写到剪贴板，并弹出成功提示
    await view.getByRole('button', { name: '复制' }).click()
    await p
      .getByText('已复制报告')
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：复制后没有成功提示'))

    // 报告来源 + 按周：列出这一周可以汇总的报告
    await p.getByRole('button', { name: '新建' }).first().click()
    await source.getByRole('radio', { name: '报告' }).click()
    await grain.getByRole('radio', { name: '按周' }).click()
    await p
      .getByRole('list', { name: '要汇总的报告' })
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：报告来源按周时没有列出这一周的报告'))
    await check(p, '工作总结-报告来源')

    // 删除：确认后从树里消失，回到提炼面板
    const before = await tree
      .getByRole('button')
      .filter({ hasText: /需求 \d+ · Bug \d+/ })
      .count()
    await tree
      .getByRole('group', { name: /^今天 · / })
      .getByRole('button')
      .nth(1)
      .click()
    await p.getByRole('button', { name: '删除这份报告' }).click()
    await p.getByRole('dialog').getByRole('button', { name: '删除' }).click()
    await p
      .getByRole('heading', { name: '提炼工作总结' })
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('工作总结：删除后没有回到提炼面板'))
    const after = await tree
      .getByRole('button')
      .filter({ hasText: /需求 \d+ · Bug \d+/ })
      .count()
    if (after !== before - 1) errors.push(`工作总结：删除后报告数没少一份（${before} → ${after}）`)

    // 手机宽度：树、设置和分项都要能正常换行
    await p.setViewportSize({ width: 480, height: 900 })
    await settle(p).catch(() => {})
    await check(p, '工作总结-手机宽度')
  }
})
