import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMcpJson } from '../shared/mcp-json.ts'

test('mcpServers 包着的多个工具都认出来', () => {
  const out = parseMcpJson(`{
    "mcpServers": {
      "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "your-api-key" } },
      "docs": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer xxx" } }
    }
  }`)
  assert.deepEqual(out, [
    {
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: 'your-api-key' },
      url: '',
      headers: {},
    },
    {
      name: 'docs',
      transport: 'http',
      command: '',
      args: [],
      env: {},
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer xxx' },
    },
  ])
})

test('VS Code 的 servers、注释和结尾逗号', () => {
  const [d] = parseMcpJson(`{
    // 注释
    "servers": { "fs": { "type": "stdio", "command": "node", "args": ["a.js", "http://x//y"], }, },
  }`)
  assert.equal(d.name, 'fs')
  assert.deepEqual(d.args, ['a.js', 'http://x//y'])
})

test('只复制了 "名字": {...} 一段', () => {
  const [d] = parseMcpJson(`"playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },`)
  assert.equal(d.name, 'playwright')
  assert.equal(d.command, 'npx')
})

test('单个配置对象：名字取 name，参数写进 command 的拆开', () => {
  const [d] = parseMcpJson(`{ "name": "fs", "command": "npx -y \\"@scope/pkg\\" ~/dir", "env": { "N": 1 } }`)
  assert.equal(d.name, 'fs')
  assert.equal(d.command, 'npx')
  assert.deepEqual(d.args, ['-y', '@scope/pkg', '~/dir'])
  assert.deepEqual(d.env, { N: '1' })
})

test('远程地址的几种写法', () => {
  assert.equal(parseMcpJson(`{ "x": { "serverUrl": "https://a/sse" } }`)[0].url, 'https://a/sse')
  const [d] = parseMcpJson(`{ "url": "https://a/mcp" }`)
  assert.equal(d.transport, 'http')
  assert.equal(d.name, '')
})

test('认不出时给出能看懂的错误', () => {
  assert.throws(() => parseMcpJson(''), /先粘贴/)
  assert.throws(() => parseMcpJson('{ oops'), /JSON 格式不对/)
  assert.throws(() => parseMcpJson('{ "a": 1 }'), /没在 JSON 里找到/)
})
