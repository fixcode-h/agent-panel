/**
 * 退出码 0 却没跑起来的后台命令按失败算（server/bg/sanity.ts）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { notRunReason } from './sanity.ts'

const UE =
  '"D:/Program Files/Epic Games/UE_5.8/Engine/Build/BatchFiles/Build.bat" X Win64 Development -Project="C:/P/X.uproject"'

test('cmd 只打印版本横幅就退出：不算成功（UTF-16 读成带空格的也认）', () => {
  assert.ok(
    notRunReason(
      'cmd.exe /d /c "x"',
      ['Microsoft Windows [Version 10.0.26200.9711]', '(c) Microsoft Corporation. All rights reserved.', '', 'C:\\P>'],
      300,
    ),
  )
  assert.ok(
    notRunReason(
      'x',
      [
        'M i c r o s o f t   W i n d o w s   [ V e r s i o n   1 0 . 0 ]',
        '( c )   M i c r o s o f t   C o r p o r a t i o n',
      ],
      300,
    ),
  )
  // 横幅后面有真正的输出：照常
  assert.equal(notRunReason('x', ['Microsoft Windows [Version 10]', 'hello'], 300), '')
})

test('UE 编译几秒就完、没有 UnrealBuildTool 的日志：不算成功；有日志或跑得久的照常', () => {
  assert.ok(notRunReason(UE, [], 310))
  assert.equal(
    notRunReason(UE, ['Running UnrealBuildTool: dotnet "..\\UnrealBuildTool.dll" X', 'Target is up to date'], 3000),
    '',
  )
  assert.equal(notRunReason(UE, ['whatever'], 60_000), '')
  assert.equal(notRunReason('npm test', [], 300), '')
})
