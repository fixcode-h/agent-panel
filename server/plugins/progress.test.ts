/**
 * 插件工具的进度写进对话里那次调用的工具行（插件框架改进 G2）。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task } from '../../shared/schema.ts'
import { pluginProgress } from './progress.ts'

const task = (tools: { label: string; running?: boolean; output?: string }[]) =>
  ({ messages: [{ tools: tools.map((x) => ({ kind: 'other', detail: '', ...x })) }] }) as unknown as Pick<
    Task,
    'messages'
  >

test('找到还在跑的那一行：进度接在输出后面，只留最近 30 行', () => {
  const t = task([
    { label: 'ue · ue_editor', output: '旧的结果' },
    { label: 'ue · ue_editor', running: true },
  ])
  for (let i = 1; i <= 35; i++) assert.equal(pluginProgress(t, 'ue', 'ue_editor', `编译 ${i}/35`), true)
  const [done, live] = t.messages[0]!.tools!
  assert.equal(done!.output, '旧的结果', '跑完的那一行不动')
  const lines = live!.output!.split('\n')
  assert.equal(lines.length, 30)
  assert.equal(lines.at(-1), '编译 35/35')
})

test('没有对得上的行（别的 CLI、调用已结束）：不写，返回 false', () => {
  const t = task([{ label: 'ue · ue_editor' }])
  assert.equal(pluginProgress(t, 'ue', 'ue_editor', '编译中'), false)
  assert.equal(t.messages[0]!.tools![0]!.output, undefined)
})
