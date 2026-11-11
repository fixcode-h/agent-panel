/**
 * 界面检查分片：模式切换只有 Agent / Chat、旧的 UI 设计地址转到插件整页、ComfyUI 工作流、命令面板
 * UI 设计本身搬进了 UI 设计插件（fixcode-h/agent-plugins 的 ui-design），它的界面在插件那边测
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors }) => {
  const p = await page({ width: 1440, height: 900 })
  // 侧栏顶上的模式切换只有 Agent 和 Chat 两个：UI 设计、模型设计都是插件的整页，入口在图标栏（ADR 0059，插件接口 5）
  await p.goto(base + '#/home')
  const modes = await p.getByRole('radiogroup', { name: '模式' }).first().getByRole('radio').count()
  if (modes !== 2) errors.push(`模式切换应该只有 Agent、Chat 两个，现在是 ${modes} 个`)
  await check(p, '模式切换-两个', ['新建任务'])
  // 旧的 UI 设计地址（面板自带时的 #/design/…、设计模式时的 #/pdesign/ui/…）收藏过的照样能打开：
  // 转到 UI 设计插件的整页，子位置原样带过去；演示里没装插件，说明插件没有打开
  await p.goto(base + '#/design/demo-design-menu/inspect')
  await p
    .waitForURL(/#\/plugin\/ui-design\/ui\/demo-design-menu\/inspect$/, { timeout: 5000 })
    .catch(() => errors.push(`旧地址 #/design/… 没有转到 UI 设计插件页：${p.url()}`))
  await check(p, '设计-旧地址', ['插件没有打开'])
  await p.goto(base + '#/pdesign/ui/demo-design-menu')
  await p
    .waitForURL(/#\/plugin\/ui-design\/ui\/demo-design-menu$/, { timeout: 5000 })
    .catch(() => errors.push(`旧地址 #/pdesign/ui/… 没有转到 UI 设计插件页：${p.url()}`))
  // ComfyUI 工作流（照设计稿 ComfyUI 画板）：列表按游戏 / 网页 / 图片处理分组，内置的只读；
  // 入口在图标栏的通用功能里（视频画质增强也用它），哪个模式下都有
  await p.goto(base + '#/comfy/game')
  await check(p, 'ComfyUI-工作流', [
    '游戏图标 · 道具与技能',
    '内置，只读',
    '{{prompt}}',
    'KSampler',
    '导入到 ComfyUI',
    '试生成',
  ])
  if (!(await p.locator('[data-activity-bar]').getByRole('button', { name: 'ComfyUI 工作流' }).count()))
    errors.push('ComfyUI 页：图标栏里没有 ComfyUI 工作流的入口')
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
  // 画布现在撑满整块（上下还浮着工具条和试生成）：按宽或按高有一边铺满就算适应好了
  const checkGraph = async (where) => {
    const g = await graphFit()
    if (!g) return errors.push(`ComfyUI-节点图 ${where}：没有画出来`)
    if (g.zoom < 0.5) errors.push(`ComfyUI-节点图 ${where}：缩放只有 ${g.zoom.toFixed(2)}，节点文字看不清`)
    if (Math.max(g.coverW, g.coverH) < 0.75)
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
  // 点画布上的节点：右栏切到「节点」，列出它的参数
  await p.locator('.react-flow__node').first().click()
  await p
    .getByText(/ · #\w+$/)
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('ComfyUI：点节点后右栏没有显示它的参数'))
  await check(p, 'ComfyUI-节点参数')
  // 在 ComfyUI 页点 Agent 模式要能切回去（之前会停在 ComfyUI）
  // ComfyUI 页让开了会话侧栏，模式切换竖排在图标栏里
  await p.getByRole('radio', { name: /^Agent 模式/ }).click()
  await p
    .waitForURL((u) => !u.hash.startsWith('#/comfy'), { timeout: 5000 })
    .catch(() => errors.push('在 ComfyUI 页点 Agent 模式没有切过去'))
  if (!(await p.locator('[data-activity-bar]').getByRole('button', { name: 'ComfyUI 工作流' }).count()))
    errors.push('Agent 模式下图标栏里也要有 ComfyUI 工作流的入口')
  await p.goto(base + '#/comfy/game')
  await p
    .getByRole('button', { name: /网页插画/ })
    .first()
    .click()
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
