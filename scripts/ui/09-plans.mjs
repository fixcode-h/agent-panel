/**
 * 界面检查分片：计划面板（分组、下次执行时间、最近一次结果、新建、编辑、立即执行、停用、删除）
 *
 * 演示数据里预置了一条「今日工作」计划；演示版不会真的启动对话，点「立即执行」只会给一句提示。
 * 错过和启动失败的两条计划通过 localStorage 造：演示后端的计划存在那里，改完要整页重载才会读到。
 */
import { runShard } from './harness.mjs'

const KEY = 'agent-panel-demo-v3'

await runShard(import.meta.filename, async ({ base, page, check, errors }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base + '#/schedules')
  await check(p, '计划列表', ['计划', '今日工作', '新建计划', '即将执行', '下次执行', '每天'])

  /** 分组标题（h2 的文字里带着数量） */
  const groupHeading = (name) => p.getByRole('heading', { name: new RegExp(`^${name}`) })
  /** 某一组的卡片里看到的文字（空白压成一行，方便断言） */
  const groupText = async (name) =>
    (await p.locator('section').filter({ hasText: name }).first().innerText()).replace(/\s+/g, ' ')
  /** 组标题上的数量 */
  const groupCount = async (name) => {
    const h = groupHeading(name).first()
    await h.waitFor({ timeout: 5000 })
    const text = (await h.innerText()).replace(/\s+/g, ' ').trim()
    return Number(text.slice(name.length).trim())
  }

  // 即将执行：预置的今日工作在最上面，下次执行写清绝对时间和相对时间
  if ((await groupCount('即将执行')) !== 1) errors.push('计划列表：「即将执行」组的数量不是 1')
  const upcoming = await groupText('即将执行')
  if (!/下次执行/.test(upcoming)) errors.push('计划列表：卡片上没有「下次执行」')
  if (!/19:00/.test(upcoming)) errors.push('计划列表：今日工作没有显示 19:00 这个时间')
  if (!/（[^）]*(后|到点)[^）]*）/.test(upcoming))
    errors.push(`计划列表：下次执行没有相对时间：${upcoming.slice(0, 80)}`)

  // 新建：弹窗里时间与重复在前、角色与项目其次、提示词最后；默认已按「今日工作」填好
  await p.getByRole('button', { name: '新建计划' }).click()
  const dlg = p.getByRole('dialog')
  await check(p, '新建计划', [
    '填入「今日工作」模板',
    '执行时间',
    '重复',
    '用哪个角色',
    '在哪个项目里执行',
    '到点后执行的对话内容',
  ])
  const name = await dlg.getByLabel('名称').inputValue()
  if (name !== '今日工作') errors.push(`新建计划：名称默认是「${name}」，不是「今日工作」`)
  const daily = await dlg.getByRole('radio', { name: '每天' }).getAttribute('aria-checked')
  if (daily !== 'true') errors.push('新建计划：重复默认不是「每天」')
  const atValue = await dlg.getByLabel('执行时间').inputValue()
  if (!/^\d{4}-\d{2}-\d{2}T19:00$/.test(atValue)) errors.push(`新建计划：执行时间默认不是 19:00（${atValue}）`)
  // 改乱之后一键填回模板
  await dlg.getByLabel('名称').fill('随便写')
  await dlg.getByRole('radio', { name: '只执行一次' }).click()
  await dlg.getByRole('button', { name: '填入「今日工作」模板' }).click()
  if ((await dlg.getByLabel('名称').inputValue()) !== '今日工作') errors.push('填入模板：名称没有填回「今日工作」')
  if ((await dlg.getByRole('radio', { name: '每天' }).getAttribute('aria-checked')) !== 'true')
    errors.push('填入模板：重复没有填回「每天」')
  await dlg.getByLabel('名称').fill('下午茶提醒')
  await dlg.getByLabel('到点后执行的对话内容').fill('提醒大家喝水和起来走走')
  await dlg.getByRole('button', { name: '保存' }).click()
  await dlg.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => errors.push('新建计划：保存后弹窗没有关上'))
  await check(p, '新建后', ['下午茶提醒'])

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

  // 立即执行：演示版不会真的启动对话，但最近一次结果照正式后端的字段更新
  const fresh = p.locator('li', { hasText: '下午茶时间' })
  await fresh.getByRole('button', { name: '立即执行' }).click()
  await check(p, '立即执行提示', ['在线演示里不会真的启动对话'])
  await p
    .getByText('已启动', { exact: true })
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('立即执行后：最近一次结果没有显示「已启动」'))

  // 停用：卡片移到「已停用」组，下次执行显示「不会再次执行」
  await fresh.getByRole('button', { name: '停用' }).click()
  await groupHeading('已停用')
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('停用后：没有出现「已停用」分组'))
  if (!(await groupText('已停用')).includes('下午茶时间')) errors.push('停用后：卡片没有归到「已停用」组')
  if (!(await fresh.innerText()).includes('不会再次执行')) errors.push('停用后：没有显示「不会再次执行」')
  if ((await fresh.innerText()).includes('下次执行')) errors.push('停用后：还显示「下次执行」')

  // 删除：先确认再删，确认前列表里还有
  await fresh.getByRole('button', { name: '删除' }).click()
  await check(p, '删除确认', ['删除计划「下午茶时间」？', '删除后不会再执行'])
  if (!(await p.getByText('下午茶时间', { exact: true }).count())) errors.push('删除确认：还没确认就把计划删掉了')
  await p.getByRole('dialog').getByRole('button', { name: '删除' }).click()
  await p
    .getByText('下午茶时间', { exact: true })
    .waitFor({ state: 'detached', timeout: 10000 })
    .catch(() => errors.push('删除后：列表里还有这条计划'))
  await check(p, '删除后', ['今日工作'])

  // 造两条出过问题的计划（错过 / 启动失败）和一条已停用的，验证分组和「最近一次结果」
  await p.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key))
    const now = Date.now()
    const day = 86_400_000
    const iso = (ms) => new Date(ms).toISOString()
    const at19 = (ms) => {
      const d = new Date(ms)
      d.setHours(19, 0, 0, 0)
      return d.toISOString()
    }
    const base = {
      prompt: '总结今天做的工作',
      projectId: '',
      agentId: '',
      repeat: 'daily',
      enabled: true,
      status: 'pending',
      lastRunAt: '',
      lastTaskId: '',
      missedAt: '',
      lastError: '',
      createdAt: iso(now),
      updatedAt: iso(now),
    }
    db.schedules.push(
      // 错过：下次执行还在，最近一次结果是昨天那次没跑；带一条旧错误，验证「上次启动失败：」前缀后仍能展开
      {
        ...base,
        id: 'ui-missed',
        name: '每日站会',
        at: at19(now + day),
        missedAt: at19(now - day),
        lastError: '项目「老项目」已经不存在，到点启动会失败，请重新选择',
      },
      // 启动失败：单次已经跳过，错误原文比一行长，能展开
      {
        ...base,
        id: 'ui-failed',
        name: '周报提醒',
        repeat: 'once',
        status: 'skipped',
        at: iso(now - day),
        lastError: '项目「老项目」已经不存在：它在项目页里被删掉了，这条计划没法启动对话，重新选一个项目再保存。',
      },
      { ...base, id: 'ui-off', name: '旧提醒', enabled: false, at: iso(now - day) },
    )
    localStorage.setItem(key, JSON.stringify(db))
  }, KEY)
  // 演示后端把数据缓存在内存里，只改 localStorage 不重载会被它覆盖回去
  await p.reload()

  await check(p, '出过问题', ['出过问题', '错过', '面板当时没在跑', '启动失败', '项目「老项目」已经不存在'])
  if ((await groupCount('出过问题')) !== 2)
    errors.push(`出过问题：分组数量不是 2（实际 ${await groupCount('出过问题')}）`)
  if ((await groupCount('已停用')) !== 1) errors.push('已停用：分组数量不是 1（旧提醒应该在停用组）')
  if (!(await groupText('已停用')).includes('旧提醒')) errors.push('已停用：旧提醒没有归到停用组')
  const missed = p.locator('li', { hasText: '每日站会' })
  if (!(await missed.innerText()).includes('下次执行')) errors.push('错过的计划：每天的计划还应该显示下次执行')
  // 错过 + 旧错误：渲染文本带「上次启动失败：」前缀，超过 30 字时必须有「展开全文」
  await missed
    .getByRole('button', { name: '展开全文', exact: true })
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('错过 + 旧错误：前缀加进去后被截断却没有「展开全文」'))
  // 「收起」这类词页面上别处也有（name 默认是子串匹配），限定到这张卡片里并精确匹配
  const failedCard = p.locator('li', { hasText: '周报提醒' })
  await failedCard
    .getByRole('button', { name: '展开全文', exact: true })
    .click({ timeout: 5000 })
    .catch(() => errors.push('启动失败：长错误没有「展开全文」'))
  await failedCard
    .getByRole('button', { name: '收起', exact: true })
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('启动失败：展开后没有「收起」'))

  // 演示版的「立即执行」和正式后端走同一个 afterRun：单次计划跑完变 done、清掉上次错误
  await failedCard.getByRole('button', { name: '立即执行' }).click()
  await failedCard
    .getByText('已启动', { exact: true })
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('立即执行后：单次计划没有变成「已启动」'))
  if (!(await failedCard.innerText()).includes('不会再次执行'))
    errors.push('立即执行后：单次计划没有归到「不会再执行」')
  if ((await groupCount('出过问题')) !== 1) errors.push('立即执行后：失败的卡片没有离开「出过问题」组')

  // 窄窗口：卡片和操作按钮都放得下，不出现横向滚动（check 里会断言）
  for (const width of [375, 1024]) {
    await p.setViewportSize({ width, height: 820 })
    await p.reload()
    await check(p, `计划-${width} 宽度`, ['出过问题', '错过', '新建计划'])
  }
})
