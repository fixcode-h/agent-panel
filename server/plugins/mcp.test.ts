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

/** 一个一直不返回、记下有没有收到取消的工具 */
function hanging(timeoutSec?: number) {
  const seen = { aborted: false }
  const tool: McpTool = {
    name: 'compile',
    description: '',
    inputSchema: {},
    ...(timeoutSec && { timeoutSec }),
    call: (_a, ctx) =>
      new Promise(() => {
        ctx.signal?.addEventListener('abort', () => (seen.aborted = true))
      }),
  }
  return { tool, seen }
}

test('插件工具跑到一半这一轮结束：调用被取消，插件收到 signal，Agent 那边按出错返回', async () => {
  const { tool, seen } = hanging()
  const m = openPluginMcp('ue', 'ue', 'task2', () => [tool])
  const pending = call(m.url, 'compile')
  await new Promise((r) => setTimeout(r, 20))
  m.close()
  const r = await pending
  assert.equal(r.isError, true)
  assert.equal(seen.aborted, true)
})

test('插件工具声明了 timeoutSec：到时间按出错返回并取消', async () => {
  const { tool, seen } = hanging(0.05)
  const m = openPluginMcp('ue', 'ue', 'task3', () => [tool])
  const r = await call(m.url, 'compile')
  assert.equal(r.isError, true)
  assert.match(JSON.stringify(r.content), /超过 0\.05 秒/)
  assert.equal(seen.aborted, true)
  m.close()
})

test('CLI 发 notifications/cancelled：对应的那次调用被取消', async () => {
  const { tool, seen } = hanging()
  const m = openPluginMcp('ue', 'ue', 'task4', () => [tool])
  const token = m.url.split('/').pop()!
  const pending = call(m.url, 'compile')
  await new Promise((r) => setTimeout(r, 20))
  await pluginMcpApi().request(`/${token}`, {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
  })
  assert.equal((await pending).isError, true)
  assert.equal(seen.aborted, true)
  m.close()
})

test('插件工具报进度：交给这一轮的 progress，带服务名和工具名', async () => {
  const seen: string[] = []
  const tool: McpTool = {
    name: 'compile',
    description: '',
    inputSchema: {},
    call: async (_a, ctx) => {
      ctx.progress?.('编译 1/2')
      ctx.progress?.('编译 2/2')
      return { content: [{ type: 'text', text: '好了' }] }
    },
  }
  const m = openPluginMcp('ue', 'ue', 'task5', () => [tool], undefined, {
    cwd,
    progress: (server, name, text) => seen.push(`${server}/${name}/${text}`),
  })
  await call(m.url, 'compile')
  assert.deepEqual(seen, ['ue/compile/编译 1/2', 'ue/compile/编译 2/2'])
  m.close()
})
