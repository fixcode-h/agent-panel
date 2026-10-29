/**
 * 界面检查分片：UI 设计（游戏界面、网页、动画、标注、AI 对话）和 ComfyUI 工作流、命令面板
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { runShard, dialogBottomSpaceProblems } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base + '#/design/demo-design-menu')
  await check(p, 'UI设计', ['控件树', 'AI 对话', 'StartGroup'])
  // 设计对话和 Chat 模式共用同一个对话页壳：消息区有共享的标记
  assert.equal(await p.locator('[data-conversation-scroll="messages"]').count(), 1, '设计对话使用共用的消息区')
  // 滚轮在画布上缩放（以鼠标为中心），不滚动整个页面
  const zoomText = async () =>
    Number(
      (
        await p
          .getByText(/^\d+%$/)
          .first()
          .textContent()
      ).replace('%', ''),
    )
  const z0 = await zoomText()
  const cv = await p.locator('[data-wid]').first().boundingBox()
  await p.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2)
  for (let i = 0; i < 3; i++) await p.mouse.wheel(0, -100)
  await p.waitForTimeout(200)
  assert.ok((await zoomText()) > z0, '滚轮往上放大')
  for (let i = 0; i < 3; i++) await p.mouse.wheel(0, 100)
  await p.waitForTimeout(200)
  assert.ok(Math.abs((await zoomText()) - z0) <= 2, '滚轮往下缩回去')
  await p.getByRole('button', { name: '适应窗口' }).click()
  // 画布空白处右键：粘贴、适应窗口、原始大小
  const stageBox = await p.locator('[data-wid]').first().boundingBox()
  await p.mouse.click(stageBox.x - 10, stageBox.y + stageBox.height / 2, { button: 'right' })
  await check(p, 'UI设计-画布空白菜单', ['粘贴', '适应窗口', '原始大小'])
  await p.keyboard.press('Escape')
  // 画布控件右键：和控件树同一套菜单，层级有二级菜单
  await p.getByText('ETERNAL REALM', { exact: true }).click({ button: 'right' })
  await check(p, 'UI设计-画布右键', ['引用到 AI 对话', '锁定', '层级', '对齐', '删除'])
  await p.getByRole('menuitem', { name: '层级' }).hover()
  await check(p, 'UI设计-画布右键层级', ['置顶', '上移一层', '下移一层', '置底'])
  await p.keyboard.press('Escape')
  await p.keyboard.press('Escape')
  // 缩到最小：拖右下角一直往左上，宽高停在最小尺寸，不会变负或翻转
  await p.getByRole('treeitem', { name: /TitlePlate/ }).click()
  await p.getByTitle('拖动改变大小').waitFor()
  const handle = await p.getByTitle('拖动改变大小').boundingBox()
  assert.ok(handle, '选中的画布控件有缩放手柄')
  await p.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await p.mouse.down()
  await p.mouse.move(handle.x - 2000, handle.y - 2000, { steps: 8 })
  await p.mouse.up()
  await p.waitForTimeout(200)
  assert.equal(Number(await p.getByRole('textbox', { name: 'W' }).inputValue()), 8, '宽度停在最小尺寸')
  assert.equal(Number(await p.getByRole('textbox', { name: 'H' }).inputValue()), 8, '高度停在最小尺寸')
  await check(p, 'UI设计-最小尺寸', ['X / 宽', 'Y / 高'])
  await p.keyboard.press('Control+z')
  // 控件树右键菜单和二级菜单
  await p.getByRole('treeitem', { name: /StartGroup/ }).click({ button: 'right' })
  await p.getByRole('menuitem', { name: '包裹为' }).hover()
  await check(p, 'UI设计-右键菜单', ['创建副本', 'SizeBox'])
  await p.keyboard.press('Escape')
  await p.keyboard.press('Escape')
  // 行尾的眼睛按钮：悬停出现，点了画板收起、名字变淡，再点恢复
  const startRow = p.getByRole('treeitem', { name: /StartGroup/ })
  const startId = await startRow.getAttribute('data-tid')
  await startRow.hover()
  const eye = startRow.getByRole('button', { name: '隐藏', exact: true })
  // IconButton 的显隐带一小段淡入：等淡入结束再读，不在悬停的同一刻读
  await eye.evaluate(
    (el) =>
      new Promise((done) => {
        const t0 = performance.now()
        const tick = () =>
          getComputedStyle(el).opacity === '1' || performance.now() - t0 > 1000
            ? done(null)
            : requestAnimationFrame(tick)
        tick()
      }),
  )
  assert.equal(await eye.evaluate((el) => getComputedStyle(el).opacity), '1', '悬停到行上时出现隐藏按钮')
  const rowBox = await startRow.boundingBox()
  const eyeBox = await eye.boundingBox()
  const nameBox = await startRow.locator('span').first().boundingBox()
  assert.ok(eyeBox.x > nameBox.x, '隐藏按钮在名字后面')
  assert.ok(rowBox.x + rowBox.width - (eyeBox.x + eyeBox.width) < 16, '隐藏按钮在行尾')
  assert.equal(await p.locator('[data-wid="' + startId + '"]').count(), 1)
  await eye.click()
  await p.waitForTimeout(200)
  assert.equal(await p.locator('[data-wid="' + startId + '"]').count(), 0, '隐藏后画板不再画这个控件')
  assert.match(await startRow.locator('span').first().getAttribute('class'), /opacity-50/, '隐藏后树里名字变淡')
  await check(p, 'UI设计-控件树隐藏')
  await startRow.getByRole('button', { name: '显示', exact: true }).click()
  await p.waitForTimeout(200)
  assert.equal(await p.locator('[data-wid="' + startId + '"]').count(), 1, '再点一次恢复显示')
  assert.doesNotMatch(await startRow.locator('span').first().getAttribute('class'), /opacity-50/)
  // 根控件没有隐藏按钮（和原来一样）
  assert.equal(
    await p
      .getByRole('treeitem', { name: /RootCanvas/ })
      .getByRole('button', { name: /隐藏|显示/ })
      .count(),
    0,
    '根控件没有显示 / 隐藏按钮',
  )
  // 右键菜单里的隐藏 / 显示和眼睛按钮是同一份逻辑
  await startRow.click({ button: 'right' })
  await p.getByRole('menuitem', { name: '隐藏', exact: true }).click()
  await p.waitForTimeout(200)
  assert.equal(await p.locator('[data-wid="' + startId + '"]').count(), 0, '右键隐藏同样生效')
  await startRow.click({ button: 'right' })
  await p.getByRole('menuitem', { name: '显示', exact: true }).click()
  await p.waitForTimeout(200)
  assert.equal(await p.locator('[data-wid="' + startId + '"]').count(), 1, '右键显示同样生效')
  // 引用到 AI 对话：输入框上方出现带路径的引用条，可以删掉
  const cite = p.getByTitle(/RootCanvas \/ MenuBox \/ StartGroup/)
  await p.getByRole('treeitem', { name: /StartGroup/ }).click({ button: 'right' })
  await p.getByRole('menuitem', { name: '引用到 AI 对话' }).click()
  await cite.waitFor()
  await check(p, 'UI设计-引用', ['StartGroup'])
  await p.getByRole('button', { name: '从对话里去掉' }).click()
  await cite.waitFor({ state: 'detached' })
  // 动画：选中控件，用预设加一个弹出动画，拖播放头预览
  await p.getByRole('treeitem', { name: /StartGroup/ }).click()
  // 属性面板：只有可动画的属性行左边有 UE 的关键帧菱形；还没有动画时禁用并提示
  const keyBtn = (label) => p.locator(`[data-field="${label}"] button[aria-pressed]`)
  assert.ok(await keyBtn('RenderOpacity').isDisabled(), '没有动画时打帧按钮禁用')
  assert.equal(await keyBtn('Visibility').count(), 0, '不可动画的属性没有打帧按钮')
  // 动画面板默认打开
  await p.getByRole('button', { name: '预设' }).click()
  await p.getByRole('menuitem', { name: '弹出（弹窗）' }).click()
  await check(p, 'UI设计-动画', ['Anim_PopIn', 'StartGroup · 缩放'])
  assert.equal(await keyBtn('RenderOpacity').count(), 1, '不透明度有打帧按钮')
  assert.equal(await keyBtn('Translation').count(), 1, '位移有打帧按钮')
  assert.equal(await keyBtn('Scale').count(), 1, '缩放有打帧按钮')
  assert.equal(await keyBtn('Angle').count(), 1, '旋转有打帧按钮')
  // 预设已经在 0 秒给不透明度和缩放打了帧（实心），位移还没有轨道（空心）
  assert.equal(await p.locator('[data-field="RenderOpacity"] button[aria-pressed="true"]').count(), 1, '已有帧')
  assert.equal(await p.locator('[data-field="Translation"] button[aria-pressed="true"]').count(), 0, '还没轨道')
  await check(p, 'UI设计-关键帧按钮', ['RenderOpacity', 'Scale'])
  // 点位移的菱形：在当前播放头新建轨道并加帧，时间轴里出现这条轨道
  await keyBtn('Translation').click()
  await check(p, 'UI设计-打关键帧', ['StartGroup · 位移'])
  assert.equal(await p.locator('[data-field="Translation"] button[aria-pressed="true"]').count(), 1, '打完变成实心')
  await p.getByRole('button', { name: '关闭动画面板' }).click()
  // 属性名完整显示：长名字换行，不再为了和开关对齐截成省略号
  await p.getByRole('treeitem', { name: /Background/ }).click()
  const labelFits = (label) =>
    p.locator(`[data-field="${label}"] > span`).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
  assert.ok(await labelFits('Size To Content'), 'Size To Content 完整显示')
  assert.ok(await labelFits('RenderTransformPivot'), '长的属性名完整显示')
  await check(p, 'UI设计-属性名完整', ['Size To Content', 'RenderTransformPivot'])
  // 由内容撑开的文字不能改宽高：属性面板直接说明，不再假装能改 W / H
  // （控件树里的 treeitem 名字带尺寸，直接点画布上的标题文字选它）
  await p.getByText('ETERNAL REALM', { exact: true }).first().click()
  await p.getByText('宽度由内容决定').waitFor()
  await check(p, 'UI设计-文字尺寸', ['宽度由内容决定', '高度由内容决定'])
  // 图片：图片适配方式，以及对齐到兄弟控件 / 填满父控件（用 locator 精确断言，不靠文本子串）
  await p.getByRole('treeitem', { name: /TitlePlate/ }).click()
  await p.getByRole('combobox', { name: 'ImageFit', exact: true }).waitFor()
  await p.getByRole('combobox', { name: '对齐到', exact: true }).waitFor()
  await p.getByRole('button', { name: '填满父控件', exact: true }).waitFor()
  await check(p, 'UI设计-图片适配', ['对齐到', '填满父控件'])
  // 标注：框选一块，写说明，出现在 AI 输入框上方
  await p.keyboard.press('r')
  const vp = await p.locator('[data-wid]').first().boundingBox()
  await p.mouse.move(vp.x + vp.width * 0.3, vp.y + vp.height * 0.42)
  await p.mouse.down()
  await p.mouse.move(vp.x + vp.width * 0.7, vp.y + vp.height * 0.8, { steps: 6 })
  await p.mouse.up()
  await p.getByRole('textbox', { name: '标注说明' }).fill('按钮换成金色描边，间距大一点')
  await p.keyboard.press('Enter')
  await check(p, 'UI设计-标注', ['按钮换成金色描边'])
  await p.keyboard.press('v')
  // 引用的控件随消息一起发出去：发出后输入框上的引用条清掉，消息里保留
  await p.getByRole('treeitem', { name: /StartGroup/ }).click({ button: 'right' })
  await p.getByRole('menuitem', { name: '引用到 AI 对话' }).click()
  await cite.waitFor()
  // 发给 AI：流式输出，生成图片时进度固定在输入框上方
  await p.getByRole('textbox', { name: '告诉 AI 要做什么' }).fill('按钮再大一点')
  await p.keyboard.press('Enter')
  await p.getByRole('button', { name: '从对话里去掉' }).waitFor({ state: 'detached' })
  await cite.waitFor()
  await check(p, 'UI设计-引用消息', ['StartGroup'])
  // 生成图片只有几秒：先等它出现（收尾前就看得到，不依赖消息入库和折叠）
  await p.getByText(/正在生成图片 \d+\/\d+/).waitFor({ timeout: 15000 })
  // 和 Chat 对话一模一样：这一轮结束后，思考和工具调用收进一个折叠，只留折叠行和最后的回复
  // 折叠行按可访问名定位（「其他操作 N 次 · 思考 N 次」），和 02-task.mjs 的折叠行用同一套口径；
  // 底下那个「思考过程」行虽然也是 button，但名字里没有次数，不会互相抢
  const foldRow = p.getByRole('button', { name: /(其他操作|思考) \d+ 次/ }).last()
  await foldRow.waitFor({ timeout: 20000 }).catch(() => errors.push('UI设计：回复完成后没有收起过程的折叠行'))
  // 展开后截「生成中」和写入的工具调用（收起时它们只在折叠行的「其他操作 N 次」里）
  await foldRow.click().catch(() => errors.push('UI设计：点不开过程的折叠行'))
  await p
    .getByText('思考过程', { exact: true })
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('UI设计：展开折叠后看不到思考过程'))
  await check(p, 'UI设计-生成中', ['正在生成图片'])
  await check(p, 'UI设计-写入', ['replace_widget'])
  await p.getByText(/正在生成图片/).waitFor({ state: 'detached', timeout: 20000 })
  // 收起后过程不铺在屏幕上：思考块整个不渲染，不是一个还占着位置的隐藏块
  {
    await foldRow.click().catch(() => errors.push('UI设计：再点一次没有收起过程'))
    await p
      .getByText('思考过程', { exact: true })
      .first()
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => errors.push('UI设计：收起后思考过程还铺在对话里'))
    // 设计页特有的东西不能跟着折叠一起没掉
    await p
      .getByText(/需要的图片：\d+ 张/)
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('UI设计：折叠把「需要的图片」一起收没了'))
    const brief = await foldRow.innerText().catch(() => '')
    if (!/其他操作 \d+ 次/.test(brief) || !/思考 \d+ 次/.test(brief))
      errors.push(`UI设计：折叠行没有写这段做了什么（读到「${brief}」）`)
    await check(p, 'UI设计-过程折叠')
    // 再点开能看到过程，再点一次又收起（展开 / 收起的状态按这一段记）
    await foldRow.click()
    await p
      .getByText('思考过程', { exact: true })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('UI设计：再展开看不到思考过程'))
    await check(p, 'UI设计-展开过程', ['思考过程'])
    await foldRow.click()
    await p
      .getByText('思考过程', { exact: true })
      .first()
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => errors.push('UI设计：展开后再点一次没有收起'))
  }
  // AI 分析：只读检查对话和生成的 UI，结果回到对话里，分三段并带「按建议修改」
  await p.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await p
    .getByText('正在分析设计')
    .waitFor({ timeout: 15000 })
    .catch(() => {})
  await p.getByText('AI 分析结果').waitFor({ timeout: 15000 })
  await check(p, 'UI设计-AI分析', ['对话过程问题', 'UI 结果问题', '生成能力改进建议', '按建议修改'])
  await p.getByRole('tab', { name: /图片/ }).click()
  await check(p, 'UI设计-图片')
  // 把图片拖到画布上：能放、大小合适的控件高亮，松手就用上（用脚本发拖放事件，无头浏览器的鼠标拖不出 HTML5 拖放）
  await p.evaluate(() => {
    window.__dt = new DataTransfer()
    const thumb = document.querySelector('button[draggable="true"]')
    thumb.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__dt }))
  })
  await p.waitForTimeout(200)
  const dragAt = (type) =>
    p.evaluate((type) => {
      const slot = document.querySelector('[data-drop-slot]')
      if (!slot) return ''
      const r = slot.getBoundingClientRect()
      const at = { bubbles: true, cancelable: true, dataTransfer: window.__dt }
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      document.elementFromPoint(x, y).dispatchEvent(new DragEvent(type, { ...at, clientX: x, clientY: y }))
      return slot.dataset.dropSlot
    }, type)
  const dropName = await dragAt('dragover')
  assert.ok(dropName, '拖图片时有大小合适的控件高亮')
  await check(p, 'UI设计-拖图片', ['放到 ' + dropName])
  await dragAt('drop')
  await p.evaluate(() =>
    document
      .querySelector('button[draggable="true"]')
      .dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dt })),
  )
  // UI 项目设置：美术提示词
  await p.getByText('暗夜远征').first().click({ button: 'right' })
  await p.getByRole('menuitem', { name: '美术提示词' }).click()
  await check(p, 'UI设计-项目提示词', ['让 AI 生成', '画风', '暗黑奇幻'])
  // 设计项目设置弹窗和项目设置用同一份滚动区常量，底部留白也要一致
  errors.push(...(await dialogBottomSpaceProblems(p, 'UI设计-项目提示词-底部留白')))
  await p.keyboard.press('Escape')
  // 项目行：最前面的箭头按钮才折叠，点项目名打开 UI 项目主页（用户报的「点不开主页」「点整行就折叠」）
  // 定位项目名不用最左边的「收起」按钮（未按项目限定时多个项目下顺序不可靠），
  // 箭头按钮用 data-fold={项目id} 锁定；限在侧栏里找，避开副栏、对话里同名的文字；
  // 分类行按 data-kind 定位，不靠文字子串匹配
  const side = () => p.locator('[data-sidebar]')
  const projName = () => side().getByRole('button', { name: /打开项目「暗夜远征」/ })
  const gameKind = () => side().locator('[data-kind="game"]')
  const projFold = () => side().locator('[data-fold="demo-ui-project"]')
  // 主页的断言必须限在主页容器里：侧栏先于页面渲染，侧栏的设计行也有「主菜单」「背包」，
  // 不限作用域的话主页完全没画出来也会通过（假通过）
  const home = () => p.locator('[data-design-home="demo-ui-project"]')
  // 先断言展开：下面几条断言靠它区分「点了没反应」和「本来就收着」
  assert.equal(await gameKind().getAttribute('aria-expanded'), 'true', '初始是展开的')
  await projName().click()
  // 点项目名是打开项目主页，侧栏的折叠状态不变
  await p.waitForURL(/#\/design\/home\/demo-ui-project/, { timeout: 5000 })
  assert.equal(await gameKind().getAttribute('aria-expanded'), 'true', '点项目名不会折叠')
  await home().waitFor()
  // 只断言主页里有的：侧栏也有「暗夜远征」，靠 check 的全局匹配不限定作用域会假通过
  await home().getByText('个界面').first().waitFor()
  await home().getByText('最近改动').first().waitFor()
  await check(p, 'UI设计-项目主页')
  // 主页容器里真的列出了这个项目的两个设计（侧栏也有同名行，所以要限定作用域）
  for (const title of ['主菜单', '背包']) await home().getByText(title, { exact: true }).first().waitFor()
  // 主页里点一行进设计器：点主页里的那一行，不是侧栏的同名行
  await home()
    .getByRole('button', { name: /^主菜单/ })
    .click()
  await p.waitForURL(/demo-design-menu/, { timeout: 5000 })
  // 回到主页再试折叠：只有最前面的箭头按钮能折叠
  await p.goto(base + '#/design/home/demo-ui-project')
  await gameKind().waitFor()
  await projFold().click()
  await gameKind().waitFor({ state: 'detached' })
  // 折叠后箭头本身还叫「展开」，拿它当定位（名字和状态自洽，且已经按项目锁定，不靠 DOM 顺序）
  assert.equal(await projFold().getAttribute('aria-expanded'), 'false', '点箭头才折叠')
  await home().waitFor()
  await check(p, 'UI设计-箭头收起')
  await projFold().click()
  await gameKind().waitFor()
  assert.equal(await gameKind().getAttribute('aria-expanded'), 'true', '箭头再点一次又展开')
  // 点项目名不折叠，而且留在项目主页
  await projName().click()
  await p.waitForURL(/#\/design\/home\/demo-ui-project/, { timeout: 5000 })
  // 等主页渲染出来当同步点，不用「停一阵」（见教训 lmvnpbhxfu1yg）
  await home().getByText('个界面').first().waitFor()
  assert.equal(await projFold().getAttribute('aria-expanded'), 'true', '点项目名不会折叠')
  assert.equal(await home().count(), 1, '点项目名后仍然在项目主页')
  // 分类行仍能单独收起展开
  await side().locator('[data-kind="game"]').click()
  await side().locator('[data-kind="game"]').click()
  // 侧栏顶部的设计类型下拉：切到「模型设计」列的是 Agent 项目里的模型对话（演示数据里没有，显示说明、没有假按钮），
  // 切回「UI 设计」项目列表还在
  await side().getByRole('button', { name: '切换设计类型' }).click()
  await p.getByRole('menuitemradio', { name: /模型设计/ }).click()
  await side()
    .getByText(/还没有模型设计对话/)
    .waitFor()
  assert.equal(await projFold().count(), 0, '模型设计下不列 UI 项目')
  await side().getByRole('button', { name: '切换设计类型' }).click()
  await p.getByRole('menuitemradio', { name: /UI 设计/ }).click()
  await gameKind().waitFor()
  // 画板按运行时假数据渲染：背包格子有物品、数量、选中和锁定；数据面板能改，改完切回画板立刻生效
  await p.goto(base + '#/design/demo-design-inventory')
  await check(p, 'UI设计-画板数据', ['星辉宝石'])
  await p.waitForTimeout(300)
  assert.equal(await p.locator('[data-ac="WBP_ItemSlot"]').count(), 20, '背包按数据渲染 20 个格子')
  assert.ok(await p.getByText('3', { exact: true }).first().isVisible(), '格子里显示物品数量')
  // 第一个格子选中：高亮显示、锁定图标隐藏（隐藏的控件数就是锁定图标那一个）
  const hiddenInFirstSlot = () =>
    p.evaluate(() => {
      const slot = document.querySelector('[data-ac="WBP_ItemSlot"]')
      if (!slot) return -1
      // 列表条目里的控件没有 data-wid（不能单独选中），按计算样式找隐藏的那个
      return [...slot.querySelectorAll('*')].filter((n) => getComputedStyle(n).visibility === 'hidden').length
    })
  assert.equal(await hiddenInFirstSlot(), 1, '第一格有选中高亮、没有锁定图标')
  await p.getByRole('radio', { name: '数据' }).click()
  await check(p, 'UI设计-数据面板', ['运行时假数据', '只影响画板预览，导出时剔除', 'Items', '添加一行'])
  // 多个数据结构：新建一个集合绑到背包的 Grid 上，画板按控件自己的绑定渲染，不是都用第一个集合
  await p.getByRole('button', { name: '新建集合' }).first().click()
  await check(p, 'UI设计-数据面板-多集合', ['data_2', '0 行', '绑定到列表控件'])
  // 按集合卡片定位：卡片上已经有这个列表控件时下拉不显示它，只有别的集合卡片能换回来
  const bindGrid = async (id) => {
    const card = p.locator('section').filter({ has: p.getByText(id, { exact: true }) })
    await card.getByRole('combobox', { name: '绑定到列表控件' }).click()
    await p.getByRole('option', { name: /^Grid/ }).click()
  }
  await bindGrid('data_2')
  const data2Card = p.locator('section').filter({ has: p.getByText('data_2', { exact: true }) })
  await data2Card.getByText('Grid', { exact: true }).waitFor()
  await check(p, 'UI设计-数据面板-换绑', ['Grid'])
  await p.getByRole('radio', { name: '画板' }).click()
  await p.waitForTimeout(200)
  assert.equal(await p.locator('[data-ac="WBP_ItemSlot"]').count(), 0, '绑到没有行的集合，画板不画格子')
  await p.getByRole('radio', { name: '数据' }).click()
  // 从原来的集合卡片上换回来：同一个列表控件换绑另一个集合
  await bindGrid('items')
  await p.getByRole('radio', { name: '画板' }).click()
  await p.waitForTimeout(200)
  assert.equal(await p.locator('[data-ac="WBP_ItemSlot"]').count(), 20, '换回 Items 又按 20 行渲染')
  await p.getByRole('radio', { name: '数据' }).click()
  // 集合卡片能折叠：折叠后只留卡片头，行数和删除按钮还在；点输入框改名不会误触
  await p.getByRole('button', { name: '收起集合', exact: true }).first().click()
  assert.equal(await p.getByText('20 行', { exact: true }).count(), 1, '折叠后卡片头显示行数')
  await check(p, 'UI设计-数据面板-折叠')
  await p.getByRole('button', { name: '展开集合', exact: true }).first().waitFor()
  assert.equal(await p.getByRole('checkbox', { name: '锁定' }).count(), 0, '折叠后不显示行里的字段')
  assert.ok(
    await p
      .getByText(/^\d+ 行$/)
      .first()
      .isVisible(),
    '折叠后仍显示行数',
  )
  assert.equal(await p.getByRole('button', { name: '删除集合', exact: true }).count(), 2, '折叠后仍能删除集合')
  await p.getByRole('textbox', { name: '集合名称' }).first().click()
  assert.equal(await p.getByRole('button', { name: '展开集合', exact: true }).count(), 1, '点输入框不会展开')
  // 点卡片头的名字区域也能展开
  await p.getByText('items', { exact: true }).click()
  await p.getByRole('checkbox', { name: '锁定' }).first().waitFor()
  // 数据面板改第一行：锁定打开，切回画板就能看到锁
  await p.getByRole('checkbox', { name: '锁定' }).first().check()
  await p.getByRole('radio', { name: '画板' }).click()
  await check(p, 'UI设计-画板数据-锁定')
  await p.waitForTimeout(300)
  assert.equal(await hiddenInFirstSlot(), 0, '第一格按数据改成锁定后显示锁图标')
  // 来回切换不丢编辑
  await p.getByRole('radio', { name: '数据' }).click()
  assert.ok(await p.getByRole('checkbox', { name: '锁定' }).first().isChecked(), '切回来锁定的值还在')
  // 折叠状态按设计记住：切到画板再回来，同一次会话里还保持折叠
  await p.getByRole('button', { name: '收起集合', exact: true }).first().click()
  await p.getByRole('radio', { name: '画板' }).click()
  await p.waitForTimeout(200)
  await p.getByRole('radio', { name: '数据' }).click()
  await p.getByRole('button', { name: '展开集合', exact: true }).first().waitFor()
  assert.equal(await p.getByRole('checkbox', { name: '锁定' }).count(), 0, '切回来还是折叠的')
  assert.ok(
    await p
      .getByText(/^\d+ 行$/)
      .first()
      .isVisible(),
    '切回来仍显示行数',
  )
  await p.getByRole('button', { name: '展开集合', exact: true }).first().click()
  await p.getByRole('radio', { name: '画板' }).click()
  await p.goto(base + '#/design/new')
  await check(p, 'UI设计-新建', ['开始设计'])
  // 先出原画：新的游戏界面默认打开「原画」，AI 先出几张整屏原画，显示在左边挑
  await p.getByRole('textbox').first().fill('背包')
  await p.getByRole('button', { name: '开始设计' }).click()
  // 「原画」按钮右键：设置一次出几张原画，和输入框旁边的「每张 N 版」分开
  await p.getByRole('button', { name: '先出原画' }).click({ button: 'right' })
  await p.getByText('一次出几张原画').waitFor()
  const before = await p.getByRole('menuitemradio', { checked: true }).textContent()
  await p.getByRole('menuitemradio', { name: '2 张' }).click()
  await p.keyboard.press('Escape')
  await p.getByRole('button', { name: '先出原画' }).click({ button: 'right' })
  const after = await p.getByRole('menuitemradio', { checked: true }).textContent()
  assert.notEqual(before, after, '右键菜单能改一次出几张原画，选中状态跟着变')
  // 菜单开着时截图再关：先按 Escape 的话，菜单收起得快时文字已经不在页面上，检查会偶发失败
  await check(p, 'UI设计-原画张数', ['一次出几张原画'])
  await p.keyboard.press('Escape')
  await p.getByRole('textbox', { name: '告诉 AI 要做什么' }).fill('暗黑奇幻风格的背包界面')
  await p.keyboard.press('Enter')
  await p.getByRole('button', { name: '用这张做模板' }).waitFor({ timeout: 15000 })
  await p.getByText(/正在出原画/).waitFor({ state: 'detached', timeout: 20000 })
  await check(p, 'UI设计-原画', ['第 1 轮', '用这张做模板'])
  // 原画阶段就能看到标注工具：工具栏上每种标注有文字（用户报「看不到标注工具」：以前只有图标）
  const board = p.locator('[data-concept-board]')
  const conceptBar = board.getByRole('toolbar', { name: '标注工具' })
  for (const name of ['框选', '箭头', '画笔', '打点', '蒙版']) {
    await conceptBar.getByText(name, { exact: true }).waitFor()
  }
  await check(p, 'UI设计-原画标注工具', ['框选', '箭头', '打点', '选一种标注工具'])
  // 在原画上框一块：工具栏下面给出下一步说明，面板底部出现「发送标注给 AI」按钮
  await conceptBar.getByRole('button', { name: /^框选标注/ }).click()
  const conceptImg = await board.locator('img[alt^="c"]').first().boundingBox()
  assert.ok(conceptImg, '原画显示出来了')
  await p.mouse.move(conceptImg.x + conceptImg.width * 0.25, conceptImg.y + conceptImg.height * 0.35)
  await p.mouse.down()
  await p.mouse.move(conceptImg.x + conceptImg.width * 0.6, conceptImg.y + conceptImg.height * 0.55, { steps: 8 })
  await p.mouse.up()
  await p.getByRole('textbox', { name: '标注说明' }).fill('按钮换成金色描边')
  await p.keyboard.press('Enter')
  const sendMarks = board.getByRole('button', { name: '发送标注给 AI（1）' })
  await sendMarks.waitFor()
  await check(p, 'UI设计-原画标注', ['按钮换成金色描边', '发送标注给 AI（1）'])
  // 标注随消息发给 AI：顶栏按钮直接发，输入框上的标注条清掉，消息里留下这条标注
  await sendMarks.click()
  await sendMarks.waitFor({ state: 'detached' })
  const sent = p.locator('[data-conversation-scroll="messages"]').getByText('按钮换成金色描边')
  await sent.first().waitFor({ timeout: 10000 })
  await check(p, 'UI设计-原画标注发出', ['按钮换成金色描边'])
  // 发出去之后又出一轮新的原画，能接着标
  await p.getByText('第 2 轮').waitFor({ timeout: 20000 })
  await p.getByText(/正在出原画/).waitFor({ state: 'detached', timeout: 20000 })
  // 勾了「只重绘蒙版区域」时按钮上的数字要和实际发出去的条数一致（只会发蒙版那一块）
  await conceptBar.getByRole('button', { name: /^蒙版涂抹/ }).click()
  const img3 = await board.locator('img[alt^="c"]').first().boundingBox()
  await p.mouse.move(img3.x + img3.width * 0.35, img3.y + img3.height * 0.45)
  await p.mouse.down()
  await p.mouse.move(img3.x + img3.width * 0.5, img3.y + img3.height * 0.55, { steps: 6 })
  await p.mouse.up()
  // 涂完蒙版会弹出这一处的说明框：先按 Esc 收起（标注留着），画板窄时它会盖住下面要框选的位置
  await p.keyboard.press('Escape')
  await conceptBar.getByRole('button', { name: /^框选标注/ }).click()
  await p.mouse.move(img3.x + img3.width * 0.6, img3.y + img3.height * 0.3)
  await p.mouse.down()
  await p.mouse.move(img3.x + img3.width * 0.75, img3.y + img3.height * 0.45, { steps: 6 })
  await p.mouse.up()
  await p.getByRole('textbox', { name: '标注说明' }).fill('这里要改')
  await p.keyboard.press('Enter')
  // 勾选「只重绘蒙版区域」后按钮文案要跟实际行为一致：
  // 默认生图方式是图片模型（cli），不支持局部重绘——这种时候勾了也是整张重画、两条标注都发，
  // 按钮就不能写成「按蒙版重绘（1）」（写错了会让人以为只发了一处）
  await board.getByRole('button', { name: '发送标注给 AI（2）' }).waitFor()
  const inpaintToggle = p.getByRole('button', { name: '只重绘蒙版区域' })
  await inpaintToggle.click()
  // 等勾选真的生效（aria-pressed）再断言按钮文案：不然点空了后面的断言就在赌
  await p.waitForFunction(
    () =>
      [...document.querySelectorAll('button[aria-label="只重绘蒙版区域"]')].some(
        (el) => el.getAttribute('aria-pressed') === 'true',
      ),
    undefined,
    { timeout: 5000 },
  )
  // 不支持局部重绘：按钮保持原样，不喊「按蒙版重绘」；提示由勾选按钮自己给（「会整张重画」）
  assert.equal(
    await board.getByRole('button', { name: '按蒙版重绘（1）' }).count(),
    0,
    '不支持局部重绘时不能写成按蒙版重绘',
  )
  await board.getByRole('button', { name: '发送标注给 AI（2）' }).waitFor()
  // 截图在勾选状态下拍：降级提示「会整张重画」就挂在勾选按钮上
  await check(p, 'UI设计-原画标注-不支持局部重绘', ['发送标注给 AI（2）', '会整张重画'])
  await inpaintToggle.click()
  // 清掉这两条，后面蒙版那段从头测
  await conceptBar.getByRole('button', { name: '清除所有标注' }).click()
  // 收起 AI 对话栏时点「发送标注给 AI」也要真的发出去：先自动把对话栏打开，不静默落空
  await p.getByRole('button', { name: '收起 AI 对话' }).click()
  await p.getByRole('textbox', { name: '告诉 AI 要做什么' }).waitFor({ state: 'detached' })
  await conceptBar.getByRole('button', { name: /^框选标注/ }).click()
  const img2 = await board.locator('img[alt^="c"]').first().boundingBox()
  assert.ok(img2, '第二轮的图显示出来了')
  await p.mouse.move(img2.x + img2.width * 0.3, img2.y + img2.height * 0.3)
  await p.mouse.down()
  await p.mouse.move(img2.x + img2.width * 0.55, img2.y + img2.height * 0.5, { steps: 6 })
  await p.mouse.up()
  await p.getByRole('textbox', { name: '标注说明' }).fill('标题再大一点')
  await p.keyboard.press('Enter')
  await board.getByRole('button', { name: '发送标注给 AI（1）' }).click()
  // 对话栏自己打开了，消息也发出去了（标注不会留在图上）
  await p.getByRole('textbox', { name: '告诉 AI 要做什么' }).waitFor({ timeout: 5000 })
  await p.locator('[data-conversation-scroll="messages"]').getByText('标题再大一点').first().waitFor({ timeout: 10000 })
  await p.getByText(/正在出原画/).waitFor({ state: 'detached', timeout: 20000 })
  await check(p, 'UI设计-原画标注-收起对话', ['标题再大一点'])
  // 蒙版：在原画上涂一块，出现蒙版工具和「只重绘蒙版」开关（默认还是整张重画）
  // UI 画布的工具栏也有蒙版按钮，原画面板盖在上面、渲染在后面
  await p.getByRole('button', { name: '蒙版涂抹' }).last().click()
  const maskImg = await p.locator('img[alt^="c"]').first().boundingBox()
  assert.ok(maskImg, '原画显示出来了')
  await p.mouse.move(maskImg.x + maskImg.width * 0.32, maskImg.y + maskImg.height * 0.4)
  await p.mouse.down()
  await p.mouse.move(maskImg.x + maskImg.width * 0.62, maskImg.y + maskImg.height * 0.58, { steps: 8 })
  await p.mouse.up()
  await check(p, 'UI设计-蒙版', ['只重绘蒙版', '蒙版'])
  await p.getByRole('button', { name: '用这张做模板' }).click()
  await p.getByRole('button', { name: '对照模板' }).waitFor({ timeout: 15000 })
  await p.goto(base + '#/design/new')
  // 网页 UI：新建一个网页设计，让 AI 搭首页，看自动布局画出来的样子
  await p.getByRole('radio', { name: /网页 UI/ }).click()
  await p.getByRole('textbox').first().fill('首页')
  await p.getByRole('button', { name: '开始设计' }).click()
  await p.getByRole('textbox', { name: '告诉 AI 要做什么' }).fill('做一个产品首页')
  await p.keyboard.press('Enter')
  // 还没定整体风格：AI 先给几个风格选项，点一个接着做
  await p.getByText('想要什么整体风格？').waitFor({ timeout: 15000 })
  // 问题面板换掉输入框：一次问两个问题，最后一项可以自己输入，全部回答后一起发出去
  await check(p, 'UI设计-问风格', ['想要什么整体风格？', '简约科技', '配色'])
  await p.getByRole('button', { name: /简约科技/ }).click()
  await p.getByText('主色调偏向哪种？').waitFor()
  await p.getByRole('textbox', { name: '自己输入回答' }).fill('蓝紫渐变')
  await check(p, 'UI设计-问配色', ['提交 2 个回答'])
  await p.getByRole('button', { name: '提交 2 个回答' }).click()
  await p.getByText('做好了产品首页').first().waitFor({ timeout: 20000 })
  // 回答显示在对话里：问题一行小字，下面是答案
  // 接着就生成图片，只有几秒：先等它出现再收尾，回答在对话里一直都在，生成完再截
  await p.getByText(/正在生成图片/).waitFor({ timeout: 20000 })
  await p.getByText(/正在生成图片/).waitFor({ state: 'detached', timeout: 30000 })
  await check(p, 'UI设计-回答', ['主色调偏向哪种？', '蓝紫渐变'])
  await check(p, 'UI设计-网页', ['Hero', 'FeatureCard'])
  await p.getByRole('radio', { name: /手机/ }).click()
  await check(p, 'UI设计-网页-手机')
  await p.getByRole('radio', { name: /桌面/ }).click()
  await p.getByRole('button', { name: '版本' }).click()
  await p
    .getByText(/AI 修改前/)
    .first()
    .waitFor()
  await check(p, 'UI设计-版本', ['存版本', 'AI 修改前'])
  await p.keyboard.press('Escape')
  // 侧栏里点设计那一行的图标（不是文字）也能切过去
  const row = await p.getByRole('button', { name: '主菜单', exact: true }).boundingBox()
  await p.mouse.click(row.x - 14, row.y + row.height / 2)
  await p.waitForURL(/demo-design-menu/, { timeout: 5000 })
  // ComfyUI 工作流：游戏和网页分开，内置的只读
  await p.goto(base + '#/comfy/game')
  await check(p, 'ComfyUI-工作流', ['游戏图标 · 道具与技能', '内置，只读', '{{prompt}}', 'KSampler', '导入到 ComfyUI'])
  // 节点图打开时就要适应到画布：节点占满主要区域、文字看得清
  // （以前视口宽的比例缩放成 0.43，上下各留一半空白）
  const graphFit = () =>
    p.evaluate(() => {
      const pane = document.querySelector('.react-flow')
      const viewport = document.querySelector('.react-flow__viewport')
      const nodes = [...document.querySelectorAll('.react-flow__node')]
      if (!pane || !viewport || !nodes.length) return null
      const zoom = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a
      const rects = nodes.map((el) => el.getBoundingClientRect())
      const box = pane.getBoundingClientRect()
      const left = Math.min(...rects.map((r) => r.left))
      const top = Math.min(...rects.map((r) => r.top))
      const right = Math.max(...rects.map((r) => r.right))
      const bottom = Math.max(...rects.map((r) => r.bottom))
      return { zoom, coverW: (right - left) / box.width, coverH: (bottom - top) / box.height }
    })
  const checkGraph = async (where) => {
    const g = await graphFit()
    if (!g) return errors.push(`ComfyUI-节点图 ${where}：没有画出来`)
    if (g.zoom < 0.5) errors.push(`ComfyUI-节点图 ${where}：缩放只有 ${g.zoom.toFixed(2)}，节点文字看不清`)
    if (g.coverW < 0.8 || g.coverH < 0.8)
      errors.push(
        `ComfyUI-节点图 ${where}：节点只占画布宽 ${Math.round(g.coverW * 100)}%、高 ${Math.round(g.coverH * 100)}%，留白太多`,
      )
  }
  await checkGraph('1440')
  await check(p, 'ComfyUI-节点图-1440')
  // 窗口变大节点图跟着变大；窗口窄时也能用，不留大片空白、不横向滚动
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 800 },
  ]) {
    await p.setViewportSize(size)
    await p.waitForTimeout(500)
    await checkGraph(String(size.width))
    await check(p, `ComfyUI-节点图-${size.width}`)
  }
  await p.setViewportSize({ width: 1440, height: 900 })
  // 节点图可以在图形和配置（JSON）之间切换
  await p.getByRole('radio', { name: '配置', exact: true }).click()
  await check(p, 'ComfyUI-节点图配置', ['"class_type"'])
  await p.getByRole('radio', { name: '图形', exact: true }).click()
  // 切回图形要重新适应，不是带着上一次的缩放
  await p.waitForTimeout(500)
  await checkGraph('切回图形')
  // 在 ComfyUI 页点 Agent 模式要能切回去（之前会停在 ComfyUI）
  // 模式切换在左上角的下拉里：先点开，再选菜单项
  await p.getByRole('button', { name: '切换模式' }).click()
  await p.getByRole('menuitemradio', { name: /^Agent 模式/ }).click()
  await p
    .waitForURL((u) => !u.hash.startsWith('#/comfy'), { timeout: 5000 })
    .catch(() => errors.push('在 ComfyUI 页点 Agent 模式没有切过去'))
  await p.goto(base + '#/comfy/game')
  await p.getByRole('radio', { name: '网页 UI' }).click()
  await check(p, 'ComfyUI-网页工作流', ['网页插画'])
  // 换了工作流也要重新适应，不能带着上一个工作流的位置和缩放
  await p.waitForTimeout(500)
  await checkGraph('网页工作流')
  await p.getByRole('button', { name: 'AI 优化' }).click()
  await p.getByRole('button', { name: '出图更清晰、边缘更干净' }).click()
  await p.getByRole('button', { name: '优化', exact: true }).click()
  await check(p, 'ComfyUI-AI优化', ['网页插画（优化）', '保存'])
  await p.keyboard.press('Control+k')
  await check(p, '命令面板', ['新建聊天'])
  await p.keyboard.press('Escape')
})
