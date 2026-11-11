/**
 * 界面检查分片：表格页（游戏配置表管理）。
 *
 * 演示项目「商城前台」在项目设置里把 data 设成了表格目录，所以图标栏里有「表格」：
 * - 文件树列出 data 下的表格，打开配置表后自动认出 5 行表头、按角色上色
 * - 内容搜索跨文件找到格子，点一处打开那个文件并滚到那一格
 * - 结构化：检查标红、枚举下拉、repeated 列表编辑、列结构；左栏「检查」查整个项目
 * - 导表脚本（占位换成真实路径、看输出）、本地文件切换到某一版
 * - 项目设置里的「表格」页（目录、包含 / 排除、导表脚本、结构信息存放位置）和 AI 分析表格风格
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
  await check(p, '表格页-列结构', ['InteractionAllowCharacterIDs', '格式（正则）', '必填'])
  await p.keyboard.press('Escape')

  // 引用跳转：引用列的格子右键，跳到被引用表的那一行
  await cell(8, 5).click({ button: 'right' })
  await p
    .getByRole('menuitem', { name: /C_Character\.xlsx · ID = 1003/ })
    .click({ timeout: 5000 })
    .catch(() => errors.push('引用跳转：引用列右键没有「跳到被引用的行」'))
  await p
    .getByRole('tab', { name: 'C_Character.xlsx' })
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('引用跳转：没有打开被引用的表'))
  await check(p, '表格页-引用跳转', ['C_Character.xlsx'])
  // 反向：被引用的这一行右键「谁引用了这一行」
  await p.locator('[role=cell][aria-selected=true]').first().click({ button: 'right' })
  await p
    .getByRole('menuitem', { name: '谁引用了这一行' })
    .click({ timeout: 5000 })
    .catch(() => errors.push('反向引用：被引用表的行右键没有「谁引用了这一行」'))
  await p
    .getByRole('list', { name: '引用这一行的格子' })
    .getByRole('listitem')
    .first()
    .click({ timeout: 8000 })
    .catch(() => errors.push('反向引用：没有列出引用这一行的格子'))
  if ((await p.getByRole('tab', { name: 'C_HomeDecorationConfig.xlsx' }).getAttribute('aria-selected')) !== 'true')
    errors.push('反向引用：点结果没有回到引用它的表')

  // 查找替换：预览每处改成什么，取消不改
  await p.getByRole('button', { name: '替换', exact: true }).click()
  const fr = p.getByRole('dialog', { name: '查找替换' })
  await fr.getByRole('radio', { name: '整张表' }).click()
  await fr.getByRole('textbox', { name: '查找' }).fill('穿衣镜')
  await fr.getByRole('textbox', { name: '替换为' }).fill('立镜')
  await fr
    .getByRole('list', { name: '替换预览' })
    .getByText(/立镜/)
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('查找替换：没有预览'))
  await check(p, '表格页-查找替换', ['全部替换'])
  await fr.getByRole('button', { name: '取消' }).click()

  // 冻结列：列名右键冻结到 B 列，左右滚动时钉在左边
  await p
    .getByRole('columnheader', { name: /^B( |$)/ })
    .first()
    .click({ button: 'right' })
  await p.getByRole('menuitem', { name: /冻结到 B 列/ }).click()
  if (!(await p.locator('.sheet-frozen-last').count())) errors.push('冻结列：冻结后没有钉住的列')
  await p.locator('[aria-label=表格内容]').evaluate((el) => (el.scrollLeft = 600))
  await check(p, '表格页-冻结列', ['ID'])
  await p
    .getByRole('columnheader', { name: /^B( |$)/ })
    .first()
    .click({ button: 'right' })
  await p.getByRole('menuitem', { name: '取消冻结' }).click()

  // 一格的历史：右键看哪几次提交改过这一格（按主键找同一行）
  await cell(8, 5).click({ button: 'right' })
  await p.getByRole('menuitem', { name: '这一格的历史' }).click()
  await p
    .getByRole('list', { name: '改过这一格的提交' })
    .getByText('5e1c09a2')
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('一格的历史：没有列出改过这一格的提交'))
  await check(p, '表格页-一格的历史', ['按 ID = '])
  await p.keyboard.press('Escape')

  // 版本冲突：角色表演示有冲突，三方合并只列两边都改了的格子，放进表格当一次改动
  await p.getByRole('tab', { name: 'C_Character.xlsx' }).click()
  await p.getByRole('button', { name: '合并冲突' }).click({ timeout: 8000 })
  const merge = p.getByRole('dialog', { name: '合并冲突' })
  await merge
    .getByText('C_Character · 1001 · Level')
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('合并冲突：没有列出两边都改了的格子'))
  await check(p, '表格页-合并冲突', ['自动合进来对方的', '用对方的'])
  await merge
    .getByRole('button', { name: /用对方的/ })
    .first()
    .click()
  await merge.getByRole('button', { name: '放进表格' }).click()
  await p
    .getByText('诺拉')
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('合并冲突：放进表格后没有对方新加的行'))
  await check(p, '表格页-合并结果', ['合并结果已放进表格', '米娅·星'])
  await p.getByRole('button', { name: '撤销（Ctrl+Z）' }).click()

  // AI 提的改动：演示里库存表带一份，看差异后放进表格（一次改动，撤销退掉）
  await p.getByRole('tab', { name: 'stock.xlsx' }).click()
  await p.getByRole('button', { name: '看差异' }).click({ timeout: 8000 })
  const prop = p.getByRole('dialog', { name: 'AI 提的改动' })
  await prop
    .getByText('p-1005')
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('AI 提议：差异里没有 AI 加的行'))
  await check(p, '表格页-AI提的改动', ['放进表格'])
  await prop.getByRole('button', { name: '放进表格' }).click()
  if ((await p.getByRole('tab', { name: '补货记录' }).getAttribute('aria-selected')) !== 'true')
    errors.push('AI 提议：放进表格后没有切到那张工作表')
  await p.getByRole('button', { name: '撤销（Ctrl+Z）' }).click()
  // 工具栏「AI」：加行、修不合规、解释
  await p.getByRole('button', { name: 'AI', exact: true }).click()
  await p.getByRole('menuitem', { name: '照着描述加几行…' }).click()
  await check(p, '表格页-AI加行', ['要什么样的行', '让 AI 写'])
  await p.getByRole('dialog', { name: '照着描述加几行' }).getByRole('button', { name: '取消' }).click()
  await p.getByRole('tab', { name: 'C_HomeDecorationConfig.xlsx' }).click()

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
  // 批量同步：勾文件、选整文件还是一列，先预览每个文件会怎样
  await cmp.getByRole('button', { name: '批量同步…' }).click()
  const sync = p.getByRole('dialog', { name: /批量同步到/ })
  await sync.getByRole('list', { name: '要同步的文件' }).getByRole('checkbox').first().click()
  await sync.getByRole('button', { name: '预览' }).click()
  await sync
    .getByRole('list', { name: '同步预览' })
    .getByText(/整个替换|右边新建|已经一样/)
    .first()
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('批量同步：没有出预览'))
  await check(p, '表格页-批量同步预览', ['写之前都会备份'])
  await sync.getByRole('button', { name: '返回修改' }).click()
  await sync.getByRole('button', { name: '取消' }).click()
  await p.keyboard.press('Escape')

  // 导表：工具栏「导表」选一个脚本，窗口里看到占位换成真实路径后的命令和输出
  await p.getByRole('button', { name: '导表', exact: true }).click()
  await p.getByRole('menuitem', { name: /导出 JSON/ }).click()
  const run = p.getByRole('dialog')
  await run
    .getByText(/导出 C_HomeDecorationConfig\.json/)
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('导表：没有跑出输出'))
  if (
    !(await run.getByText(/export_json\.py \/home\/demo\/code\/web-shop\/data\/C_HomeDecorationConfig\.xlsx/).count())
  )
    errors.push('导表：命令里的 {file} 没有换成表格的真实路径')
  await check(p, '表格页-导表', ['完成', '退出码 0'])
  await p.keyboard.press('Escape')
  // 从 CSV 粘贴导入：第一行是字段名就按名字对列，预览追加的行
  await p.getByRole('button', { name: '导表', exact: true }).click()
  await p.getByRole('menuitem', { name: '从 CSV 粘贴导入…' }).click()
  const imp = p.getByRole('dialog', { name: '从 CSV 粘贴导入' })
  await imp.getByRole('textbox').fill('ID,DisplayName\n990001,新落地镜')
  await imp
    .getByRole('table', { name: '追加的行' })
    .getByText('新落地镜')
    .waitFor({ timeout: 5000 })
    .catch(() => errors.push('导入：没有预览追加的行'))
  await check(p, '表格页-粘贴导入', ['按第一行的字段名对列', '追加 1 行'])
  await imp.getByRole('button', { name: '取消' }).click()

  // 本地文件切换到某一版：选一个旧提交，确认后整个文件换成那一版
  await p.getByRole('button', { name: '版本', exact: true }).click()
  await hist.getByRole('button', { name: /9b7d3f10/ }).click()
  await hist.getByRole('button', { name: '本地文件切换到这一版' }).click()
  await check(p, '表格页-切换版本确认', ['整个文件换成这一版的内容'])
  await p.getByRole('button', { name: '切换', exact: true }).click()
  await p
    .getByText(/已把 C_HomeDecorationConfig\.xlsx 切换到所选版本/)
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('表格页：切换到旧版本没有成功'))

  // 项目设置里的「表格」页
  await p.getByRole('button', { name: '表格设置' }).click()
  const dlg = p.getByRole('dialog')
  await dlg
    .getByText('表格目录', { exact: true })
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('表格页：「表格设置」没有打开项目设置的表格页'))
  await check(p, '项目设置-表格', ['结构信息', '5 个表格', '一共 5 个表格文件', '导表脚本', '执行时：', '组合唯一'])

  await dlg.getByRole('button', { name: '添加导表脚本' }).scrollIntoViewIfNeeded()
  await check(p, '项目设置-导表脚本', ['插入占位：', '执行时：'])

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
