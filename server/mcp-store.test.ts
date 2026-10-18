import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readToml, writeToml } from './mcp-store.ts'
import { convertCommand } from './library.ts'
import { McpServer } from '../shared/library.ts'

const store = {
  file: '',
  format: 'toml',
  key: 'mcp_servers',
  urlKey: 'url',
  remoteType: '',
  stdioType: false,
  headersKey: 'http_headers',
} as const

const sample = `model = "gpt-5"

# 手写的注释要留着
[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp", "--flag"]

[mcp_servers.docs.env]
TOKEN = "abc"

[mcp_servers."web search"]
url = "https://example.com/mcp"
http_headers = { Authorization = "Bearer x" }

[profiles.a]
model = "x"
`

test('读 Codex 的 config.toml 里的 MCP 工具', () => {
  const r = readToml(sample, store)
  assert.deepEqual(r.docs.args, ['-y', 'docs-mcp', '--flag'])
  assert.deepEqual(r.docs.env, { TOKEN: 'abc' })
  assert.equal(r['web search'].transport, 'http')
  assert.deepEqual(r['web search'].headers, { Authorization: 'Bearer x' })
})

test('改写、删除只动这个工具，别的内容原样保留', () => {
  const sv = McpServer.parse({ name: 'docs', transport: 'stdio', command: 'node', args: ['a b'], env: { K: 'v' } })
  const next = writeToml(sample, store, sv, 'docs')
  assert.ok(next.includes('# 手写的注释要留着'))
  assert.ok(next.includes('[profiles.a]'))
  const r = readToml(next, store)
  assert.equal(r.docs.command, 'node')
  assert.deepEqual(r.docs.args, ['a b'])
  assert.equal(r['web search'].url, 'https://example.com/mcp')
  const gone = writeToml(next, store, null, 'docs')
  assert.equal(readToml(gone, store).docs, undefined)
  assert.ok(gone.includes('model = "gpt-5"'))
})

test('命令在 md 和 toml 之间转换', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lib-'))
  const md = path.join(dir, 'a.md')
  await writeFile(md, '---\ndescription: 提交\n---\n看改动 $ARGUMENTS\n')
  const toml = await convertCommand(md, 'md', 'toml')
  assert.ok(toml.includes('{{args}}'))
  const f = path.join(dir, 'a.toml')
  await writeFile(f, toml)
  const back = await convertCommand(f, 'toml', 'md')
  assert.ok(back.includes('description: "提交"') && back.includes('$ARGUMENTS'))
})
