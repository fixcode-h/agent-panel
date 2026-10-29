/**
 * 界面检查分片：ComfyUI 模板商店与工作流链、统一的悬停提示、计划面板、工作总结。
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
    await repeatGroup.getByRole('radio', { name: '单次' }).click()
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
    await p
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
  {
    const p = await page({ width: 1440, height: 900 })
    await p.goto(base + '#/summary')

    // 左侧导航里的入口：点进去就在这个页面
    await p
      .getByRole('button', { name: '工作总结' })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('工作总结：左侧导航里没有入口'))
    await check(p, '工作总结-列表', ['工作总结', '项目', '生成报告'])

    // 左对齐：页头、选择区和报告共用同一条左边缘，整页内容靠左而不是居中。
    // 坐标是相对主区算的（左边还有侧栏），不能拿视口绝对坐标判断
    const mainBox = await p.locator('main').first().boundingBox()
    const h1Box = await p.getByRole('heading', { name: '工作总结', level: 1 }).first().boundingBox()
    const firstSection = await p.locator('main section').first().boundingBox()
    if (!mainBox || !h1Box || !firstSection) errors.push('工作总结：取不到主区、页头或内容的位置')
    else {
      if (Math.abs(h1Box.x - firstSection.x) > 2)
        errors.push(`工作总结：页头与内容没有左对齐（${h1Box.x} vs ${firstSection.x}）`)
      // 靠左时内容左边距只该是容器内边距（md 下 32px）；居中时会被推到主区中间
      const inset = firstSection.x - mainBox.x
      if (inset > 80) errors.push(`工作总结：整页内容没有靠左（相对主区左边距 ${inset}）`)
    }
    await check(p, '工作总结-左对齐')

    // 时间范围：默认今天（和改造前一致），可以切昨天 / 近 7 天 / 自定义日期
    const range = p.getByRole('radiogroup', { name: '总结范围' })
    await range.waitFor({ timeout: 5000 }).catch(() => errors.push('工作总结：没有时间范围选择'))
    if (await range.count()) {
      const checked = async (name) => (await range.getByRole('radio', { name }).getAttribute('aria-checked')) === 'true'
      if (!(await checked('今天'))) errors.push('工作总结：默认范围不是「今天」')
      await range.getByRole('radio', { name: '近 7 天' }).click()
      await p
        .getByText('不挑就是近 7 天全部', { exact: false })
        .first()
        .waitFor({ timeout: 3000 })
        .catch(() => errors.push('工作总结：切到「近 7 天」后说明文字没跟着变'))
      // 自定义范围要能选起止日期
      await range.getByRole('radio', { name: '自定义' }).click()
      await p
        .getByLabel('开始日期')
        .waitFor({ timeout: 3000 })
        .catch(() => errors.push('工作总结：选「自定义」后没有开始日期'))
      await p
        .getByLabel('结束日期')
        .waitFor({ timeout: 3000 })
        .catch(() => errors.push('工作总结：选「自定义」后没有结束日期'))
      await range.getByRole('radio', { name: '今天' }).click()
      await p
        .getByText('不挑就是今天全部', { exact: false })
        .first()
        .waitFor({ timeout: 3000 })
        .catch(() => errors.push('工作总结：切回「今天」后说明文字没恢复'))
    }
    await check(p, '工作总结-范围切换')

    // 项目选择器：下拉选一个再点「增加」，下拉本身不会直接算选中
    const picker = p.getByLabel('选择要总结的项目')
    await picker.waitFor({ timeout: 5000 }).catch(() => errors.push('工作总结：没有项目下拉'))
    await p
      .getByText('还没有加入项目。选一个项目后点「增加」。')
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：打开时没有空状态提示'))

    // 项目头部的「增加」按钮（第一个）：点一次加一个项目
    const addProject = p.getByRole('button', { name: '增加', exact: true }).first()
    await addProject.click()
    await p
      .getByText('已选 1 个')
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：点「增加」后没有加入一个项目'))
    const removeProjects = p.getByRole('button', { name: /^删除项目/ })
    if ((await removeProjects.count()) !== 1) errors.push('工作总结：加入项目后没有对应的删除按钮')
    await check(p, '工作总结-加入项目', ['已选 1 个'])

    // 再加一个项目：多个项目能同时存在
    await addProject.click()
    await p
      .getByText('已选 2 个')
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：加入第二个项目后已选数量没有变成 2'))

    // 切到别的页面再回来：已选的项目（顺序和名字）原样还在（页面状态存在本机，见 web/src/lib/summary-page.ts）
    const pickNames = async () =>
      p.getByRole('button', { name: /^删除项目/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    const beforeSwitch = await pickNames()
    await p.getByRole('button', { name: '计划', exact: true }).first().click()
    await p.getByRole('button', { name: '工作总结', exact: true }).first().click()
    await p
      .getByText('已选 2 个')
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('工作总结：切到别的页面再回来，已选的项目没了'))
    const afterSwitch = await pickNames()
    if (afterSwitch.join('|') !== beforeSwitch.join('|'))
      errors.push(`工作总结：切页面回来后项目变了（${beforeSwitch.join('、')} → ${afterSwitch.join('、')}）`)
    await check(p, '工作总结-切页面回来')

    // 刷新（F5）后选择也还在：存到本机才成立
    await p.reload()
    await p
      .getByRole('button', { name: /^删除项目/ })
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('工作总结：刷新后已选的项目没了'))
    if ((await pickNames()).join('|') !== beforeSwitch.join('|'))
      errors.push('工作总结：刷新后选择的项目和刷新前不一样')
    await check(p, '工作总结-刷新后恢复')

    // 每个项目下挑对话：下拉 + 增加，加进去的能在这一项里删掉。
    // 先在两个项目里找一个今天有对话的（演示数据里商城前台今天跑过）
    const taskPicker = p.getByLabel('选择要分析的对话').first()
    await taskPicker
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('工作总结：已加入的项目下没有对话下拉（今天应当有可总结的对话）'))
    if (await taskPicker.count()) {
      // 这个是 Radix 下拉，不是原生 select：点开后在浮层里点选项，没有 <option> 可取
      await taskPicker.click()
      const option = p.getByRole('option').first()
      await option.waitFor({ timeout: 3000 }).catch(() => errors.push('工作总结：对话下拉点开后没有可选的对话'))
      if (await option.count()) {
        await option.click()
        // 对话的「增加」在项目行里，和项目头部的那个不是同一个
        await p.locator('li', { has: taskPicker }).getByRole('button', { name: '增加', exact: true }).first().click()
        const removeTasks = p.getByRole('button', { name: /^删除对话/ })
        await removeTasks
          .first()
          .waitFor({ timeout: 3000 })
          .catch(() => errors.push('工作总结：点对话的「增加」后没有出现在该项目下'))
        await check(p, '工作总结-加入对话', ['只分析已选的 1 个对话'])
        await removeTasks.first().click()
        await removeTasks
          .first()
          .waitFor({ state: 'detached', timeout: 3000 })
          .catch(() => errors.push('工作总结：删掉对话后它还留在该项目下'))
      }
    }

    // 删掉第二个项目：删除只影响这一项，剩下的那个继续留着
    await removeProjects.nth(1).click()
    await p
      .getByText('已选 1 个')
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：删掉第二个项目后已选数量没有回到 1'))

    // 生成：演示后端过一会儿给出示例报告
    await p.getByRole('button', { name: '生成报告' }).first().click()
    await p
      .getByRole('button', { name: '复制' })
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => errors.push('工作总结：生成后没有出现报告（看不到复制按钮）'))
    await check(p, '工作总结-报告', ['今天的报告', '最近的报告'])
    // 报告固定四节：节名按 Markdown 标题渲染出来
    const preview = p.locator('section', { hasText: '今天的报告' }).first()
    for (const heading of ['一、概览', '二、需求进度', '三、问题与修复', '四、下一步']) {
      if (!(await preview.getByText(heading, { exact: false }).count()))
        errors.push(`工作总结：报告里没有固定的二级节「${heading}」`)
    }
    // 报告头部显示这份报告的元数据：项目、对话数、字数、耗时。
    // 限定在报告卡片里找：整页找的话「最近的报告」列表行也有这些字样，元数据没渲染时也会通过
    for (const text of ['个对话', '字', '耗时'])
      await preview
        .getByText(text, { exact: false })
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push(`工作总结-报告元数据：报告头没有显示「${text}」`))
    await check(p, '工作总结-报告元数据')

    // 编辑：切到编辑是 textarea，内容是 Markdown，第一行是一级标题
    await p.getByRole('radio', { name: '编辑' }).click()
    const area = p.getByLabel('报告内容')
    await area.waitFor({ timeout: 3000 }).catch(() => errors.push('工作总结：切到编辑后没有出现文本框'))
    const text = await area.inputValue().catch(() => '')
    if (!text.startsWith('# ')) errors.push(`工作总结：编辑框里不是 Markdown 报告（${text.slice(0, 30)}）`)
    for (const heading of ['## 一、概览', '## 二、需求进度', '## 三、问题与修复', '## 四、下一步']) {
      if (!text.includes(heading)) errors.push(`工作总结：生成的报告缺少「${heading}」`)
    }
    await check(p, '工作总结-编辑')

    // 改几个字但不点保存：报告头的字数要跟着编辑框里的正文变，不能等保存后才更新
    // （同一屏的「最近的报告」也显示字数，两处必须对得上）
    const charsOf = async () => {
      const raw = await preview
        .getByText(/^\d+ 字$/)
        .first()
        .textContent()
        .catch(() => '')
      return Number((raw ?? '').replace(/\D/g, '')) || 0
    }
    const beforeChars = await charsOf()
    await area.fill(text + '\n\n（还没保存的草稿）')
    await p
      .waitForFunction(
        (prev) => {
          const card = [...document.querySelectorAll('section')].find((s) => s.textContent?.includes('今天的报告'))
          const m = card?.textContent?.match(/(\d+)\s*字/)
          return !!m && Number(m[1]) > prev
        },
        beforeChars,
        { timeout: 3000 },
      )
      .catch(() => errors.push('工作总结：编辑正文后报告头的字数没有跟着变'))
    // 切到别的页面再回来，编辑 tab 和还没保存的改动都要还在
    await p.getByRole('button', { name: '计划', exact: true }).first().click()
    await p.getByRole('button', { name: '工作总结', exact: true }).first().click()
    const areaBack = p.getByLabel('报告内容')
    await areaBack.waitFor({ timeout: 5000 }).catch(() => errors.push('工作总结：切页面回来后没有回到编辑 tab'))
    const draftBack = await areaBack.inputValue().catch(() => '')
    if (!draftBack.includes('（还没保存的草稿）')) errors.push('工作总结：切页面回来后编辑器里还没保存的改动丢了')
    await check(p, '工作总结-草稿跨页面保留')

    // 复制：写到剪贴板，并弹出成功提示
    await p.getByRole('radio', { name: '预览' }).click()
    await p.getByRole('button', { name: '复制' }).first().click()
    await p
      .getByText('已复制报告')
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：复制后没有成功提示'))
    const copied = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '')
    if (!copied.includes('## 四、下一步')) errors.push(`工作总结：剪贴板里不是报告正文（${copied.slice(0, 40)}）`)
    await check(p, '工作总结-复制')
    // 对比两份：再生成一份（演示后端的第二份报告和第一份不同），勾选两份看新增 / 消失 / 状态变化
    await p.getByRole('button', { name: '生成报告' }).first().click()
    await p
      .getByRole('button', { name: '对比两份' })
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => errors.push('工作总结：没有「对比两份」入口'))
    // 等第二份报告进列表（列表按时间倒序，新的在最前）
    await p
      .locator('section', { hasText: '最近的报告' })
      .locator('li')
      .nth(1)
      .waitFor({ timeout: 20000 })
      .catch(() => errors.push('工作总结：没有生成出第二份报告，没法对比'))
    await p.getByRole('button', { name: '对比两份' }).first().click()
    const boxes = p.getByLabel('对比这份报告')
    await boxes
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('工作总结：对比模式里没有勾选框'))
    if ((await boxes.count()) < 2) errors.push('工作总结：「最近的报告」里没有两份可以对比')
    else {
      await boxes.nth(0).check()
      await boxes.nth(1).check()
      const cmp = p.locator('section', { hasText: '两份报告的对比' }).first()
      await cmp.waitFor({ timeout: 5000 }).catch(() => errors.push('工作总结：勾选两份后没有出现对比区'))
      for (const heading of ['需求进度', '问题与修复', '下一步']) {
        if (!(await cmp.getByText(heading, { exact: true }).count()))
          errors.push(`工作总结：对比区里没有「${heading}」`)
      }
      // 标题实际写成「新增（1）」「已修复（消失）（1）」：按整行精确匹配，
      // 否则「已修复（消失）」会把「消失」也命中，看不出需求进度有没有真的消失项
      for (const [kind, re] of [
        ['新增', /^新增（\d+）$/],
        ['消失', /^消失（\d+）$/],
        ['状态变化', /^状态变化（\d+）$/],
        ['已修复（消失）', /^已修复（消失）（\d+）$/],
      ]) {
        if (!(await cmp.getByText(re).count())) errors.push(`工作总结：对比区里没有「${kind}」`)
      }
      await check(p, '工作总结-对比两份')
      // 取消对比：对比区收起，列表回到普通模式
      await p.getByRole('button', { name: '取消对比' }).click()
      await p
        .getByText('两份报告的对比')
        .first()
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => errors.push('工作总结：取消对比后对比区还在'))
      // 再选一次，然后直接换范围：对比要跟着收起（不能还挂着上一段的两份报告，也不能留在对比模式）
      await p.getByRole('button', { name: '对比两份' }).click()
      await boxes.nth(0).check()
      await boxes.nth(1).check()
      await cmp.waitFor({ timeout: 5000 }).catch(() => errors.push('工作总结：重新勾选两份后没有出现对比区'))
      await range.getByRole('radio', { name: '近 7 天' }).click()
      await p
        .getByText('两份报告的对比')
        .first()
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => errors.push('工作总结：换范围后对比区还在'))
      if (await p.getByRole('button', { name: '取消对比' }).count()) errors.push('工作总结：换范围后还留在对比模式')
      await range.getByRole('radio', { name: '今天' }).click()
    }

    // 换范围不能把上一段的报告当成这一段的：切到近 7 天后当前报告消失，旧报告还在「最近的报告」里
    await range.getByRole('radio', { name: '近 7 天' }).click()
    await p
      .locator('section', { hasText: '今天的报告' })
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => errors.push('工作总结：切到近 7 天后仍然显示「今天的报告」'))
    await p
      .getByText('最近的报告')
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：切范围后「最近的报告」列表没了'))
    await range.getByRole('radio', { name: '今天' }).click()
    await check(p, '工作总结-换范围不串报告')

    // 项目在别的地方被删掉：回到这一页时它从选择里消失并提示一次，不静默也不拿着错数据去生成。
    // 演示版的数据库在 localStorage 里（改完要整页导航，只改 hash 会被内存里的数据盖回去）
    await p.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('agent-panel-demo-v3') || 'null')
      const state = JSON.parse(localStorage.getItem('summary-page:v1') || 'null')
      const picked = state?.picks?.[0]?.projectId
      if (!db || !picked) return
      db.projects = db.projects.filter((x) => x.id !== picked)
      localStorage.setItem('agent-panel-demo-v3', JSON.stringify(db))
    })
    await p.reload()
    await p
      .getByText('1 个项目已不存在，已从选择里移除')
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('工作总结：恢复时没有提示已不存在的项目被移除'))
    if (await p.getByRole('button', { name: /^删除项目/ }).count())
      errors.push('工作总结：已经不存在的项目还留在选择里')
    await p
      .getByText('已选 0 个')
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => errors.push('工作总结：移除已不存在的项目后已选数量没变'))
    await check(p, '工作总结-已删项目被过滤')

    // 手机宽度：项目列表和报告都要能正常换行
    await p.setViewportSize({ width: 480, height: 900 })
    await settle(p).catch(() => {})
    await check(p, '工作总结-手机宽度')
  }
})
