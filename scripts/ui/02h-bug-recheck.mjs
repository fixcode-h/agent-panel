/**
 * 界面检查分片：确认次数按风险收放（分析稿 B2）和面板复核回归测试（B9）。
 * 修复这一版写了回归测试命令、面板复核过「改前失败、改后通过」：确认按钮写「确认修复，验证也算通过」，
 * 正文有「面板复核回归测试」一节（退出码、真实输出），确认按钮旁有「后面几步没有要注意的就自动通过」。
 * 演示数据从头生成（见 harness.mjs），不依赖别的分片
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
    Object.assign(kid, { resolved: false, status: 'done', working: false, bug: true, requests: [] })
    const at = new Date().toISOString()
    const base = {
      at,
      symptom: '购物车角标在删除最后一件商品后仍显示 1',
      rootCause: '`web/src/cart/store.ts:52` 删除最后一件时提前 return，没有通知订阅者',
      confirmed: true,
      fix: '去掉提前 return，统一在末尾派发 change',
      files: ['web/src/cart/store.ts'],
      verify: 'store.test.ts 新增「删除最后一件后角标归零」',
      level: 'quick',
      attribution: { category: 'recent', change: 'a1b2c3d', how: 'blame', confidence: 'high' },
      answers: [],
      notes: [],
      overall: '',
      before: [],
    }
    const cmd = 'npx vitest run web/src/cart/store.test.ts'
    kid.diagnoses = [
      { ...base, phase: 'plan', version: 1, rev: 1, status: 'approved', autoNext: true },
      {
        ...base,
        phase: 'fix',
        version: 2,
        rev: 1,
        status: 'pending',
        changes: [
          { file: 'web/src/cart/store.ts', what: '去掉 `left === 0` 时的提前 return', why: '删最后一件也要通知订阅者' },
          { file: 'web/src/cart/store.test.ts', what: '加「删最后一件后角标归零」用例', why: '改前失败、改后通过' },
        ],
        result: {
          reproBefore: '角标停在 1',
          reproAfter: '角标归零',
          impactChecks: [],
          regressionTests: ['web/src/cart/store.test.ts'],
          commands: [cmd],
          runs: '',
        },
        recheck: {
          state: 'done',
          why: '',
          at,
          doneAt: at,
          items: [
            {
              command: cmd,
              skip: '',
              before: {
                code: 1,
                ms: 2310,
                timedOut: false,
                error: '',
                out: ' FAIL  web/src/cart/store.test.ts > 删最后一件后角标归零\nAssertionError: expected 1 to be 0\n Test Files  1 failed (1)',
              },
              after: {
                code: 0,
                ms: 2104,
                timedOut: false,
                error: '',
                out: ' ✓ web/src/cart/store.test.ts (3 tests) 12ms\n Test Files  1 passed (1)',
              },
            },
          ],
        },
      },
    ]
    localStorage.setItem(`task-child:${parent.id}`, kid.id)
    localStorage.removeItem(`task-run:${parent.id}`)
    localStorage.setItem(k, JSON.stringify(db))
  }, 'agent-panel-demo-v3')
  await p.reload()
  await backToTask()

  const dlg = p.getByRole('dialog')
  const name = '确认修复，验证也算通过'
  let approve = dlg.getByRole('button', { name })
  if (
    !(await approve.waitFor({ timeout: 10000 }).then(
      () => true,
      () => false,
    ))
  ) {
    const open = childView(p).locator('.proc-list').getByRole('button', { name: '查看报告' })
    if (await open.count()) await open.last().click()
    approve = dlg.getByRole('button', { name })
    await approve.waitFor({ timeout: 10000 }).catch(() => errors.push(`复核：弹窗里没有「${name}」`))
  }
  await settle(p)
  for (const text of ['面板复核回归测试', '每条都是改前失败、改后通过', 'expected 1 to be 0', '面板复核通过'])
    if (!(await dlg.getByText(text, { exact: false }).count())) errors.push(`复核：没有显示「${text}」`)
  // 「后面几步没有要注意的就自动通过」：沿用上一次同意时的选择（方案那一版勾了），在确认按钮旁边
  const auto = dlg.getByRole('checkbox', { name: '后面几步没有要注意的就自动通过' })
  if (!(await auto.count())) errors.push('复核：确认按钮旁没有「后面几步没有要注意的就自动通过」')
  else if ((await auto.getAttribute('aria-checked')) !== 'true') errors.push('复核：自动通过没有沿用上一次的选择')
  await dlg
    .locator('h2', { hasText: '面板复核回归测试' })
    .scrollIntoViewIfNeeded()
    .catch(() => {})
  await check(p, '诊断报告-修复-面板复核', ['面板复核回归测试', name])
})
