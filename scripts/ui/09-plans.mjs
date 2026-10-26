/**
 * 界面检查分片：计划面板（列表、新建的默认模板、编辑、启用开关、立即执行、删除）
 *
 * 演示数据里预置了一条「今日工作」计划；演示版不会真的启动对话，点「立即执行」只会给一句提示。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base + '#/schedules')
  await check(p, '计划列表', ['计划', '今日工作', '待执行', '每天', '下次执行', '新建计划'])

  // 新建：默认已经按「今日工作」模板填好，改两处就能存
  await p.getByRole('button', { name: '新建计划' }).click()
  const dlg = p.getByRole('dialog')
  await check(p, '新建计划', ['已按「今日工作」填好', '到点后执行的对话内容', '重复', '执行时间'])
  const name = await dlg.getByLabel('名称').inputValue()
  if (name !== '今日工作') errors.push(`新建计划：名称默认是「${name}」，不是「今日工作」`)
  const daily = await dlg.getByRole('radio', { name: '每天' }).getAttribute('aria-checked')
  if (daily !== 'true') errors.push('新建计划：重复默认不是「每天」')
  await dlg.getByLabel('名称').fill('下午茶提醒')
  await dlg.getByLabel('到点后执行的对话内容').fill('提醒大家喝水和起来走走')
  await dlg.getByRole('button', { name: '保存' }).click()
  await dlg.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => errors.push('新建计划：保存后弹窗没有关上'))
  await check(p, '新建后', ['下午茶提醒', '每天'])

  const row = p.locator('li', { hasText: '下午茶提醒' })
  // 编辑：改完名字列表跟着变
  await row.getByRole('button', { name: '编辑' }).click()
  await p.getByRole('dialog').getByLabel('名称').fill('下午茶时间')
  await p.getByRole('dialog').getByRole('button', { name: '保存' }).click()
  await p
    .getByRole('dialog')
    .waitFor({ state: 'hidden', timeout: 15000 })
    .catch(() => errors.push('编辑：保存后弹窗没有关上'))
  await check(p, '编辑后', ['下午茶时间'])
  if (await p.getByText('下午茶提醒', { exact: true }).count()) errors.push('编辑后：旧名字还在列表里')

  // 立即执行：演示版不会真的启动对话，给一句提示
  await p.getByRole('button', { name: '立即执行' }).first().click()
  await check(p, '立即执行提示', ['在线演示里不会真的启动对话'])

  // 停用：状态变成「已停用」，「下次执行」不再显示
  const fresh = p.locator('li', { hasText: '下午茶时间' })
  await fresh.getByRole('switch', { name: '启用这条计划' }).click()
  await check(p, '停用后', ['已停用'])
  const freshText = (await fresh.innerText()).replace(/\s+/g, ' ')
  if (freshText.includes('下次执行')) errors.push('停用后：还显示「下次执行」')

  // 删除：确认框里说清是哪条，确认后列表里不再有它
  await fresh.getByRole('button', { name: '删除' }).click()
  await check(p, '删除确认', ['删除计划「下午茶时间」？', '删除后不会再执行'])
  await p.getByRole('dialog').getByRole('button', { name: '删除' }).click()
  await p
    .getByText('下午茶时间', { exact: true })
    .waitFor({ state: 'detached', timeout: 10000 })
    .catch(() => errors.push('删除后：列表里还有这条计划'))
  await check(p, '删除后', ['今日工作'])

  // 手机宽度：卡片和操作按钮都能放下，不出现横向滚动
  await p.setViewportSize({ width: 390, height: 844 })
  await p.goto(base + '#/schedules')
  await check(p, '计划-手机宽度', ['今日工作', '新建计划'])
})
