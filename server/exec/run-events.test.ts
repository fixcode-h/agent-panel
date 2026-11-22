/**
 * 授权请求答完才开始给命令计时（server/exec/run-events.ts 的 afterApproval）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ToolUse } from '../../shared/schema.ts'
import { afterApproval } from './run-events.ts'

test('等用户批准的时间不算进命令耗时', () => {
  const tool = { kind: 'run', label: 'node x.js', startedAt: 1 } as ToolUse
  const toolStart = new Map<ToolUse, number>([[tool, 1]])
  let got: unknown
  afterApproval((r: string) => (got = r), toolStart)('ok')
  assert.equal(got, 'ok')
  assert.ok(toolStart.get(tool)! > 1_000)
  assert.equal(tool.startedAt, toolStart.get(tool))
})
