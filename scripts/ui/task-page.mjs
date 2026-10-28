/**
 * 任务页（对话页）分片共用的开场和操作。
 *
 * 02-task / 02b-subagent / 02c-element-pick 三片都从同一个页面状态开始：
 * 打开在线演示版、点开「购物车右上角」那条父对话。拆成多个文件后各片自己重建前置状态，
 * 不依赖别的分片先跑过，也不需要谁先跑谁后跑。
 *
 * 这个文件不以数字开头，不会被 scripts/ui-check.mjs 当成一个分片收录。
 */
/** 演示数据里那条父对话：列表项和页面标题都以这句开头 */
export const CART_CONVERSATION = '购物车右上角'

/** 任务页的默认视口：窄屏用例会自己再改 */
export const TASK_VIEWPORT = { width: 1440, height: 900 }

/**
 * 开一个页面、进入那条父对话，返回这个 page。
 * afterOpen 在点开对话之后、等输入框之前调用：加载日志这类「打开瞬间才看得到」的断言要在那里做。
 */
export async function openCartTask({ base, page, errors }, { viewport = TASK_VIEWPORT, afterOpen } = {}) {
  const p = await page(viewport)
  await p.goto(base)
  const conv = p.getByText(CART_CONVERSATION, { exact: false }).first()
  const found = await conv.waitFor({ timeout: 15000 }).then(
    () => true,
    () => false,
  )
  // 列表项都没出来就别接着 click：click 会白等 30 秒默认超时、抛错穿到 catch 分支，
  // 这条更有用的提示反而看不到。直接返回，后面每一步各自报出找不到元素，分片照样以失败结束
  if (!found) {
    errors.push('任务页：演示数据没生成出来（找不到对话列表项）')
    return p
  }
  await conv.click()
  await afterOpen?.(p)
  await p
    .locator('#follow-up')
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('任务页：点开对话后没有出现输入框'))
  return p
}

/** 中间打开的子对话（页签）：父对话页签在前台时它是隐藏的，读屏树里没有 */
export const childView = (p) => p.getByRole('region', { name: '子对话' })

/** 页签条上关闭子对话的按钮（子对话视图里不再有自己的 ✕） */
export const closeChildTab = (p) =>
  p.getByRole('tablist', { name: '对话页签' }).getByRole('button', { name: '关闭子对话', exact: true })

/**
 * 任务页上的常用操作，绑定到一个 page 上。
 * 三片各自用自己那个 page 调一次，不共享状态。
 */
export function taskPageHelpers(p, { settle, errors }) {
  /** 宽屏标题栏的文件按钮：文件面板默认收起，后面的用例要自己先把它点开 */
  const openFiles = async () => {
    const open = p.getByRole('button', { name: '显示文件', exact: true })
    if (await open.count()) {
      await open.click()
      await settle(p)
    }
  }

  /**
   * 等页面上的提示（toast）全部退场再点标题栏的按钮。
   * 两件事一起做，缺一不可：
   * - 提示在右上角，和「任务进度」这类标题栏按钮抢同一个位置，还挂着时会拦掉点击
   *   （CI 的 30 秒超时就是这条：locator resolved 到了按钮，但点击被 [data-sonner-toast] 截走）
   * - sonner 在鼠标悬停在提示上时会把自动关闭的计时冻住（expanded），只等不动手就永远等不到，
   *   所以先把指针挪回左上角再等
   */
  const waitToastsGone = async () => {
    await p.mouse.move(0, 0)
    await p
      .waitForFunction(() => document.querySelectorAll('[data-sonner-toast]').length === 0, undefined, {
        timeout: 15000,
      })
      .catch(() => errors.push('提示：15 秒内没有全部退场（会挡住后面的点击）'))
  }

  /** 刷新后回到购物车那个任务页：当前路由就是任务页，等它画出来；没回到任务页时从列表点进去 */
  const backToTask = async () => {
    const token = p.getByTitle('Token 用量').first()
    if (
      await token.waitFor({ timeout: 5000 }).then(
        () => true,
        () => false,
      )
    ) {
      await openFiles()
      return
    }
    await p.getByText(CART_CONVERSATION, { exact: false }).first().click()
    await token.waitFor({ timeout: 5000 }).catch(() => {})
    await openFiles()
  }

  /** Esc 关掉弹层之后等它真的卸载，再点下面的东西 */
  const closed = () =>
    p
      .getByRole('dialog')
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})

  return { openFiles, waitToastsGone, backToTask, closed }
}
