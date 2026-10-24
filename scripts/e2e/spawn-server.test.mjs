/**
 * /health 的身份校验：端口被别的服务（残留进程、并行的分片）占着时，只要求「回了 {ok:true}」的旧健康检查
 * 会当成自己的服务起来了，然后再在第一个 waitFor 上超时——这条规则就是拦住那种假通过。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeHealthMismatch } from './spawn-server.mjs'

test('instance 一致时认为连上了自己的服务', () => {
  assert.equal(describeHealthMismatch({ ok: true, instance: 'assist-abc' }, 'assist-abc', 4000), null)
})

test('instance 不一致时指出端口被占，并写出实际回显', () => {
  const text = describeHealthMismatch({ ok: true, instance: '04-subagents-xyz' }, 'assist-abc', 4123)
  assert.match(text, /端口 4123/)
  assert.match(text, /04-subagents-xyz/)
  assert.match(text, /assist-abc/)
  assert.match(text, /被残留的服务进程或并行的分片占着/)
})

test('旧服务只回裸 {ok:true} 时同样不算自己的服务', () => {
  assert.match(describeHealthMismatch({ ok: true }, 'assist-abc', 4123), /instance=undefined/)
})
