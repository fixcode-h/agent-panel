/**
 * 界面检查分片：任务页：子对话、子任务、Token 浮层、执行计划、文件拖入、对话进程和内存曲线、工作流任务的节点、执行中发消息
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await p.getByText('购物车右上角', { exact: false }).first().click()
  // 右栏是文件系统（带 git 状态），启动命令是名字那行最右边的图标，上下文和用量在输入框下面
  await check(p, '任务', ['src', '命中', 'package.json'])
  /** 刷新后回到购物车那个任务页：当前路由就是任务页，等它画出来；没回到任务页时从列表点进去 */
  const backToTask = async () => {
    const token = p.getByTitle('Token 用量').first()
    if (
      await token.waitFor({ timeout: 5000 }).then(
        () => true,
        () => false,
      )
    )
      return
    await p.getByText('购物车右上角', { exact: false }).first().click()
    await token.waitFor({ timeout: 5000 }).catch(() => {})
  }
  /** Esc 关掉弹层之后等它真的卸载，再点下面的东西 */
  const closed = () =>
    p
      .getByRole('dialog')
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
  // 子对话栏的计数：三个在转圈（其中两个带没做完的计划，仍算执行中），分子就是 3；分母是进程还活着的 5 个。
  // 在跑又带着没做完计划的也算「执行中」，不能一边转圈一边归到「未完成」
  {
    // 按 aria-label 里的计数文案定位：页面上还有别的（禁用的）按钮也写着「子对话」
    const bar = p.getByRole('button', { name: /个进行中，共 \d+ 个/ })
    if (!(await bar.count())) errors.push('子对话栏：输入框上方没有子对话入口')
    else {
      await check(p, '子对话-三个在跑', ['子对话', '3/3'])
      await bar.first().click()
      await p.getByRole('button', { name: '全部' }).first().click()
      await check(p, '子对话-三个在跑-列表', ['执行中 · 3', '已完成 · 3'])
      await p.keyboard.press('Escape')
      await closed()
    }
  }
  // 派出的子任务不再铺在消息流里：入口在输入框上方、和子对话同一行，点开是列表和只读窗口
  {
    const openTask = () => backToTask()
    // 折叠行「派出 3 个子任务」也是一个按钮，入口按钮的 aria-label 正好是「子任务」，按精确名字定位它
    const bar = p.getByRole('button', { name: '子任务', exact: true })
    if (!(await bar.count())) errors.push('子任务栏：输入框上方没有「子任务」入口')
    else {
      if (await p.getByText('核对角标的订阅时机', { exact: false }).count())
        errors.push('子任务栏：消息流里还画着子任务卡片')
      await bar.first().click()
      // 这个示例对话本来就有 2 个子角色，演示数据又添了 1 个
      await check(p, '子任务-列表', ['共 3 个', '已完成', '核对角标的订阅时机', '8.60s'])
      await p.getByRole('button', { name: /核对角标的订阅时机/ }).click()
      await check(p, '子任务-窗口', ['问题在', '这里只能查看'])
      await p.keyboard.press('Escape')
      await closed()
      // 窄窗口：入口和输入框上方那一行不能被挤坏（运行中的块在窄屏收进按钮里）
      await p.setViewportSize({ width: 900, height: 800 })
      await p.reload()
      await openTask()
      if (!(await p.getByRole('button', { name: '子任务', exact: true }).count()))
        errors.push('子任务栏：窄窗口里入口不见了')
      await check(p, '子任务-窄窗口')
      await p.setViewportSize({ width: 1440, height: 900 })
      await p.reload()
      await openTask()
    }
  }

  // 实时推送时输入框不能被重新挂载、不能丢焦点：演示任务改成执行中，打字期间会不停推快照
  // （一次推送整页重渲染时，输入框如果跟着重挂载或重画，用户打一半就会失焦、字也会跳）
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    const openTask = async () => {
      await p.reload()
      await backToTask()
    }

    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k))
      const task = db.tasks.find((x) => x.title.includes('购物车'))
      task.status = 'running'
      localStorage.setItem(k, JSON.stringify(db))
    }, key)
    await openTask()
    const before = await p.evaluate(() => {
      window.__composer = document.querySelector('#follow-up')
      return { id: window.__composer?.id ?? '' }
    })
    await p.locator('#follow-up').click()
    await p.keyboard.type('实时推送时输入的内容')
    await p.waitForTimeout(1600)
    const after = await p.evaluate(() => {
      const el = document.querySelector('#follow-up')
      return {
        same: el === window.__composer,
        focused: el === document.activeElement,
        active: document.activeElement?.id ?? document.activeElement?.tagName ?? '',
        text: el?.textContent ?? '',
      }
    })
    if (before.id !== 'follow-up') errors.push('任务页没有找到输入框')
    else {
      if (!after.same) errors.push('实时推送时输入框被重新挂载')
      if (!after.focused) errors.push(`实时推送时输入框丢了焦点（焦点在 ${after.active}）`)
      if (!after.text.includes('实时推送时输入的内容')) errors.push('实时推送时输入的文字丢了')
    }
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await openTask()
  }
  // Token 胶囊：点开浮层看整个运行的合计（本对话 + 子对话 + 派出的子任务）
  {
    await p.getByTitle('Token 用量').first().click()
    await check(p, '任务-Token浮层', ['整个运行', '缓存命中'])
    await p.keyboard.press('Escape')
  }
  // 浮层里的速度只算正在输出的：造两种数据各截一张（演示数据用完改回去，不影响后面的截图）
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    /** writing：父对话在写、子对话和子任务都停了（留着上一轮很高的速度）；idle：全都没在输出 */
    const setup = (mode) =>
      p.evaluate(
        ([k, m]) => {
          const db = JSON.parse(localStorage.getItem(k))
          const parent = db.tasks.find((x) => x.title.includes('购物车'))
          const agent = (tps, lastTps) => ({
            context: 96000,
            window: 200000,
            model: 'claude-sonnet-5-5',
            tps,
            lastTps,
            outputTokens: 1000,
            genMs: 1000,
          })
          // 自己的步骤和派出的子任务分开用两个角色，界面才能把两层的速度拆开
          for (const s of parent.steps) s.agentId = s.slot === 'sub' ? 'demo-helper' : 'demo-own'
          parent.status = m === 'writing' ? 'running' : 'done'
          parent.usage.agents = {
            'demo-own': agent(m === 'writing' ? 42 : 0, m === 'writing' ? 42 : 900),
            // 已经停下的子任务：lastTps 还留着 2041.7，不能算进速度
            'demo-helper': agent(0, 2041.7),
          }
          db.tasks = db.tasks.filter((x) => !x.id.startsWith('demo-speed-'))
          for (const [i, id] of ['demo-speed-c1', 'demo-speed-c2'].entries()) {
            db.tasks.push({
              ...structuredClone(parent),
              id,
              parentTaskId: i ? 'demo-speed-c1' : parent.id,
              rootTaskId: parent.id,
              title: i ? '子对话：核对通知时序' : '子对话：角标订阅',
              status: 'done',
              steps: [],
              messages: [],
              usage: {
                agents: { 'demo-child': agent(0, 3000) },
                inputTokens: 2000,
                outputTokens: 200,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0.01,
              },
            })
          }
          localStorage.setItem(k, JSON.stringify(db))
        },
        [key, mode],
      )
    // 重新加载后回到任务页（当前路由就是任务页，不用再点头部）
    const gotoTask = async () => {
      await p.reload()
      await backToTask()
    }
    const openToken = async () => {
      await gotoTask()
      await p.getByTitle('Token 用量').first().click()
      await p.getByRole('dialog').last().waitFor({ timeout: 5000 })
    }
    const popover = async () => (await p.getByRole('dialog').last().innerText()).replace(/\s+/g, ' ')
    // 父对话在写：整体 = 本对话，子任务与子对话那行是「空闲」
    await setup('writing')
    await openToken()
    await check(p, '任务-Token浮层-父对话在写', ['整个运行', '空闲', '42.0 token/s'])
    const writing = await popover()
    if (/2041\.7|3000\.0/.test(writing)) errors.push(`Token 浮层：停下的子任务还在贡献速度（${writing}）`)
    await p.keyboard.press('Escape')
    // 全都没在输出：不显示任何残留速度
    await setup('idle')
    await openToken()
    await check(p, '任务-Token浮层-全都空闲', ['整个运行', '空闲'])
    const idle = await popover()
    if (/token\/s/.test(idle)) errors.push(`Token 浮层：全都空闲时还显示速度（${idle}）`)
    await p.keyboard.press('Escape')
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await gotoTask()
  }
  // 执行计划：输入框上方的按钮，点开是计划窗口（进行中的主步骤展开子步骤），以前的计划收在下面
  await p.getByRole('button', { name: '执行计划' }).click()
  await check(p, '执行计划', ['修复购物车角标', '等：端到端测试', '覆盖删除商品后角标归零', '以前的计划 · 1'])
  await p.keyboard.press('Escape')
  // 子对话里点「启动工作流」：在子对话这块面板内换成那次运行的视图，标题栏左边能返回子对话，
  // 右边是 ⋯ 和 ✕（✕ 关掉子对话面板本身，和返回不一样），返回后子对话原样回来
  {
    const key = 'agent-panel-demo-v3'
    const saved = await p.evaluate((k) => localStorage.getItem(k), key)
    // 演示数据里没有子对话：照父对话里的工作流任务造一个，并补一条「启动工作流」的调用
    await p.evaluate((k) => {
      const db = JSON.parse(localStorage.getItem(k))
      const parent = db.tasks.find((x) => x.title.includes('购物车'))
      const wf = db.tasks.find((x) => x.mode === 'workflow' && x.runs?.length && x.projectId === parent.projectId)
      if (!wf) return
      db.tasks = db.tasks.filter((x) => x.id !== 'demo-child-run')
      const child = structuredClone(wf)
      Object.assign(child, {
        id: 'demo-child-run',
        parentTaskId: parent.id,
        rootTaskId: parent.id,
        title: '子对话：到货提醒',
      })
      child.messages.splice(1, 0, {
        id: 'demo-child-tool',
        role: 'agent',
        agentId: '',
        step: '',
        text: '',
        at: new Date().toISOString(),
        tools: [
          {
            kind: 'other',
            name: 'MCP__panel__start_plan',
            label: '',
            detail: '',
            input: JSON.stringify({ input: '给商品详情页加「到货提醒」' }),
            output: '',
            ms: 1200,
          },
        ],
      })
      db.tasks.push(child)
      localStorage.setItem(k, JSON.stringify(db))
    }, key)
    const gotoTask = async () => {
      await p.reload()
      await backToTask()
    }
    /** 输入框上方的「子对话」→ 全部 → 打开那个子对话 */
    const openChild = async () => {
      await gotoTask()
      // 入口按钮带 aria-expanded + aria-label；页面上还有几个禁用的「子对话」占位按钮，按名字会撞上
      await p.locator('button[aria-expanded][aria-label^="子对话"]').first().click()
      await p.getByRole('button', { name: '全部' }).click()
      await p.getByText('子对话：到货提醒').first().click()
      await p
        .locator('button[title="打开这次运行的对话"]')
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => {})
    }
    await openChild()
    await check(p, '子对话-面板', ['子对话：到货提醒'])
    const runTitle = p.locator('button[title="打开这次运行的对话"]')
    if (!(await runTitle.count())) errors.push('子对话：工作流那几行没有「打开这次运行的对话」的入口')
    // 点「启动工作流」这一行：面板内换成这次运行的视图，不是把内容铺在子对话里
    await runTitle.first().click()
    await check(p, '子对话-运行视图', ['子对话：到货提醒', '第 1 次运行'])
    if (!(await p.getByRole('button', { name: '返回子对话' }).count()))
      errors.push('子对话运行视图：标题栏左边没有返回子对话的按钮')
    if (!(await p.getByRole('button', { name: '关闭子对话面板' }).count()))
      errors.push('子对话运行视图：标题栏右边没有关闭子对话面板的按钮')
    // 子对话启动的工作流也能补充要求：输入框跟着放进运行视图底下，盖住的子对话里不再留一个
    {
      const box = await p.evaluate(() => {
        const view = document.querySelector('button[aria-label="返回子对话"]')?.closest('.absolute')
        return {
          inView: view?.querySelectorAll('#follow-up').length ?? 0,
          under: view?.parentElement ? [...view.parentElement.querySelectorAll('#follow-up')].length : 0,
        }
      })
      if (box.inView !== 1) errors.push(`子对话运行视图：底下应该有一个输入框（现在 ${box.inView} 个）`)
      else if (box.under !== 1) errors.push(`子对话运行视图：被盖住的子对话里还留着输入框（共 ${box.under} 个）`)
    }
    // 窄窗口：标题截断，但返回和 ✕ 不能被挤掉（手机上子对话面板占满整个宽度）
    {
      await p.setViewportSize({ width: 420, height: 860 })
      await settle(p)
      const back = await p.getByRole('button', { name: '返回子对话' }).boundingBox()
      const close = await p.getByRole('button', { name: '关闭子对话面板' }).boundingBox()
      if (!back || !close) errors.push('子对话运行视图（窄窗口）：返回或关闭按钮不见了')
      else if (back.x < 0 || close.x + close.width > 420)
        errors.push(`子对话运行视图（窄窗口）：标题把按钮挤出视口（返回 ${back.x}，关闭 ${close.x + close.width}）`)
      await check(p, '子对话-运行视图-窄窗口')
      await p.setViewportSize({ width: 1440, height: 900 })
      await settle(p)
    }
    // 返回：回到子对话，不是关掉面板
    await p.getByRole('button', { name: '返回子对话' }).click()
    await p
      .getByRole('button', { name: '返回子对话' })
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    await check(p, '子对话-返回', ['子对话：到货提醒'])
    if (await p.getByRole('button', { name: '返回子对话' }).count())
      errors.push('子对话运行视图：点了返回，运行的视图还在')
    // 这一次运行的卡片也进同一个视图
    await runTitle.last().click()
    await check(p, '子对话-运行视图-卡片')
    // ✕：关掉子对话面板本身，回到父对话的文件面板
    await p.getByRole('button', { name: '关闭子对话面板' }).click()
    await p
      .getByText('子对话：到货提醒')
      .first()
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    await check(p, '子对话-关闭面板', ['购物车右上角'])
    if (await p.getByText('子对话：到货提醒').count()) errors.push('子对话运行视图：点 ✕ 后子对话面板还在')
    await p.evaluate(([k, raw]) => (raw ? localStorage.setItem(k, raw) : localStorage.removeItem(k)), [key, saved])
    await gotoTask()
  }
  // 回复完成后思考和工具调用收进一个折叠，折叠行写这段做了什么；点开能看到过程，再点收起
  {
    const fold = p.getByRole('button', { name: /查看 \d+ 个文件/ }).first()
    await fold.click().catch(() => errors.push('任务：回复完成后没有收起过程的折叠行'))
    await check(p, '任务-展开过程', ['思考过程'])
    await fold.click().catch(() => {})
  }
  // 窄版右栏的右键菜单：能弹出，而且整个菜单都在视口里（不能溢出去）
  {
    const compactRow = p.locator('button[title="package.json"]').first()
    const cb = await compactRow.boundingBox()
    if (!cb) errors.push('任务右栏：没有列出 package.json')
    else {
      await p.mouse.click(cb.x + 40, cb.y + cb.height / 2, { button: 'right' })
      const box = await p
        .locator('[role="menu"]')
        .first()
        .boundingBox()
        .catch(() => null)
      if (!box) errors.push('任务右栏：右键没有弹出菜单')
      else {
        const vw = p.viewportSize().width
        const vh = p.viewportSize().height
        if (box.x < 0 || box.y < 0 || box.x + box.width > vw || box.y + box.height > vh)
          errors.push(`任务右栏：右键菜单超出视口（${JSON.stringify(box)}，视口 ${vw}×${vh}）`)
        await check(p, '任务-右栏右键菜单')
      }
      await p.keyboard.press('Escape')
      await p
        .locator('[role="menu"]')
        .first()
        .waitFor({ state: 'detached', timeout: 3000 })
        .catch(() => {})
    }
  }
  // 按 Agent 显示的对话：滚到回复中部时「谁 + 什么模型」固定在滚动区顶部，下一轮顶走。
  // 演示内容不够长，先把这一轮撑高，再滚到中部看署名行的位置
  {
    const stuck = await p.evaluate(async () => {
      const sc = [...document.querySelectorAll('div')].find((el) => el.className === 'flex-1 overflow-y-auto')
      const row = [...document.querySelectorAll('*')].find((el) => getComputedStyle(el).position === 'sticky')
      if (!sc || !row) return 'no-sticky'
      const col = row.parentElement
      const pad = document.createElement('div')
      pad.style.height = '1800px'
      col.appendChild(pad)
      sc.scrollTop = 700
      await new Promise((r) => setTimeout(r, 250))
      const top = Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top)
      sc.scrollTop = 900
      await new Promise((r) => setTimeout(r, 250))
      const top2 = Math.round(row.getBoundingClientRect().top - sc.getBoundingClientRect().top)
      return { top, top2, bg: getComputedStyle(row).backgroundColor }
    })
    if (stuck === 'no-sticky') errors.push('署名吸顶：按 Agent 显示的对话里没有吸顶的署名行')
    else if (stuck.top !== 0 || stuck.top2 !== 0)
      errors.push(`署名吸顶：滚到回复中部时署名行没固定在顶部（top=${stuck.top}/${stuck.top2}）`)
    await p.evaluate(() => {
      const sc = [...document.querySelectorAll('div')].find((el) => el.className === 'flex-1 overflow-y-auto')
      sc.scrollTop = 0
    })
    await check(p, '任务-署名吸顶')
  }
  // 启动命令只留图标，点开才显示完整命令
  const cmd = p.getByRole('button', { name: '查看启动命令' }).first()
  if (!(await cmd.count())) errors.push('任务：没有启动命令按钮')
  else {
    await cmd.click()
    await check(p, '任务-启动命令', ['acceptEdits'])
    await p.keyboard.press('Escape')
  }
  if (!(await p.getByPlaceholder('查找文件').count())) errors.push('任务：没有文件搜索框')
  if (!(await p.getByLabel('刷新文件').first().count())) errors.push('任务：没有「刷新文件」')
  // 文件树里的文件左键长按拖到输入框：按住够久才拖起来，松手插入「@相对路径」纯文本，不当附件上传；
  // 拖动之后的补发 click 要压掉（不能顺手把文件打开），短按仍然是打开文件
  {
    const row = p.locator('button[data-file-row][data-path="package.json"]').first()
    const input = p.locator('#follow-up')
    await input.fill('')
    const rb = await row.boundingBox()
    const ib = await input.boundingBox()
    if (!rb || !ib) errors.push('长按拖入：找不到文件行或输入框')
    else {
      await p.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2)
      await p.mouse.down()
      await p.waitForTimeout(420)
      const tx = ib.x + ib.width / 2
      const ty = ib.y + ib.height / 2
      for (let i = 1; i <= 12; i++) {
        await p.mouse.move(rb.x + ((tx - rb.x) * i) / 12, rb.y + ((ty - rb.y) * i) / 12)
        await p.waitForTimeout(25)
      }
      await p.mouse.up()
      await input
        .filter({ hasText: '@package.json' })
        .waitFor({ timeout: 3000 })
        .catch(() => {})
      const text = (await input.textContent()) ?? ''
      if (!text.includes('@package.json')) errors.push(`长按拖入：输入框里没有引用（${JSON.stringify(text)}）`)
      if (await input.locator('[data-chip]').count()) errors.push('长按拖入：引用被做成了附件卡片')
      if (await p.getByRole('dialog').count()) errors.push('长按拖入：拖动把文件也打开了')
      // 行首的 @ 用等宽字体造形，不能是「图标和文字叠在一起」那个坏字形
      const atW = await p.evaluate(() => {
        const el = document.querySelector('#follow-up')
        const node = el?.firstChild
        if (!node || node.nodeType !== Node.TEXT_NODE) return 0
        const r = document.createRange()
        r.setStart(node, 0)
        r.setEnd(node, 1)
        return r.getBoundingClientRect().width
      })
      if (atW < 6 || atW > 11) errors.push(`长按拖入：@ 的宽度是 ${atW}，不像正常等宽字形`)
      await check(p, '任务-长按拖入引用', ['@package.json'])
      // 短按还是打开文件
      await row.click()
      await p
        .getByRole('dialog')
        .first()
        .waitFor({ timeout: 5000 })
        .catch(() => errors.push('长按拖入：短按没有打开文件'))
      await p.keyboard.press('Escape')
      await input.fill('')
    }
  }
  // 从外面把文件拖到消息区（不是输入框）也算引入到要求里：拖入时整页提示，松开后进附件条和内联卡片；
  // 只拖文字时不拦截浏览器默认行为
  {
    const dropped = await p.evaluate(async () => {
      const sc = [...document.querySelectorAll('div')].find((el) => el.className === 'flex-1 overflow-y-auto')
      if (!sc) return { error: '没有消息区' }
      const box = sc.getBoundingClientRect()
      const at = (dt, x, y) => ({ bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y })
      const file = new DataTransfer()
      file.items.add(new File(['dropped from the message area'], '页面拖入.txt', { type: 'text/plain' }))
      // 模拟真实拖拽：先在消息区进入、在子元素之间移动（enter/leave 交错），提示不能闪掉
      sc.dispatchEvent(new DragEvent('dragenter', at(file, box.left + 80, box.top + 70)))
      sc.dispatchEvent(new DragEvent('dragover', at(file, box.left + 90, box.top + 80)))
      await new Promise((r) => setTimeout(r, 200))
      const inner = sc.querySelector('div')
      if (inner) inner.dispatchEvent(new DragEvent('dragenter', at(file, box.left + 100, box.top + 90)))
      sc.dispatchEvent(new DragEvent('dragleave', at(file, box.left + 100, box.top + 90)))
      await new Promise((r) => setTimeout(r, 250))
      const hint = document.body.textContent.includes('松开鼠标，把文件附到要求里')
      const inputHighlighted = !!document.querySelector('#follow-up')?.closest('.border-accent')
      // 只拖文字：不能 preventDefault
      const text = new DataTransfer()
      text.setData('text/plain', '一段文字')
      const textEvent = new DragEvent('dragover', at(text, box.left + 90, box.top + 80))
      sc.dispatchEvent(textEvent)
      sc.dispatchEvent(new DragEvent('drop', at(file, box.left + 90, box.top + 80)))
      await new Promise((r) => setTimeout(r, 1200))
      return {
        hint,
        inputHighlighted,
        textPrevented: textEvent.defaultPrevented,
        hintAfterDrop: document.body.textContent.includes('松开鼠标，把文件附到要求里'),
        chip: !!document.querySelector('[data-chip="file"][data-name="页面拖入.txt"]'),
        inline: document.body.textContent.includes('页面拖入.txt'),
      }
    })
    if (dropped.error) errors.push(`拖文件：${dropped.error}`)
    else {
      if (!dropped.hint) errors.push('拖文件：在消息区拖入时没有整页提示')
      if (dropped.inputHighlighted) errors.push('拖文件：页面提示和输入框高亮同时出现，叠了两层提示')
      if (dropped.textPrevented) errors.push('拖文件：只拖文字时被拦截了（应该保持浏览器默认行为）')
      if (dropped.hintAfterDrop) errors.push('拖文件：松开后整页提示没有消失')
      if (!dropped.chip) errors.push('拖文件：在消息区松开后要求里没有这张卡片')
      if (!dropped.inline) errors.push('拖文件：附件没有出现在要求里')
    }
    await check(p, '任务-页面拖文件')
    // 这个附件只用于检查拖入，清掉以免影响后面的步骤
    await p
      .locator('[data-chip="file"][data-name="页面拖入.txt"]')
      .first()
      .press('Backspace')
      .catch(() => {})
  }
  // 工作流任务：任务进度按节点列出，节点下面挂验收和它自己派出的子 Agent，窄窗口里从标题栏点开
  await p.getByText('商品详情页增加', { exact: false }).first().click()
  // 对话进程下拉：收起时不挂载面板内容（DOM 里没有节点、也不轮询），展开后才渲染进程列表和内存合计
  const procBtn = p.getByRole('button', { name: '对话进程' }).first()
  await procBtn.waitFor({ timeout: 5000 }).catch(() => errors.push('任务：没有「对话进程」按钮'))
  if ((await p.getByText('内存合计').count()) > 0) errors.push('对话进程：收起状态下面板内容已经挂在 DOM 里')
  await procBtn.click()
  await check(p, '任务-对话进程', [
    '内存合计',
    '清理无效进程',
    '已结束的子任务',
    // 合计行要说明是哪些加起来：这个会话树上全部进程（含子对话）
    '这个会话树上全部进程的合计，含子对话',
    '下面按归属分组',
  ])
  // 子对话的进程只算它自己：组头分别标出本对话 / 子对话，内存读不到的写未采集
  await check(p, '任务-对话进程-归属', ['本对话', '子对话'])
  // 内存曲线：原有左右拖动和悬停读数保留；右键也能拖，拖过之后出现「回到最新」
  await p.getByRole('button', { name: '内存曲线', exact: true }).click()
  await check(p, '任务-内存曲线', ['AI 分析', '每 30 秒采样一次'])
  const chatChart = p.getByRole('img', { name: '会话内存随时间的变化' })
  const chatBox = await chatChart.boundingBox()
  if (!chatBox) errors.push('任务-内存曲线：曲线没有渲染')
  else {
    if (await p.getByRole('button', { name: '回到最新' }).count())
      errors.push('任务-内存曲线：还没拖动就出现了「回到最新」')
    // 往右拖 = 看更早（MemoryChart 的 offset 变大）
    await p.mouse.move(chatBox.x + chatBox.width * 0.2, chatBox.y + chatBox.height / 2)
    await p.mouse.down({ button: 'right' })
    await p.mouse.move(chatBox.x + chatBox.width * 0.8, chatBox.y + chatBox.height / 2, { steps: 8 })
    await p.mouse.up({ button: 'right' })
    await check(p, '任务-内存曲线-右键拖动', ['回到最新'])
    await p.getByRole('button', { name: '回到最新' }).click()
    await p
      .getByRole('button', { name: '回到最新' })
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(() => {})
    if (await p.getByRole('button', { name: '回到最新' }).count())
      errors.push('任务-内存曲线：点了「回到最新」按钮还留着')
  }
  // 收起：面板内容不挂载。放在弹窗前做，聚焦的下拉状态最干净
  await p.getByRole('button', { name: '对话进程' }).first().click()
  await p
    .locator('[aria-label="对话进程"][aria-expanded="false"]')
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => {})
  if ((await p.locator('[aria-label="对话进程"]').first().getAttribute('aria-expanded')) !== 'false')
    errors.push('对话进程：收起后按钮的 aria-expanded 不是 false')
  if ((await p.getByText('内存合计').count()) > 0) errors.push('对话进程：收起后面板内容还挂在 DOM 里')
  // AI 分析：把采样和进程占用交给演示里的 AI 排查对话，在统一的弹窗里出结论（先重新打开下拉）
  await procBtn.click()
  await p.getByRole('button', { name: '内存曲线', exact: true }).click()
  await p.getByRole('button', { name: 'AI 分析', exact: true }).click()
  await p
    .getByRole('heading', { name: 'AI 排查：会话内存分析' })
    .last()
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('任务-内存曲线：点 AI 分析没有新建排查对话'))
  await check(p, '任务-内存曲线-AI分析', ['这次要做的：看一下这个会话的内存'])
  // 关闭时先确认停止（和别处的 AI 排查一样）
  await p.getByRole('button', { name: '关闭', exact: true }).last().click()
  if (await p.getByText('停止 AI 排查？').isVisible()) {
    await p.getByRole('button', { name: '停止并关闭' }).click()
  }
  // 等弹窗真的收起再点任务页的东西，别被遮罩挡住
  await p
    .getByRole('dialog')
    .last()
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => {})
  await p.getByRole('button', { name: '任务进度' }).click()
  // 演示任务是启动后在后台模拟执行的，轮到这个任务时可能还没跑完：等测试节点的子 Agent 出现再断言
  await p
    .getByText('子角色 · 单元测试', { exact: false })
    .first()
    .waitFor({ timeout: 30000 })
    .catch(() => {})
  await check(p, '任务-节点与子Agent', ['分析需求、拆分任务', '单元测试', '子角色 · 单元测试'])
  // 执行中发消息：在聊天页新建一个对话，趁它还在回复时再发一条。消息立刻出现在对话里，
  // 没有「排队」卡片、也没有「下一条」的排队提示
  await p.goto(base + '#/chat')
  await p.locator('#task-prompt').fill('整理一下这个项目的模块结构')
  await p.waitForTimeout(300)
  const opened = await p
    .locator('#task-prompt')
    .press('Enter')
    .then(
      () => p.locator('#follow-up').waitFor({ timeout: 20000 }),
      () => undefined,
    )
    .then(
      () => true,
      () => false,
    )
  if (!opened) errors.push('执行中发消息：新建对话后没有进入任务页')
  else {
    await p.locator('#follow-up').fill('顺手看看测试配置')
    await p.locator('#follow-up').press('Enter')
    await p
      .getByText('顺手看看测试配置', { exact: false })
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('执行中发消息：消息没有立刻出现在对话里'))
    if (await p.getByText('排队', { exact: false }).count()) errors.push('执行中发消息：还能看到「排队」')
    if (await p.getByText('下一条', { exact: true }).count()) errors.push('执行中发消息：还能看到「下一条」的排队卡片')
    await check(p, '任务-执行中发消息')
  }
})
