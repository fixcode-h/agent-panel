/**
 * API 测速的判断（api-speed.ts）：只有模型真的输出了内容才算首包。运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasContent, largePrompt } from './api-speed.ts'

test('首包按模型真的输出内容算：开头的空壳（message_start、role）不算，思考和正文都算', () => {
  assert.equal(hasContent('anthropic', 'event: message_start\ndata: {"type":"message_start"}'), false)
  assert.equal(hasContent('anthropic', 'data: {"type":"content_block_delta","delta":{"type":"thinking_delta"}}'), true)
  assert.equal(hasContent('openai-chat', 'data: {"choices":[{"delta":{"role":"assistant","reasoning":""}}]}'), false)
  assert.equal(hasContent('openai-chat', 'data: {"choices":[{"delta":{"reasoning":"The"}}]}'), true)
  assert.equal(hasContent('openai-chat', 'data: {"choices":[{"delta":{"content":"好"}}]}'), true)
  assert.equal(hasContent('openai-responses', 'data: {"type":"response.created"}'), false)
  assert.equal(hasContent('openai-responses', 'data: {"type":"response.output_text.delta","delta":"a"}'), true)
})

test('大请求的正文长度固定、每次一样，前后几次结果可比', () => {
  assert.equal(largePrompt(1000), largePrompt(1000))
  assert.ok(largePrompt(1000).length > 1000 && largePrompt(1000).length < 1200)
})
