/**
 * 界面检查分片：设置 →「MCP」（ADR 0064）：总览的「检查 Agent 能拿到什么」、来源卡片、面板自带服务的工具列表
 * （按用途 / 按对话类型分组、展开看交给 Agent 的说明原文）、你装的 MCP 的入口；设置 →「组件」里的「MCP 能力」示例。
 *
 * 和其他分片并行跑（见 harness.mjs），演示数据由 web/src/lib/demo/demo-mcp-catalog.ts 给。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await p.getByRole('button', { name: '设置' }).first().click()
  await p.getByRole('button', { name: 'MCP', exact: true }).click()
  await check(p, '设置-MCP-总览', ['检查 Agent 能拿到什么', '来源', 'Agent 面板', '有说明'])
  // 自检是现算的：切到「工作流节点」后面板服务那一行还在，并且给出挂上的个数
  await p.getByRole('radio', { name: '工作流节点' }).click()
  await check(p, '设置-MCP-自检-工作流节点', ['agent-panel', '按真实规则现算'])

  // 面板自带服务：工具行有作用和「什么时候用」，分组能切
  await p
    .getByRole('button', { name: /Agent 面板/ })
    .first()
    .click()
  await check(p, '设置-MCP-面板工具', ['MCP 服务 agent-panel', '什么时候挂', '按用途', '该用', '别用'])
  // 展开一行：能看到交给 Agent 的说明原文和参数
  const row = p.getByRole('dialog').locator('li > button[aria-expanded="false"]').first()
  if (!(await row.count())) errors.push('设置-MCP-面板工具：没有能展开的工具行')
  else {
    await row.click()
    await check(p, '设置-MCP-面板工具-展开', ['交给 Agent 的原文'])
  }
  await p.getByRole('radio', { name: '按对话类型' }).click()
  await check(p, '设置-MCP-面板工具-按对话类型', ['父对话', '工作流节点'])
  // 你装的 MCP：只给入口
  await p
    .getByRole('button', { name: /你装的 MCP/ })
    .first()
    .click()
  await check(p, '设置-MCP-你装的', ['打开「MCP 工具」页'])

  // 共用组件能在设置 →「组件」里看到和微调
  await p.getByRole('dialog').getByRole('button', { name: '组件', exact: true }).first().click({ force: true })
  await check(p, '设置-组件-MCP 能力', ['MCP 能力', '运行时对象', '改属性'])
})
