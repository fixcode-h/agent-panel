import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codeTerms, flagLines } from './terms.ts'

test('codeTerms：截图里那段修复说明，文件名、函数名、字段、键=值补上反引号，普通词不动（用户 2026-11-07）', () => {
  const out = codeTerms(
    's_CSM_CompanionNPCSystem.lua 在 OnCompanionTrackTaskChange 记录 CurTrackTaskType 并对现有 NPC 调用恢复，' +
      '新增 TryRestoreCompanionState（Follow 模式 + NPC TaskID 匹配）找 target_type=59、client_param1=InstanceID 的动作',
  )
  assert.equal(
    out,
    '`s_CSM_CompanionNPCSystem.lua` 在 `OnCompanionTrackTaskChange` 记录 `CurTrackTaskType` 并对现有 NPC 调用恢复，' +
      '新增 `TryRestoreCompanionState`（Follow 模式 + NPC `TaskID` 匹配）找 `target_type=59`、`client_param1=InstanceID` 的动作',
  )
})

test('codeTerms：已有的反引号、链接、网址、HTML 标签不动；带目录的路径整段包住；产品名、版本号不包', () => {
  assert.equal(
    codeTerms(
      '改 Project/Script/a_b.lua:42 和 `x_y`，见 [说明](src/a_b.ts)、https://a.com/x_y.ts<br>用 GitHub 1.2.3 self.Foo:Bar()',
    ),
    '改 `Project/Script/a_b.lua:42` 和 `x_y`，见 [说明](src/a_b.ts)、https://a.com/x_y.ts<br>用 GitHub 1.2.3 `self.Foo:Bar()`',
  )
  assert.equal(codeTerms('只有中文和 NPC、PIE、H6'), '只有中文和 NPC、PIE、H6')
})

test('flagLines：「注意：」单独一行画成提示块，前后空行免得吞掉下一行；列表里的只加粗', () => {
  assert.equal(flagLines('第一段\n注意：会清掉旧数据\n后面'), '第一段\n\n> [!WARNING]\n> 会清掉旧数据\n\n后面')
  assert.equal(flagLines('- 风险：改了公共接口'), '- **风险**：改了公共接口')
  assert.equal(flagLines('没有要注意的：普通一句'), '没有要注意的：普通一句')
})
