/** 回复里的 Markdown 表格：包一层工具条、复制成 TSV / Markdown、点表头排序的顺序 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderDoc } from '@/lib/workflow-doc'
import { reorderMarkdown, sortKey, sortedOrder, tableHtml, toTsv } from '@/lib/markdown/table'

test('表格外面包一层 .md-table：带原文、行数和工具条，表格本身照旧', () => {
  const html = renderDoc('| 名字 | 数量 |\n| --- | --: |\n| a | 2 |\n| b | 10 |', new Set())
  assert.match(html, /<div class="md-table" data-rows="2" data-src="[^"]*名字[^"]*">/)
  assert.match(html, /data-table="copy"/)
  assert.match(html, /data-table="full"/)
  assert.match(html, /<table>[\s\S]*<th align="right">数量<\/th>[\s\S]*<\/table>\s*<\/div>/)
  // 原文里的竖线、引号都转义在属性里
  assert.doesNotMatch(tableHtml('<table></table>', '| "x" |', 0), /data-src="\| "x"/)
})

test('TSV：一格一个制表符，格子里有制表符、换行、引号时加引号', () => {
  assert.equal(
    toTsv([
      ['a', 'b'],
      ['1', 'x\ty'],
      ['2', '说"明"\n第二行'],
    ]),
    'a\tb\n1\t"x\ty"\n2\t"说""明""\n第二行"',
  )
})

test('复制成 Markdown：按显示顺序重排数据行，表头和对齐行不动，去掉列表里的缩进', () => {
  const raw = '  | k | v |\n  | - | - |\n  | a | `1` |\n  | b | **2** |\n  | c | 3 |\n'
  assert.equal(reorderMarkdown(raw, [2, 0, 1]), '| k | v |\n| - | - |\n| c | 3 |\n| a | `1` |\n| b | **2** |')
  // 行数对不上时原样给
  assert.equal(reorderMarkdown('| k |\n| - |\n| a |', [0, 1]), '| k |\n| - |\n| a |')
})

test('排序值：千分位、百分号、货币、单位去掉后按数字比', () => {
  assert.equal(sortKey('1,234'), '1234')
  assert.equal(sortKey('45%'), '45')
  assert.equal(sortKey('¥12.5'), '12.5')
  assert.equal(sortKey('300ms'), '300')
  assert.equal(sortKey('12 行'), '12')
  assert.equal(sortKey('v1.2'), 'v1.2')
  assert.equal(sortKey(' item2 '), 'item2')
})

test('排序顺序：数字按大小、文字按自然顺序、空格子在最后，相同值保持原来先后；不排时原顺序', () => {
  assert.deepEqual(sortedOrder(['10%', '9%', '1,000%', ''], false), [1, 0, 2, 3])
  assert.deepEqual(sortedOrder(['10%', '9%', '1,000%'], true), [2, 0, 1])
  assert.deepEqual(sortedOrder(['item10', 'item2', 'item2'], false), [1, 2, 0])
  assert.deepEqual(sortedOrder(['b', 'a'], undefined), [0, 1])
})
