/**
 * 界面检查分片：手机宽度（分析稿 U9）。外网访问时在手机上处理「等你处理」是真实用法，
 * 这一片按手机宽度把「首页 → 总览 → 点进去 → 看报告 → 确认」这条路走一遍：
 * 首页的三个选择器不截断，总览的 Bug 行点得进去，报告弹窗的主按钮在屏幕里，确认后子对话铺满整屏。
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 */
import { runShard } from './harness.mjs'
import { patchDemoOnce } from './task-page.mjs'

const PHONE = { width: 390, height: 844 }

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page(PHONE)
  await p.goto(base)
  await p.locator('#task-prompt').waitFor({ timeout: 15000 })
  // 首页：Agent、模型、强度三个选择器整个换行，不被挤成「Claude C…」「med…」
  {
    const picks = p.getByRole('button', { name: /^(对话用的 Agent|模型|思考强度)$/ })
    await picks
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('手机首页：没有 Agent / 模型 / 强度选择器'))
    const cut = await picks.evaluateAll((els) =>
      els
        .map((el) => {
          const text = el.querySelector('.truncate')
          return text && text.scrollWidth > text.clientWidth + 1 ? el.getAttribute('aria-label') : ''
        })
        .filter(Boolean),
    )
    if (cut.length) errors.push(`手机首页：选择器被截断了（${cut.join('、')}）`)
    await check(p, '手机-首页')
  }

  // 造一个在等你确认修复方案的 Bug（演示数据种子写完之后、下一次加载之前改，见 patchDemoOnce）
  await patchDemoOnce(p, 'mobile-bug', (db) => {
    const parent = db.tasks.find((x) => x.title.includes('购物车右上角'))
    const kid = db.tasks.find((x) => x.parentTaskId === parent.id && x.title.includes('修侧栏时间显示'))
    Object.assign(kid, { resolved: false, status: 'done', working: false, bug: { kind: 'report' }, requests: [] })
    const base = {
      at: new Date().toISOString(),
      symptom: '购物车角标在删除最后一件商品后仍显示 1',
      rootCause: 'store.ts 删除最后一件时提前 return，没有通知订阅者',
      confirmed: true,
      fix: '去掉提前 return',
      files: ['web/src/cart/store.ts'],
      verify: 'store.test.ts',
      level: 'standard',
      options: [
        { id: 'A', title: '去掉提前 return', change: 'store.ts:52', files: ['web/src/cart/store.ts'], covers: '角标' },
        {
          id: 'B',
          title: '角标自己轮询数量',
          change: 'badge.ts 定时读',
          files: [],
          covers: '角标',
          misses: '别的订阅者',
        },
      ],
      chosen: { id: 'A', why: '修在源头', whyNotOthers: 'B 只是绕过' },
      changes: [{ file: 'web/src/cart/store.ts', what: 'remove 去掉提前 return' }],
      answers: [],
      notes: [],
      overall: '',
      before: [],
    }
    kid.bug.diagnoses = [
      { ...base, phase: 'cause', version: 1, rev: 1, status: 'approved' },
      { ...base, phase: 'plan', version: 2, rev: 1, status: 'pending' },
    ]
  })
  // 总览 → Bug 视图：等你确认的那一行在最上面一组，点进去打开父对话、右栏切到这个子对话
  await p.goto(base + '#/overview')
  await p.reload()
  await p.locator('[data-seg-id="bugs"]').click({ timeout: 10000 })
  const row = p.locator('[data-bug-row]').filter({ hasText: '修侧栏时间显示' }).first()
  await row.waitFor({ timeout: 8000 }).catch(() => errors.push('手机总览：Bug 视图没有列出等你确认的 Bug'))
  await check(p, '手机-总览Bug', ['等你确认'])
  await row.click()
  // 报告交上来、等你确认：打开这个对话时自动弹出；没弹就从子对话的报告卡片点开
  const dlg = p.getByRole('dialog')
  const confirm = dlg.getByRole('button', { name: '确认方案，开始修' })
  if (
    !(await confirm.waitFor({ timeout: 8000 }).then(
      () => true,
      () => false,
    ))
  ) {
    await p
      .getByRole('button', { name: '查看报告' })
      .filter({ visible: true })
      .first()
      .click({ timeout: 8000 })
      .catch(() => errors.push('手机：打开对话后找不到「查看报告」'))
  }
  await confirm.waitFor({ timeout: 8000 }).catch(() => errors.push('手机：报告弹窗里没有「确认方案，开始修」'))
  // 底栏按钮一行放不下时换行：主按钮整个在屏幕里，不被挤出右边
  const box = await confirm.boundingBox()
  if (!box || box.x < 0 || box.x + box.width > PHONE.width)
    errors.push(`手机：报告弹窗的「确认方案，开始修」超出屏幕（${box ? Math.round(box.x + box.width) : '没有'}）`)
  await check(p, '手机-诊断报告', ['候选方案'])
  await confirm.click()
  await dlg
    .first()
    .waitFor({ state: 'detached', timeout: 8000 })
    .catch(() => errors.push('手机：确认后报告弹窗没有关掉'))
  await settle(p)
  // 子对话在右栏抽屉里：手机宽度下铺满整屏，不是挤在右边两百多像素
  const drawer = await p
    .locator('[data-task-panel]')
    .filter({ visible: true })
    .first()
    .boundingBox()
    .catch(() => null)
  if (!drawer || drawer.width < PHONE.width - 1)
    errors.push(`手机：子对话抽屉没有铺满屏幕（宽 ${drawer ? Math.round(drawer.width) : 0}px）`)
  await check(p, '手机-确认后的子对话')
})
