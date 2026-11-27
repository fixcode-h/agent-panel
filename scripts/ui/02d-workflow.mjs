/**
 * 界面检查分片：工作流运行在跑时对话里的卡片（进度、已跑多久）、点了切到流程图、跑完不留运行区。
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
  // 这一条同时验「点它切到流程图」和「跑完这一行消失、不留空横线」
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
      // 工作流改成独立运行后（4304d14），运行的节点输出都挂在节点上，对话里没有主 Agent 的回复，
      // 运行自己的对话页靠工作流卡片显示进度和已跑多久；运行区只挂在回复下面，这里不再出现
      const card = p.locator('[role="button"][data-run]').first()
      const listed = await card.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      )
      const text = listed ? ((await card.innerText()) || '').replace(/\s+/g, ' ').trim() : ''
      if (!listed) errors.push('运行区-工作流在跑：工作流运行在跑时对话里没有工作流卡片')
      else if (!text.includes(`${info.done}/${info.total}`))
        errors.push(`运行区-工作流在跑：卡片上没有显示进度 ${info.done}/${info.total}，实际「${text}」`)
      else {
        // 耗时跟着开始时间走（造的是 80 秒前开始，读到时只会更大）
        // fmtDuration 的秒位带一位小数（如「1m 20.5s」），只认整秒会漏
        if (!/\d+m \d+(?:\.\d+)?s/.test(text))
          errors.push(`运行区-工作流在跑：卡片上没有显示已跑了多久（实际「${text}」）`)
        await check(p, '运行区-工作流在跑', ['工作流'])
        // 点卡片就地切到流程图，不另开「运行 n」页签（用户 2026-10-30 要求）
        const runTabs = p.getByRole('tablist', { name: '对话页签' }).getByRole('tab', { name: /运行 \d+/ })
        const before = await runTabs.count()
        await card.click()
        await settle(p)
        const flowTab = p.getByRole('tab', { name: '流程图' }).first()
        if ((await flowTab.getAttribute('aria-selected')) !== 'true')
          errors.push('运行区-工作流在跑：点卡片没有切到当前对话的流程图')
        else if ((await runTabs.count()) > before) errors.push('运行区-工作流在跑：点卡片还另外打开了运行页签')
        else await check(p, '运行区-工作流在跑-切到流程图', ['流程图'])
        await p.getByRole('tab', { name: '对话' }).first().click()
        await settle(p)
        // 跑完：不留运行区（不在对话下面多一条空横线），卡片不再转圈
        await patch(false)
        await p.reload()
        await settle(p)
        const areas = await p.locator('[role="group"][aria-label="运行区"]').count()
        if (areas) errors.push(`运行区-工作流在跑：跑完以后运行区还留着（${areas} 块），会多出一条空横线`)
        else if (await p.locator('[data-run] .animate-spin').count())
          errors.push('运行区-工作流在跑：跑完以后卡片还在转圈')
        else await check(p, '运行区-工作流跑完消失')
      }
      await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [KEY, saved])
      await p.reload()
      await backToTask()
    }
  }

  // 需求原话对照表（复盘 2026-11-26 §5-1）：演示里「到货提醒」的运行拆了 3 条，落地 2 条、1 条没落地。
  // 卡片底下一行写进度（有没落地的标黄），点开弹窗看整张表；点这一行只开弹窗，不顺带切到流程图
  {
    const info = await p.evaluate(() => {
      const db = JSON.parse(localStorage.getItem('agent-panel-demo-v3') ?? '{}')
      const task = (db.tasks ?? []).find((x) => x.mode === 'workflow' && x.title.includes('商品详情页增加'))
      return task ? { id: task.id, projectId: task.projectId } : null
    })
    if (!info) errors.push('需求对照：演示数据里没有「到货提醒」工作流任务，用例前提不成立')
    else {
      await p.goto(`${base}#/projects/${encodeURIComponent(info.projectId)}/${encodeURIComponent(info.id)}`)
      await settle(p)
      const line = p.locator('[data-needs-line]').first()
      const shown = await line.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      )
      if (!shown) errors.push('需求对照：工作流卡片底下没有需求对照那一行')
      else {
        const text = ((await line.innerText()) || '').replace(/\s+/g, ' ')
        if (!text.includes('2/3 已落地') || !text.includes('1 条未落地'))
          errors.push(`需求对照：卡片上的进度不对，实际「${text}」`)
        await check(p, '需求对照-卡片', ['需求对照'])
        await line.click()
        await check(p, '需求对照-弹窗', [
          '到货时发短信通知',
          '未落地',
          'ProductDetail.tsx 缺货分支显示按钮',
          '识别现场与方案',
        ])
        const flowTab = p.getByRole('tab', { name: '流程图' }).first()
        if ((await flowTab.getAttribute('aria-selected').catch(() => null)) === 'true')
          errors.push('需求对照：点需求那一行顺带切到了流程图')
        await p.keyboard.press('Escape')
        await settle(p)
      }
      await backToTask()
    }
  }

  // 对话里的工作流卡片：点它和标题栏点「流程图」一样就地切到流程图，不另开运行页（用户 2026-10-30 要求）
  {
    const card = p.locator('[role="button"][data-run]').filter({ hasText: '查看流程图' }).first()
    if (!(await card.count())) errors.push('工作流卡片：购物车任务的对话里没有工作流卡片，用例前提不成立')
    else {
      // 前面的用例可能留着别的「运行 n」页签：只看点卡片有没有多开
      const runTabs = p.getByRole('tablist', { name: '对话页签' }).getByRole('tab', { name: /运行 \d+/ })
      const before = await runTabs.count()
      await card.scrollIntoViewIfNeeded()
      await card.click()
      await settle(p)
      const flowTab = p.getByRole('tab', { name: '流程图' }).first()
      if ((await flowTab.getAttribute('aria-selected')) !== 'true')
        errors.push('工作流卡片：点卡片没有切到当前对话的流程图')
      else if ((await runTabs.count()) > before) errors.push('工作流卡片：点卡片还另外打开了运行页')
      else await check(p, '工作流卡片-切到流程图', ['流程图'])
      await p.getByRole('tab', { name: '对话' }).first().click()
      await settle(p)
    }
  }

  // 阶段确认（节点完成后等你确认）改成审阅弹窗：输入框上方只有一条入口，弹窗里按 Markdown 渲染结果，
  // 选中文字标注、右栏列标注。底部只有一个「确认」（用户 2026-11-27 定）：有标注时它把标注整理成意见退回，
  // 标注全删掉才是真正确认。只改这一种请求，其他提问照旧
  {
    const KEY = 'agent-panel-demo-v3'
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k) ?? '{}')
      const task = (db.tasks ?? []).find((x) => x.title.startsWith('购物车右上角'))
      if (!task) return
      const step = task.steps[0]
      task.requests = [
        {
          id: 'ui-review',
          step: step?.id ?? '',
          agentId: step?.agentId,
          kind: 'confirm',
          title: '「设计与压测」完成了，看一下结果再继续',
          detail: '## 方案\n\n1. 列表行加上模型标签\n2. 新增按 CLI 筛选\n\n> 风险：窄屏放不下',
          options: [],
          at: new Date().toISOString(),
        },
      ]
      localStorage.setItem(k, JSON.stringify(db))
    }, KEY)
    await p.reload()
    await p.getByText('购物车右上角', { exact: false }).first().click()
    const entry = p.getByRole('button', { name: '查看结果', exact: true })
    if (
      !(await entry.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      ))
    )
      errors.push('阶段确认：输入框上方没有「查看结果」入口')
    else {
      await entry.click()
      const dlg = p.getByRole('dialog')
      await dlg.waitFor()
      await settle(p)
      const line = dlg.getByText('列表行加上模型标签').first()
      const b = await line.boundingBox()
      await p.mouse.move(b.x + 2, b.y + b.height / 2)
      await p.mouse.down()
      await p.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 5 })
      await p.mouse.up()
      const mark = p.getByRole('button', { name: '标注', exact: true })
      if (
        !(await mark.waitFor({ timeout: 3000 }).then(
          () => true,
          () => false,
        ))
      )
        errors.push('阶段确认：选中文字后没有出现「标注」按钮')
      else {
        await mark.click()
        await p.keyboard.type('标签放到名字右边')
        await check(p, '阶段确认-审阅弹窗', ['标注', '确认 · 交回 1 条标注'])
        if (await dlg.getByRole('button', { name: '修改', exact: true }).count())
          errors.push('阶段确认：还有单独的「修改」按钮，应只剩一个「确认」')
        if (await dlg.getByRole('button', { name: '确认', exact: true }).count())
          errors.push('阶段确认：有标注时按钮还叫「确认」，应提示会交回标注')
        // 连点两下只交一次：第二下落在 busy 上被挡掉
        const send = dlg.getByRole('button', { name: '确认 · 交回 1 条标注', exact: true })
        await send.dblclick()
        await dlg
          .waitFor({ state: 'detached', timeout: 5000 })
          .catch(() => errors.push('阶段确认：有标注点「确认」后弹窗没关'))
        const sent = await p.evaluate((k) => {
          const task = JSON.parse(localStorage.getItem(k) ?? '{}').tasks.find((x) => x.title.startsWith('购物车右上角'))
          return { left: task.requests.length, text: task.messages.at(-1)?.text ?? '' }
        }, KEY)
        if (sent.left) errors.push('阶段确认：有标注点「确认」后请求还在')
        else if (!sent.text.includes('原文：「列表行加上模型标签」') || !sent.text.includes('意见：标签放到名字右边'))
          errors.push(`阶段确认：退回的意见没带上标注：${sent.text}`)
      }
    }
  }

  // 阶段报告（submit_report，用户 2026-11-15 定）：结论在最上面，决策一题一张卡片、Agent 选的那项预先勾上，
  // 改了勾选标「已改」、底栏提示会重出一版；有多版时能切版本、对比上一版。确认时交回选择，对话里写清改了哪几项
  {
    const KEY = 'agent-panel-demo-v3'
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k) ?? '{}')
      const task = (db.tasks ?? []).find((x) => x.title.startsWith('购物车右上角'))
      if (!task) return
      const step = task.steps[0]
      const opt = (id, label, note = '') => ({ id, label, note })
      const report = (pick) => ({
        summary: '角标不刷新是因为角标组件自己缓存了一份数量，推荐改成订阅购物车 store。',
        decisions: [
          {
            id: 'Q1',
            title: '角标怎么拿到最新数量',
            question: '角标组件自己缓存数量，加入商品后不会刷新。',
            options: [
              opt('A', '订阅购物车 store 的 count', '改 2 个文件'),
              opt('B', '加入商品后手动刷新角标', '以后还会漏'),
            ],
            pick,
            why: '只有改成同一份数据才能根治。',
            self: false,
          },
          {
            id: 'M1',
            title: '读数量的写法',
            question: '',
            options: [opt('A', '沿用 useCart()'), opt('B', '新写 useCartCount()')],
            pick: 'A',
            why: '项目里已有 9 处这么用。',
            self: true,
          },
        ],
        details: '### 改动\n1. CartBadge.tsx 改成订阅 count',
        next: '',
      })
      task.requests = [
        {
          id: 'ui-stage-report',
          step: step?.id ?? '',
          agentId: step?.agentId,
          kind: 'confirm',
          title: '「压测并确认」完成了，看一下结果再继续',
          detail: '先读了 CartBadge.tsx，再核对购物车 store 的广播。',
          reports: [
            { report: report('B'), at: '2026-11-15T09:00:00.000Z', picks: { Q1: 'A' }, result: 'changed' },
            { report: report('A'), at: '2026-11-15T09:20:00.000Z' },
          ],
          options: [],
          at: new Date().toISOString(),
        },
      ]
      localStorage.setItem(k, JSON.stringify(db))
    }, KEY)
    await p.reload()
    await p.getByText('购物车右上角', { exact: false }).first().click()
    const entry = p.getByRole('button', { name: '查看结果', exact: true })
    if (
      !(await entry.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      ))
    )
      errors.push('阶段报告：输入框上方没有「查看结果」入口')
    else {
      await entry.click()
      const dlg = p.getByRole('dialog')
      await dlg.waitFor()
      await settle(p)
      const card = dlg.locator('[data-decision="Q1"]')
      if ((await card.getByRole('checkbox', { checked: true }).count()) !== 1)
        errors.push('阶段报告：Q1 应该只勾着 Agent 推荐的那一项')
      for (const dark of [false, true]) {
        await p.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark)
        await settle(p)
        await check(p, `阶段报告-${dark ? '深色' : '浅色'}`, ['结论', '需要你决定', '我按规则定的', 'Agent 推荐'])
      }
      await p.evaluate(() => document.documentElement.classList.toggle('dark', false))
      await card.getByRole('checkbox', { name: /手动刷新角标/ }).click()
      if (!(await card.getAttribute('data-changed'))) errors.push('阶段报告：改了勾选后卡片没有标成已改')
      await check(p, '阶段报告-改了一项', ['已改', '改了 1 项决策'])
      // 只写整体意见也算要改：按钮变成「确认 · 交回意见」；清空后回到真正的「确认」
      const overall = dlg.getByLabel('整体意见')
      await overall.fill('窄屏再想想')
      if (!(await dlg.getByRole('button', { name: '确认 · 交回意见', exact: true }).count()))
        errors.push('阶段报告：只写整体意见时按钮没变成「确认 · 交回意见」')
      await overall.fill('')
      await dlg.getByRole('button', { name: '确认', exact: true }).click()
      await dlg.waitFor({ state: 'detached', timeout: 5000 }).catch(() => errors.push('阶段报告：点「确认」后弹窗没关'))
      const said = await p.evaluate((k) => {
        const task = JSON.parse(localStorage.getItem(k) ?? '{}').tasks.find((x) => x.title.startsWith('购物车右上角'))
        return task.messages.at(-1)?.text ?? ''
      }, KEY)
      if (!said.includes('改了 1 项决策') || !said.includes('Q1'))
        errors.push(`阶段报告：确认后对话里没写清改了哪项：${said}`)
    }
  }

  // 子对话的阶段确认（工作流节点完成后等你确认）：父对话页不在输入框上方另起黄色确认条，
  // 和诊断报告一样留在运行区子对话那一行（「阶段待确认」+ 行尾「查看结果」），点了直接在父对话页审阅
  {
    const KEY = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), KEY)
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k) ?? '{}')
      const parent = (db.tasks ?? []).find((x) => x.title.includes('购物车右上角'))
      // 用一个已经停下的子对话：演示里在跑的子对话会被模拟执行改写
      const kid = parent && db.tasks.find((x) => x.parentTaskId === parent.id && x.title.includes('修侧栏时间显示'))
      if (!kid) return
      parent.requests = []
      Object.assign(kid, { resolved: false, status: 'done', working: false })
      kid.requests = [
        {
          id: 'ui-child-review',
          step: kid.steps[0]?.id ?? '',
          agentId: kid.steps[0]?.agentId,
          kind: 'confirm',
          title: '「识别现场与方案」完成了，看一下结果再继续',
          detail: '## 现场\n\n- 侧栏时间按服务器时区显示\n\n## 方案\n\n改成按浏览器时区格式化',
          options: [],
          at: new Date().toISOString(),
        },
      ]
      localStorage.setItem(`task-child:${parent.id}`, '')
      localStorage.setItem(k, JSON.stringify(db))
    }, KEY)
    await p.reload()
    await backToTask()
    if (await p.locator('[data-child-request]').count())
      errors.push('子对话阶段确认：父对话输入框上方不该再有单独的确认条')
    const btn = p.locator('.proc-list').getByRole('button', { name: '查看结果' })
    if (
      !(await btn
        .first()
        .waitFor({ timeout: 10000 })
        .then(
          () => true,
          () => false,
        ))
    )
      errors.push('子对话阶段确认：运行区那个子对话的行上没有「查看结果」')
    else {
      await check(p, '子对话阶段确认-运行区那一行', ['阶段待确认'])
      await btn.first().click()
      const dlg = p.getByRole('dialog')
      await dlg
        .getByText('改成按浏览器时区格式化')
        .waitFor({ timeout: 10000 })
        .catch(() => errors.push('子对话阶段确认：点「查看结果」没有打开审阅弹窗'))
      await dlg.getByRole('button', { name: '确认', exact: true }).click()
      await dlg.waitFor({ state: 'detached', timeout: 5000 }).catch(() => errors.push('子对话阶段确认：确认后弹窗没关'))
      const left = await p.evaluate((k) => {
        const db = JSON.parse(localStorage.getItem(k) ?? '{}')
        return db.tasks.find((x) => x.title.includes('修侧栏时间显示'))?.requests?.length ?? 0
      }, KEY)
      if (left) errors.push('子对话阶段确认：在父对话页确认后子对话的请求还在')
    }
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [KEY, saved])
    await p.reload()
    await backToTask()
  }

  // 改文件的审批卡：带要改的内容（按行上色），「本对话不再询问」按目录放行（设计报告 Agent P0-3）
  {
    const KEY = 'agent-panel-demo-v3'
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k) ?? '{}')
      const task = (db.tasks ?? []).find((x) => x.title.startsWith('购物车右上角'))
      if (!task) return
      task.requests = [
        {
          id: 'ui-edit',
          step: '',
          agentId: task.agentId,
          kind: 'file',
          title: '修改文件：src/components/CartBadge.tsx',
          detail: '',
          diff: '--- a/src/components/CartBadge.tsx\n+++ b/src/components/CartBadge.tsx\n@@\n-  const count = items.length\n+  const count = items.reduce((n, x) => n + x.qty, 0)',
          rule: 'file:src/components/',
          options: [],
          at: new Date().toISOString(),
        },
      ]
      localStorage.setItem(k, JSON.stringify(db))
    }, KEY)
    await p.reload()
    await p.getByText('购物车右上角', { exact: false }).first().click()
    const card = p.getByRole('alertdialog', { name: 'Agent 请求确认' })
    if (
      !(await card.waitFor({ timeout: 10000 }).then(
        () => true,
        () => false,
      ))
    )
      errors.push('改文件审批卡：没有出现')
    else {
      await settle(p)
      await check(p, '审批卡-改文件带差异', ['CartBadge.tsx', 'items.reduce', '本对话不再询问', '允许一次'])
      // 等你确认的卡浮在输入框上方（FloatAbove），不排在停靠区里把输入框往下顶（用户 2026-11-10）
      if (!(await p.locator('[data-float-above]').getByRole('alertdialog', { name: 'Agent 请求确认' }).count()))
        errors.push('改文件审批卡：没有浮在输入框上方（应该在 FloatAbove 里）')
      // 紧贴输入框，不浮到消息区里：悬浮层的底边在计划、子对话那几行的下面（盖住它们没关系）
      const gap = await p.evaluate(() => {
        const f = document.querySelector('[data-float-above]')?.getBoundingClientRect()
        const rows = [...document.querySelectorAll('[data-status-row]')].map((r) => r.getBoundingClientRect().bottom)
        return f && rows.length ? f.bottom - Math.max(...rows) : 0
      })
      if (gap < 0) errors.push('改文件审批卡：悬浮层浮到了计划、子对话那几行的上面，应该紧贴输入框')
      // 子对话等你确认的条也浮在输入框上方（用户 2026-11-27），不夹在计划行和子对话栏之间
      if (await p.locator('[data-child-request]:not([data-float-above] [data-child-request])').count())
        errors.push('子对话等你确认的条：应该浮在输入框上方，不该留在子对话栏上面')
      // diff 统一画法（web/src/lib/diff-html.ts）：删除的行整行红底（.cdiff-del），记号和代码分开，不带开头的 -
      if (!(await card.locator('.cdiff-del').filter({ hasText: 'const count = items.length' }).count()))
        errors.push('改文件审批卡：删除行没有标红')
      const always = card.getByRole('button', { name: '本对话不再询问', exact: true })
      if (!(await always.getAttribute('title'))?.includes('目录 src/components/ 里的文件'))
        errors.push('改文件审批卡：「一直允许」的说明没写清放行的范围')
    }
    // 收掉这条，免得挡住后面的步骤
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k) ?? '{}')
      const task = (db.tasks ?? []).find((x) => x.title.startsWith('购物车右上角'))
      if (task) task.requests = []
      localStorage.setItem(k, JSON.stringify(db))
    }, KEY)
    await p.reload()
  }

  // 对话中的输入框「+」里引入工作流（ADR 0044：工作流只由父对话启动）：父对话的角色能启动工作流才有这一项；
  // 选好后输入框下面出工作流标记，发出去的要求点名这个工作流，交给父对话起工作流子对话
  {
    const KEY = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), KEY)
    const name = await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k) ?? '{}')
      const task = db.tasks.find((x) => x.title.startsWith('购物车右上角'))
      const agent = db.agents.find((a) => a.id === task.agentId)
      if (!agent) return ''
      Object.assign(agent, { canDelegate: true, canPlan: true })
      localStorage.setItem(k, JSON.stringify(db))
      return db.workflows[0]?.name ?? ''
    }, KEY)
    if (!name) errors.push('引入工作流：演示数据里父对话没有角色或没有工作流，用例前提不成立')
    else {
      await p.reload()
      await backToTask()
      await p.locator('#follow-up').waitFor({ timeout: 10000 })
      await p.getByRole('button', { name: '添加文件、图片或引用' }).first().click()
      const item = p.getByRole('button', { name: '引入工作流' })
      if (
        !(await item.waitFor({ timeout: 3000 }).then(
          () => true,
          () => false,
        ))
      )
        errors.push('引入工作流：父对话的「+」菜单里没有这一项')
      else {
        await check(p, '引入工作流-菜单', ['上传文件或图片', '引入工作流', '引入会话'])
        await item.click()
        await p
          .getByRole('button', { name: new RegExp(name) })
          .first()
          .click()
        // 和图片一样插成输入框里的一张行内卡片
        const chip = p.locator(`#follow-up [data-chip="workflow"][data-name="${name}"]`)
        await chip.waitFor({ timeout: 3000 }).catch(() => errors.push('引入工作流：选好后输入框里没有工作流卡片'))
        await p.locator('#follow-up').click()
        await p.keyboard.type('把角标刷新改掉')
        await check(p, '引入工作流-已选', [name])
        await p.keyboard.press('Enter')
        await chip
          .waitFor({ state: 'detached', timeout: 5000 })
          .catch(() => errors.push('引入工作流：发出去后输入框里的工作流卡片还在'))
        const sent = await p
          .waitForFunction(
            (k) => {
              const task = JSON.parse(localStorage.getItem(k) ?? '{}').tasks.find((x) =>
                x.title.startsWith('购物车右上角'),
              )
              return task.messages.find((m) => m.role === 'user' && m.text.includes('把角标刷新改掉'))?.text
            },
            KEY,
            { timeout: 5000 },
          )
          .then(
            (h) => h.jsonValue(),
            () => '',
          )
        if (!sent.startsWith(`用工作流「${name}」（id `)) errors.push(`引入工作流：发出去的要求没有点名工作流：${sent}`)
        // 对话里那条消息把点名画回工作流卡片，不露出「用工作流…（id …）做：」原文
        await p
          .locator(`[data-chip="workflow"][data-name="${name}"]`)
          .last()
          .waitFor({ timeout: 5000 })
          .catch(() => errors.push('引入工作流：对话里的消息没有显示工作流卡片'))
        if (await p.getByText(`用工作流「${name}」`, { exact: false }).count())
          errors.push('引入工作流：对话里露出了点名工作流的原文')
        await check(p, '引入工作流-已发送', ['把角标刷新改掉'])
      }
    }
    await p.evaluate(([k, raw]) => localStorage.setItem(k, raw), [KEY, saved])
  }
})
