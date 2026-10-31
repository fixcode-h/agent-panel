// scripts/release-notes.mjs 的测试：前缀分节（含「界面：」）、找不到上一个标签时正式版直接失败
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classify, commitRange, pickPreviousTag, FALLBACK_COMMITS } from './release-notes.mjs'

test('前缀分节：「界面：」归到改进与调整并去掉前缀，「内部：」不进说明，没前缀的取标题', () => {
  const s = classify([
    '界面：悬停提示在滚动时关掉，不再挂在原地\n\nCo-Authored-By: x <x@x>',
    '流程图支持拖线新建节点\n\n新功能：拖线新建节点 — 从节点拖线到空白处松手\n修复：设置弹窗 — 不再闪动\n界面：下拉框 — 跟随主题',
    '内部：测试提速\n\n改进：只给用户看的这一行',
    '内部：只改了文档',
    '没有前缀的标题',
  ])
  assert.deepEqual(s['新功能'], ['**拖线新建节点** — 从节点拖线到空白处松手'])
  assert.deepEqual(s['Bug 修复'], ['**设置弹窗** — 不再闪动'])
  assert.deepEqual(s['改进与调整'], [
    '悬停提示在滚动时关掉，不再挂在原地',
    '**下拉框** — 跟随主题',
    '只给用户看的这一行',
    '没有前缀的标题',
  ])
  assert.ok(
    Object.values(s)
      .flat()
      .every((l) => !/^(界面|内部)[:：]/.test(l)),
    '前缀不原样留在说明里',
  )
})

test('上一个标签：正式版只认不带后缀的，预览版只认 -dev', () => {
  const tags = ['v0.28.12-dev', 'v0.28.10', 'v0.28.9-dev', 'v0.27.5']
  assert.equal(pickPreviousTag(tags, 'main'), 'v0.28.10')
  assert.equal(pickPreviousTag(tags, 'dev'), 'v0.28.12-dev')
  assert.equal(pickPreviousTag(['v0.28.12-dev'], 'main'), '')
})

test('取提交范围：有标签从标签起；正式版没标签直接失败，显式允许或预览版才退回最近几个提交并给提示', () => {
  assert.deepEqual(commitRange({ prev: 'v0.28.10', channel: 'main' }), { range: ['v0.28.10..HEAD'], warning: '' })
  assert.throws(() => commitRange({ prev: '', channel: 'main' }), /找不到上一个正式版标签.*--allow-no-tag/)
  const allowed = commitRange({ prev: '', channel: 'main', allowNoTag: true })
  assert.deepEqual(allowed.range, ['HEAD', '-n', String(FALLBACK_COMMITS)])
  assert.match(allowed.warning, /正式版标签/)
  const dev = commitRange({ prev: '', channel: 'dev' })
  assert.deepEqual(dev.range, ['HEAD', '-n', String(FALLBACK_COMMITS)])
  assert.match(dev.warning, /预览版标签/)
})
