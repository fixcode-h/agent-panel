/**
 * 界面检查分片：运行区里的工作流行——在跑时列出来（进度、已跑多久）、点开打开这次运行的视图、跑完整行消失。
 *
 * 原来是 02b 的最后一块：它要两次整页重载（改 localStorage 造「正在跑」，再改回去看它消失），
 * 单步就要 30 秒，是 02b 里最慢的一步（其余 27 步合计只有 33 秒）。拆成单独一片后，
 * 02b 和它并排跑，最慢分片不再是 02b（见 scripts/ui-check.mjs 的并行）。
 */
import { runShard } from './harness.mjs'
import { openCartTask, taskPageHelpers } from './task-page.mjs'

await runShard(import.meta.filename, async (api) => {
  const { base, check, errors, settle } = api
  const p = await openCartTask(api)
  const { backToTask } = taskPageHelpers(p, api)

  // 运行区也列「正在跑的工作流」（用户要求「有运行中的工作流也展示在这」）：谁在跑工作流就显示在谁的对话页。
  // 以前运行区那行的判定只认 mode === 'chat'，工作流任务自己跑的时候什么也不列。
  // 这一条同时验「点它能打开这次运行的视图」和「跑完这一行消失、不留空横线」
  {
    const KEY = 'agent-panel-demo-v3'
    const TITLE = '商品详情页增加'
    const saved = await p.evaluate((k) => localStorage.getItem(k), KEY)
    /** 把演示里已经跑完的那条工作流任务改成「正在跑」，进度造出一个确定的值 */
    const patch = (running) =>
      p.evaluate(
        ([k, title, live]) => {
          const db = JSON.parse(localStorage.getItem(k) ?? '{}')
          const task = (db.tasks ?? []).find((x) => x.mode === 'workflow' && x.title.includes(title) && x.runs?.length)
          if (!task) return null
          const rec = task.runs.at(-1)
          task.status = live ? 'running' : 'done'
          rec.status = live ? 'running' : 'done'
          rec.endedAt = live ? '' : new Date().toISOString()
          rec.startedAt = new Date(Date.now() - 80_000).toISOString()
          // 前两个节点做完、其余还没开始：进度是确定的「2/N」，不依赖演示数据跑到哪一步
          const tops = task.steps.filter((s) => !s.parentId && !s.id.endsWith('@main'))
          const done = Math.min(2, tops.length)
          tops.forEach((s, i) => (s.status = live && i >= done ? 'pending' : 'done'))
          localStorage.setItem(k, JSON.stringify(db))
          return { id: task.id, projectId: task.projectId, total: tops.length, done, run: rec.id }
        },
        [KEY, TITLE, running],
      )
    const info = await patch(true)
    if (!info) errors.push('运行区-工作流在跑：演示数据里没有可用的工作流任务，用例前提不成立')
    else {
      // 改完 localStorage 必须整页重载，只改 hash 会被内存里那份旧的演示数据覆盖回去（见演示数据说明），
      // 再从地址栏直接进这个任务的对话页
      await p.reload()
      await p.goto(`${base}#/projects/${encodeURIComponent(info.projectId)}/${encodeURIComponent(info.id)}`)
      await settle(p)
      const box = p.locator('[aria-label="运行区"]').first()
      const listed = await box.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      )
      const text = listed ? ((await box.innerText()) || '').replace(/\s+/g, ' ').trim() : ''
      if (!listed) errors.push('运行区-工作流在跑：工作流任务在跑时运行区里什么也没有列')
      else if (!text.includes(`${info.done}/${info.total} 个节点`))
        errors.push(`运行区-工作流在跑：没有显示进度 ${info.done}/${info.total}，实际「${text}」`)
      else {
        // 耗时跟着开始时间走（造的是 80 秒前开始，读到时只会更大）
        // fmtDuration 的秒位带一位小数（如「1m 20.5s」），只认整秒会漏
        if (!/\d+m \d+(?:\.\d+)?s/.test(text))
          errors.push(`运行区-工作流在跑：这一行没有显示已跑了多久（实际「${text}」）`)
        await check(p, '运行区-工作流在跑', ['工作流'])
        // 整行点了打开这次运行的视图：右栏标题写「运行 n」，不是另外弹一个窗口
        const runner = box.locator('div').filter({ hasText: '个节点' }).last()
        await runner.click()
        const opened = await p
          .locator(`aside[aria-label="运行 ${info.run}"]`)
          .first()
          .waitFor({ timeout: 10000 })
          .then(
            () => true,
            () => false,
          )
        if (!opened) errors.push('运行区-工作流在跑：点这一行没有打开这次运行的视图')
        else await check(p, '运行区-工作流在跑-打开运行视图', [`运行 ${info.run}`])
        // 跑完：这一行从运行区消失，也不在总结下面留一条空横线
        await patch(false)
        await p.reload()
        await settle(p)
        // 跑完要整块不画：运行区那个 role="group" 的容器不在了，就不会在总结下面留一条空横线
        const areas = await p.locator('[role="group"][aria-label="运行区"]').count()
        if (areas) errors.push(`运行区-工作流在跑：跑完以后运行区还留着（${areas} 块），会多出一条空横线`)
        const left = await p
          .locator('[aria-label="运行区"]')
          .first()
          .innerText()
          .catch(() => '')
        if (left.includes('个节点') || left.includes('工作流'))
          errors.push(`运行区-工作流在跑：跑完以后这一行还在（「${left.replace(/\s+/g, ' ').trim()}」）`)
        else await check(p, '运行区-工作流跑完消失')
      }
      await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [KEY, saved])
      await p.reload()
      await backToTask()
    }
  }
})
