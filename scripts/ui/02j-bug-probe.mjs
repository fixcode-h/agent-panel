/**
 * 界面检查分片：Bug 的补排查（设计稿「Bug 模式子对话体验」第 1 节、N1、N3、N4、N5）——
 * 报告底栏和输入框上方动作条的「补排查」、补排查表单、临时排查改动清单（论证日志 + 补排查）、
 * 单条撤掉、右栏的补排查记录和复现记录、不修了的确认框里列出补排查。演示数据从头生成，不依赖别的分片
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
    const kid = db.tasks.find((x) => x.parentTaskId === parent.id && x.title.includes('修侧栏时间显示'))
    const at = new Date(Date.now() - 20 * 60_000).toISOString()
    const later = new Date(Date.now() - 10 * 60_000).toISOString()
    Object.assign(kid, {
      resolved: false,
      status: 'done',
      working: false,
      requests: [],
      worktree: { path: '/tmp/wt', branch: 'ap/bug', baseBranch: 'main', state: 'active', note: '' },
    })
    const stack = [
      {
        id: 'S1',
        parent: '',
        file: 'web/src/cart/CartPage.tsx',
        line: 90,
        fn: 'CartPage.onDelete',
        note: '',
        role: 'entry',
      },
      { id: 'S2', parent: 'S1', file: 'web/src/cart/store.ts', line: 48, fn: 'remove(id)', note: '', role: 'fault' },
      {
        id: 'S3',
        parent: 'S2',
        file: 'web/src/cart/badge.ts',
        line: 12,
        fn: 'Badge.onCartChange',
        note: '',
        role: 'symptom',
      },
    ]
    const base = { level: 'standard', answers: [], notes: [], overall: '', before: [], stack, hypotheses: [] }
    kid.bug = {
      kind: 'report',
      diagnoses: [
        {
          ...base,
          at,
          phase: 'evidence',
          version: 1,
          rev: 1,
          status: 'approved',
          symptom: '删掉最后一件后角标仍是 1',
          rootCause: '假设：删除最后一件时没有派发 change',
          logPlan: [
            {
              id: 'L1',
              file: 'web/src/cart/store.ts',
              line: 48,
              print: '打出 remove 的 id 和 left',
              fn: '',
              hypothesis: '',
            },
            {
              id: 'L2',
              file: 'web/src/cart/store.ts',
              line: 53,
              print: '派发 cart:change 之前',
              fn: '',
              hypothesis: '',
            },
          ],
        },
        {
          ...base,
          at: later,
          phase: 'plan',
          version: 2,
          rev: 1,
          status: 'pending',
          confirmed: true,
          symptom: '删掉最后一件后角标仍是 1',
          rootCause: 'store.ts 删除最后一件时提前 return，没有通知订阅者',
          logPlan: [],
          files: ['web/src/cart/store.ts'],
        },
      ],
      probes: [
        {
          id: 'P1',
          kind: 'log',
          ask: '角标收到事件时打出数量',
          at: later,
          targets: [],
          workspace: true,
          remind: false,
          state: 'added',
          rev: 1,
          spots: [{ file: 'web/src/cart/badge.ts', line: 12, lines: 2 }],
          problems: [],
          doneAt: later,
        },
        {
          id: 'P2',
          kind: 'draw',
          ask: '角标位置画红框，数量写在框上',
          at: later,
          targets: [],
          workspace: true,
          remind: false,
          state: 'added',
          rev: 1,
          spots: [{ file: 'web/src/cart/badge.ts', line: 18, lines: 7 }],
          problems: [],
          doneAt: later,
        },
      ],
      repros: [
        {
          id: 'R1',
          at: new Date().toISOString(),
          path: 'logs/app.log',
          startLine: 412,
          endLine: 430,
          related: 3,
          hits: ['P1', '角标'],
        },
      ],
    }
    localStorage.setItem(`task-child:${parent.id}`, kid.id)
    localStorage.removeItem(`task-run:${parent.id}`)
    localStorage.setItem(k, JSON.stringify(db))
  }, 'agent-panel-demo-v3')
  await p.reload()
  await backToTask()

  // 报告交上来时会自动弹出：先关掉，看输入框上方的动作条（N1）
  const dlg = p.getByRole('dialog').first()
  if (
    await dlg.waitFor({ timeout: 8000 }).then(
      () => true,
      () => false,
    )
  ) {
    await p.keyboard.press('Escape')
    await settle(p)
  }
  const view = childView(p)
  const bar = view.locator('[data-bug-bar]')
  await bar.waitFor({ timeout: 10000 }).catch(() => errors.push('补排查：Bug 子对话的输入框上方没有动作条'))
  if (await bar.count()) {
    for (const name of ['补排查', '放到我的工作区'])
      if (!(await bar.getByRole('button', { name }).count())) errors.push(`补排查：动作条上没有「${name}」`)
    await check(p, '补排查-动作条', ['修复方案', '查看报告 · 临时改动 2 处'])
    await bar.getByRole('button', { name: /查看报告/ }).click()
  }

  // 打开报告：清单、记录、底栏按钮
  const ledger = dlg.locator('[data-probe-ledger]')
  if (
    !(await ledger.waitFor({ timeout: 8000 }).then(
      () => true,
      () => false,
    ))
  ) {
    await bar
      .getByRole('button', { name: /查看报告/ })
      .click()
      .catch(() => {})
    await ledger.waitFor({ timeout: 8000 }).catch(() => errors.push('补排查：报告里没有「临时排查改动」清单'))
  }
  await settle(p)
  for (const id of ['L1', 'L2', 'P1', 'P2'])
    if (!(await ledger.locator(`#probe-row-${id}`).count())) errors.push(`补排查：清单里没有 ${id}`)
  if (!(await ledger.locator('#probe-row-P1').getByText('打出来了').count()))
    errors.push('补排查：复现里打出来的 P1 没有标「打出来了」')
  if (!(await dlg.locator('[data-probe-records]').count())) errors.push('补排查：右栏没有补排查记录')
  await ledger.scrollIntoViewIfNeeded().catch(() => {})
  await check(p, '补排查-临时排查改动清单', ['临时排查改动', '补排查记录', '4 处 · 2 个文件'])

  // 表单（效果图 1）
  const footBtn = dlg.getByRole('button', { name: '补排查' }).last()
  await footBtn.click()
  const form = p.locator('[data-probe-form]')
  await form.waitFor({ timeout: 5000 }).catch(() => errors.push('补排查：点「补排查」没有弹出表单'))
  if (await form.count()) {
    await form.getByRole('textbox', { name: '想看什么' }).fill('点删除之后，在 onDelete 里打出删前删后的数量')
    await form.getByRole('button', { name: /S1 CartPage\.onDelete/ }).click()
    await check(p, '补排查-表单', ['马上加', '加在：'])
    await p.getByRole('button', { name: '马上加' }).click()
    await ledger
      .locator('#probe-row-P3')
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('补排查：马上加之后清单里没有 P3'))
  }

  // 单条撤掉
  await ledger
    .locator('#probe-row-P2')
    .getByRole('button', { name: '撤掉' })
    .click()
    .catch(() => {})
  await ledger
    .locator('#probe-row-P2')
    .getByText('已撤掉')
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('补排查：点「撤掉」后 P2 没有标已撤掉'))
  await check(p, '补排查-撤掉一条')

  // 不修了的确认框里列出补排查
  await dlg.getByRole('button', { name: '取消修复' }).click()
  const ask = p.getByRole('dialog', { name: '取消这次修复？' })
  await ask
    .locator('[data-probe-cancel]')
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('补排查：不修了的确认框里没有列出补排查'))
  await check(p, '补排查-不修了一起删')
  await p.keyboard.press('Escape')
})
