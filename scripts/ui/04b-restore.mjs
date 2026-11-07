/**
 * 界面检查分片：UI 设计的「照原画还原」
 *
 * 演示版在浏览器里跑和正式版同一套检测、切图、编译、校验算法：从示例原画开始，
 * 一步步确认（原画 → 拆解 → 切图 → 搭建 → 校验 → 交付），每步都看决策卡和这一步的产物。
 */
import assert from 'node:assert/strict'
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base + '#/design/demo-design-restore')
  await p.locator('[data-restore-card="source"]').waitFor()
  await check(p, '还原-原画', ['照原画还原', '确认，下一步'])

  // 确认当前步骤，等下一步在后台跑完、卡片进入「等你确认」
  const confirm = async (next) => {
    await p.locator('[data-restore-confirm]').click()
    await p.locator(`[data-restore-card="${next}"][data-status="review"]`).waitFor({ timeout: 60000 })
  }

  await confirm('elements')
  // 元素框是算法量出来的：背包格子至少 20 个，点一个能看它的类型和名字
  const slots = p.locator('[data-restore-boxes] [data-kind="slot"]')
  assert.ok((await slots.count()) >= 20, `格子 ${await slots.count()}`)
  await slots
    .nth(5)
    .locator('rect')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await p.locator('[data-restore-inspector]').waitFor()
  await check(p, '还原-拆解', ['等你确认'])

  await confirm('assets')
  await p.locator('[data-restore-assets] figure').first().waitFor()
  await check(p, '还原-切图', ['干净背景'])

  await confirm('build')
  await check(p, '还原-搭建', ['在画布里看'])

  await confirm('verify')
  // 示例原画全部对上：没有标成「没过」的行
  await p.locator('[data-restore-verify] tbody tr').first().waitFor()
  assert.equal(await p.locator('[data-restore-verify] [data-check="bad"]').count(), 0, '校验有没对上的元素')
  await check(p, '还原-校验', ['对上'])

  await confirm('deliver')
  await p.locator('[data-restore-confirm]').click()
  await p.locator('[data-restore-card="deliver"][data-status="done"]').waitFor()
  await p.locator('[data-restore-open-canvas]').click()
  await p.locator('[data-restore-card]').waitFor({ state: 'detached' })
  await check(p, '还原-画布', [])
})
