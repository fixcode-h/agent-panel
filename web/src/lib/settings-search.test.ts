import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fillVars, highlightParts, matchSetting, searchSettings, searchTerms, snippet } from './settings-search.ts'

const item = (title: string, more: Partial<Parameters<typeof matchSetting>[0]> = {}) => ({
  section: 'general',
  title,
  zh: title,
  ...more,
})

test('设置搜索：空格分开的每段都要命中，不分大小写，也比对中文原文', () => {
  assert.deepEqual(searchTerms('  Web  Hook '), ['web', 'hook'])
  assert.equal(matchSetting(item('启用 Webhook'), searchTerms('webhook')), true)
  assert.equal(matchSetting(item('超时', { desc: '分钟，填 0 不限制' }), searchTerms('超时 分钟')), true)
  assert.equal(matchSetting(item('超时'), searchTerms('超时 代理')), false)
  // 英文界面下用中文原文也能搜到
  assert.equal(matchSetting(item('Timeout', { zh: '超时' }), searchTerms('超时')), true)
  // 小节名命中也算
  assert.equal(matchSetting(item('上限', { group: '会话保活' }), searchTerms('保活')), true)
  assert.deepEqual(searchSettings([item('a'), item('b')], '   '), [])
})

test('设置搜索：命中的字切成段，重叠的合并', () => {
  assert.deepEqual(highlightParts('Webhook 地址', ['web', 'hook']), [
    { text: 'Webhook', hit: true },
    { text: ' 地址', hit: false },
  ])
  assert.deepEqual(highlightParts('代理与代理', ['代理']), [
    { text: '代理', hit: true },
    { text: '与', hit: false },
    { text: '代理', hit: true },
  ])
  assert.deepEqual(highlightParts('abc', ['x']), [{ text: 'abc', hit: false }])
})

test('设置搜索：说明里命中的词离开头太远时从它前面截', () => {
  const long = `${'甲'.repeat(60)}代理${'乙'.repeat(10)}`
  assert.equal(snippet(long, ['代理'], 10), `…${'甲'.repeat(10)}代理${'乙'.repeat(10)}`)
  assert.equal(snippet('代理在前面', ['代理']), '代理在前面')
  assert.equal(snippet('没命中', ['代理']), '没命中')
})

test('设置搜索：文案里的变量知道的填值，不知道的写省略号', () => {
  assert.equal(fillVars('{cli} 的模型，最多 {n} 次', { cli: 'Codex' }), 'Codex 的模型，最多 … 次')
})
