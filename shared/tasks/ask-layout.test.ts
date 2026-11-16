/**
 * 提问弹窗的拆分：问题拆成标题 / 背景 / 细节，选项说明拆成结果 / ✓✕ 对照。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askLayout, optionLayout, recommendedIndex, splitOption } from './ask-layout.ts'

test('按约定写的问题：第一段是标题，第二段是背景，<details> 折叠', () => {
  const l = askLayout(
    'SMC 文件的 P4 改动归到哪个 CL？\n\n派单说已打开，实际没有。\n\n<details><summary>核查</summary>\n- p4 opened 5 个文件\n</details>',
  )
  assert.equal(l.title, 'SMC 文件的 P4 改动归到哪个 CL？')
  assert.equal(l.context, '派单说已打开，实际没有。')
  assert.equal(l.details, '- p4 opened 5 个文件')
})

test('旧写法的长问题：引子、列表和过长的段落都收进细节', () => {
  const l = askLayout('**需要你定 P4 归属。**\n\n现状（已核实）：\n\n- 实际 5 个文件\n\n1（推荐）归入现有 CL')
  assert.equal(l.title, '需要你定 P4 归属。')
  assert.equal(l.context, '')
  assert.match(l.details, /^现状（已核实）：/)
  assert.match(l.details, /归入现有 CL$/)
  assert.equal(askLayout('只有一句？').details, '')
})

test('选项说明：✓ / ✕ 开头的行是对照，其余是结果；名字去掉「（推荐）」', () => {
  const o = optionLayout('归入现有 CL（推荐）', 'CL 变成 6 个文件\n✓ 不新建 CL\n- ✕ 改了指定位置')
  assert.equal(o.name, '归入现有 CL')
  assert.equal(o.effect, 'CL 变成 6 个文件')
  assert.deepEqual(o.checks, [
    { ok: true, text: '不新建 CL' },
    { ok: false, text: '改了指定位置' },
  ])
  assert.deepEqual(optionLayout('留在 default').checks, [])
})

test('推荐项：先认 recommended 字段，再认「（推荐）」', () => {
  const options = [{ label: 'a' }, { label: 'b（推荐）' }]
  assert.equal(recommendedIndex({ options }), 1)
  assert.equal(recommendedIndex({ options, recommended: 0 }), 0)
  assert.equal(recommendedIndex({ options: [{ label: 'a' }] }), -1)
})

test('字符串选项：第一行是做法，后面是说明', () => {
  assert.deepEqual(splitOption('内存缓存（推荐）\n切页面不闪\n✓ 不改接口'), {
    label: '内存缓存（推荐）',
    description: '切页面不闪\n✓ 不改接口',
  })
  assert.deepEqual(splitOption('只有做法'), { label: '只有做法', description: '' })
})
