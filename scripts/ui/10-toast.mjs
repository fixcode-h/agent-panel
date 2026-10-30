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
  /**
   * 屏幕上的条数：
   * - mounted：DOM 里挂了几个 `[data-sonner-toast]`
   * - live：真正还在队列里的（排除 `data-removed="true"`）——sonner 关掉一条后要先把它标成 removed、
   *   播完退出动画才从 DOM 掉，这期间它照样被 querySelectorAll 数进去。拿 mounted 当基准时，
   *   基准会被抬高到「补位完成后也回不到」的数，判据就永远等不到。
   * - visible：live 里真的看得见几条（sonner 的 visibleToasts 藏起来的、以及正在淡出的都不算）
   */
  const rawStat = () =>
    p.evaluate(() => {
      const all = [...document.querySelectorAll('[data-sonner-toast]')]
      const live = all.filter((el) => el.getAttribute('data-removed') !== 'true')
      return {
        mounted: all.length,
        live: live.length,
        visible: live.filter((el) => {
          const s = getComputedStyle(el)
          return el.getAttribute('data-visible') !== 'false' && s.opacity !== '0' && s.visibility !== 'hidden'
        }).length,
      }
    })
  /**
   * 等屏幕上正好 n 条「还在队列里」的、并且每条都真的可见，且这个状态连续稳住 hold 毫秒。
   * 不能读一帧就断言：
   * - 刚递进去的那条在 mounted 之前 opacity 是 0，会被当成「被 sonner 藏了」；
   * - 正在播退出动画的那条 opacity 在从 1 淡到 0，会被误判成「看得见」（所以按 removed 排除）；
   * - 4 秒到期是「移除 + 当场补位」两步，中间那段条数也是对的，一帧采样会把半途当成结论。
   * 采样在页面里用 rAF 自己做（不往 window 上挂状态）。
   * 外层再套一道脚本侧硬超时：页面不可见、主线程被长任务占住时 rAF 会停，
   * 光靠页面里的 deadline 等不到——那会把整个分片挂死（page.evaluate 不吃 setDefaultTimeout）。
   */
  const waitStat = async (n, timeout = 4000, hold = 200) => {
    const sampling = p.evaluate(
      async ({ want, limit, holdMs }) => {
        const frames = () =>
          [...document.querySelectorAll('[data-sonner-toast]')].filter(
            (el) => el.getAttribute('data-removed') !== 'true',
          )
        const ok = () => {
          const live = frames()
          return (
            live.length === want &&
            live.every((el) => {
              const s = getComputedStyle(el)
              return el.getAttribute('data-visible') !== 'false' && s.opacity !== '0' && s.visibility !== 'hidden'
            })
          )
        }
        const startedAt = performance.now()
        let stableSince = 0
        for (;;) {
          const now = performance.now()
          if (ok()) {
            if (!stableSince) stableSince = now
            if (now - stableSince >= holdMs) return true
          } else stableSince = 0
          if (now - startedAt >= limit) return false
          await new Promise((r) => requestAnimationFrame(() => r()))
        }
      },
      { want: n, limit: timeout, holdMs: hold },
    )
    // 定时器用完清掉，别让它拖住分片退出
    let timer
    const hardStop = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeout + 1000)
    })
    try {
      return await Promise.race([sampling.catch(() => false), hardStop])
    } finally {
      clearTimeout(timer)
    }
  }

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
  /**
   * 当前「活着的」提示（排除正在退场的）的元素句柄。
   * 只比条数不够：「一条到期 + 一条新进」也能凑出满额，所以后面要按元素身份比对。
   * 先一次 evaluate 取存活元素的下标，再按同一个下标从 elementHandles() 里挑——
   * 逐个句柄 evaluate 是 N 次 round-trip，会把判定链拖长（到期窗口就在这段里）。
   */
  const snapshot = async () => {
    const alive = await p.evaluate(() =>
      [...document.querySelectorAll('[data-sonner-toast]')].map((el) => el.getAttribute('data-removed') !== 'true'),
    )
    const handles = await toasts.elementHandles()
    return handles.filter((_, i) => alive[i])
  }
  /** 点确定 ✓ 的关闭按钮把屏上的提示全部关掉，并等真的空下来（重建干净状态时用） */
  const clearAll = async () => {
    for (let round = 0; round < VISIBLE_LIMIT + 4; round += 1) {
      if (!(await rawStat()).live) break
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
    await p.mouse.move(700, 500)
  }
  /**
   * 弹一条提示：右键那行 → 复制分支名。
   * `expectQueued` 表示屏上已经满额、新的一条应当只排队不进 DOM。
   * 这个分支不在这里猜：点击后由调用方用 `sameTop` + 元素身份（keptOthers / gotNew）确认，
   * 真的进 DOM 了就会挤到最上面，调用方一见 topHandle 不是那一照就报错。
   */
  const popOne = async ({ expectQueued = false } = {}) => {
    const before = (await rawStat()).live
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
    // 满额时这一条只排队，不等 DOM 增长（等不到）；调用方用 sameTop 和元素身份确认
    if (expectQueued) return
    return p
      .waitForFunction(
        (n) =>
          [...document.querySelectorAll('[data-sonner-toast]')].filter(
            (el) => el.getAttribute('data-removed') !== 'true',
          ).length > n,
        before,
        { timeout: 2000 },
      )
      .then(
        () => true,
        () => false,
      )
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
          // 用活着的条数判（不含正在播退出动画的那条），条数只减不增这一步不会假阳性
          const closed = await p
            .waitForFunction(
              (n) =>
                [...document.querySelectorAll('[data-sonner-toast]')].filter(
                  (el) => el.getAttribute('data-removed') !== 'true',
                ).length < n,
              before.live,
              { timeout: 3000 },
            )
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
  {
    // 上一步用 Tab + Enter 关掉了提示，这次点击落在弹窗外面，Radix 的环境弹窗跟着关了；
    // 后面还要用「复制分支名」弹提示，先把它重新打开
    if (!(await envTitle.isVisible().catch(() => false))) {
      await p.locator('button[aria-label="环境"]').first().click()
      await envTitle.waitFor({ timeout: 5000 }).catch(() => errors.push('提示：重新打开环境弹窗失败'))
    }
    /* 先清空再重建满额：前面几轮 ensure() 弹的提示剩余寿命各不相同（各自 4 秒到期），
       直接拿它们当背景，验证期间会陆续到期、各自触发一次「移除 + 补位」，
       屏上条数自己就在变，分不清是我们要的那次补位还是别人的计时到了。
       并发抢 CPU 时这种撞车更容易踩上，就是之前全量跑偶发失败的原因。 */
    let beforeQueue = []
    let closing
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await clearAll()
      const emptied = await p
        .waitForFunction(
          () =>
            [...document.querySelectorAll('[data-sonner-toast]')].filter(
              (el) => el.getAttribute('data-removed') !== 'true',
            ).length === 0,
          null,
          { timeout: 5000 },
        )
        .then(
          () => true,
          () => false,
        )
      if (!emptied) {
        errors.push('提示-补位：没法先把屏上的提示清空，后面量不准补位')
        return
      }
      /* 连弹 VISIBLE_LIMIT 条建出满额。它们各自从投递那一刻开始走 4 秒计时，
         所以后面的判定链必须短：实测这条链约 1s，而 4 条约 3.7s 后陆续到期。
         不能靠「先 hover 冻住再重建」——popOne 要右键点菜单，鼠标一离开提示区
         sonner 就把 expanded 置回 false、计时照走（实测：先弹 1 条再 hover 补满，
         第 1 条仍在 4.0s 到期）。所以靠的不是冻结，而是判定链本身够短。 */
      for (let i = 0; i < VISIBLE_LIMIT; i += 1) await popOne()
      beforeQueue = await snapshot()
      if (beforeQueue.length !== VISIBLE_LIMIT) {
        const s = await rawStat()
        errors.push(`提示-补位：重建满额失败（屏上只有 ${s.live} 条活着的）`)
        return
      }
      /* 再弹一条：屏上已经满额，这一条只进队列、不进 DOM。
         不单独等「条数没变」再判一次——那是多一段可能撞上到期的窗口；
         下面按元素身份确认时，如果它其实进了 DOM，gotNew 会多出一条、keptOthers 也会对不上。 */
      await popOne({ expectQueued: true })
      /* 用元素句柄盯住被关的那一条：它真的从 DOM 里移除（＝关闭生效、且退出动画已经播完）
         才是可观测的关闭事实。不能只看条数——刚点下去时它还在、正在播退出动画。
         先确认最上面那条就是快照里的第 0 个元素：
         名额上限失效时第 5 条会直接进 DOM、插到最上面，两者就不是同一条了——
         那样「等被关元素消失」会等到一条永远不会被关的，最后报成「点了关闭也不消失」，
         掩盖掉真正的原因（排队没生效）。 */
      closing = beforeQueue[0]
      const topHandle = await toasts.first().elementHandle()
      const sameTop = topHandle && closing ? await p.evaluate(([a, b]) => a === b, [topHandle, closing]) : false
      if (sameTop) break
      /* 最上面换了人有两种可能：排队真的没生效（第 5 条直接进了 DOM），或者 CI 很慢、
         满额那几条在判定链走完前就 4 秒到期了。后者满额那几条会有人已经不在，换一轮重建再量；
         前者那几条都还在，直接报 */
      const expired = await p.evaluate(
        (els) => els.some((el) => !el.isConnected || el.getAttribute('data-removed') === 'true'),
        beforeQueue,
      )
      if (!expired || attempt === 2) {
        const st = await rawStat()
        errors.push(
          expired
            ? `提示-补位：连着 3 轮满额的提示都在判定前到期，量不了补位（现在 ${st.live} 条）`
            : `提示-补位：满额后再弹一条，它直接进了界面并排到最上面（现在 ${st.live} 条，排队没生效）`,
        )
        return
      }
    }
    await toasts.first().hover()
    await toasts.first().locator('[data-close-button]').click()
    const removed = closing
      ? await p
          .waitForFunction((el) => !el.isConnected, closing, { timeout: 5000 })
          .then(
            () => true,
            () => false,
          )
      : false
    if (!removed) {
      errors.push('提示-补位：点了关闭按钮，被关的那条一直没从屏幕上移除')
      return
    }
    /* 关闭生效后屏上要重新满额，而且换掉的必须只有我们关的那一条：
       - 其余那几条句柄仍在（keptOthers）＝ 没有别的提示到期
       - 出现了一条新的（gotNew）＝ 排队的那条真的补上来了
       比对要在页面里做：elementHandles() 每次返回新的包装对象，Node 侧 === / includes 永远不相等。 */
    const refilled = await waitStat(VISIBLE_LIMIT)
    const { keptOthers, gotNew } = await p.evaluate(
      ({ before, closingEl }) => {
        const now = [...document.querySelectorAll('[data-sonner-toast]')].filter(
          (el) => el.getAttribute('data-removed') !== 'true',
        )
        return {
          keptOthers: before.filter((el) => el !== closingEl).every((el) => now.includes(el)),
          gotNew: now.some((el) => !before.includes(el)),
        }
      },
      { before: beforeQueue, closingEl: closing },
    )
    if (!refilled || !keptOthers || !gotNew) {
      const s = await rawStat()
      errors.push(
        `提示-补位：关掉一条之后排队的那条没有补上来（屏上 ${s.live} 条活着的，应当是 ${VISIBLE_LIMIT} 条；` +
          `其余几条原样保留 ${keptOthers}，出现新的一条 ${gotNew}）`,
      )
    }
    await p.mouse.move(700, 500)
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
    const left = (await rawStat()).live
    if (left) errors.push(`提示-清空：关掉全部之后又冒出来 ${left} 条（排队没清）`)
    await check(p, '提示-关掉全部不留残余')
  }
})
