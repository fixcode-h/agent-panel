import assert from 'node:assert/strict'
import test from 'node:test'
import { launch, openWithSystem } from './open.ts'

// 用户报的「点了没反应」：spawn 的 error 事件被空回调吞掉，接口照样回 ok，界面什么都没显示。
// 这几条保证「起不来」一定变成失败，能被接口翻译成界面上的提示。

test('launch 起不存在的程序要 reject，不能静默成功', async () => {
  await assert.rejects(() => launch('agent-panel-no-such-command-xyz', []), /ENOENT|not found|找不到/i)
})

test('launch 等进程真的起来才 resolve', async () => {
  // 用 node 自己跑一个马上退出的命令：spawn 事件到了就算成功，不等它退出
  await launch(process.execPath, ['--version'])
})

test('可执行文件只显示不运行：openWithSystem 返回 false 且不去启动它', async () => {
  assert.equal(await openWithSystem('C:\\tmp\\安装程序.exe'), false)
  assert.equal(await openWithSystem('/tmp/脚本.sh'), false)
})
