/**
 * 界面检查分片：诊断报告「等你复现」那一步的取证（分析稿 B1、B3、B4）——
 * 把独立分支里的临时日志放到我的工作区 / 还原、面板自己取日志填进输入框、取消前提醒先还原、
 * 「依据和背景」里的「环境（面板自动采集）」。演示数据从头生成（见 harness.mjs），不依赖别的分片
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
    // 用一个已经停下的子对话（演示里在跑的子对话会被模拟执行改写消息），放在独立分支里
    const kid = db.tasks.find((x) => x.parentTaskId === parent.id && x.title.includes('修侧栏时间显示'))
    Object.assign(kid, {
      resolved: false,
      status: 'done',
      working: false,
      bug: { kind: 'report' },
      requests: [],
      worktree: { path: '/tmp/wt', branch: 'ap/bug', baseBranch: 'main', state: 'active', note: '' },
    })
    const at = new Date().toISOString()
    const collect = {
      steps: ['加一件商品', '删掉它，看角标'],
      where: 'logs/app.log',
      filter: '[排查-角标]',
      expect: '',
      outcomes: [{ see: 'L2 没出现', means: '派发没走到' }],
    }
    kid.bug.diagnoses = [
      {
        at,
        phase: 'evidence',
        version: 1,
        rev: 1,
        status: 'pending',
        symptom: '删掉最后一件后角标仍是 1',
        rootCause: '假设：删除最后一件时没有派发 change',
        level: 'standard',
        hypotheses: [{ id: 'H1', text: '提前 return', status: 'open', basis: '' }],
        logPlan: [
          {
            id: 'L1',
            file: 'web/src/cart/store.ts',
            line: 52,
            print: "console.log('[排查-角标] L1')",
            hypothesis: 'H1',
          },
          {
            id: 'L2',
            file: 'web/src/cart/badge.ts',
            line: 18,
            print: "console.log('[排查-角标] L2')",
            hypothesis: 'H1',
          },
        ],
        collect,
        awaiting: { at, added: ['L1 web/src/cart/store.ts:52', 'L2 web/src/cart/badge.ts:18'], collect },
        env: {
          at,
          os: 'Windows 11 Pro 10.0.26100 (x64)',
          node: 'v22.11.0',
          cli: 'Claude Code',
          model: 'claude-sonnet',
          branch: 'dev',
          commits: [{ hash: 'c0ffee1', title: '购物车删除重构', author: '李四', date: '2026-10-27' }],
          dirty: ['web/src/cart/badge.ts'],
          dirtyMore: 0,
          lock: { file: 'package-lock.json', hash: 'abc1234', title: '升级依赖', date: '2026-10-20' },
        },
        answers: [],
        notes: [],
        overall: '',
        before: [],
      },
    ]
    localStorage.setItem(`task-child:${parent.id}`, kid.id)
    localStorage.removeItem(`task-run:${parent.id}`)
    localStorage.setItem(k, JSON.stringify(db))
  }, 'agent-panel-demo-v3')
  await p.reload()
  await backToTask()

  // 交上来时自动弹审阅弹窗；没弹就从报告卡片打开
  const dlg = p.getByRole('dialog').first()
  const putBtn = dlg.getByRole('button', { name: '放到我的工作区' })
  if (
    !(await putBtn.waitFor({ timeout: 10000 }).then(
      () => true,
      () => false,
    ))
  ) {
    const open = childView(p).locator('.proc-list').getByRole('button', { name: '查看报告' })
    if (await open.count()) await open.last().click()
    await putBtn.waitFor({ timeout: 10000 }).catch(() => errors.push('取证：等你复现时没有「放到我的工作区」'))
  }
  await settle(p)
  await check(p, '诊断报告-取证-放到工作区', ['临时日志加在它的独立分支里'])

  // B1：放到工作区 → 出现「从我的工作区还原」和文件列表
  if (await putBtn.count()) {
    await putBtn.click()
    const restore = dlg.getByRole('button', { name: '从我的工作区还原' })
    await restore.waitFor({ timeout: 5000 }).catch(() => errors.push('取证：放到工作区后没有「从我的工作区还原」'))
    if (!(await dlg.locator('[data-workspace-patch]').getByText('web/src/cart/badge.ts').count()))
      errors.push('取证：放到工作区后没有列出放了哪些文件')
    await check(p, '诊断报告-取证-已放到工作区')

    // 取消修复的确认框里提醒先还原
    await dlg.getByRole('button', { name: '取消修复' }).click()
    const ask = p.getByRole('dialog', { name: '取消这次修复？' })
    await ask.waitFor({ timeout: 5000 }).catch(() => errors.push('取证：点「取消修复」没有弹确认框'))
    await ask
      .locator('[data-patch-reminder]')
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('取证：补丁还在工作区时，取消确认框里没有提醒先还原'))
    await check(p, '诊断报告-取证-取消前提醒还原')
    await p.keyboard.press('Escape')
    await settle(p)

    if (await restore.count()) {
      await restore.click()
      await dlg
        .getByText('已还原：', { exact: false })
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push('取证：还原后没有说明已还原'))
      if (!(await putBtn.count())) errors.push('取证：还原后没有回到「放到我的工作区」')
    }
  }

  // B3：面板自己取日志 → 把日志文件引用进整体意见框，写明从第几行往后看（不再粘贴日志内容）
  const watch = dlg.locator('[data-log-watch]')
  if (!(await watch.count())) errors.push('取证：报告写了日志文件，贴日志的框上面没有「开始复现」')
  else {
    if (!(await watch.getByText('logs/app.log').count())) errors.push('取证：没有显示认出来的日志文件路径')
    const fetchBtn = watch.getByRole('button', { name: '复现完了，取日志' })
    if (!(await fetchBtn.isDisabled())) errors.push('取证：没点「开始复现」时「取日志」就能点')
    await watch.getByRole('button', { name: '开始复现' }).click()
    await watch
      .getByText('已记下日志文件现在到哪了', { exact: false })
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('取证：点「开始复现」后没有说明'))
    await fetchBtn.click()
    const box = dlg.getByRole('textbox', { name: '整体意见' })
    await p
      .waitForFunction(() => document.body.innerText.includes('从第 412 行往后看'), null, { timeout: 5000 })
      .catch(() => errors.push('取证：取日志后输入框里没有写从第几行往后看'))
    const filled = (await box.innerText().catch(() => '')) || ''
    if (filled.includes('[排查-演示]')) errors.push('取证：日志内容又被粘贴进了输入框')
    if (!(await box.getByText('app.log').count())) errors.push('取证：输入框里没有日志文件的卡片')
    if (await dlg.getByRole('button', { name: '交日志，继续分析' }).isDisabled())
      errors.push('取证：日志填进去后「交日志，继续分析」还不能点')
    await check(p, '诊断报告-取证-取日志', ['复现完了，取日志'])
  }

  // B4：「依据和背景」里有面板自动采集的环境
  await dlg.getByRole('button', { name: '依据和背景' }).click()
  await settle(p)
  const envHead = dlg.getByText('环境（面板自动采集）')
  await envHead.waitFor({ timeout: 5000 }).catch(() => errors.push('取证：依据和背景里没有「环境（面板自动采集）」'))
  for (const text of ['Windows 11 Pro', 'c0ffee1', 'package-lock.json'])
    if (!(await dlg.getByText(text, { exact: false }).count())) errors.push(`取证：环境里没有显示「${text}」`)
  await envHead.scrollIntoViewIfNeeded().catch(() => {})
  await check(p, '诊断报告-取证-环境')
})
