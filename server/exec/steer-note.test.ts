/**
 * 执行中插话的说明：对话里先判断相关性，相关的调整方向，无关的等当前任务做完再处理。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from '../../shared/i18n.ts'
import { steerNote } from './runner.ts'

setLang('zh')

test('对话里的补充：先判断相关性，无关的等当前任务做完再处理', () => {
  const note = steerNote('顺便看看天气', true)
  assert.match(note, /先判断它和当前任务的关系/)
  assert.match(note, /按它调整方向/)
  assert.match(note, /做完后再处理这条内容/)
  assert.match(note, /顺便看看天气$/)
})

test('工作流的补充：仍然交给节点结合当前任务处理', () => {
  const note = steerNote('加一条日志', false)
  assert.doesNotMatch(note, /无关/)
  assert.match(note, /结合它继续当前的任务/)
  assert.match(note, /加一条日志$/)
})

test('父对话 / 面板发来的消息不说成用户补充，让模型按它处理并回复', () => {
  const note = steerNote('【状态询问】你已经 3 分钟没有输出了', true, true)
  assert.match(note, /父对话 \/ 面板在你执行中发来一条消息/)
  assert.match(note, /不是用户发的补充/)
  assert.match(note, /按它处理并回复/)
  assert.doesNotMatch(note, /用户在你执行中补充了信息/)
})
