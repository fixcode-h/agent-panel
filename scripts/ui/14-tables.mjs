/**
 * 界面检查分片：表格页（游戏配置表管理）。
 *
 * 演示项目「商城前台」在项目设置里把 data 设成了表格目录，所以图标栏里有「表格」：
 * - 文件树列出 data 下的表格，打开配置表后自动认出 5 行表头、按角色上色
 * - 内容搜索跨文件找到格子，点一处打开那个文件并滚到那一格
 * - 结构化：检查标红、枚举下拉、repeated 列表编辑、列结构；左栏「检查」查整个项目
 * - 项目设置里的「表格」页（目录、包含 / 排除、结构信息存放位置）和 AI 分析表格风格
 * 只走用户能走的路（点图标栏、点文件树、在搜索框里打字）。
 */
import { runShard } from './harness.mjs'

await runShard(import.meta.filename, async ({ base, page, check, errors, settle }) => {
  const p = await page({ width: 1440, height: 900 })
  await p.goto(base)
  await settle(p)
  const entry = p.getByRole('navigation', { name: '功能栏' }).getByRole('button', { name: '表格', exact: true })
  await entry.click({ timeout: 8000 }).catch(() => errors.push('图标栏：设了表格目录的项目没有「表格」入口'))
  const tree = p.getByRole('tree', { name: '表格文件' })
  await tree
    .getByRole('treeitem', { name: /C_HomeDecorationConfig\.xlsx/ })
    .click({ timeout: 8000 })
    .catch(() => errors.push('表格页：文件树里没有演示的配置表'))
  await p
    .getByText(/表头 5 行（第 1–5 行），数据从第 6 行开始/)
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('表格页：配置表没有认出 5 行表头'))
  await check(p, '表格页-打开配置表', ['C_HomeDecorationConfig.xlsx', '自动识别'])

  // 再开一张：页签里两个文件都在，可以来回切
  await tree.getByRole('treeitem', { name: /stock\.xlsx/ }).click()
  await p
    .getByRole('tab', { name: 'stock.xlsx' })
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('表格页：打开第二个文件没有出现页签'))
  if ((await p.getByRole('tablist', { name: '打开的表格' }).getByRole('tab').count()) !== 2)
    errors.push('表格页：打开两个文件后页签不是两个')
  await check(p, '表格页-多个页签', ['stock.xlsx'])

  // 内容搜索：找到格子，点一处切回那个文件
  await p.getByRole('radio', { name: '内容' }).click()
  await p.getByPlaceholder('在所有表格的格子里找').fill('穿衣镜')
  await p
    .getByText(/个文件里找到 \d+ 处/)
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('表格页：内容搜索没有结果'))
  await check(p, '表格页-内容搜索', ['穿衣镜'])
  await p.getByRole('group', { name: 'data/C_HomeDecorationConfig.xlsx' }).getByRole('button').first().click()
  if ((await p.getByRole('tab', { name: 'C_HomeDecorationConfig.xlsx' }).getAttribute('aria-selected')) !== 'true')
    errors.push('表格页：点搜索结果没有切到那个文件')

  // 改格子：双击进编辑框，回车确认；改过的格子标出来，撤销能退回去
  const cell = (r, c) => p.locator(`[role=cell][data-r="${r}"][data-c="${c}"]`)
  await cell(5, 4).dblclick()
  const box = p.getByRole('textbox', { name: '编辑单元格' })
  await box.fill('曲线穿衣镜（改）')
  await box.press('Enter')
  if (!(await cell(5, 4).getAttribute('class'))?.includes('sheet-dirty')) errors.push('表格页：改过的格子没有标出来')
  // 选中下一格直接打字、再撤销
  await p.keyboard.type('9')
  await p.keyboard.press('Enter')
  if ((await cell(6, 4).textContent()) !== '9') errors.push('表格页：直接打字没有改到当前格')
  await p.keyboard.press('Control+z')
  if ((await cell(6, 4).textContent()) === '9') errors.push('表格页：Ctrl+Z 没有撤销')
  await check(p, '表格页-改格子', ['曲线穿衣镜（改）'])
  await p.getByRole('button', { name: '保存', exact: true }).click()
  const save = p.getByRole('dialog')
  await save
    .getByText('E6', { exact: true })
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('保存确认：没有列出改了的格子'))
  await check(p, '表格页-保存确认', ['只改下面这些格子的值'])
  await save.getByRole('button', { name: '保存', exact: true }).click()
  await p
    .getByText('已保存 C_HomeDecorationConfig.xlsx')
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('表格页：保存后没有提示'))
  if ((await cell(5, 4).getAttribute('class'))?.includes('sheet-dirty')) errors.push('表格页：保存后格子还标着改过')
  if ((await cell(5, 4).textContent()) !== '曲线穿衣镜（改）') errors.push('表格页：保存后内容不对')

  // 结构化：InteractionTriggerState 设了 0–1（-1 也允许），值是 2 的格子标红，「检查」列出来
  await p.getByRole('button', { name: /处不合规/ }).click()
  const bar = p.getByRole('region', { name: '不合规的格子' })
  await bar
    .getByText(/不能大于 1/)
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('结构化：取值范围外的格子没有列进检查结果'))
  await check(p, '表格页-检查结果', ['InteractionTriggerState'])
  // 枚举列：下拉列出结构文件里的值；打一个不在里面的字，最后一项是「新增枚举值」
  await cell(6, 3).dblclick()
  const opts = p.getByRole('listbox')
  await opts
    .getByRole('option', { name: /TabletopDecor/ })
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('结构化：枚举列没有下拉'))
  await p.getByRole('combobox', { name: '选择值' }).fill('CeilingLamp')
  await opts
    .getByRole('option', { name: /新增枚举值「CeilingLamp」/ })
    .waitFor({ timeout: 3000 })
    .catch(() => errors.push('结构化：打了新的字没有「新增枚举值」'))
  await check(p, '表格页-枚举下拉', ['新增枚举值'])
  await p.keyboard.press('Escape')
  // 从枚举表取值的枚举：XL 只在枚举表里有
  await cell(5, 2).dblclick()
  await opts
    .getByRole('option', { name: /XL/ })
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('结构化：从枚举表取值的枚举没有列出表里的值'))
  await p.keyboard.press('Escape')
  // repeated + 引用：列表编辑，下面能点角色表里的 ID
  await cell(8, 5).dblclick()
  await p
    .getByRole('listitem')
    .filter({ hasText: '1003' })
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('结构化：repeated 列没有拆成一项一项'))
  await check(p, '表格页-列表编辑', ['艾琳'])
  await p.keyboard.press('Escape')
  await cell(8, 5).click()
  await p.getByRole('button', { name: '列结构' }).click()
  await check(p, '表格页-列结构', ['InteractionAllowCharacterIDs'])
  await p.keyboard.press('Escape')

  // 左栏「检查」：整个项目按结构查一遍，点一处跳到那一格
  await p.getByRole('radio', { name: '检查' }).click()
  await p.getByPlaceholder('按文件名、字段名筛').fill('')
  await p
    .getByText(/个表格查完/)
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('表格页：「检查」没有出结果'))
  await check(p, '表格页-全项目检查', ['InteractionTriggerState'])

  // 版本差异：本地改动（含刚才保存的）和某个提交改了什么，格子级、按主键对齐
  await p.getByRole('radio', { name: '文件名' }).click()
  await p.getByRole('button', { name: '版本', exact: true }).click()
  const hist = p.getByRole('dialog')
  await hist
    .getByText('按主键 ID 对齐')
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('表格页：版本差异没有按主键对齐出结果'))
  await check(p, '表格页-版本差异-本地', ['本地改动', '5e1c09a2'])
  await hist.getByRole('button', { name: /9b7d3f10/ }).click()
  await hist
    .getByText(/\+10 行/)
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('表格页：选一个提交没有显示它加的 10 行'))
  await check(p, '表格页-版本差异-提交', ['41aa0c6e → 9b7d3f10'])
  await p.keyboard.press('Escape')

  // 跨项目对比：客户端主工程当 Release 工作区，选中一行拷过去
  await p.getByRole('button', { name: '跨项目对比' }).click()
  const cmp = p.getByRole('dialog')
  await cmp
    .getByRole('button', { name: /把选中行拷到右边/ })
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('表格页：跨项目对比没有打开有差异的文件'))
  await check(p, '表格页-跨项目对比', ['有差异', '客户端主工程'])
  await cmp.getByRole('checkbox').first().click()
  await cmp.getByRole('button', { name: /把选中行拷到右边/ }).click()
  await p.getByRole('button', { name: /拷过去|照样拷/ }).click()
  await p
    .getByText(/已拷 1 行到/)
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('表格页：跨项目对比拷行没有成功'))
  await p.keyboard.press('Escape')

  // 项目设置里的「表格」页
  await p.getByRole('button', { name: '表格设置' }).click()
  const dlg = p.getByRole('dialog')
  await dlg
    .getByText('表格目录', { exact: true })
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('表格页：「表格设置」没有打开项目设置的表格页'))
  await check(p, '项目设置-表格', ['结构信息', '5 个表格', '一共 5 个表格文件'])

  // 表格目录一行一个：「添加表格目录」弹出目录选择器，选项目里的 tests 多一行（里面没有表格），再删掉
  await dlg.getByRole('button', { name: '添加表格目录' }).click()
  const picker = p.getByRole('dialog', { name: '选择表格目录' })
  await picker
    .getByRole('button', { name: 'tests', exact: true })
    .dblclick({ timeout: 8000 })
    .catch(() => errors.push('项目设置-表格：目录选择器里没有项目的 tests 目录'))
  const added = p.getByRole('textbox', { name: '第 2 个目录' })
  await added.waitFor({ timeout: 5000 }).catch(() => errors.push('项目设置-表格：选了目录没有多一行'))
  if ((await added.inputValue().catch(() => '')) !== 'tests')
    errors.push('项目设置-表格：选到项目目录里的文件夹应该写成相对路径 tests')
  await p
    .getByText(/没有符合「包含」的表格|找不到这个目录/)
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('项目设置-表格：新加的目录下面没有显示找到几个表格'))
  await check(p, '项目设置-表格目录选择', ['tests'])
  await p.getByRole('button', { name: '删掉这个目录' }).nth(1).click()
  await added.waitFor({ state: 'detached', timeout: 3000 }).catch(() => errors.push('项目设置-表格：删不掉目录'))

  // AI 分析表格风格：演示里按示例给结果，回到这里逐项勾选
  await dlg.getByRole('button', { name: 'AI 分析' }).click()
  const review = p.getByRole('region', { name: 'AI 分析结果' })
  // 分析做完后关掉 AI 窗口回到设置（窗口开着时设置弹窗对读屏是隐藏的），结果逐项列着
  await p
    .getByText(/分析完成/)
    .waitFor({ timeout: 30000 })
    .catch(() => errors.push('项目设置-表格：AI 分析没有做完'))
  await p.keyboard.press('Escape')
  await review.waitFor({ timeout: 10000 }).catch(() => errors.push('项目设置-表格：AI 分析的结果没有交回来'))
  await review.scrollIntoViewIfNeeded().catch(() => {})
  await check(p, '项目设置-AI分析表格', ['枚举：HomeDecorationSizeType', '例外：data/enum/*.xlsx'])
  await review.getByRole('button', { name: /写进结构文件/ }).click()
  await p
    .getByText(/上次分析：/)
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('项目设置-表格：AI 分析的结果没有写进结构文件'))
})
