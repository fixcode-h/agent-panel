/**
 * 界面检查分片：对话里「学到经验」的卡片（web/src/components/tasks/LearnedCard.tsx）。
 * 演示的购物车对话在总结后面挂了一张：一条新加、一条并入已有、一条没收下（web/src/lib/demo-experience.ts）。
 * 断言按条展示、悬停出操作、删掉后原地留痕能撤销、停用能恢复、撤回合并后不再标「并入已有」、
 * 「全部经验」打开项目设置的经验页。和其他分片一样自己从头生成演示数据
 */

import { runShard } from './harness.mjs'
import { openCartTask } from './task-page.mjs'

await runShard(import.meta.filename, async (api) => {
  const { check, errors } = api
  const p = await openCartTask(api)
  const card = p.locator('.learned-card').first()
  const shown = await card.waitFor({ timeout: 10000 }).then(
    () => true,
    () => false,
  )
  if (!shown) {
    errors.push('学到经验卡片：购物车对话里没有出现')
    return
  }
  await card.scrollIntoViewIfNeeded()
  const rows = card.locator(':scope > .divide-y > .group')
  if ((await rows.count()) !== 2) errors.push(`学到经验卡片：应该一条一行共 2 行，实际 ${await rows.count()} 行`)
  for (const text of ['学到 2 条经验', '新加', '并入已有', '另有 1 条没收下'])
    if (!(await card.getByText(text, { exact: false }).count())) errors.push(`学到经验卡片：没有「${text}」`)
  await check(p, '学到经验-按条展示')

  // 悬停出编辑、停用、删除；删掉后这一行原地标「已删除」，撤销能加回来
  const first = rows.nth(0)
  await first.hover()
  await first.getByRole('button', { name: '不对，删掉' }).click()
  await first
    .getByText('已删除')
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('学到经验卡片：删掉后这一行没有标「已删除」'))
  await check(p, '学到经验-删掉后留痕')
  await first.getByRole('button', { name: '撤销' }).click()
  await first
    .getByText('已删除')
    .waitFor({ state: 'detached', timeout: 3000 })
    .catch(() => errors.push('学到经验卡片：撤销删除后还标着「已删除」'))

  // 停用 → 已停用 · 恢复
  const second = rows.nth(1)
  await second.hover()
  await second.getByRole('button', { name: '停用' }).click()
  await second
    .getByText('已停用')
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('学到经验卡片：停用后这一行没有标「已停用」'))
  await second.getByRole('button', { name: '恢复' }).click()

  // 展开并入已有的那条：说明并进了哪条、能撤回这次合并；撤回后不再标「并入已有」
  await second.locator('button[aria-expanded]').first().click()
  if (!(await second.getByText('并入已有的一条', { exact: false }).count()))
    errors.push('学到经验卡片：展开并入已有的那条时没说明并进了哪条')
  await check(p, '学到经验-展开并入已有')
  await second.getByRole('button', { name: '撤回这次合并' }).click()
  await second
    .getByText('已撤回合并')
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('学到经验卡片：撤回合并后没有标「已撤回合并」'))

  // 「全部经验」打开项目设置的经验页
  await card.getByRole('button', { name: '全部经验' }).click()
  await p
    .getByText('项目经验')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('学到经验卡片：点「全部经验」没有打开项目设置的经验页'))
  await check(p, '学到经验-全部经验')
  // 命中记录：每条写用上几次、最近一次；切到「很久没用上的在前」后从没用上的排最前
  await p.getByRole('radio', { name: '很久没用上的在前' }).click()
  await check(p, '项目经验-很久没用上', ['用上 7 次', '还没用上'])
})
