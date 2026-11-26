/**
 * 界面检查分片：自建工具（ADR 0082）。「技能与 MCP → 工具」页签的列表、编辑抽屉（改名保存、用途、试运行）、行尾菜单复制到全局，
 * 「程序位置」一块（登记、改、删、名字不对的报错），「/」菜单里的「自建工具」一组，以及 /createtool 在对话里弹出的保存弹窗（选项目、保存后卡片消失）
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle, sendNew }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await settle(p)
  const projectId = await p.evaluate(
    () => JSON.parse(localStorage.getItem('agent-panel-demo-v3') ?? '{}').projects?.[0]?.id,
  )
  if (!projectId) return void errors.push('演示数据里没有项目')
  await p.evaluate((id) => (location.hash = `#/projects/${id}/capabilities`), projectId)
  await p.getByRole('radio', { name: /^工具 \d+$/ }).click()
  await check(p, '工具-列表', ['项目的工具', '全局的工具', '导表', 'Lua 语法检查', '查端口占用', '会改文件', '只读'])

  // 程序位置（复盘 2026-11-26 §5 第 4 项）：Agent 登记的、找不到了的；自己登记、改、删
  const progs = p.locator('[data-program-paths]')
  await progs.scrollIntoViewIfNeeded()
  await check(p, '工具-程序位置', ['程序位置', 'luac', 'TableExporter', '找不到了', '只在本机'])
  await progs.getByRole('button', { name: '登记程序' }).click()
  const dlg = p.getByRole('dialog')
  await dlg.getByLabel('程序名').fill('texture tool')
  await dlg.getByLabel('完整路径').fill('/opt/tools/texconv2')
  await dlg.getByRole('button', { name: '保存', exact: true }).click()
  await check(p, '工具-程序位置-名字不对', ['程序名不对'])
  await dlg.getByLabel('程序名').fill('texconv2')
  await dlg.getByRole('button', { name: '保存', exact: true }).dblclick()
  await p
    .getByRole('dialog')
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => errors.push('程序位置：保存后弹窗没关'))
  if ((await p.getByText('已登记 texconv2').count()) !== 1) errors.push('程序位置：双击保存应该只登记一次')
  if ((await progs.getByText('texconv2', { exact: true }).count()) !== 1)
    errors.push('程序位置：登记后列表里应该正好一条 texconv2（双击保存不该登记两次）')
  await progs.getByRole('button', { name: '修改 luac' }).click()
  await p.getByRole('dialog').getByLabel('完整路径').fill('/home/demo/tools/luac54')
  await p.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
  await check(p, '工具-程序位置-改路径', ['/home/demo/tools/luac54'])
  await progs.getByRole('button', { name: '删掉 texconv2' }).click()
  await settle(p)
  if (await progs.getByText('texconv2', { exact: true }).count()) errors.push('程序位置：删掉后还在列表里')
  // 顶上的搜索框也筛程序位置
  await p.getByPlaceholder('搜索能力').fill('Exporter')
  if (await progs.getByText('luac', { exact: true }).count()) errors.push('程序位置：搜 Exporter 不该还列 luac')
  await p.getByPlaceholder('搜索能力').fill('')

  // 编辑抽屉：改中文名保存，版本 +1，列表跟着变
  await p.getByText('导表', { exact: true }).first().click()
  await check(p, '工具-编辑', ['运行和参数', '影响和输出', '什么时候用'])
  const name = p.getByRole('dialog').getByLabel('中文名')
  await name.fill('导表工具')
  // 「运行前先问我」默认关（用户 2026-11-26：自建工具默认直接跑），打开后保存要记住
  await p.getByRole('dialog').getByRole('radio', { name: '影响和输出' }).click()
  const ask = p.getByRole('dialog').getByRole('switch', { name: '运行前先问我' })
  if ((await ask.getAttribute('aria-checked')) !== 'false') errors.push('工具：「运行前先问我」默认应是关')
  await ask.click()
  await p.getByRole('dialog').getByRole('radio', { name: '版本' }).click()
  await check(p, '工具-版本', ['v3', 'v2', '加了输出目录参数'])
  await p.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
  await check(p, '工具-保存后', ['已保存为 v4', '导表工具'])
  if (await p.getByRole('dialog').count()) errors.push('工具：保存后编辑抽屉没关')
  await p.getByText('导表工具', { exact: true }).first().click()
  await p.getByRole('dialog').getByRole('radio', { name: '影响和输出' }).click()
  await check(p, '工具-运行前先问我', ['运行前先问我', '默认关：Agent 调用时直接跑'])
  if (
    (await p.getByRole('dialog').getByRole('switch', { name: '运行前先问我' }).getAttribute('aria-checked')) !== 'true'
  )
    errors.push('工具：「运行前先问我」保存后没记住')
  await p.keyboard.press('Escape')
  await settle(p)

  // 用途（ADR 0086）：校验工具列表行上有「校验」徽标，编辑抽屉的「用途」页看得到管哪些文件、顶替哪些程序
  await p.getByText('Lua 语法检查', { exact: true }).first().click()
  await p.getByRole('dialog').getByRole('radio', { name: '用途' }).click()
  await check(p, '工具-用途', [
    '校验：改完对得上的文件后面板自己跑',
    '改了哪些文件要查',
    '**/*.lua',
    '顶替的程序',
    'luac',
  ])
  await p.keyboard.press('Escape')
  await settle(p)

  // 试运行：从行尾菜单进，先只展开命令，再「运行」
  await p.getByText('导表工具', { exact: true }).first().click({ button: 'right' })
  await p.getByRole('menuitem', { name: '试运行' }).click()
  await p.getByRole('dialog').getByLabel(/^表名/).fill('Item  Table')
  await p.getByRole('button', { name: '只展开命令' }).click()
  await check(p, '工具-只展开', ['命令展开成功（没有执行）', "'Item  Table' --out Content/Config"])
  await p.getByRole('button', { name: '运行', exact: true }).click()
  await check(p, '工具-运行', ['运行成功', '完整输出 4 行'])
  await p.keyboard.press('Escape')
  await settle(p)

  // 行尾「更多操作」：复制到全局，全局那块多一个
  const lua = p.locator('[role="button"]', { hasText: 'Lua 语法检查' }).first()
  await lua.hover()
  await lua.getByRole('button', { name: '更多操作' }).click()
  await p.getByRole('menuitem', { name: '复制到全局' }).click()
  await check(p, '工具-复制到全局', ['已复制', /全局的工具/])
  if ((await p.getByText('Lua 语法检查', { exact: true }).count()) < 2) errors.push('工具：复制到全局后全局那块没有它')
  // 项目里同 id 的盖住全局的
  await check(p, '工具-被盖住', ['被项目里同名的工具盖住了'])

  // 「/」菜单：自建工具一组
  await p.goto(base)
  await settle(p)
  await p.locator('#task-prompt').click()
  await p.keyboard.type('/tool')
  await check(p, '工具-斜杠菜单', ['自建工具', 'tool:export-tables'])
  await p.keyboard.press('Escape')
  await p.locator('#task-prompt').press('Control+a')
  await p.keyboard.press('Backspace')

  // /createtool：Agent 交上草稿后弹保存弹窗，选「加入项目」保存，入口卡片消失
  await p.keyboard.type('/createtool')
  await p.keyboard.press('Enter')
  await p.keyboard.type('把打包资源做成工具')
  await sendNew(p, '工具-createtool')
  await p
    .getByText('保存工具「打包资源」')
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => errors.push('工具：/createtool 没弹出保存弹窗'))
  await check(p, '工具-保存弹窗', [
    '加入项目',
    '全局',
    'python tools/pack.py --platform {{platform}}',
    '让 Agent 再改',
    '运行前先问我',
  ])
  if (
    (await p.getByRole('dialog').getByRole('switch', { name: '运行前先问我' }).getAttribute('aria-checked')) !== 'false'
  )
    errors.push('工具：保存弹窗里「运行前先问我」默认应是关')
  // 关掉弹窗不算回答：入口还在，点「查看并保存」再打开；保存连点两下也只收一次
  await p.keyboard.press('Escape')
  await settle(p)
  if (!(await p.getByText('查看并保存').count())) errors.push('工具：关掉保存弹窗后入口没了')
  await p.getByRole('button', { name: '查看并保存' }).click()
  await p.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).dblclick()
  await settle(p)
  await p
    .getByText('查看并保存')
    .waitFor({ state: 'detached', timeout: 8000 })
    .catch(() => errors.push('工具：保存后保存入口还在'))
  await check(p, '工具-保存完', ['你确认了'])

  // 设置 → 控件样式：三个共用部件的样例
  await p.goto(base)
  await p.getByRole('button', { name: '设置' }).first().click()
  await p.getByRole('button', { name: '控件样式', exact: true }).click()
  await p.getByText('ScopePicker · ToolParamForm · ToolRunResult（自建工具）').scrollIntoViewIfNeeded()
  await check(p, '工具-组件样例', ['ScopePicker · ToolParamForm', '缺列 ID', '影响外部'])
})
