import assert from 'node:assert/strict'
import test from 'node:test'
import { panelSource, appSource, panelCheckRow, appCheckRow } from './panel.ts'
import { runCheck } from './index.ts'
import { withPanelGuides } from './guides.ts'

test('能力目录·面板服务：每个工具有声明、说明是补过时机的原文、标出给谁和收进 more_tools 的', () => {
  const src = panelSource()
  const tools = src.servers[0]!.tools
  assert.ok(tools.length > 30)
  for (const x of tools) {
    assert.ok(x.guide, `${x.name} 没有声明`)
    // 原文已经写过这句的不重复补（record_experience 原文就写了 /learn）
    assert.ok(
      x.description.replace(/\s+/g, '').includes(x.guide!.useWhen.replace(/\s+/g, '')),
      `${x.name} 的说明没补时机`,
    )
    assert.ok(x.audience?.length, `${x.name} 没有标给谁`)
  }
  const bg = tools.find((x) => x.name === 'run_background')!
  assert.deepEqual([...bg.audience!].sort(), ['chat', 'child', 'helper', 'node', 'parent'])
  assert.deepEqual(tools.find((x) => x.name === 'create_conversation')!.audience, ['parent'])
  assert.equal(tools.find((x) => x.name === 'record_lesson')!.deferred, true)
  // 同名的两份（request_build 父对话、子对话）合成一行
  assert.equal(tools.filter((x) => x.name === 'request_build').length, 1)
  // 和交给 CLI 的同一份：ask-mcp 走的 withPanelGuides 拼出来的一样
  const [ask] = withPanelGuides([
    { name: 'end_turn', description: tools.find((x) => x.name === 'end_turn')!.description },
  ])
  assert.ok(ask!.description.split('什么时候用：').length === 2, '说明里「什么时候用」不能补两遍')
})

test('能力目录·自检：面板服务按对话类型算，操控软件只给对话；不支持 MCP 的 CLI 一行都没有', async () => {
  assert.ok(panelCheckRow('parent').count > panelCheckRow('helper').count)
  assert.equal(appCheckRow('helper', new Set()).state, 'off')
  assert.equal(appCheckRow('chat', new Set()).state, 'on')
  assert.ok(appSource(new Set()).actions.length > 0)
  const deps = { agents: { list: async () => [] }, projects: { get: async () => null }, taskTitle: async () => '' }
  const none = await runCheck({ projectId: '', agentId: '', cli: '没有的', kind: 'parent' }, deps)
  assert.equal(none.cli.mcp, false)
  assert.deepEqual(none.rows, [])
  const claude = await runCheck({ projectId: '', agentId: '', cli: 'claude', kind: 'child' }, deps)
  assert.deepEqual(
    claude.rows.map((r) => r.source),
    ['panel', 'app'],
  )
})
