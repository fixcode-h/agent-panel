/**
 * 面板调插件代码的统一限时（插件框架改进 A1）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { PluginTimeout, withPluginLimit } from './limit.ts'

test('插件按时返回：结果原样交回', async () => {
  assert.equal(await withPluginLimit('tools', async () => 42, 200), 42)
  assert.equal(await withPluginLimit('status', () => 'sync', 200), 'sync')
})

test('插件卡住：到时间按超时报错，不一直等', async () => {
  const t0 = Date.now()
  await assert.rejects(
    withPluginLimit('tools', () => new Promise(() => {}), 50),
    (e) => e instanceof PluginTimeout,
  )
  assert.ok(Date.now() - t0 < 1000)
})

test('插件自己抛错（同步、异步）：原样交回，不当成超时', async () => {
  await assert.rejects(
    withPluginLimit('stop', () => {
      throw new Error('坏了')
    }),
    (e) => !(e instanceof PluginTimeout) && (e as Error).message === '坏了',
  )
  await assert.rejects(
    withPluginLimit('stop', async () => Promise.reject(new Error('异步坏了'))),
    /异步坏了/,
  )
})
