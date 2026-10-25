/**
 * 界面检查分片：设置：Agent 的上下文档位、Pi 安装卸载和「AI 处理」、API 配置、授权、部署、本机生图；最小化浮条
 *
 * 和其他分片并行跑：每个分片自己起静态服务、开浏览器，演示数据各自从头生成（见 harness.mjs）。
 * 总入口 scripts/ui-check.mjs 并行跑全部分片并汇总。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await p.getByRole('button', { name: '设置' }).first().click()
  await p.getByRole('button', { name: 'Agent', exact: true }).first().click()
  await p.getByText('添加其他 Agent').scrollIntoViewIfNeeded()
  await check(p, '设置-CLI', ['添加其他 Agent', 'Gemini CLI'])
  // 三档模型的上下文、最大输出：默认按模型自动填，手动改了能恢复自动；Codex 不接受最大输出
  await p.getByRole('dialog').getByText('Claude Code', { exact: true }).first().click()
  // 上下文和最大输出默认收在折叠里，点开第一档才看得到输入框
  await p
    .getByRole('dialog')
    .getByRole('button', { name: /^上下文/ })
    .first()
    .click()
  const ctx = p.getByRole('dialog').getByLabel('上下文', { exact: true }).first()
  await ctx.scrollIntoViewIfNeeded()
  await ctx.fill('500k')
  await ctx.press('Enter')
  await check(p, '设置-CLI-三档上下文', ['三档模型'])
  // 输入框里直接用灰字显示按模型估出来的值，不再带「自动 ·」
  if (!(await p.getByRole('dialog').getByPlaceholder('128K').count()))
    errors.push('设置-CLI-三档上下文：最大输出没有按模型自动填')
  if ((await ctx.inputValue()) !== '500K')
    errors.push(`设置-CLI-三档上下文：手填的值显示成了「${await ctx.inputValue()}」`)
  await p.getByRole('dialog').getByRole('button', { name: '恢复自动' }).first().click()
  // 清空要等设置保存、重新渲染；CI 的机器慢，立刻读会读到旧值
  for (let i = 0; i < 30 && (await ctx.inputValue()) !== ''; i++) await p.waitForTimeout(100)
  if ((await ctx.inputValue()) !== '') errors.push('设置-CLI-三档上下文：恢复自动后没有清空')
  await p.getByRole('dialog').getByText('Codex', { exact: true }).first().click()
  await p.getByText('没有设置最大输出的参数').first().scrollIntoViewIfNeeded()
  await check(p, '设置-CLI-Codex档位', ['没有设置最大输出的参数'])
  // 报错的地方都有「AI 处理」：演示里 Pi 卸载会失败（留着启动脚本），点了在统一的弹窗里看 AI 的处理
  await p.getByRole('dialog').getByText('Pi', { exact: true }).first().click()
  await p.getByRole('button', { name: '安装', exact: true }).first().click()
  await p.getByText('安装完成').first().waitFor({ timeout: 8000 })
  // 装好后才有的：开关（离线运行默认开着）和扩展包
  await p.getByRole('list', { name: '已装的扩展包' }).scrollIntoViewIfNeeded()
  await check(p, '设置-CLI-Pi扩展包', ['离线运行', '扩展包', 'npm:@example/pi-web-tools'])
  await p.getByRole('button', { name: '卸载', exact: true }).first().click()
  await p.getByRole('dialog').last().getByRole('button', { name: '卸载', exact: true }).click()
  await p.getByText('卸载没有成功').first().waitFor({ timeout: 8000 })
  await check(p, '设置-CLI-卸载失败', ['卸载没有成功', 'AI 处理'])
  await p.getByRole('button', { name: 'AI 处理', exact: true }).first().click()
  // 在聊天里新建一个排查对话，显示在大窗口里；最小化成右下角的按钮，排查照常进行
  await p
    .getByRole('heading', { name: 'AI 排查：Pi：卸载没有成功' })
    .last()
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('AI 处理：没有新建排查对话'))
  await check(p, 'AI处理-对话', ['出了什么问题：Pi：卸载没有成功'])
  // 最小化成浮条（和「角色」页的 AI 优化共用同一个组件）：后面的设置流程里它一直在，最后统一验拖动和关闭
  await p.getByRole('button', { name: '最小化', exact: true }).last().click()
  await check(p, 'AI处理-最小化', ['AI 排查：Pi：卸载没有成功'])
  // API 配置：识别到各个 CLI 自己配的 API，确认后存进列表
  await p.getByRole('button', { name: 'API 配置', exact: true }).first().click()
  await check(p, '设置-API-识别', ['在本机 Agent 的配置里识别到 2 个 API', 'Codex · openrouter'])
  await p.getByRole('button', { name: '存到 API 配置' }).first().click()
  await check(p, '设置-API-已存', ['已在列表中', '一键更新', '映射模型'])
  // 授权：检测外部 CLI，在面板里完成浏览器授权（演示里模拟），退出后回到未授权
  await p.getByRole('button', { name: '授权', exact: true }).first().click()
  await check(p, '设置-授权', ['GitHub CLI', '浏览器授权', '用 Token 授权'])
  await p.getByRole('button', { name: '浏览器授权' }).first().click()
  await p
    .getByText('一次性授权码')
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('授权：没有显示一次性授权码'))
  await check(p, '设置-授权-进行中', ['等待浏览器完成授权', 'ABCD-1234', '取消授权'])
  await p
    .getByText('已授权', { exact: true })
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => errors.push('授权：浏览器授权没有完成'))
  await check(p, '设置-授权-完成', ['已授权', 'demo-user'])
  await p.getByRole('button', { name: '退出登录' }).first().click()
  await p.getByRole('dialog').getByRole('button', { name: '退出登录' }).click()
  await p
    .getByRole('button', { name: '浏览器授权' })
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('授权：退出后没有回到未授权'))
  await check(p, '设置-授权-已退出', ['未授权', '浏览器授权'])
  // 回到 CLI 的默认 CLI 页（部署在它下面）
  await p.getByRole('button', { name: 'Agent', exact: true }).first().click()
  await p.getByRole('dialog').getByText('默认 Agent', { exact: true }).first().click()
  // 部署：全局说明写进各 CLI，技能默认不选，选了再部署
  await p.getByRole('button', { name: '部署', exact: true }).first().click()
  await check(p, '设置-部署', ['全局说明（AGENTS.md）', '写到哪些 Agent', '要部署的技能', 'grilling'])
  await p.getByRole('switch', { name: 'grilling' }).click()
  await p.getByRole('button', { name: '部署', exact: true }).last().click()
  await p
    .getByText('部署好了')
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('部署：没有提示部署结果'))
  await check(p, '设置-部署-完成', ['已部署', '已是最新'])
  // 本机生图：一键安装 ComfyUI、下载推荐的模型（演示里是模拟的进度）
  await p.getByRole('button', { name: '本机生图' }).click()
  await check(p, '设置-本机生图', ['一键安装', 'Z-Image Turbo', '建议显存'])
  await p.getByRole('button', { name: '一键安装' }).click()
  await p.getByText('已安装，未启动').waitFor({ timeout: 10000 })
  await p.getByRole('button', { name: '下载' }).first().click()
  await p.getByText('Z-Image Turbo 已下载').or(p.getByText('已下载').first()).waitFor({ timeout: 10000 })
  await check(p, '设置-本机生图-已下载', ['已下载'])
  await p.keyboard.press('Escape')
  // 最小化后的浮条：「AI 处理」和「AI 优化」用同一个组件——尺寸、圆角、层级、状态文字一致，
  // 两个同时最小化时默认位置错开、不互相盖；能按住拖动，松手后位置记进 localStorage，展开再最小化还在原处
  const dock = (name) => p.getByRole('group', { name, exact: true })
  const aiDock = dock('AI 排查：Pi：卸载没有成功')
  await aiDock.waitFor({ timeout: 5000 }).catch(() => errors.push('浮条：关掉设置后 AI 处理的浮条没了'))
  // 量计算后的样式：刚出现的浮条还在跑 pop-in（会缩放），getBoundingClientRect 会偏小 1px
  const dockLook = (loc) =>
    loc.evaluate((el) => {
      const s = getComputedStyle(el)
      return { h: s.height, radius: s.borderRadius, z: s.zIndex, font: s.fontSize }
    })
  await p
    .getByRole('radio', { name: /^Agent 模式/ })
    .first()
    .click()
  await p.getByRole('button', { name: '角色', exact: true }).first().click()
  // 「评审」要随内置工作流添加，这个分片里没有；用演示自带的角色
  await p.getByText('代码审查', { exact: true }).first().click()
  await p.getByRole('button', { name: 'AI 优化' }).first().click()
  await p.getByRole('button', { name: '最小化', exact: true }).last().click()
  const assistDock = dock('用 AI 优化「代码审查」')
  await assistDock.waitFor({ timeout: 5000 }).catch(() => errors.push('浮条：AI 优化最小化后没有浮条'))
  // 等 pop-in 动画跑完再量位置：动画中 rect 会缩着、往上偏 8px
  await settle(p)
  const lookA = await dockLook(aiDock)
  const lookB = await dockLook(assistDock)
  if (lookA.h !== lookB.h || lookA.radius !== lookB.radius || lookA.z !== lookB.z || lookA.font !== lookB.font)
    errors.push(`浮条：两个窗口的最小化形态不一致（${JSON.stringify(lookA)} / ${JSON.stringify(lookB)}）`)
  const boxA = await aiDock.boundingBox()
  const boxB = await assistDock.boundingBox()
  if (
    boxA &&
    boxB &&
    boxA.x < boxB.x + boxB.width &&
    boxB.x < boxA.x + boxA.width &&
    boxA.y < boxB.y + boxB.height &&
    boxB.y < boxA.y + boxA.height
  )
    errors.push('浮条：两个同时最小化的窗口叠在一起了')
  await check(p, 'AI处理-两个浮条')
  // 按住拖动：位置跟着指针走，拖动不会被当成点击把窗口展开
  const from = await assistDock.boundingBox()
  await p.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await p.mouse.down()
  await p.mouse.move(from.x + from.width / 2 - 240, from.y + from.height / 2 - 180, { steps: 10 })
  await p.mouse.up()
  const to = await assistDock.boundingBox()
  if (Math.abs(to.x - (from.x - 240)) > 2 || Math.abs(to.y - (from.y - 180)) > 2)
    errors.push(
      `浮条：拖动后没有跟着走（${Math.round(from.x)},${Math.round(from.y)} → ${Math.round(to.x)},${Math.round(to.y)}）`,
    )
  if (!(await assistDock.isVisible())) errors.push('浮条：拖动被当成了点击，浮条展开后不见了')
  const savedPos = await p.evaluate(() => JSON.parse(localStorage.getItem('minimized-chat-pos') ?? '{}'))
  if (!savedPos.assist) errors.push('浮条：拖动后的位置没有记进 localStorage')
  // 展开再最小化：回到拖到的位置，不是默认的右下角
  await assistDock.getByRole('button', { name: '展开', exact: true }).click()
  await p.getByRole('button', { name: '最小化', exact: true }).last().click()
  await settle(p)
  const back = await assistDock.boundingBox()
  if (Math.abs(back.x - to.x) > 1 || Math.abs(back.y - to.y) > 1) errors.push('浮条：重新最小化后没回到记住的位置')
  await check(p, 'AI处理-浮条拖动')
  // 另一个窗口的关闭按钮同样是直接关（不再弹确认）；先关它再切页面，切走时它会隨页面卸载
  await assistDock.getByRole('button', { name: '关闭', exact: true }).click()
  await assistDock
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => errors.push('浮条：AI 优化点关闭后浮条还在'))
  // 窗口和对话解耦：对话从聊天列表里删掉后，浮条不消失，标成「对话已关闭」，只有用户点关闭才关
  await p
    .getByRole('radio', { name: /^Chat 模式/ })
    .first()
    .click()
  const fixRow = p.locator('[data-sidebar] button[title="AI 排查：Pi：卸载没有成功"]').first()
  await fixRow.waitFor({ timeout: 5000 }).catch(() => errors.push('浮条：侧栏里找不到排查对话'))
  await fixRow.click({ button: 'right' })
  await p.getByRole('menuitem', { name: '删除', exact: true }).click()
  await p.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
  await aiDock
    .getByText('对话已关闭')
    .waitFor({ timeout: 15000 })
    .catch(() => errors.push('浮条：对话删掉后浮条没显示「对话已关闭」'))
  await check(p, 'AI处理-对话关了浮条还在', ['对话已关闭'])
  await aiDock.getByRole('button', { name: '展开', exact: true }).click()
  await check(p, 'AI处理-对话已关闭', ['这个对话已经关闭了', '它已经从对话列表里删掉'])
  // 关闭按钮直接关：不再弹「关闭窗口会停止这次排查」的确认
  await p.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).last().click()
  await p
    .getByRole('dialog')
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => errors.push('浮条：点关闭后对话窗口没有关掉'))
  if (await p.getByText('停止 AI 排查？').count()) errors.push('浮条：点关闭还在弹确认框')
  await aiDock.waitFor({ state: 'detached', timeout: 5000 }).catch(() => errors.push('浮条：关掉窗口后浮条还在'))
})
