/**
 * 滚动条显隐的界面检查（web/src/lib/scroll-reveal.ts）：会话栏外层和里面的 MCP 工具列表是嵌套的两个滚动区，
 * 原来两条滚动条同时画着。现在只有正在滚动的那一块挂 data-scrolling（样式只给它画滑块），停下一会儿就摘掉。
 * 深浅色各拍一张滚动中的截图到 ui-shots/。
 *
 * 不以数字开头，不会被 scripts/ui-check.mjs 当成分片。
 */

/** 比 SCROLL_HIDE_MS（900）多留一点，慢机器上计时器晚一拍也不误报 */
const HIDE_WAIT_MS = 1400

/** 元素自己能竖向滚动（内容比可视高度高，overflow 允许滚） */
const scrollableIn = (root) =>
  root.evaluate((r) => {
    const els = [r, ...r.querySelectorAll('*')].filter((el) => {
      const s = getComputedStyle(el)
      return /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1
    })
    els.forEach((el, i) => el.setAttribute('data-sr-probe', String(i)))
    return els.map((el) => ({ i: els.indexOf(el), inner: els.some((o) => o !== el && el.contains(o)) === false }))
  })

const scrollingIds = (p) =>
  p.evaluate(() => [...document.querySelectorAll('[data-scrolling]')].map((el) => el.getAttribute('data-sr-probe')))

export async function scrollRevealProblems(p, rail, errors) {
  // 展开 MCP 工具列表，让它在会话栏里成为第二个（内层）滚动区
  const toggle = rail.getByRole('button', { name: /MCP 工具/ }).first()
  if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  // 演示数据里的工具不多，列表不一定超出 max-h-56：压矮它，保证里面能滚
  await toggle
    .locator('xpath=following-sibling::ul[1]')
    .evaluate((el) => (el.style.maxHeight = '72px'))
    .catch(() => errors.push('滚动条：展开 MCP 工具后没找到工具列表'))
  // 会话栏外层要能滚：视口压矮一点
  const size = p.viewportSize()
  await p.setViewportSize({ width: size.width, height: 640 })
  await p.waitForTimeout(200)
  const list = await scrollableIn(rail)
  const inner = list.find((x) => x.inner)
  const outer = list.find((x) => !x.inner)
  if (!inner || !outer || inner.i === outer.i) {
    errors.push(`滚动条：会话栏里没找到嵌套的两个滚动区（找到 ${list.length} 个），检查不了只显示一条`)
    await p.setViewportSize(size)
    return
  }
  const innerEl = rail.locator(`[data-sr-probe="${inner.i}"]`)
  // 列表可能在外层可视区下面：先滚过去（这一下会让外层显示），等外层自己隐藏再开始
  await innerEl.scrollIntoViewIfNeeded()
  await p.waitForTimeout(HIDE_WAIT_MS)
  const box = await innerEl.boundingBox()
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  if ((await scrollingIds(p)).length) errors.push('滚动条：停止滚动后没有自动隐藏（外层）')
  await p.mouse.wheel(0, 60)
  await p.waitForTimeout(150)
  const now = await scrollingIds(p)
  if (!now.includes(String(inner.i))) errors.push('滚动条：滚内层列表时它的滚动条没显示')
  if (now.length !== 1) errors.push(`滚动条：滚内层列表时同时显示了 ${now.length} 条滚动条`)
  for (const dark of [false, true]) {
    await p.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark)
    await p.mouse.wheel(0, dark ? -30 : 30)
    await p.waitForTimeout(100)
    await rail.screenshot({ path: `ui-shots/02-滚动条-滚动中-${dark ? '深色' : '浅色'}.png` }).catch(() => {})
  }
  await p.evaluate(() => document.documentElement.classList.remove('dark'))
  await p.waitForTimeout(HIDE_WAIT_MS)
  if ((await scrollingIds(p)).length) errors.push('滚动条：停止滚动后没有自动隐藏')
  await rail.screenshot({ path: 'ui-shots/02-滚动条-停下后.png' }).catch(() => {})
  // 鼠标移到列表外、只在外层上滚：轮到外层显示，内层不显示
  const railBox = await rail.boundingBox()
  await p.mouse.move(railBox.x + railBox.width / 2, railBox.y + 30)
  await p.mouse.wheel(0, 80)
  await p.waitForTimeout(150)
  const outerNow = await scrollingIds(p)
  if (outerNow.length !== 1 || outerNow[0] !== String(outer.i))
    errors.push(`滚动条：滚会话栏外层时应只显示外层那条，实际 ${JSON.stringify(outerNow)}`)
  // 会话栏外层不画自己的原生滚动条，滑块画在它右边、消息区滚动条的那条槽里：两块共用一根（用户要求）
  {
    const own = await rail
      .locator(`[data-sr-probe="${outer.i}"]`)
      .evaluate((el) => el.offsetWidth - el.clientWidth)
      .catch(() => -1)
    if (own !== 0) errors.push(`滚动条：会话栏外层还占着自己的滚动条宽度（${own}px），会和消息区的并排两根`)
    const thumb = rail.locator('[data-rail-thumb]')
    const tb = await thumb.boundingBox().catch(() => null)
    if ((await thumb.getAttribute('data-rail-thumb').catch(() => null)) !== 'shown' || !tb)
      errors.push('滚动条：滚会话栏时右边槽里没画出它的滑块')
    else if (tb.x < railBox.x + railBox.width - 1) errors.push('滚动条：会话栏的滑块没画在右边的滚动槽里')
    else
      await p
        .screenshot({
          path: 'ui-shots/02-滚动条-会话栏共用槽.png',
          clip: { x: railBox.x + railBox.width - 80, y: railBox.y, width: 110, height: railBox.height },
        })
        .catch(() => {})
  }
  await p.evaluate(() => {
    for (const el of document.querySelectorAll('[data-sr-probe]')) el.removeAttribute('data-sr-probe')
  })
  await p.setViewportSize(size)
  await p.waitForTimeout(HIDE_WAIT_MS)
}
