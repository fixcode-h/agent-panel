import assert from 'node:assert/strict'
import test from 'node:test'
import { getCli } from './clis.ts'
import { pluginArgs } from './role-plugins.ts'
import { AgentInput } from './schema.ts'

/** ADR 0050 第四期：角色额外加载的插件，Pi 按 -e 传、只在这一次运行加载；不支持单次加载的 CLI 不传 */
test('角色级插件：Pi 每个来源一个 -e（去重、去空白），Codex 这类没有单次加载的 CLI 不传；角色数据里存得下', () => {
  assert.deepEqual(pluginArgs(getCli('pi'), [' npm:pi-lens ', 'npm:pi-lens', '', 'git:github.com/a/b']), [
    '-e',
    'npm:pi-lens',
    '-e',
    'git:github.com/a/b',
  ])
  assert.deepEqual(pluginArgs(getCli('codex'), ['npm:pi-lens']), [])
  assert.deepEqual(pluginArgs(getCli('pi'), undefined), [])
  const a = AgentInput.parse({ name: '测试', plugins: ['npm:pi-lens'] })
  assert.deepEqual(a.plugins, ['npm:pi-lens'])
  assert.equal(AgentInput.parse({ name: '旧角色' }).plugins, undefined, '旧数据没有这一项')
  const args = getCli('pi')!.buildArgs({
    model: 'm',
    permission: 'full',
    extraArgs: pluginArgs(getCli('pi'), a.plugins),
  })
  assert.ok(args.join(' ').includes('-e npm:pi-lens'), '执行时进了 Pi 的参数')
})
