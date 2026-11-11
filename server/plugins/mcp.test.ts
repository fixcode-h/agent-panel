import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { openPluginMcp, pluginMcpApi, type McpTool } from './mcp.ts'
import { clearPluginEffects, pluginExtra } from './effects.ts'

const cwd = path.resolve('/proj')

async function call(url: string, name: string, args: Record<string, unknown> = {}) {
  const token = url.split('/').pop()!
  const res = await pluginMcpApi().request(`/${token}`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  return ((await res.json()) as { result: Record<string, unknown> }).result
}

test('插件工具声明改文件：执行前过守卫，成功后改动记下来、不交给 Agent', async () => {
  clearPluginEffects()
  let ran = 0
  const changed: string[][] = []
  const write: McpTool = {
    name: 'write_asset',
    description: '',
    inputSchema: {},
    effect: 'edit',
    targets: (a) => [String(a.path)],
    call: async () => {
      ran++
      return { content: [{ type: 'text', text: '写好了' }], changed: ['Content/A.uasset'] }
    },
  }
  const seen: string[][] = []
  const m = openPluginMcp('ue', 'ue', 'task1', () => [write], undefined, {
    cwd,
    guardEdit: async (_tool, paths) => {
      seen.push(paths)
      return paths[0] === 'Content/Locked.uasset' ? '【面板】只读' : ''
    },
    changed: (f) => changed.push(f),
  })
  const denied = await call(m.url, 'write_asset', { path: 'Content/Locked.uasset' })
  assert.equal(denied.isError, true)
  assert.equal(ran, 0, '守卫拒绝时不执行')
  const ok = await call(m.url, 'write_asset', { path: 'Content/A.uasset' })
  assert.equal(ok.isError, undefined)
  assert.equal(ok.changed, undefined, 'changed 不交给 Agent')
  assert.deepEqual(changed, [[path.join(cwd, 'Content/A.uasset')]])
  assert.deepEqual(seen, [['Content/Locked.uasset'], ['Content/A.uasset']])
  assert.deepEqual(pluginExtra('task1', '').files, ['Content/A.uasset'])
  m.close()
})
