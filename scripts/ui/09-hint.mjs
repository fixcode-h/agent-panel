/**
 * 界面检查分片：统一的悬停提示（web/src/components/ui/hint.tsx）
 *
 * 这里要拦住的是「换成浮层后丢掉的、原生 title 本来有的行为」：
 * 悬停能出来、鼠标移开就自己消失、不吃鼠标点击（原生 title 从不挡）、
 * disabled 元素也有提示、同屏只有一个、窄屏不出视口、关掉后 title 还原。
 *
 * 悬停提示刻意不放关闭按钮（鼠标一移开就消失，按钮只会占住内容还要处理焦点回收）；
 * 要手动关掉的是错误提示，见 index.css 里按 data-type 只给 error 留关闭按钮的规则。
 */
import { runShard } from './harness.mjs'

/**
 * 和 web/src/components/ui/hint.tsx 里的 SKIP_TAGS 一致：
 * 这些原生元素的 title 是浏览器自己的语义，实现不接管，用例也不该拿它们当目标。
 */
const SKIP_TITLE_TAGS = new Set(['IFRAME', 'OPTION', 'OPTGROUP', 'TITLE', 'STYLE', 'SCRIPT'])

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
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
        errors.push(`提示-disabled：disabled 的元素上没有出现提示（pointer-events=${pe}，这正是按坐标取元素会踩的坑）`)
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
          if (tb.x < 0 || tb.x + tb.width > 1441) errors.push(`提示-长文字：浮层跑出视口（x=${tb.x}, 宽=${tb.width}）`)
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
})
