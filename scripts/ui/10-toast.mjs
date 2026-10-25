/**
 * 界面检查分片：提示（toast）统一走 web/src/lib/toast.ts 之后的行为
 *
 * 拦住的是这次改造的几件事，都是别的用例不会碰到的：
 * - 位置在右上角（原来在右下角，会压住最小化浮条）
 * - 最新的在最上面，依次往下
 * - 同屏最多 TOAST_VISIBLE_LIMIT 条，其余排队、前面的消失后补位
 *   （不是 sonner 的 visibleToasts，那个只把超出的藏起来、不补位）
 * - 关闭按钮只在鼠标悬停 / 键盘聚焦时出现，触屏常显
 * 进出动画靠 sonner 自己的位移过渡，这里确认过渡时长压在卸载前留的 200ms 之内（退出动画能播完）。
 *
 * 触发方式：环境弹窗里独立分支那一行的右键菜单「复制分支名」，点一次弹一条「已复制」。
 * 提示本身 4 秒就到期，而 check() 要截图、比断言慢，所以每个用例开头用 ensure() 先把屏幕上的条数补齐。
 * 点提示里的关闭按钮算「弹窗外的点击」，Radix 的 Dialog 会顺手把环境弹窗也关掉——所以提示都在关掉弹窗之前弹好。
 * 只用真实点击，不往页面里塞测试钩子——演示版的分片本来就该走用户能走的路。
 */
import { runShard } from './harness.mjs'

