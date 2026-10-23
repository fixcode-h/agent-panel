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
    // 等演示的回复写完：还在回复时页面会定时把内存里的对话写回 localStorage，盖掉下面补进去的那条
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
    // 演示的回复是固定的，往这个对话里补一条带路径的回复（回复里出现的路径才是要测的）
    const added = await p.evaluate(() => {
      const key = 'agent-panel-demo-v3'
      const d = JSON.parse(localStorage.getItem(key) ?? '{}')
      const id = decodeURIComponent(location.hash.split('/').pop() ?? '')
      const task = (d.tasks ?? []).find((x) => x.id === id)
      if (!task) return ''
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
      return id
    })
    if (!added) errors.push('路径可点：没有找到刚建的对话，补不进回复')
    // 改了 localStorage 必须真的重新加载，页面才读得到新数据
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

  const m = await page({ width: 390, height: 844 })
  await m.goto(base)
  await check(m, '手机-首页', ['今天要做什么'])
  await m.goto(base + '#/workflows')
  await check(m, '手机-工作流')
  // 用量统计在手机宽度下：工具条换行、表格隐藏缓存和任务列，不能出现横向滚动
  // 手机布局的侧栏收在抽屉里，先点顶部的菜单再进设置
  await m.getByRole('button', { name: '打开菜单' }).click()
  await m.getByRole('button', { name: '设置' }).first().click()
  await m.getByRole('button', { name: '用量统计', exact: true }).click()
  await check(m, '手机-用量统计', ['按天', '按周', '按月', '合计'])
})
