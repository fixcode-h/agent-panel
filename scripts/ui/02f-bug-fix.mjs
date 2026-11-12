/**
 * 界面检查分片：诊断报告的「修复」这一步（用户 2026-11-10 定）：修完交上来给用户看改了哪些代码、为什么这么改，
 * 确认了才进验证；对代码有疑问选中标注交回。演示数据从头生成（见 harness.mjs），不依赖别的分片
 */

import { runShard } from './harness.mjs'
import { childView, openCartTask, taskPageHelpers } from './task-page.mjs'

await runShard(import.meta.filename, async (api) => {
  const { check, errors, settle } = api
  const p = await openCartTask(api)
  const { backToTask } = taskPageHelpers(p, api)

  await p.evaluate((k) => {
    const db = JSON.parse(localStorage.getItem(k))
    const parent = db.tasks.find((x) => x.title.includes('购物车右上角'))
    // 用一个已经停下的子对话（演示里在跑的子对话会被模拟执行改写消息）
    const kid = db.tasks.find((x) => x.parentTaskId === parent.id && x.title.includes('修侧栏时间显示'))
    Object.assign(kid, { resolved: false, status: 'done', working: false, bug: { kind: 'report' }, requests: [] })
    const at = new Date().toISOString()
    const base = {
      at,
      symptom: '购物车角标在删除最后一件商品后仍显示 1',
      rootCause: '`web/src/cart/store.ts:52` 删除最后一件时提前 return，没有通知订阅者',
      confirmed: true,
      fix: '去掉提前 return，统一在末尾派发 change',
      files: ['web/src/cart/store.ts'],
      verify: 'store.test.ts 新增「删除最后一件后角标归零」',
      level: 'standard',
      options: [
        { id: 'A', title: '去掉提前 return', change: '`remove` 删完总是派发 `cart:change`', files: [] },
        { id: 'B', title: '角标自己轮询数量', change: 'badge.ts 定时读', files: [] },
      ],
      chosen: { id: 'A', why: '修在源头，别的订阅者也能收到', whyNotOthers: 'B 只是绕过' },
      answers: [],
      notes: [],
      overall: '',
      before: [],
    }
    kid.bug.diagnoses = [
      {
        ...base,
        phase: 'plan',
        version: 1,
        rev: 1,
        status: 'approved',
        changes: [{ file: 'web/src/cart/store.ts', what: '去掉提前 return' }],
      },
      {
        ...base,
        phase: 'fix',
        version: 2,
        rev: 1,
        status: 'pending',
        changes: [
          {
            file: 'web/src/cart/store.ts',
            what: '`remove` 去掉 `left === 0` 时的提前 return，删完总是派发 `cart:change`',
            why: '提前 return 让删最后一件时订阅者收不到通知，角标停在 1；派发挪到末尾，任何删除都会通知',
          },
          {
            file: 'web/src/cart/store.test.ts',
            what: '加「删最后一件后角标归零」用例',
            why: '改前失败、改后通过，防止以后再挪派发时回归',
            isNew: true,
          },
        ],
        fixFiles: [
          {
            file: 'web/src/cart/store.ts',
            add: 1,
            del: 2,
            isNew: false,
            diff: [
              '@@ -48,9 +48,8 @@ export function removeItem(id: string) {',
              '   items.delete(id)',
              '   const left = items.size',
              '-  if (left === 0) return',
              "-  emit('cart:change', { count: left })",
              "+  emit('cart:change', { count: left })",
              ' }',
            ].join('\n'),
          },
          {
            file: 'web/src/cart/store.test.ts',
            add: 4,
            del: 0,
            isNew: true,
            diff: [
              '@@ -0,0 +1,4 @@',
              "+test('删最后一件后角标归零', () => {",
              "+  addItem('a'); removeItem('a')",
              '+  assert.equal(lastChange().count, 0)',
              '+})',
            ].join('\n'),
          },
        ],
      },
    ]
    localStorage.setItem(`task-child:${parent.id}`, kid.id)
    localStorage.removeItem(`task-run:${parent.id}`)
    localStorage.setItem(k, JSON.stringify(db))
  }, 'agent-panel-demo-v3')
  await p.reload()
  await backToTask()

  // 交上来时自动弹审阅弹窗：按钮是「确认修复，开始验证」，正文是为什么这么改、改了哪些文件、每个文件的 diff
  const dlg = p.getByRole('dialog')
  let approve = dlg.getByRole('button', { name: '确认修复，开始验证' })
  if (
    !(await approve.waitFor({ timeout: 10000 }).then(
      () => true,
      () => false,
    ))
  ) {
    const open = childView(p).locator('.proc-list').getByRole('button', { name: '查看报告' })
    if (await open.count()) await open.last().click()
    approve = dlg.getByRole('button', { name: '确认修复，开始验证' })
    await approve.waitFor({ timeout: 10000 }).catch(() => errors.push('修复：弹窗里没有「确认修复，开始验证」'))
  }
  await settle(p)
  for (const text of ['为什么这么改', '改了哪些文件', '改动的代码', '按方案 A 改完了：去掉提前 return'])
    if (!(await dlg.getByText(text, { exact: false }).count())) errors.push(`修复：没有显示「${text}」`)
  if (!(await dlg.getByText('提前 return 让删最后一件时订阅者收不到通知', { exact: false }).count()))
    errors.push('修复：没有显示每个文件为什么这么改')
  // 阶段条：走到「修复」这一步，正在看它
  const stage = dlg.getByRole('list', { name: '排查阶段' }).getByRole('button', { name: '修复', exact: true })
  if ((await stage.getAttribute('aria-current').catch(() => null)) !== 'step')
    errors.push('修复：阶段条上「修复」不是当前这一步')
  await check(p, '诊断报告-修复', ['改了哪些文件', '改动的代码'])

  // 往下是每个文件的 diff：增删行着色，文件名是小节标题（目录里能跳）
  await dlg
    .locator('h2', { hasText: '改动的代码' })
    .scrollIntoViewIfNeeded()
    .catch(() => {})
  await check(p, '诊断报告-修复-代码', ['store.test.ts'])

  // 在代码上选中一行标注：「有疑问，让它分析」随之可点
  const line = dlg.getByText("emit('cart:change', { count: left })", { exact: false }).last()
  await line.scrollIntoViewIfNeeded().catch(() => {})
  await settle(p)
  const b = await line.boundingBox()
  if (b) {
    await p.mouse.move(b.x + 2, b.y + b.height / 2)
    await p.mouse.down()
    await p.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 5 })
    await p.mouse.up()
  }
  const mark = p.getByRole('button', { name: '标注', exact: true })
  if (
    await mark.waitFor({ timeout: 3000 }).then(
      () => true,
      () => false,
    )
  ) {
    await mark.click()
    await dlg.getByLabel('标注 1 的意见').fill('count 传 left，删完是 0 吗？')
    if (await dlg.getByRole('button', { name: '有疑问，让它分析' }).isDisabled())
      errors.push('修复：在代码上标注了还不能点「有疑问，让它分析」')
    await check(p, '诊断报告-修复-代码标注')
  } else errors.push('修复：在 diff 上选中代码后没有出现「标注」按钮')
})