/** 和 web/src/lib/toast-queue.ts 的 TOAST_VISIBLE_LIMIT 一致 */
const VISIBLE_LIMIT = 4
/** sonner 卸载提示前留的 200ms：过渡比它长，退出动画就会被掐断 */
const UNMOUNT_MS = 200

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await p.getByText('购物车右上角', { exact: false }).first().click()
  await settle(p)

  const toasts = p.locator('[data-sonner-toaster] [data-sonner-toast]')
  /** 一条提示的 ✕ 是不是真的看得见：用 opacity 判，不用 isVisible()（后者对 opacity: 0 仍返回 true） */
  const closeShown = (locator) =>
    locator
      .evaluate((btn) => getComputedStyle(btn).opacity !== '0' && getComputedStyle(btn).pointerEvents !== 'none')
      .catch(() => false)
  /** 屏幕上挂了几条、其中几条真的看得见（sonner 藏起来的算没显示） */
  const rawStat = () =>
    p.evaluate(() => {
      const all = [...document.querySelectorAll('[data-sonner-toast]')]
      return {
        mounted: all.length,
        visible: all.filter((el) => {
          const s = getComputedStyle(el)
          return el.getAttribute('data-visible') !== 'false' && s.opacity !== '0' && s.visibility !== 'hidden'
        }).length,
      }
    })
  /**
   * 等屏幕上正好 n 条、并且每条都真的可见。
   * 不能读一帧就断言：刚递进去的那条在 mounted 之前 opacity 是 0，会被当成「被 sonner 藏了」。
   */
  const waitStat = (n) =>
    p
      .waitForFunction(
        (want) => {
          const all = [...document.querySelectorAll('[data-sonner-toast]')]
          if (all.length !== want) return false
          return all.every((el) => {
            const s = getComputedStyle(el)
            return el.getAttribute('data-visible') !== 'false' && s.opacity !== '0' && s.visibility !== 'hidden'
          })
        },
        n,
        { timeout: 4000 },
      )
      .then(
        () => true,
        () => false,
      )

  await p.locator('button[aria-label="环境"]').first().click()
  const envTitle = p.getByText('独立分支', { exact: true }).first()
  const envShown = await envTitle.waitFor({ timeout: 5000 }).then(
    () => true,
    () => false,
  )
  if (!envShown) {
    errors.push('提示：环境弹窗没有打开，这条用例没法触发提示')
    return
  }

  const row = p.locator('[data-worktree-group="live"] [data-worktree-row]').first()
  /** 弹一条提示：右键那行 → 复制分支名，等它真的进了 toaster */
  const popOne = async () => {
    const before = (await rawStat()).mounted
    // 环境弹窗可能在上一步被关掉了（点 ✕ 算弹窗外的点击、或按 Enter 关提示时一并关了），先确保它是开的
    if (!(await row.count())) {
      await p
        .locator('button[aria-label="环境"]')
        .first()
        .click()
        .catch(() => {})
      await envTitle.waitFor({ timeout: 5000 }).catch(() => {})
    }
    await row.click({ button: 'right' })
    const item = p.getByRole('menuitem', { name: '复制分支名', exact: true }).first()
    await item.waitFor({ timeout: 5000 })
    await item.click()
    // 满了（VISIBLE_LIMIT 条在屏上）时新的一条会排队，DOM 条数不会增加
    await p
      .waitForFunction((n) => document.querySelectorAll('[data-sonner-toast]').length > n, before, { timeout: 2000 })
      .catch(() => {})
  }
  /** 保证屏幕上有 n 条：不够就补，多了不管（多了说明排队没生效，由排队用例去拦） */
  const ensure = async (n) => {
    for (let i = 0; i < VISIBLE_LIMIT; i += 1) {
      if ((await rawStat()).visible >= n) return
      await popOne()
    }
  }

  await ensure(VISIBLE_LIMIT)

  /* 排队与同屏上限：只数元素个数发现不了「被 sonner 的 visibleToasts 藏起来」，
     所以要同时看「挂上去几条」和「真的看得见几条」 */
  {
    const ok = await waitStat(VISIBLE_LIMIT)
    const s = await rawStat()
    if (!ok) {
      if (s.mounted !== VISIBLE_LIMIT)
        errors.push(`提示-排队：屏幕上挂了 ${s.mounted} 条，应当是 ${VISIBLE_LIMIT} 条（多的应当排队）`)
      else if (s.visible !== VISIBLE_LIMIT)
        errors.push(
          `提示-排队：挂了 ${s.mounted} 条里只有 ${s.visible} 条真的可见，应当是 ${VISIBLE_LIMIT} 条（被 sonner 的 visibleToasts 藏了？）`,
        )
      else errors.push(`提示-排队：等了 4 秒也没等到 ${VISIBLE_LIMIT} 条全部播完进场`)
    }
    await check(p, '提示-排队与同屏上限')
  }

  /* 位置：右上角 */
  await ensure(1)
  {
    const box = await toasts.first().boundingBox()
    const viewport = p.viewportSize()
    if (!box || !viewport) errors.push('提示：量不到提示的位置')
    else {
      // 离右边 32px 以内、离上边 60px 以内算右上角
      const fromRight = viewport.width - (box.x + box.width)
      const fromTop = box.y
      if (fromRight > 32) errors.push(`提示：没在右边（离右边缘 ${Math.round(fromRight)}px）`)
      if (fromTop > 60) errors.push(`提示：没在上边（离上边缘 ${Math.round(fromTop)}px，原来在右下角）`)
      await check(p, '提示-位置在右上角')
    }
  }

  /* 最新的在最上面：data-index 越大 y 越大（index 0 是最新的一条） */
  await ensure(VISIBLE_LIMIT)
  {
    const tops = await p.evaluate(() =>
      [...document.querySelectorAll('[data-sonner-toast]')].map((el) => ({
        y: Math.round(el.getBoundingClientRect().y),
        index: Number(el.getAttribute('data-index')),
      })),
    )
    const byIndex = [...tops].sort((a, b) => a.index - b.index)
    const ys = byIndex.map((t) => t.y)
    if (ys.length < 2) errors.push(`提示-顺序：屏幕上只有 ${ys.length} 条，量不出先后顺序`)
    else if (!ys.every((y, i) => i === 0 || y > ys[i - 1]))
      errors.push(`提示-顺序：没有按「最新的在最上面」依次往下排（各条 y = ${ys.join(', ')}）`)
    if (byIndex[0] && byIndex[0].index !== 0) errors.push('提示-顺序：找不到最上面那条（data-index=0）')
    await check(p, '提示-最新的在最上面')
  }

  /* 关闭按钮：不悬停时隐藏，悬停在这条提示上才出现，移开又收起来 */
  await ensure(1)
  {
    const first = toasts.first()
    const close = first.locator('[data-close-button]')
    await p.mouse.move(700, 500)
    await p.waitForTimeout(200)
    if (await closeShown(close)) errors.push('提示：没悬停时关闭按钮就显示出来了')

    await first.hover()
    await p.waitForTimeout(150)
    if (!(await closeShown(close))) errors.push('提示：鼠标悬停在提示上，关闭按钮没出现')
    await check(p, '提示-悬停显示关闭按钮')

    await p.mouse.move(700, 500)
    await p.waitForTimeout(250)
    if (await closeShown(close)) errors.push('提示：鼠标移开后关闭按钮没有收起来')

    /* 点一下提示正文再把鼠标移开：sonner 给每条提示的 li 带了 tabIndex=0，鼠标点正文会把它聚焦上。
       样式用 :focus-within 时 ✕ 会一直挂着（用户要的是「移开就收起」），所以这里盯一下这条路径 */
    {
      const box = await first.boundingBox()
      if (!box) errors.push('提示：量不到提示的位置')
      else {
        await first.hover()
        await p.mouse.click(box.x + 60, box.y + box.height / 2)
        await p.mouse.move(700, 500)
        await p.waitForTimeout(250)
        if (await closeShown(close)) errors.push('提示：点过提示正文之后，鼠标移开 ✕ 还挂着没收起来')
      }
    }

    /* 键盘可达：真实按 Tab 聚焦到提示上时也要能出现关闭按钮，否则键盘用户关不掉。
       不能用 `locator.focus()`：它不算键盘来源，Chromium 不会给 `:focus-visible`，
       这样就测不出样式用的选择器对不对（鼠标点过之后 `focus()` 也一样）。 */
    if ((await first.getAttribute('tabindex')) === null)
      errors.push('提示：提示本身不可聚焦（没有 tabindex），键盘用户没法聚焦它看到关闭按钮')
    else {
      // 先 blur：不把焦点留在任何元素上，从文档开头 Tab 起
      await p.evaluate(() => document.activeElement?.blur())
      let reached = false
      for (let i = 0; i < 60; i += 1) {
        await p.keyboard.press('Tab')
        reached = await p.evaluate(() => document.activeElement?.hasAttribute('data-sonner-toast') === true)
        if (reached) break
      }
      if (!reached) errors.push('提示：一路 Tab 都聚焦不到提示，键盘用户没法关掉它')
      else {
        await p.waitForTimeout(200)
        // 断言 Tab 真实落到的那一条：屏幕上可能有好几条，`first` 不一定就是被聚焦的那条
        const focusedHasClose = await p.evaluate(() => {
          const el = document.activeElement
          const btn = el?.querySelector('[data-close-button]')
          return !!btn && getComputedStyle(btn).opacity !== '0'
        })
        if (!focusedHasClose) errors.push('提示：键盘 Tab 聚焦到提示上时关闭按钮没出现')

        /* 再 Tab 一下要能走进 ✕ 并按 Enter 关掉。
           这条是盯「隐藏方式」的：用 display: none 藏时按钮不在 Tab 序列里，
           li 一失焦又不再匹配 :focus-visible，焦点直接被丢回 body，键盘用户根本关不掉。 */
        const before = await rawStat()
        await p.keyboard.press('Tab')
        await p.waitForTimeout(150)
        const onClose = await p.evaluate(() => document.activeElement?.hasAttribute('data-close-button') === true)
        if (!onClose) errors.push('提示：键盘再 Tab 一次走不进 ✕（按钮不在 Tab 序列里）')
        else {
          const shownOnFocus = await p.evaluate(() => {
            const btn = document.activeElement
            return !!btn && getComputedStyle(btn).opacity !== '0'
          })
          if (!shownOnFocus) errors.push('提示：焦点走到 ✕ 上时按钮反而被藏起来了（键盘用户关不掉）')
          await p.keyboard.press('Enter')
          const closed = await p
            .waitForFunction((n) => document.querySelectorAll('[data-sonner-toast]').length < n, before.mounted, {
              timeout: 3000,
            })
            .then(
              () => true,
              () => false,
            )
          if (!closed) errors.push('提示：键盘聚焦到 ✕ 上按 Enter 没有关掉这条提示')
        }
      }
      await p.mouse.move(700, 500)
    }
  }

  /* 补位：关掉最上面那一条，排队的第一条要立刻补上来（不是等它自己的计时走完就丢掉） */
  await ensure(VISIBLE_LIMIT)
  {
    // 上一步用 Tab + Enter 关掉了提示，这次点击落在弹窗外面，Radix 的环境弹窗跟着关了；
    // 后面还要用「复制分支名」弹提示，先把它重新打开
    if (!(await envTitle.isVisible().catch(() => false))) {
      await p.locator('button[aria-label="环境"]').first().click()
      await envTitle.waitFor({ timeout: 5000 }).catch(() => errors.push('提示：重新打开环境弹窗失败'))
      await ensure(VISIBLE_LIMIT)
    }
    const before = (await rawStat()).mounted
    const first = toasts.first()
    await first.hover()
    await first.locator('[data-close-button]').click()
    const refilled = await p
      .waitForFunction((n) => document.querySelectorAll('[data-sonner-toast]').length === n, before, { timeout: 5000 })
      .then(
        () => true,
        () => false,
      )
    if (!refilled) errors.push('提示-补位：关掉一条之后排队的那条没有补上来')
    await check(p, '提示-排队补位')
  }

  /* 进出动画：过渡时长必须短于 sonner 卸载前留的 200ms，否则退出动效播不完就被掐掉 */
  await ensure(1)
  {
    const ms = await p.evaluate(() => {
      const el = document.querySelector('[data-sonner-toast]')
      if (!el) return null
      return Math.max(
        ...getComputedStyle(el)
          .transitionDuration.split(',')
          .map((d) => (d.trim().endsWith('ms') ? parseFloat(d) : parseFloat(d) * 1000))
          .filter((n) => !Number.isNaN(n)),
      )
    })
    if (ms === null) errors.push('提示-动画：量不到提示的过渡时长')
    else if (ms === 0) errors.push('提示-动画：提示没有过渡，进出都是硬切')
    else if (ms > UNMOUNT_MS) errors.push(`提示-动画：过渡 ${ms}ms 超过了退出前留的 ${UNMOUNT_MS}ms，退出动画会被掐断`)
    await check(p, '提示-进出动画')
  }

  /* 关掉全部之后队列也清干净：不会过一会儿又冒出排队的那几条 */
  {
    // 一条一条关：鼠标先移到那条上让关闭按钮显出来（按坐标移动，避开动画期间的元素稳定性检查），
    // 再点按钮；关掉一条后排队的那条会补位，所以循环多跑几轮
    for (let round = 0; round < VISIBLE_LIMIT + 4; round += 1) {
      const box = await toasts
        .first()
        .boundingBox()
        .catch(() => null)
      if (!box) break
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await p.waitForTimeout(120)
      const closed = await p
        .evaluate(() => {
          const btn = document.querySelector('[data-sonner-toast] [data-close-button]')
          if (!btn) return false
          btn.click()
          return true
        })
        .catch(() => false)
      if (!closed) break
      await p.waitForTimeout(120)
    }
    await toasts
      .first()
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => {})
    await p.mouse.move(700, 500)
    await p.waitForTimeout(600)
    const left = (await rawStat()).mounted
    if (left) errors.push(`提示-清空：关掉全部之后又冒出来 ${left} 条（排队没清）`)
    await check(p, '提示-关掉全部不留残余')
  }
})
