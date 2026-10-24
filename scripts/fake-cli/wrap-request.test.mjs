/**
 * 父对话一轮里可能同时收到几个子对话的收尾请求：每一个都要交给 finish_child，
 * 只处理第一个会让后面的子对话一直等到超时（看起来像合并卡住）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wrapRequestIds } from './wrap-request.mjs'

const wrapLine = (title, id) => `【收尾请求】子对话「${title}」（id ${id}）只剩合回了：计划其余步骤都做完。`

test('一轮里只有一个收尾请求时照常返回', () => {
  assert.deepEqual(wrapRequestIds(`前文\n${wrapLine('甲', 'kid-1')}\n后文`), ['kid-1'])
})

test('一轮里有几个收尾请求时按顺序全部返回', () => {
  const input = [wrapLine('甲', 'kid-1'), '别的消息', wrapLine('乙', 'kid-2'), wrapLine('丙', 'kid-3')].join('\n')
  assert.deepEqual(wrapRequestIds(input), ['kid-1', 'kid-2', 'kid-3'])
})

test('同一个子对话的收尾请求出现两次只处理一次', () => {
  assert.deepEqual(wrapRequestIds([wrapLine('甲', 'kid-1'), wrapLine('甲', 'kid-1')].join('\n')), ['kid-1'])
})

test('没有收尾请求时返回空数组', () => {
  assert.deepEqual(wrapRequestIds('普通的一轮，没有收尾请求'), [])
  // 【子对话状态】这类标签不是收尾请求
  assert.deepEqual(wrapRequestIds('【子对话状态】子对话「甲」（id kid-9）在跑'), [])
})
