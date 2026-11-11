/**
 * 界面检查分片：表格页（游戏配置表管理）。
 *
 * 演示项目「商城前台」在项目设置里把 data 设成了表格目录，所以图标栏里有「表格」：
 * - 文件树列出 data 下的表格，打开配置表后自动认出 5 行表头、按角色上色
 * - 内容搜索跨文件找到格子，点一处打开那个文件并滚到那一格
 * - 项目设置里的「表格」页（目录、包含 / 排除、结构信息存放位置）
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

  // 项目设置里的「表格」页
  await p.getByRole('button', { name: '表格设置' }).click()
  const dlg = p.getByRole('dialog')
  await dlg
    .getByText('表格目录', { exact: true })
    .waitFor({ timeout: 8000 })
    .catch(() => errors.push('表格页：「表格设置」没有打开项目设置的表格页'))
  await check(p, '项目设置-表格', ['结构信息', '找到 3 个表格文件'])
})
