/**
 * 界面检查分片：设置 →「Agent 工具」→「技能」（ADR 0083）：技能目录按来源分组、搜索、开关自动推送，
 * 详情里改条件、「每个对话都带」、恢复默认、最近推送。演示数据由 web/src/lib/demo/demo-agent-tools.ts 给。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await p.getByRole('button', { name: '设置' }).first().click()
  await p.getByRole('button', { name: 'Agent 工具', exact: true }).click()
  await check(p, '设置-Agent工具-技能', ['技能', '自带', '插件 · Unreal Engine', 'lua-code-style', '单个对话推送上限'])

  // 点一行看详情：条件、最近推送
  await p.locator('[data-skill="lua-code-style"] button').first().click()
  await check(p, '设置-Agent工具-技能详情', [
    '什么时候推（任意一条对上）',
    '最近推送',
    '背包出售按钮没反应',
    '压缩后补推',
  ])

  // 搜索：只剩对得上的
  await p.getByPlaceholder('搜索技能').fill('debug')
  if ((await p.locator('[data-skill]').count()) !== 1)
    errors.push('设置-Agent工具：搜 debug 应该只剩 systematic-debugging')
  await p.getByPlaceholder('搜索技能').fill('')

  // 关掉自动推：右边出现「已改」和「恢复默认」，恢复后消失
  await p.getByRole('switch', { name: '自动推 lua-code-style' }).click()
  await check(p, '设置-Agent工具-关掉自动推', ['已改', '恢复默认'])
  await p.getByRole('button', { name: '恢复默认' }).click()
  await p.waitForTimeout(200)
  if (await p.locator('[data-skill-detail] >> text=已改').count())
    errors.push('设置-Agent工具：恢复默认后还标着「已改」')

  // 加一条条件：填好失焦后存下，列表摘要跟着变
  await p.getByRole('button', { name: '加条件' }).click()
  const value = p.getByRole('textbox', { name: '条件的值' }).last()
  await value.fill('**/*.luau')
  await value.blur()
  await check(p, '设置-Agent工具-加条件', ['改 **/*.luau 前'])

  // 每个对话都带：列表行上出现徽标
  await p.getByRole('switch', { name: '每个对话都带' }).click()
  await check(p, '设置-Agent工具-每个对话都带', ['每个对话都带'])
  if (!(await p.locator('[data-skill="lua-code-style"] >> text=每个对话都带').count()))
    errors.push('设置-Agent工具：设成每个对话都带后列表行没有徽标')
})
