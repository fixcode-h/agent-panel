/**
 * 界面检查分片：UI 设计（游戏界面、网页、动画、标注、AI 对话）和 ComfyUI 工作流、命令面板
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import assert from 'node:assert/strict'
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base + '#/design/demo-design-menu')
  await check(p, 'UI设计', ['控件树', 'AI 对话', 'StartGroup'])
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
  // 思考、调设计工具、说明按顺序边出边显示
  await p.getByText('check', { exact: true }).first().waitFor({ timeout: 15000 })
  // 生成图片只有几秒：一出现就先截「生成中」，再截写入的工具调用（机器慢时先截写入会错过生成中）
  await p.getByText(/正在生成图片 \d+\/\d+/).waitFor({ timeout: 15000 })
  await check(p, 'UI设计-生成中', ['正在生成图片'])
  await check(p, 'UI设计-写入', ['replace_widget'])
  await p.getByText(/正在生成图片/).waitFor({ state: 'detached', timeout: 20000 })
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
  await p.keyboard.press('Escape')
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
  // 数据面板改第一行：锁定打开，切回画板就能看到锁
  await p.getByRole('checkbox', { name: '锁定' }).first().check()
  await p.getByRole('radio', { name: '画板' }).click()
  await check(p, 'UI设计-画板数据-锁定')
  await p.waitForTimeout(300)
  assert.equal(await hiddenInFirstSlot(), 0, '第一格按数据改成锁定后显示锁图标')
  // 来回切换不丢编辑
  await p.getByRole('radio', { name: '数据' }).click()
  assert.ok(await p.getByRole('checkbox', { name: '锁定' }).first().isChecked(), '切回来锁定的值还在')
  await p.getByRole('radio', { name: '画板' }).click()
  await p.goto(base + '#/design/new')
  await check(p, 'UI设计-新建', ['开始设计'])
  // 先出原画：新的游戏界面默认打开「原画」，AI 先出几张整屏原画，显示在左边挑
  await p.getByRole('textbox').first().fill('背包')
  await p.getByRole('button', { name: '开始设计' }).click()
  await p.getByRole('textbox', { name: '告诉 AI 要做什么' }).fill('暗黑奇幻风格的背包界面')
  await p.keyboard.press('Enter')
  await p.getByRole('button', { name: '用这张做模板' }).waitFor({ timeout: 15000 })
  await p.getByText(/正在出原画/).waitFor({ state: 'detached', timeout: 20000 })
  await check(p, 'UI设计-原画', ['第 1 轮', '用这张做模板'])
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
  await p.getByRole('radio', { name: /^Agent 模式/ }).click()
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
