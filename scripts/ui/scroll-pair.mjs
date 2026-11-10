/**
 * 对话正文和会话栏的滚动条互斥（web/src/components/ui/rail-scrollbar.tsx）：两块共用右边一条槽，
 * 鼠标在哪块显示哪块的滑块，不自动隐藏；鼠标进槽里不切换（好去拖滑块）。
 * 只这两块互斥：会话栏里嵌套的 MCP 工具列表照常有自己的滚动条（用户 2026-11-09 要求，原来全局只显示一条被否掉）。
 *
 * 不以数字开头，不会被 scripts/ui-check.mjs 当成分片。
 */

/** 比「停下就隐藏」可能用的计时长：等过这么久滑块还在，才算不自动隐藏 */
const STAY_MS = 1500

const focusOf = (p) => p.evaluate(() => document.querySelector('[data-scroll-pair]')?.getAttribute('data-scroll-focus'))

export async function scrollPairProblems(p, rail, errors) {
  // 展开 MCP 工具列表并压矮，保证它是会话栏里一个能滚的内层区域
  const toggle = rail.getByRole('button', { name: /MCP 工具/ }).first()
  if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  const list = toggle.locator('xpath=following-sibling::ul[1]')
  await list
    .evaluate((el) => (el.style.maxHeight = '72px'))
    .catch(() => errors.push('滚动条：展开 MCP 工具后没找到工具列表'))
  // 会话栏外层要能滚：视口压矮一点
  const size = p.viewportSize()
  await p.setViewportSize({ width: size.width, height: 640 })
  await p.waitForTimeout(200)
  const thumb = rail.locator('[data-rail-thumb]')
  const railBox = await rail.boundingBox()
  const scroller = await p.locator('[data-conversation-scroll="messages"]').first().boundingBox()
  if (!railBox || !scroller) {
    errors.push('滚动条：找不到会话栏或消息区')
    await p.setViewportSize(size)
    return
  }

  // 鼠标在对话正文：槽里是消息区的滑块，会话栏的不画
  await p.mouse.move(scroller.x + 100, scroller.y + 100)
  if ((await focusOf(p)) !== 'main') errors.push(`滚动条：鼠标在对话正文时应显示正文的滚动条，实际 ${await focusOf(p)}`)
  if ((await thumb.getAttribute('data-rail-thumb')) !== 'hidden')
    errors.push('滚动条：鼠标在对话正文时会话栏的滑块也显示着')

  // 鼠标进会话栏：换成会话栏的滑块，不滚也显示，停一会儿也不隐藏
  await p.mouse.move(railBox.x + railBox.width / 2, railBox.y + 80)
  await p.waitForTimeout(STAY_MS)
  if ((await focusOf(p)) !== 'rail') errors.push('滚动条：鼠标在会话栏时没有切到会话栏的滚动条')
  if ((await thumb.getAttribute('data-rail-thumb')) !== 'shown')
    errors.push('滚动条：鼠标停在会话栏上，会话栏的滑块没显示（或自动隐藏了）')
  // 内层列表照常有自己的滚动条（占着宽度），不参与互斥
  const own = await list.evaluate((el) => el.offsetWidth - el.clientWidth).catch(() => 0)
  if (own <= 0) errors.push('滚动条：会话栏里的 MCP 工具列表没有自己的滚动条')

  // 从会话栏横着移进右边的槽：保持会话栏的滑块，好去拖
  await p.mouse.move(railBox.x + railBox.width + 6, railBox.y + railBox.height - 20, { steps: 4 })
  if ((await focusOf(p)) !== 'rail') errors.push('滚动条：从会话栏移进右边的槽时切走了，没法去拖会话栏的滑块')

  // 回到对话正文：换回正文的
  await p.mouse.move(scroller.x + 100, scroller.y + 100, { steps: 4 })
  if ((await focusOf(p)) !== 'main') errors.push('滚动条：鼠标回到对话正文后没换回正文的滚动条')
  await p.setViewportSize(size)
}
