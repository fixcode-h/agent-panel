/**
 * 界面检查分片：模式切换只有 Agent / Chat、旧的 UI 设计、ComfyUI 工作流地址转到插件整页、命令面板
 * UI 设计、ComfyUI 工作流页本身搬进了插件（fixcode-h/agent-plugins 的 ui-design、comfy），它们的界面在插件那边测
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
  // 面板自带的 ComfyUI 工作流页搬进了 Comfy 插件（复查报告 C3）：旧地址 #/comfy/<分类>/<工作流> 转到插件整页，
  // 子位置原样带过去；演示里没装插件，说明插件没有打开。图标栏里不再有面板自带的入口
  await p.goto(base + '#/comfy/web/demo-wf')
  await p
    .waitForURL(/#\/plugin\/comfy\/comfy\/web\/demo-wf$/, { timeout: 5000 })
    .catch(() => errors.push(`旧地址 #/comfy/… 没有转到 Comfy 插件页：${p.url()}`))
  await check(p, 'ComfyUI-旧地址', ['插件没有打开'])
  await p.keyboard.press('Control+k')
  await check(p, '命令面板', ['新建聊天'])
  await p.keyboard.press('Escape')
})
