import assert from 'node:assert/strict'
import test from 'node:test'
import { getCli } from '../clis.ts'
import type { McpServer } from '../library.ts'
import { mcpInjectArgs } from './inject.ts'

const stdio: McpServer = {
  name: 'docs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'docs-mcp', 'a "b"'],
  env: { TOKEN: 'x' },
  url: '',
  headers: {},
}
const remote: McpServer = {
  name: 'web search',
  transport: 'http',
  command: '',
  args: [],
  env: {},
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer x' },
}

test('Claude Code：按项目的条目合成一段 --mcp-config，字段和 ~/.claude.json 一样', () => {
  const args = mcpInjectArgs(getCli('claude')!.mcpStore, [stdio, remote])
  assert.equal(args.length, 2)
  assert.equal(args[0], '--mcp-config')
  assert.ok(!args[1].includes('\n'), '参数里不能有换行（Windows 上经 cmd 会被截断）')
  assert.deepEqual(JSON.parse(args[1]), {
    mcpServers: {
      docs: { type: 'stdio', command: 'npx', args: ['-y', 'docs-mcp', 'a "b"'], env: { TOKEN: 'x' } },
      'web search': { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
    },
  })
})

test('Codex：每个字段一条 -c，值按 TOML 写', () => {
  const args = mcpInjectArgs(getCli('codex')!.mcpStore, [stdio, remote])
  assert.deepEqual(args, [
    '-c',
    'mcp_servers.docs.command="npx"',
    '-c',
    'mcp_servers.docs.args=["-y", "docs-mcp", "a \\"b\\""]',
    '-c',
    'mcp_servers.docs.env={ TOKEN = "x" }',
    '-c',
    'mcp_servers."web search".url="https://example.com/mcp"',
    '-c',
    'mcp_servers."web search".http_headers={ Authorization = "Bearer x" }',
  ])
})

test('CLI 定义里没写 inject、或没有条目时不加参数', () => {
  assert.deepEqual(mcpInjectArgs(getCli('pi')!.mcpStore, [stdio]), [])
  assert.deepEqual(mcpInjectArgs(getCli('claude')!.mcpStore, []), [])
  assert.deepEqual(mcpInjectArgs(undefined, [stdio]), [])
})
