/**
 * 界面检查分片：UI 设计的「照原画还原」
 *
 * 演示版在浏览器里跑和正式版同一套检测、切图、编译、校验算法：从示例原画开始，
 * 一步步确认（原画 → 拆解 → 切图 → 搭建 → 校验 → 交付），每步都看决策卡和这一步的产物。
 */
import assert from 'node:assert/strict'
import { writePsdBuffer } from 'ag-psd'
import { runShard } from './harness.mjs'

/** 一张小 PSD：背景、面板组（底图 + 3 个格子）、按钮组（常态 + 悬停）、标题文字图层的像素 */
function samplePsd() {
  const solid = (w, h, c) => {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) data.set(c, i * 4)
    return { width: w, height: h, data }
  }
  const layer = (name, left, top, w, h, c) => ({ name, left, top, imageData: solid(w, h, c) })
  const layers = [
    layer('背景', 0, 0, 640, 360, [20, 16, 34, 255]),
    {
      name: 'Panel_Bag',
      children: [
        layer('bg', 60, 40, 520, 280, [60, 44, 90, 255]),
        layer('Slot_A', 90, 80, 72, 72, [14, 10, 24, 255]),
        layer('Slot_B', 176, 80, 72, 72, [14, 10, 24, 255]),
        layer('Slot_C', 262, 80, 72, 72, [14, 10, 24, 255]),
        {
          name: 'Btn_Use',
          children: [
            layer('@normal', 400, 250, 140, 44, [190, 110, 50, 255]),
            layer('@hover', 400, 250, 140, 44, [230, 150, 80, 255]),
          ],
        },
      ],
    },
  ]
  // 合成图：可见图层从下到上叠（悬停态不画）
  const comp = solid(640, 360, [0, 0, 0, 255])
  const draw = (list) => {
    for (const l of list) {
      if (l.children) draw(l.children.filter((k) => k.name !== '@hover'))
      else
        for (let y = 0; y < l.imageData.height; y++)
          comp.data.set(
            l.imageData.data.subarray(y * l.imageData.width * 4, (y + 1) * l.imageData.width * 4),
            ((y + l.top) * 640 + l.left) * 4,
          )
    }
  }
  draw(layers)
  return writePsdBuffer({ width: 640, height: 360, imageData: comp, children: layers })
}

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

  // PSD：新建时选 PSD，图层直接成元素（不检测），按钮的悬停态用 PSD 里画的那张
  await p.goto(base + '#/design/new')
  await p.getByRole('radio', { name: '照原画还原' }).click()
  await p.locator('[data-restore-art]').setInputFiles({
    name: 'bag.psd',
    mimeType: 'image/vnd.adobe.photoshop',
    buffer: samplePsd(),
  })
  await p.getByText('PSD：按图层还原').waitFor()
  await p.getByRole('button', { name: '开始还原' }).click()
  await p.locator('[data-restore-card="source"]').waitFor()
  await check(p, '还原-PSD-原画', ['图层元素'])
  await confirm('elements')
  await check(p, '还原-PSD-拆解', ['从 PSD 图层读出'])
  assert.equal(await p.locator('[data-restore-boxes] [data-kind="slot"]').count(), 3, 'PSD 的 3 个格子')
  await confirm('assets')
  await p.locator('[data-restore-assets] figure').filter({ hasText: 'Btn_Use_Hover' }).waitFor()
  await confirm('build')
  await confirm('verify')
  assert.equal(await p.locator('[data-restore-verify] [data-check="bad"]').count(), 0, 'PSD 校验有没对上的元素')
})
