/**
 * 界面检查分片：弹窗拖拽调整大小 + 尺寸记忆
 *
 * 设置弹窗（Modal）和清理工作目录的确认框（ConfirmDialog）各验一遍：
 * - 四边 + 四角共 8 个手柄都在
 * - 左右边只改宽、上下边只改高、拖角落按开始的宽高比一起变
 * - 拖完关掉再打开同一个弹窗恢复尺寸；清掉本机记忆后回到尺寸档默认
 *
 * 只用真实鼠标拖动（pointer events），不往页面里塞测试钩子。
 * 位置和尺寸都从弹窗自己的 boundingBox 量，不按固定坐标算。
 */
import { runShard } from './harness.mjs'

/** 和 web/src/lib/modal-size.ts 的 MODAL_SIZE_STORAGE_PREFIX 一致；改前缀时一起改 */
const STORAGE_PREFIX = 'modal-size:'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)

  const boxOf = async (loc) => {
    const box = await loc.boundingBox()
    if (!box) throw new Error('量不到弹窗位置或尺寸')
    return box
  }

  /** 从某个手柄中心出发拖 dx/dy；pointer capture 下用真实鼠标事件 */
  const dragHandle = async (dialog, key, dx, dy) => {
    const handle = dialog.locator(`[data-modal-resize="${key}"]`)
    if ((await handle.count()) !== 1) return errors.push(`弹窗调整大小：找不到 ${key} 手柄`)
    const h = await handle.boundingBox()
    if (!h) return errors.push(`弹窗调整大小：${key} 手柄看不到`)
    const x = h.x + h.width / 2
    const y = h.y + h.height / 2
    await p.mouse.move(x, y)
    await p.mouse.down()
    await p.mouse.move(x + dx, y + dy, { steps: 6 })
    await p.mouse.up()
    await settle(p)
  }

  const clearMemory = () =>
    p.evaluate((prefix) => {
      for (const key of Object.keys(localStorage)) if (key.startsWith(prefix)) localStorage.removeItem(key)
    }, STORAGE_PREFIX)

  const openSettings = async () => {
    await p.getByRole('button', { name: '设置' }).first().click()
    await settings().waitFor({ timeout: 5000 })
    await settle(p)
  }
  const settings = () => p.getByRole('dialog', { name: '设置' })
  const closeSettings = async () => {
    await p.keyboard.press('Escape')
    await settings()
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => errors.push('弹窗调整大小：设置弹窗按 Esc 没有关掉'))
    await settle(p)
  }

  // ---- Modal：四边、角落、记忆、清空后回默认 ----
  await openSettings()
  await check(p, '弹窗调整大小-设置打开', ['设置'])
  if ((await settings().locator('[data-modal-resize]').count()) !== 8)
    errors.push('弹窗调整大小：设置弹窗应该有 8 个拖拽手柄（4 边 + 4 角）')

  const defaultBox = await boxOf(settings())
  await dragHandle(settings(), 'e', 40, 0)
  const wider = await boxOf(settings())
  if (wider.width < defaultBox.width + 30)
    errors.push(`弹窗调整大小：拖右边后宽度 ${wider.width}，应至少 ${defaultBox.width + 30}`)
  if (Math.abs(wider.height - defaultBox.height) > 2) errors.push('弹窗调整大小：拖右边不该改高度')

  await dragHandle(settings(), 's', 0, -40)
  const shorter = await boxOf(settings())
  if (shorter.height > wider.height - 30) errors.push(`弹窗调整大小：拖下边后高度 ${shorter.height}，应至少减少 30`)
  if (Math.abs(shorter.width - wider.width) > 2) errors.push('弹窗调整大小：拖下边不该改宽度')

  // 先收窄，给角落放大留空间；拖右下角时宽高应按开始的宽高比一起变
  await dragHandle(settings(), 'e', -100, 0)
  const beforeCorner = await boxOf(settings())
  await dragHandle(settings(), 'se', 30, 20)
  const afterCorner = await boxOf(settings())
  if (!(afterCorner.width > beforeCorner.width + 10 && afterCorner.height > beforeCorner.height + 5))
    errors.push(
      `弹窗调整大小：拖角落没有同时放大（${beforeCorner.width}×${beforeCorner.height} → ${afterCorner.width}×${afterCorner.height}）`,
    )
  const ratioBefore = beforeCorner.width / beforeCorner.height
  const ratioAfter = afterCorner.width / afterCorner.height
  if (Math.abs(ratioAfter - ratioBefore) > ratioBefore * 0.02)
    errors.push(`弹窗调整大小：拖角落没有保持宽高比（${ratioBefore.toFixed(3)} → ${ratioAfter.toFixed(3)}）`)

  const stored = await p.evaluate((prefix) => {
    const found = Object.entries(localStorage).filter(([k]) => k.startsWith(prefix))
    return found.length === 1 ? JSON.parse(found[0][1]) : null
  }, STORAGE_PREFIX)
  if (!stored) errors.push('弹窗调整大小：拖动后没有写进本机记忆')
  else if (Math.abs(stored.w - afterCorner.width) > 2 || Math.abs(stored.h - afterCorner.height) > 2)
    errors.push(
      `弹窗调整大小：记忆的尺寸 ${stored.w}×${stored.h} 和实际 ${afterCorner.width}×${afterCorner.height} 对不上`,
    )

  await closeSettings()
  await openSettings()
  const reopened = await boxOf(settings())
  if (Math.abs(reopened.width - afterCorner.width) > 2 || Math.abs(reopened.height - afterCorner.height) > 2)
    errors.push(
      `弹窗调整大小：重新打开没有恢复尺寸（${reopened.width}×${reopened.height}，应为 ${afterCorner.width}×${afterCorner.height}）`,
    )
  await check(p, '弹窗调整大小-设置恢复尺寸')

  await closeSettings()
  await clearMemory()
  await openSettings()
  const reset = await boxOf(settings())
  if (Math.abs(reset.width - defaultBox.width) > 2 || Math.abs(reset.height - defaultBox.height) > 2)
    errors.push(
      `弹窗调整大小：清掉记忆后应回到默认 ${defaultBox.width}×${defaultBox.height}，实际 ${reset.width}×${reset.height}`,
    )
  await check(p, '弹窗调整大小-清空记忆回默认')

  // ---- ConfirmDialog：手柄、角落、记忆 ----
  // 用「抓网页快照」那行的清理按钮：05-settings 已经断言它是可点的，不依赖构建产物在不在
  await p.getByRole('button', { name: '数据', exact: true }).click()
  const cleanup = async () =>
    p.getByText('抓网页快照').locator('xpath=..').getByRole('button', { name: '清理' }).click()
  const confirm = () => p.getByRole('dialog', { name: '清理「抓网页快照」的工作目录？' })
  await cleanup()
  await confirm().waitFor({ timeout: 5000 })
  await settle(p)
  if ((await confirm().locator('[data-modal-resize]').count()) !== 8)
    errors.push('弹窗调整大小：确认框应该有 8 个拖拽手柄')

  const confirmDefault = await boxOf(confirm())
  await dragHandle(confirm(), 'e', 30, 0)
  const confirmWide = await boxOf(confirm())
  if (confirmWide.width < confirmDefault.width + 20)
    errors.push(`弹窗调整大小：确认框拖右边后宽度 ${confirmWide.width}，应至少 ${confirmDefault.width + 20}`)
  await dragHandle(confirm(), 'se', 20, 15)
  const confirmCorner = await boxOf(confirm())
  if (!(confirmCorner.width > confirmWide.width + 5 && confirmCorner.height > confirmWide.height + 3))
    errors.push('弹窗调整大小：确认框拖角落没有同时放大')

  await confirm().getByRole('button', { name: '取消', exact: true }).click()
  await confirm()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => errors.push('弹窗调整大小：确认框点取消没有关掉'))
  await cleanup()
  await confirm().waitFor({ timeout: 5000 })
  await settle(p)
  const confirmReopened = await boxOf(confirm())
  if (
    Math.abs(confirmReopened.width - confirmCorner.width) > 2 ||
    Math.abs(confirmReopened.height - confirmCorner.height) > 2
  )
    errors.push(
      `弹窗调整大小：确认框重新打开没有恢复尺寸（${confirmReopened.width}×${confirmReopened.height}，应为 ${confirmCorner.width}×${confirmCorner.height}）`,
    )
  await check(p, '弹窗调整大小-确认框恢复尺寸')
  await confirm().getByRole('button', { name: '取消', exact: true }).click()
})
