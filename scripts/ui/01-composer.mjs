/**
 * 界面检查分片：输入框：斜杠命令、行内技能和图片卡片、引入会话、发出去的图片消息、对话里的路径、手机宽度
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import { runShard, TINY_PNG } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await check(p, '首页', ['新建任务', '工作流'])
  // 左侧栏不再有独立的「文件」入口：文件的入口只在项目页右侧的文件面板里
  if (
    await p
      .locator('nav[aria-label="主导航"] button')
      .filter({ hasText: /^文件$/ })
      .count()
  )
    errors.push('侧栏：还留着「文件」这个入口')
  // 对话方式下输入「/」：内置命令、CLI 自己的命令和 Skill
  await p.goto(base + '#/chat')
  await p.locator('#task-prompt').fill('/')
  await p.locator('#task-prompt').press('End')
  await check(p, '斜杠命令', ['/init', '/commit', 'frontend-design'])
  // 菜单限高后超出的部分靠滚动看：按 ↓ 时选中项要跟着滚进菜单可视区，不能被裁在菜单外面
  const picked = () =>
    p.evaluate(() => {
      const box = document.querySelector('[role="listbox"]')
      const cur = box?.querySelector('[aria-selected="true"]')
      if (!box || !cur) return null
      const b = box.getBoundingClientRect()
      const r = cur.getBoundingClientRect()
      return {
        scrollTop: box.scrollTop,
        scrollable: box.scrollHeight > box.clientHeight + 1,
        boxTop: b.top,
        boxBottom: b.bottom,
        top: r.top,
        bottom: r.bottom,
      }
    })
  // 先往下挪几格停在菜单中部，顺便留一张选中项在菜单中部的截图
  for (let i = 0; i < 6; i++) await p.locator('#task-prompt').press('ArrowDown')
  await check(p, '斜杠命令-选中项跟随滚动')
  const mid = await picked()
  if (!mid) errors.push('斜杠命令：按 ↓ 后找不到选中的命令')
  else {
    if (!mid.scrollable) errors.push('斜杠命令：演示的命令太少，菜单没滚起来，检查不了滚动')
    if (mid.boxTop < -0.5) errors.push('斜杠命令：菜单顶部超出窗口')
    if (mid.top < mid.boxTop - 0.5 || mid.bottom > mid.boxBottom + 0.5)
      errors.push('斜杠命令：按 ↓ 后选中项不在菜单可视区里')
  }
  // 一路按到最后一项：菜单要跟着滚，选中项仍然完整可见
  for (let i = 0; i < 40; i++) await p.locator('#task-prompt').press('ArrowDown')
  const last = await picked()
  if (!last || last.scrollTop <= 0) errors.push('斜杠命令：↓ 到最后一项时菜单没滚动（scrollTop 还是 0）')
  else if (last.top < last.boxTop - 0.5 || last.bottom > last.boxBottom + 0.5)
    errors.push('斜杠命令：↓ 到最后一项时选中项被裁在菜单外面')
  // 窗口矮的时候菜单也不能顶出窗口外
  await p.setViewportSize({ width: 1440, height: 520 })
  await p.locator('#task-prompt').fill('/')
  await p.locator('#task-prompt').press('End')
  for (let i = 0; i < 6; i++) await p.locator('#task-prompt').press('ArrowDown')
  const short = await picked()
  if (!short) errors.push('斜杠命令-矮窗口：没有弹出菜单')
  else {
    if (short.boxTop < -0.5) errors.push(`斜杠命令-矮窗口：菜单顶部超出窗口 ${Math.round(-short.boxTop)}px`)
    if (short.boxBottom > 520.5) errors.push('斜杠命令-矮窗口：菜单超出窗口底部')
    if (short.top < short.boxTop - 0.5 || short.bottom > short.boxBottom + 0.5)
      errors.push('斜杠命令-矮窗口：选中项不在菜单可视区里')
  }
  await p.setViewportSize({ width: 1440, height: 900 })
  // 选中后是文字原位的一张卡片；光标停在它后面，按一次退格整张删掉
  await p.locator('#task-prompt').fill('前 ')
  await p.locator('#task-prompt').pressSequentially('/frontend-design')
  await p.getByRole('listbox').getByText('/frontend-design', { exact: true }).click()
  const skillChip = p.locator('#task-prompt [data-chip="skill"]')
  await skillChip.waitFor({ timeout: 5000 }).catch(() => errors.push('行内技能卡片：选中后没有出现在文字里'))
  await check(p, '斜杠命令-行内技能', ['前', '/frontend-design'])
  await p.keyboard.press('Backspace')
  await skillChip
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => errors.push('行内技能卡片：按一次退格没有整张删掉'))
  await p.locator('#task-prompt').fill('')
  // 图片是文字原位的一张图：直接显示图片本身，点开看大图，右上角有删除按钮
  await p
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name: '截图.png', mimeType: 'image/png', buffer: TINY_PNG })
  const imageChip = p.locator('#task-prompt [data-chip="image"]')
  await imageChip.waitFor({ timeout: 10000 }).catch(() => errors.push('行内图片卡片：附上图片后没有出现在文字里'))
  if (!(await imageChip.locator('img[src^="blob:"]').count())) errors.push('行内图片卡片：没有显示缩略图')
  // 输入框上方不再有附件条
  if (await p.getByRole('button', { name: '移除 截图.png' }).count()) errors.push('输入框上方还有附件条')
  // 右键卡片弹出面板自己的菜单（不是浏览器原生菜单），点「复制图片」真的写进系统剪贴板
  await imageChip.click({ button: 'right' })
  const copyImageItem = p.getByRole('menuitem', { name: '复制图片' })
  await copyImageItem.waitFor({ timeout: 3000 }).catch(() => errors.push('行内图片卡片：右键没有弹出卡片菜单'))
  await check(p, '输入框卡片-右键菜单', ['复制图片'])
  await copyImageItem.click()
  await p
    .getByText('图片已复制到剪贴板')
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('行内图片卡片：复制图片后没有成功提示'))
  const clipTypes = await p
    .evaluate(async () => (await navigator.clipboard.read()).flatMap((i) => i.types))
    .catch(() => null)
  if (!clipTypes) errors.push('行内图片卡片：读不到剪贴板（权限或浏览器不支持）')
  else if (!clipTypes.includes('image/png'))
    errors.push(`行内图片卡片：剪贴板里没有 PNG（${clipTypes.join(',') || '空'}）`)
  // 点图片能看大图
  await imageChip.locator('img').click()
  await p
    .getByRole('dialog')
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('行内图片卡片：点图片没有打开大图'))
  await p.keyboard.press('Escape')
  // 卡片右上角的删除按钮能删掉这张卡片
  await imageChip.locator('[data-chip-action="remove"]').click()
  await imageChip
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => errors.push('行内图片卡片：点卡片上的删除后卡片还在'))
  // 「+」里引入会话
  await p.getByRole('button', { name: '添加文件、图片或引用' }).click()
  await p.getByRole('button', { name: '引入会话' }).click()
  await check(p, '引入会话', ['主菜单', '购物车右上角'])
  await p.keyboard.press('Escape')

  // 发出去的图片消息：气泡里直接显示图片，点开浮层能看大图；取不到图时回落成图标，不显示破图
  {
    const p = await page({ width: 1440, height: 900 })
    await p.goto(base + '#/chat')
    await p.locator('#task-prompt').waitFor({ timeout: 10000 })
    await settle(p)
    // 先写文字再附图片：已经有卡片时往输入框里填，会卡在富文本受控内容上
    await p.locator('#task-prompt').fill('看看这张图')
    await p
      .locator('input[type=file]')
      .first()
      .setInputFiles({ name: '截图-气泡.png', mimeType: 'image/png', buffer: TINY_PNG })
    await p
      .locator('#task-prompt [data-chip="image"]')
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('图片气泡：附上图片后输入框里没有卡片'))
    // 上传是异步的：草稿里出现带 done 的这张才算传完，不然发出去的是空附件
    await p
      .waitForFunction(
        () =>
          Object.keys(localStorage).some((k) => {
            if (!k.startsWith('chat-attach:')) return false
            try {
              return JSON.parse(localStorage.getItem(k) ?? '[]').some((x) => x.done?.name === '截图-气泡.png')
            } catch {
              return false
            }
          }),
        undefined,
        { timeout: 20000 },
      )
      .catch(() => errors.push('图片气泡：图片没有上传完'))
    await p.locator('#task-prompt').press('Enter')
    // 打开对话页以后输入框换成 #follow-up：等它换掉，再找消息里的卡片（不然会匹配到输入框里那张）
    await p
      .locator('#task-prompt')
      .waitFor({ state: 'detached', timeout: 20000 })
      .catch(() => errors.push('图片气泡：发出后没有打开对话页'))
    const bubble = p.locator('[data-chip="image"][data-name="截图-气泡.png"]')
    await bubble.waitFor({ timeout: 20000 }).catch(() => errors.push('图片气泡：发出去以后消息里没有图片卡片'))
    const chip = await bubble
      .evaluate((el) => {
        const img = el.querySelector('img')
        return {
          src: img?.getAttribute('src') ?? '',
          missing: el.getAttribute('data-missing') === 'true',
          broken: img ? img.naturalWidth === 0 : true,
        }
      })
      .catch(() => null)
    if (!chip) errors.push('图片气泡：消息里的图片卡片读不出来')
    else {
      if (chip.missing) errors.push('图片气泡：附件明明在，卡片却显示成「附件已经不在了」')
      if (!chip.src || chip.broken) errors.push(`图片气泡：缩略图没有显示出来（src=${chip.src || '空'}）`)
    }
    await check(p, '对话-图片气泡')
    // 右上角「⋯」里的「复制对话」：剪贴板里是转录文件的路径，粘贴回输入框变成一张会话卡片，不是一段文字
    await p.getByRole('button', { name: '更多操作' }).first().click()
    // 导出菜单里除了 JSON 包还要有单文件 HTML 报告（不点：点了会下载文件）
    if (!(await p.getByRole('menuitem', { name: '导出 HTML 报告' }).count()))
      errors.push('导出：更多操作菜单里没有「导出 HTML 报告」')
    await p.getByRole('menuitem', { name: '复制对话' }).click()
    await p
      .getByText('对话已复制，粘贴到输入框会变成一张会话卡片')
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('复制对话：没有成功提示'))
    const copied = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '')
    if (!/\.md\s*$/.test(copied)) errors.push(`复制对话：剪贴板里不是转录文件的路径（${copied || '空'}）`)
    await p.locator('#follow-up').click()
    await p.keyboard.press('Control+V')
    const convChip = p.locator('#follow-up [data-chip="file"]')
    await convChip.waitFor({ timeout: 5000 }).catch(() => errors.push('复制对话：粘贴后输入框里没有出现会话卡片'))
    // 卡片背后要有附件（才能发给 Agent），输入框里不能留着那段路径文字
    const draftText = await p
      .locator('#follow-up')
      .innerText()
      .catch(() => '')
    if (copied.trim() && draftText.includes(copied.trim())) errors.push('复制对话：粘贴后还留着一大段路径文字')
    await check(p, '复制对话-粘贴成卡片')
    // 已发送消息里带附件卡片的：点消息下面的复制按钮，粘回来要变回卡片，路径不能和正文粘在一起。
    // 用户报的两个现象都在这里：卡片紧跟着正文时复制出去是「…png前面是…」，findPaths 把后面的中文
    // 一起当成路径（stat 不到），整段落成纯文本。用刚发出去的那条（气泡里有一张图片卡片）
    await p.locator('#follow-up').click()
    await p.keyboard.press('Control+A')
    await p.keyboard.press('Backspace')
    await p
      .waitForFunction(() => !document.querySelector('#follow-up [data-chip]'), null, { timeout: 5000 })
      .catch(() => errors.push('消息复制-粘贴成卡片：输入框清不空'))
    // 卡片紧贴正文是用户实际的发送形态：在对话页输入框里先打字再附图片，中间不留空格。
    // 注意：输入框自己会用 insertChip 在卡片前补一个空格（RichInput 的 insertChip），所以这里得到的是
    // 「前面是抓取的元素 [图片:…]」，走不到 copyText 新增的「卡片前补空格」分支。
    // 「粘贴时出现空格 + 粘回来变回卡片」这段全流程靠这里覆盖；
    // 真正无空格形态（[图片:…]前面是…）由 server/composer.test.ts 的 copyText 用例覆盖
    await p.locator('#follow-up').fill('前面是抓取的元素')
    await p
      .locator('input[type=file]')
      .first()
      .setInputFiles({ name: '截图-粘贴.png', mimeType: 'image/png', buffer: TINY_PNG })
    await p
      .locator('#follow-up [data-chip="image"]')
      .waitFor({ timeout: 10000 })
      .catch(() => errors.push('消息复制-粘贴成卡片：附上图片后输入框里没有卡片'))
    await p
      .waitForFunction(
        () =>
          Object.keys(localStorage).some((k) => {
            if (!k.startsWith('chat-attach:')) return false
            try {
              return JSON.parse(localStorage.getItem(k) ?? '[]').some((x) => x.done?.name === '截图-粘贴.png')
            } catch {
              return false
            }
          }),
        undefined,
        { timeout: 20000 },
      )
      .catch(() => errors.push('消息复制-粘贴成卡片：图片没有上传完'))
    await p.locator('#follow-up').press('Enter')
    // 发出去后回到消息里：找气泡里那张卡片所在的用户消息，点它的复制按钮
    const sentChip = p.locator('[data-chip="image"][data-name="截图-粘贴.png"]')
    await sentChip
      .waitFor({ timeout: 20000 })
      .catch(() => errors.push('消息复制-粘贴成卡片：发出去以后消息里没有图片卡片'))
    const sentCopy = sentChip
      .locator('xpath=ancestor::div[contains(@class,"group/msg")]//button[@aria-label="复制"]')
      .first()
    await sentCopy.click()
    // 点完的反馈是按钮自己把 title 换成「已复制」（内容只是一个 Check 图标，没有文字），
    // 不能用 getByText('已复制')：那只会匹配到页面上别处的 toast，toast 先消失时就误报「没反应」
    await p
      .waitForFunction(
        () => [...document.querySelectorAll('[aria-label="复制"]')].some((el) => el.getAttribute('title') === '已复制'),
        undefined,
        { timeout: 5000 },
      )
      .catch(() => errors.push('消息复制-粘贴成卡片：点复制后按钮没有变成「已复制」'))
    const msgCopied = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '')
    if (!msgCopied) errors.push('消息复制-粘贴成卡片：剪贴板是空的')
    // 路径和正文之间要有分隔：不然粘回来时整段中文被当成路径，卡片换不回来
    if (/截图-粘贴\.png[^\s"]/.test(msgCopied))
      errors.push(`消息复制-粘贴成卡片：路径后面直接贴着正文（${msgCopied.slice(0, 60)}）`)
    await p.locator('#follow-up').click()
    await p.keyboard.press('Control+A')
    await p.keyboard.press('Backspace')
    await p
      .waitForFunction(() => !document.querySelector('#follow-up [data-chip]'), null, { timeout: 5000 })
      .catch(() => errors.push('消息复制-粘贴成卡片：粘贴前输入框清不空'))
    await p.locator('#follow-up').click()
    await p.keyboard.press('Control+V')
    await p
      .locator('#follow-up [data-chip="image"][data-name="截图-粘贴.png"]')
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('消息复制-粘贴成卡片：粘回来没有变回图片卡片'))
    if (await p.locator('#follow-up [data-chip="file"]').count())
      errors.push('消息复制-粘贴成卡片：附件粘成了文件卡片，不是图片卡片')
    const repasted = await p
      .locator('#follow-up')
      .innerText()
      .catch(() => '')
    // 卡片自己显示文件名，所以不能按「有没有文件名」判断；要看路径文字（盘符或 uploads 目录）还在不在
    if (/[A-Za-z]:\\|uploads[\\/]/.test(repasted))
      errors.push(`消息复制-粘贴成卡片：粘贴后还留着路径文字（${repasted.slice(0, 60)}）`)
    if (!repasted.includes('前面是抓取的元素')) errors.push('消息复制-粘贴成卡片：粘贴后正文丢了')
    await check(p, '消息复制-粘贴成卡片')
    // 点开浮层看大图：别等 Playwright 的可点击判定（演示的回复还在流式输出、消息区跟着滚），直接点
    await bubble.evaluate((el) => el.click())
    await p
      .getByRole('dialog')
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('图片气泡：点开没有看大图的浮层'))
    const big = await p
      .locator('[role="dialog"] img')
      .first()
      .evaluate((el) => ({ src: el.getAttribute('src') ?? '', broken: el.naturalWidth === 0 }))
      .catch(() => null)
    if (!big || !big.src || big.broken) errors.push('图片气泡：浮层里的大图没有显示出来')
    await check(p, '对话-图片大图')
    await p.keyboard.press('Escape')
    await p.close()
  }

  // 对话里的图片 / 文件路径：点开直接看大图或文件内容；不像路径的行内代码保持原样
  {
    const p = await page({ width: 1440, height: 900 })
    await p.goto(base + '#/chat')
    await p.locator('#task-prompt').waitFor({ timeout: 10000 })
    await settle(p)
    await p.locator('#task-prompt').fill('看看这些文件')
    await p.locator('#task-prompt').press('Enter')
    await p
      .locator('#task-prompt')
      .waitFor({ state: 'detached', timeout: 20000 })
      .catch(() => errors.push('路径可点：发出后没有打开对话页'))
    // 等演示的回复写完，免得刷新后接着回复、把补进去的那条挤到中间
    await p
      .waitForFunction(
        () => {
          const id = decodeURIComponent(location.hash.split('/').pop() ?? '')
          const d = JSON.parse(localStorage.getItem('agent-panel-demo-v3') ?? '{}')
          const task = (d.tasks ?? []).find((x) => x.id === id)
          return !!task && task.status !== 'running'
        },
        undefined,
        { timeout: 20000 },
      )
      .catch(() => errors.push('路径可点：演示的回复一直没写完'))
    // 演示的回复是固定的，往这个对话里补一条带路径的回复（回复里出现的路径才是要测的）。
    // 在页面脚本运行之前写进 localStorage（addInitScript）：页面卸载时会把内存里的对话写回去，
    // 直接改 localStorage 再刷新，机器慢时补进去的这条会被盖掉
    const added = decodeURIComponent(new URL(p.url()).hash.split('/').pop() ?? '')
    if (!added) errors.push('路径可点：没有找到刚建的对话，补不进回复')
    await p.addInitScript((id) => {
      const key = 'agent-panel-demo-v3'
      const d = JSON.parse(localStorage.getItem(key) ?? '{}')
      const task = (d.tasks ?? []).find((x) => x.id === id)
      if (!task || task.messages.some((m) => m.id === 'demo-paths')) return
      task.messages.push({
        id: 'demo-paths',
        role: 'agent',
        agentId: task.messages.find((m) => m.role === 'agent')?.agentId ?? '',
        step: '',
        text: [
          '截图：`ui-shots/107-对话-图片气泡.png`',
          '',
          '改的是 `src/App.tsx:7`。',
          '',
          '不是路径的：`console.log`、`1.2.3`、`https://example.com/a.png`',
        ].join('\n'),
        tools: [],
        at: new Date().toISOString(),
      })
      localStorage.setItem(key, JSON.stringify(d))
    }, added)
    await p.reload()
    const mdPath = p.locator('code.md-path')
    await mdPath
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => errors.push('路径可点：回复里的路径没有标成能点的'))
    const links = await mdPath.evaluateAll((els) =>
      els.map((el) => ({ text: el.textContent ?? '', tip: el.getAttribute('title') ?? '' })),
    )
    const texts = links.map((l) => l.text)
    if (!texts.includes('ui-shots/107-对话-图片气泡.png'))
      errors.push(`路径可点：中文图片路径没有变成链接（${texts.join('、')}`)
    if (!texts.includes('src/App.tsx:7')) errors.push('路径可点：带行号的文件路径没有变成链接')
    if (links.find((l) => l.text === 'ui-shots/107-对话-图片气泡.png')?.tip !== '查看图片')
      errors.push('路径可点：图片路径的提示不是「查看图片」')
    // 不像路径的行内代码不能变成点了报错的假链接
    const wrong = await p.evaluate(() => {
      const notPath = ['console.log', '1.2.3', 'https://example.com/a.png']
      return [...document.querySelectorAll('code')]
        .filter((el) => notPath.includes(el.textContent ?? '') && el.classList.contains('md-path'))
        .map((el) => el.textContent ?? '')
    })
    if (wrong.length) errors.push(`路径可点：${wrong.join('、')} 不该变成链接`)
    await check(p, '对话-路径可点')
    // 点图片路径：弹出来看大图
    await mdPath
      .filter({ hasText: 'ui-shots/107-对话-图片气泡.png' })
      .first()
      .evaluate((el) => el.click())
    // 图是异步加载的：等它真的画出来再看 naturalWidth，否则拿到的是 0
    await p
      .waitForFunction(
        () => {
          const img = document.querySelector('[role="dialog"] img')
          return !!img && img.complete && img.naturalWidth > 0
        },
        undefined,
        { timeout: 8000 },
      )
      .catch(() => errors.push('路径可点：点开图片路径没有出现图片浮层'))
    const big = await p
      .locator('[role="dialog"] img')
      .first()
      .evaluate((el) => ({ src: el.getAttribute('src') ?? '', width: el.naturalWidth }))
      .catch(() => null)
    if (!big || !big.src || big.width === 0) errors.push('路径可点：图片路径点开后没有显示图片')
    await check(p, '对话-路径-图片大图')
    await p.keyboard.press('Escape')
    // 点文件路径：弹窗里显示文件内容并停在提到的那一行
    await mdPath
      .filter({ hasText: 'src/App.tsx:7' })
      .first()
      .evaluate((el) => el.click())
    const dialog = p.locator('[role="dialog"]')
    await dialog
      .getByText('src/App.tsx:7', { exact: false })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('路径可点：点开文件路径没有打开文件弹窗'))
    // 文件内容是异步读回来的：等第一行出现再断言，不然拿到的是还在转圈的弹窗
    await dialog
      .locator('[data-line]')
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => errors.push('路径可点：文件弹窗里没有显示文件内容'))
    // 只看文件弹窗里的行号行：消息里那条带行号的代码元素不算（它的行号另有 data-md-line）
    const shown = await dialog
      .evaluate((el) => {
        const rows = [...el.querySelectorAll('[data-line]')]
        const hit = rows.find((r) => r.getAttribute('data-line') === '7')
        return {
          lines: rows.length,
          text: hit?.textContent ?? '',
          marked: hit?.className.includes('bg-accent') ?? false,
        }
      })
      .catch(() => null)
    if (!shown || shown.lines < 5 || !shown.text.includes('return ('))
      errors.push('路径可点：文件弹窗里没有显示文件内容')
    else if (!shown.marked) errors.push('路径可点：文件弹窗没有停在提到的那一行（第 7 行没高亮）')
    await check(p, '对话-路径-文件')
    await p.keyboard.press('Escape')
    await p.close()
  }

  // 开发者模式的「抓取界面元素」：设置里打开才有按钮；Esc 退出不引用；中键点中后放一张引用卡片并退出抓取
  // （抓取期间左键、右键照常可用；快捷键也能进入和退出抓取）
  {
    const d = await page({ width: 1440, height: 900 })
    await d.goto(base + '#/chat')
    await d.locator('#task-prompt').waitFor()
    const pickBtn = d.getByLabel('抓取界面元素', { exact: true })
    if (await pickBtn.count()) errors.push('元素抓取：没开开发者模式就显示了抓取按钮')
    await d.getByRole('button', { name: '设置' }).first().click()
    await d.getByRole('switch', { name: '开发者模式' }).click()
    await check(d, '设置-开发者模式', ['开发者模式', '抓取界面元素'])
    await d.keyboard.press('Escape')
    await d.goto(base + '#/chat')
    const heading = d.getByRole('heading', { name: '有什么可以帮你？' })
    const hb = await heading.boundingBox()
    const overlay = d.locator('[data-element-picker]')
    await pickBtn.click()
    await d.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await check(d, '元素抓取-悬停', ['抓取元素，左键、右键照常可用', '退出抓取'])
    // 提示条挡视线（用户报的）：鼠标压到它上面要淡出，移开再淡回来。
    // 等的是 opacity 本身，不是定时器：淡出有过渡，"等一会儿再看" 会时快时慢
    const tip = d.locator('[data-pick-tip]')
    /** 等提示条的透明度落到指定状态（hidden：看不见了；shown：完全回来） */
    const waitTip = (want, why) =>
      d
        .waitForFunction(
          (hidden) => {
            const el = document.querySelector('[data-pick-tip]')
            if (!el) return false
            const v = Number(getComputedStyle(el).opacity)
            return hidden ? v < 0.05 : v > 0.95
          },
          want === 'hidden',
          { timeout: 3000 },
        )
        .catch(() => errors.push(why))
    const tipBox = await tip.boundingBox()
    const tipAt = tipBox && { x: tipBox.x + tipBox.width / 2, y: tipBox.y + tipBox.height / 2 }
    if (!tipAt) errors.push('元素抓取：找不到提示条，测不了悬停淡出')
    else {
      await d.mouse.move(tipAt.x, tipAt.y)
      await waitTip('hidden', '元素抓取：鼠标移到提示条上没有淡出（还是挡着视线）')
      await check(d, '元素抓取-提示条淡出')
      // 指针压在提示条上横向扫过（跨过它内部的 kbd、文字这些子元素）时不能弹回去：
      // 文档内的 mouseout（relatedTarget 非空）不是「离开窗口」，不能把淡出状态清掉。
      // 采样放在页面里逐帧取最大 opacity：从外面读只能读到某一瞬间，分不出「弹回过」和「没弹过」
      const sampling = d.evaluate(
        () =>
          new Promise((resolve) => {
            const el = document.querySelector('[data-pick-tip]')
            if (!el) return resolve(-1)
            let max = 0
            const t0 = performance.now()
            const tick = () => {
              max = Math.max(max, Number(getComputedStyle(el).opacity))
              if (performance.now() - t0 < 700) requestAnimationFrame(tick)
              else resolve(max)
            }
            requestAnimationFrame(tick)
          }),
      )
      await d.mouse.move(tipAt.x - tipBox.width * 0.4, tipAt.y, { steps: 4 })
      await d.mouse.move(tipAt.x + tipBox.width * 0.4, tipAt.y, { steps: 8 })
      const peak = await sampling
      if (peak > 0.5)
        errors.push(`元素抓取：鼠标在提示条上扫过时它又弹回来了（这段时间最大 opacity ${peak.toFixed(2)}）`)
      // 淡出只是躲开鼠标：抓取模式还在，移开后提示条要回来
      await d.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
      await waitTip('shown', '元素抓取：鼠标移开后提示条没有恢复（看不出还在抓取模式）')
      if (!(await overlay.count())) errors.push('元素抓取：提示条淡出时退出了抓取模式')
    }
    // 右键要能正常弹出页面自己的菜单，且不退出抓取（以前右键 = 退出抓取）
    await d.mouse.click(hb.x + hb.width / 2, hb.y + hb.height / 2, { button: 'right' })
    if (!(await overlay.count())) errors.push('元素抓取：右键点击后退出了抓取（右键应该正常弹菜单）')
    await d.keyboard.press('Escape')
    if (await overlay.count()) errors.push('元素抓取：按 Esc 没有退出抓取模式')
    if (
      await d
        .locator('#task-prompt')
        .getByText(/界面元素/)
        .count()
    )
      errors.push('元素抓取：按 Esc 退出也放了引用')
    // 左键要真的能用（不只是「没被拦」）：点顶栏的「设置」应该真的打开设置弹窗，而且不该退出抓取。
    // 以前全局吞鼠标事件时，这一个点只会把抓取退掉
    await pickBtn.click()
    await d.getByRole('button', { name: '设置' }).first().click()
    const settingsOpen = await d
      .getByRole('dialog')
      .first()
      .waitFor({ timeout: 3000 })
      .then(
        () => true,
        () => false,
      )
    if (!settingsOpen) errors.push('元素抓取：抓取期间左键点「设置」没有打开设置弹窗（左键没放行）')
    await check(d, '元素抓取-左键放行')
    // 关弹窗用弹窗自己的关闭按钮，不用 Esc：抓取期间 Esc 被覆盖层在捕获阶段吃掉、只退抓取（本来的设计），
    // 弹窗收不到，光按 Esc 关不掉它，后面的点击就会被遮罩挡住
    await d.getByRole('button', { name: '关闭设置' }).first().click()
    await d
      .getByRole('dialog')
      .first()
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => errors.push('元素抓取：左键放行用例没能关掉设置弹窗'))

    // 快捷键：`·` 进入抓取，再按一次退出。上一段（左键放行）结束时抓取还开着，
    // 先按 Esc 退出，否则这里的第一次 Backquote 会被当成「退出」而不是「进入」（抓取状态全局一份）
    await d.keyboard.press('Escape')
    await overlay.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    // 键盘模拟按的是反引号那个物理键（code=Backquote）：中文输入法和小键盘都打出 `·`，实现按 code 兼容。
    // 必须先等抓取按钮出现：settings 还在读的时候 developerMode 是 undefined，快捷键和按钮都还不生效
    await pickBtn.waitFor({ timeout: 10000 })
    // 焦点挪到页面空白处：输入框聚焦时无修饰键的快捷键按设计不触发
    await d.locator('body').click({ position: { x: 5, y: 5 } })
    await d.keyboard.press('Backquote')
    await overlay
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('元素抓取：按快捷键（Backquote / `·`）没有进入抓取模式'))
    await check(d, '元素抓取-快捷键进入')
    await d.keyboard.press('Backquote')
    await overlay
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => errors.push('元素抓取：再按一次快捷键没有退出抓取模式'))

    // 中键抓取：中键点中后放一张引用卡片并退出；中键不能把页面滚起来（自动滚动被拦了）
    await d.locator('#task-prompt').waitFor()
    await pickBtn.waitFor({ timeout: 10000 })
    const hb2 = await d.getByRole('heading', { name: '有什么可以帮你？' }).boundingBox()
    await pickBtn.click()
    await overlay.waitFor({ timeout: 5000 }).catch(() => errors.push('元素抓取：点按钮没有进入抓取模式'))
    const scrollBefore = await d.evaluate(() => window.scrollY)
    await d.mouse.click(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2, { button: 'middle' })
    await d.waitForTimeout(300)
    const scrollAfter = await d.evaluate(() => window.scrollY)
    if (scrollAfter !== scrollBefore)
      errors.push(`元素抓取：中键抓取时页面被滚动了（${scrollBefore} → ${scrollAfter}）`)
    const chip = d
      .locator('#task-prompt')
      .getByText(/界面元素/)
      .first()
    await chip.waitFor({ timeout: 5000 }).catch(() => errors.push('元素抓取：中键点中元素后输入框里没有引用卡片'))
    await overlay
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => errors.push('元素抓取：中键点中元素后没有退出抓取模式'))
    await check(d, '元素抓取-引用')
    await chip.click()
    const quoted = await d.getByRole('dialog').last().innerText()
    for (const want of ['web/src/pages/ChatPage.tsx:', '组件层级', '选择器'])
      if (!quoted.includes(want)) errors.push(`元素抓取：引用里没有「${want}」`)
    await d.keyboard.press('Escape')

    // 提示条淡出的时候，点它原来占的位置仍要抓得到下面的元素：躲开鼠标靠的是坐标判定，
    // 它自己一直 pointer-events-none，不能因为这一改把点击吞掉（吞了就选不中下面的东西）
    if (tipAt) {
      await pickBtn.waitFor({ timeout: 10000 })
      await pickBtn.click()
      await overlay.waitFor({ timeout: 5000 }).catch(() => errors.push('元素抓取：点击穿透用例没能进入抓取'))
      await d.mouse.move(tipAt.x, tipAt.y)
      await waitTip('hidden', '元素抓取：点击穿透用例里提示条没有淡出')
      const cards = () => d.locator('#task-prompt [data-chip="quote"]').count()
      const before = await cards()
      await d.mouse.click(tipAt.x, tipAt.y, { button: 'middle' })
      const picked = await d
        .waitForFunction((n) => document.querySelectorAll('#task-prompt [data-chip="quote"]').length > n, before, {
          timeout: 5000,
        })
        .then(
          () => true,
          () => false,
        )
      if (!picked) errors.push('元素抓取：提示条淡出时点它原来占的位置没抓到下面的元素（提示条吃掉了点击）')
      await overlay
        .waitFor({ state: 'detached', timeout: 5000 })
        .catch(() => errors.push('元素抓取：点击穿透用例抓完没有退出抓取'))
      await check(d, '元素抓取-提示条淡出后点击穿透')
    }

    // 换页面时抓取要自动退出：抓取状态是全局一份，不退出的话下一个页面会带着「已经在抓取中」进来，
    // 再按快捷键就成了「退出」而不是「进入」，语义反了
    await d.goto(base + '#/chat')
    await pickBtn.waitFor({ timeout: 10000 })
    await pickBtn.click()
    await overlay.waitFor({ timeout: 5000 }).catch(() => errors.push('元素抓取：切页前没能进入抓取'))
    await d.goto(base + '#/library')
    await d.getByText('commit-message').first().waitFor({ timeout: 10000 })
    await overlay
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => errors.push('元素抓取：换页面后抓取模式没有自动退出'))
    await check(d, '元素抓取-换页退出')

    // 页面上没有输入框时也能抓（记忆库页就在这）：抓到后没处放，写进剪贴板并提示。
    // 库页没有抓取按钮可等，上面刚确认过 settings 已到位
    // 等这个页面自己加载完（演示版预置了 skill 列表）
    await d.getByText('commit-message').first().waitFor({ timeout: 10000 })
    await d.locator('body').click({ position: { x: 5, y: 5 } })
    await d.keyboard.press('Backquote')
    await overlay
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('元素抓取：没有输入框的页面上按快捷键没有进入抓取模式'))
    await d.mouse.click(600, 300, { button: 'middle' })
    await overlay
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => errors.push('元素抓取：没有输入框的页面上中键抓完没有退出抓取'))
    await d
      .getByText('已复制到剪贴板，去输入框里粘贴')
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('元素抓取：没有输入框的页面上抓到元素后没有写剪贴板（没有提示）'))
    // 剪贴板里的内容要能粘回输入框还原成引用卡片（带标记，不是只有首行摘要）
    const clipped = await d.evaluate(() => navigator.clipboard.readText()).catch(() => '')
    if (clipped) {
      if (!clipped.includes('[元素引用]') || !clipped.includes('- 元素：'))
        errors.push('元素抓取：剪贴板里没有完整的元素引用（缺标记或「- 元素：」那行）')
    } else errors.push('元素抓取：读不到剪贴板内容（可能没写进去）')
    await check(d, '元素抓取-剪贴板兜底')

    // 元素引用能带出去：右键卡片「复制内容」写的是带标记的原文，粘到另一个窗口还原成同一张引用卡片。
    // 复制出去的不是路径也不是本地存储里的编号，所以换个标签页、换个面板实例都认得出（见 lib/element-ref.ts）
    // 先回对话页：上面那段结尾停在了库页，而这一步要点的是输入框里刚放进去的那张引用卡片
    await d.goto(base + '#/chat')
    await d.locator('#task-prompt').waitFor()
    await chip.waitFor({ timeout: 5000 })
    await chip.click({ button: 'right' })
    const copyItem = d.getByRole('menuitem', { name: '复制内容' })
    await copyItem.waitFor({ timeout: 3000 }).catch(() => errors.push('元素引用复制：右键卡片没有「复制内容」'))
    await copyItem.click()
    await d
      .getByText('引用内容已复制')
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('元素引用复制：复制后没有成功提示'))
    const marked = await d.evaluate(() => navigator.clipboard.readText()).catch(() => '')
    if (!marked.startsWith('[元素引用]')) errors.push(`元素引用复制：剪贴板里没有引用标记（${marked.slice(0, 24)}）`)
    if (!marked.trimEnd().endsWith('[/元素引用]')) errors.push('元素引用复制：剪贴板里的标记不完整')
    await check(d, '元素引用-复制')
    // 另一个窗口：同一个浏览器的另一个标签页，浏览器只把剪贴板里的文字带过去。
    // 两个标签页共用本地草稿，先把输入框（和里面恢复出来的卡片）清空，这样出现的卡片只可能是粘来的
    const b = await d.context().newPage()
    await b.goto(base + '#/chat')
    await b.locator('#task-prompt').waitFor({ timeout: 10000 })
    await b.locator('#task-prompt').click()
    await b.keyboard.press('Control+A')
    await b.keyboard.press('Backspace')
    await b
      .waitForFunction(() => !document.querySelector('#task-prompt [data-chip="quote"]'), null, { timeout: 5000 })
      .catch(() => errors.push('元素引用粘贴：另一个窗口的输入框清不空，判断不了卡片是不是粘来的'))
    await b.locator('#task-prompt').click()
    await b.keyboard.press('Control+V')
    const pastedChip = b.locator('#task-prompt [data-chip="quote"]').first()
    await pastedChip.waitFor({ timeout: 5000 }).catch(() => errors.push('元素引用粘贴：另一个窗口里没有还原成引用卡片'))
    if ((await b.locator('#task-prompt [data-chip="quote"]').count()) !== 1)
      errors.push('元素引用粘贴：另一个窗口里粘出来的引用卡片不是一张')
    const draft = await b
      .locator('#task-prompt')
      .innerText()
      .catch(() => '')
    if (draft.includes('[元素引用]')) errors.push('元素引用粘贴：输入框里留着标记文字，没有换成卡片')
    await check(b, '元素引用-跨窗口粘贴')
    // 卡片背后是原来那条引用的原文，不是一小段摘要
    await pastedChip.click()
    const restored = await b
      .getByRole('dialog')
      .last()
      .innerText()
      .catch(() => '')
    for (const want of ['web/src/pages/ChatPage.tsx:', '组件层级', '选择器'])
      if (!restored.includes(want)) errors.push(`元素引用粘贴：卡片里没有「${want}」`)
    await b.keyboard.press('Escape')
    // 换一套干净的浏览器环境（新的上下文，本地存储是空的）：还能还原，说明靠的是剪贴板里的原文，
    // 不是本地的编号 → 换浏览器、换面板实例照样有效
    const c = await page({ width: 1440, height: 900 })
    await c.goto(base + '#/chat')
    await c.locator('#task-prompt').waitFor({ timeout: 10000 })
    await c.locator('#task-prompt').click()
    await c.keyboard.press('Control+V')
    await c
      .locator('#task-prompt [data-chip="quote"]')
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('元素引用粘贴：全新的浏览器环境里还原不了引用卡片'))
    await check(c, '元素引用-换浏览器环境粘贴')
    await c.close()
    // 在输入框里**选中卡片按 Ctrl+C**（不是右键菜单）：剪贴板里要同样是带标记的完整原文。
    // 卡片在页面上的文字是截断到 40 个字的摘要（quoteName），靠浏览器原生复制带出去的就是那段摘要，
    // 粘回去既认不出是引用卡片、原文也丢了（用户报的现象）；RichInput 的 onCopy 按 copyOf 写剪贴板
    await b.locator('#task-prompt').click()
    await b.keyboard.press('Control+A')
    await b.keyboard.press('Backspace')
    await b
      .waitForFunction(() => !document.querySelector('#task-prompt [data-chip="quote"]'), null, { timeout: 5000 })
      .catch(() => errors.push('引用卡片选中复制：另一个窗口的输入框清不空'))
    await b.locator('#task-prompt').click()
    await b.keyboard.press('Control+V')
    const selChip = b.locator('#task-prompt [data-chip="quote"]').first()
    await selChip.waitFor({ timeout: 5000 }).catch(() => errors.push('引用卡片选中复制：先粘不进来就测不了选中复制'))
    // 选中输入框里的全部内容（含卡片）再复制。不能点卡片：点它会打开原文弹窗，
    // 之后的键盘输入全落在弹窗里，测的就不是输入框的复制了
    await b.evaluate(() => {
      const el = document.querySelector('#task-prompt')
      el?.focus()
      const r = document.createRange()
      if (el) r.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
    })
    await b.keyboard.press('Control+C')
    const picked = await b.evaluate(() => navigator.clipboard.readText()).catch(() => '')
    if (!picked.startsWith('[元素引用]'))
      errors.push(`引用卡片选中复制：剪贴板里不是带标记的原文（${picked.slice(0, 32)}）`)
    // 卡片上只显示截断到 40 个字的摘要；剪贴板里必须是摘要之后的那些行（源码、选择器）也在
    if (!picked.includes('- 元素：')) errors.push('引用卡片选中复制：剪贴板里没有完整的引用正文')
    if (!picked.includes('web/src/pages/ChatPage.tsx:')) errors.push('引用卡片选中复制：剪贴板里没有源码位置')
    if (!picked.includes('- 选择器：'))
      errors.push('引用卡片选中复制：剪贴板里没有摘要之外的行，像是只复制到卡片上那段摘要')
    // 粘回来要还原成一张卡片，输入框里不能留着标记文字
    await b.keyboard.press('Control+A')
    await b.keyboard.press('Backspace')
    await b
      .waitForFunction(() => !document.querySelector('#task-prompt [data-chip="quote"]'), null, { timeout: 5000 })
      .catch(() => errors.push('引用卡片选中复制：复制后输入框清不空'))
    await b.locator('#task-prompt').click()
    await b.keyboard.press('Control+V')
    await b
      .locator('#task-prompt [data-chip="quote"]')
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('引用卡片选中复制：粘回来没有还原成引用卡片'))
    const selDraft = await b
      .locator('#task-prompt')
      .innerText()
      .catch(() => '')
    if (selDraft.includes('[元素引用]')) errors.push('引用卡片选中复制：粘回来留着一大段标记文字')
    // 卡片背后是完整原文，不是摘要
    await b.locator('#task-prompt [data-chip="quote"]').first().click()
    const selText = await b
      .getByRole('dialog')
      .last()
      .innerText()
      .catch(() => '')
    for (const want of ['web/src/pages/ChatPage.tsx:', '组件层级', '选择器'])
      if (!selText.includes(want)) errors.push(`引用卡片选中复制：粘回来的卡片里没有「${want}」`)
    await b.keyboard.press('Escape')
    await check(b, '元素引用-选中卡片复制')
    // 剪贴板里同时有 text/plain 和 text/html：粘到 Word、Excel 这类富文本目标时换行还在，
    // 两张格式装的是同一份完整原文（不是卡片上那段 40 字摘要）
    const formats = await b
      .evaluate(async () => {
        const items = await navigator.clipboard.read()
        const out = {}
        for (const item of items) for (const type of item.types) out[type] = await (await item.getType(type)).text()
        return out
      })
      .catch(() => null)
    if (!formats) errors.push('元素引用-选中卡片复制：读不到剪贴板的两种格式')
    else {
      for (const type of ['text/plain', 'text/html']) {
        if (!(type in formats)) errors.push(`元素引用-选中卡片复制：剪贴板里没有 ${type}`)
      }
      // HTML 版里也必须是完整原文：换行在 html 里是 <br>，所以按去掉标签后的文字判断
      const htmlText = (formats['text/html'] ?? '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')
      for (const want of ['- 元素：', 'web/src/pages/ChatPage.tsx:', '- 选择器：'])
        if (!htmlText.includes(want)) errors.push(`元素引用-选中卡片复制：html 版本里没有「${want}」`)
      if (!htmlText.includes('[/元素引用]'))
        errors.push('元素引用-选中卡片复制：html 版本里没有结束标记，粘回输入框认不出卡片')
    }
    // 剪切选中的卡片：剪贴板同样写完整原文（onCut 和 onCopy 共用一份序列化），
    // 而且选中的内容要真的从输入框里删掉、背后的附件一起清掉
    await b.locator('#task-prompt').click()
    await b.keyboard.press('Control+A')
    await b.keyboard.press('Backspace')
    await b
      .waitForFunction(() => !document.querySelector('#task-prompt [data-chip="quote"]'), null, { timeout: 5000 })
      .catch(() => errors.push('引用卡片剪切：剪切前输入框清不空'))
    await b.locator('#task-prompt').click()
    await b.keyboard.press('Control+V')
    await b
      .locator('#task-prompt [data-chip="quote"]')
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => errors.push('引用卡片剪切：先粘不进来就测不了剪切'))
    await b.evaluate(() => {
      const el = document.querySelector('#task-prompt')
      el?.focus()
      const r = document.createRange()
      if (el) r.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
    })
    await b.keyboard.press('Control+X')
    const cut = await b.evaluate(() => navigator.clipboard.readText()).catch(() => '')
    if (!cut.startsWith('[元素引用]')) errors.push(`引用卡片剪切：剪贴板里不是带标记的原文（${cut.slice(0, 32)}）`)
    if (!cut.includes('- 元素：') || !cut.includes('- 选择器：'))
      errors.push('引用卡片剪切：剪贴板里只有摘要，没有完整原文')
    // 剪切要真的从输入框里删掉（不拦原生剪切时浏览器也会删，拦下后由 onCut 自己删）
    await b
      .waitForFunction(() => !document.querySelector('#task-prompt [data-chip="quote"]'), null, { timeout: 5000 })
      .catch(() => errors.push('引用卡片剪切：剪完输入框里的卡片还在'))
    // onCut 是程序化 deleteContents()，不是原生删除键：万一浏览器留下占位节点，serialize 读出来是「\n」，
    // 输入框里多一空行、草稿被判非空。这里直接断言剪完的内容是空的
    const afterCut = await b
      .locator('#task-prompt')
      .innerText()
      .catch(() => '<读不到>')
    if (afterCut.trim()) errors.push(`引用卡片剪切：剪完输入框里还留着内容（${JSON.stringify(afterCut.slice(0, 20))}）`)
    // 剪完的卡片背后不能再留着附件：再粘回来只该有一张卡片（附件没被重复带走）
    await b.locator('#task-prompt').click()
    await b.keyboard.press('Control+V')
    await b
      .waitForFunction(() => document.querySelectorAll('#task-prompt [data-chip="quote"]').length === 1, null, {
        timeout: 5000,
      })
      .catch(() => errors.push('引用卡片剪切：剪完再粘回来没有还原成一张引用卡片'))
    await check(b, '元素引用-剪切卡片')
    // 只复制了一半标记（截图、截断）时按普通文字粘进来，不能误判成卡片
    await b.locator('#task-prompt').click()
    await b.keyboard.press('Control+A')
    await b.keyboard.press('Backspace')
    await b.evaluate((half) => navigator.clipboard.writeText(half), marked.slice(0, 60))
    await b.keyboard.press('Control+V')
    await b
      .waitForFunction(
        (half) => (document.querySelector('#task-prompt')?.textContent ?? '').includes(half.slice(-12)),
        marked.slice(0, 60),
        { timeout: 5000 },
      )
      .catch(() => errors.push('元素引用粘贴：半截标记的文字没有粘进来'))
    if (await b.locator('#task-prompt [data-chip="quote"]').count())
      errors.push('元素引用粘贴：半截标记被误判成了引用卡片')
    await check(b, '元素引用-标记不完整')
    await b.close()
    await d.close()
  }

  const m = await page({ width: 390, height: 844 })
  await m.goto(base)
  await check(m, '手机-首页', ['今天要做什么'])
  await m.goto(base + '#/workflows')
  await check(m, '手机-工作流')
  // 用量统计在手机宽度下：工具条换行、表格隐藏缓存和任务列，不能出现横向滚动
  // 手机布局的侧栏收在抽屉里，先点顶部的菜单再进设置
  // 工作流页加载完会自动选中第一个工作流（地址变了，抽屉跟着关上）：等它跳完再开抽屉。
  // 抽屉滑出来之前，页面上的「设置」是看不见的那个：只点看得见的；没出来就再点一次
  await m.waitForURL(/#\/workflows\/.+/, { timeout: 10000 }).catch(() => {})
  const mobileSettings = m.getByRole('button', { name: '设置' }).filter({ visible: true }).first()
  for (let i = 0; i < 3; i++) {
    await m.getByRole('button', { name: '打开菜单' }).click()
    if (
      await mobileSettings.waitFor({ timeout: 5000 }).then(
        () => true,
        () => false,
      )
    )
      break
  }
  await mobileSettings.click()
  await m.getByRole('button', { name: '用量统计', exact: true }).click()
  await check(m, '手机-用量统计', ['按天', '按周', '按月', '合计'])
})
