/**
 * MCP 配置模板的占位符填充：内建地址、定义里的 vars，以及不能被误伤的部分（未知占位符、`${...}` 插值）。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { McpSpec, mcpConfig, mcpExtras } from './cli-spec.ts'

const spec = McpSpec.parse({
  args: ['-e', '{dir}/agent-panel-{name}.ts'],
  files: {
    '{dir}/x-{name}.ts':
      'const t = {stepTimeout}\nconst a = {attempts}\nconst s = `${what}等了`\nconst c = {constructor}\n',
  },
  vars: { stepTimeout: 4000, attempts: 2 },
})

test('mcpConfig：内建占位符和 vars 一起填，未知占位符和 ${} 插值原样保留', () => {
  const out = mcpConfig(spec, 'panel', 'http://127.0.0.1:1/mcp', '/run')
  assert.deepEqual(out.args, ['-e', '/run/agent-panel-panel.ts'])
  assert.deepEqual(out.files, [
    {
      path: '/run/x-panel.ts',
      content: 'const t = 4000\nconst a = 2\nconst s = `${what}等了`\nconst c = {constructor}\n',
    },
  ])
})

test('mcpConfig：调用方覆盖 vars 只影响这一次，定义里的生产值不变', () => {
  const out = mcpConfig(spec, 'panel', 'http://x/mcp', '/d', { stepTimeout: 300 })
  assert.match(String(out.files[0].content), /const t = 300\n/)
  assert.match(String(out.files[0].content), /const a = 2\n/)
  assert.equal(spec.vars.stepTimeout, 4000)
})

test('mcpConfig：${} 里的名字即使和 vars 同名也不替换（模板里是 TS 插值）', () => {
  const s = McpSpec.parse({ files: { 'a.ts': '`${what}等了`' }, vars: { what: '坏了' } })
  assert.equal(mcpConfig(s, 'n', 'u').files[0].content, '`${what}等了`')
})

test('mcpConfig：内建占位符不会被 vars 顶掉', () => {
  const s = McpSpec.parse({ files: { 'a.ts': '{name}-{url}-{dir}' }, vars: { name: 'x', url: 'y', dir: 'z' } })
  assert.equal(mcpConfig(s, 'panel', 'http://u', '/d').files[0].content, 'panel-http://u-/d')
})

test('mcpConfig：${} 里的内建占位符也不替换（模板里是 TS 插值）', () => {
  const s = McpSpec.parse({ files: { 'a.ts': '`${name}`{name}`${dir}`' } })
  assert.equal(mcpConfig(s, 'panel', 'http://u', '/d').files[0].content, '`${name}`panel`${dir}`')
})

test('mcpExtras：开关打开时才注入额外的扩展文件和参数，关着时一个都不写', () => {
  const s = McpSpec.parse({
    extras: [
      {
        option: 'webSearch',
        args: ['-e', '{dir}/extra-{name}.ts'],
        files: { '{dir}/extra-{name}.ts': 'const base = {url}' },
      },
    ],
  })
  // 没传 options（例如 UI 设计那一轮）当关着：不加参数，也不写文件
  assert.deepEqual(mcpExtras(s, 'panel', 'http://u/mcp', '/d'), { args: [], files: [] })
  assert.deepEqual(mcpExtras(s, 'panel', 'http://u/mcp', '/d', { webSearch: false }), { args: [], files: [] })
  assert.deepEqual(mcpExtras(s, 'panel', 'http://u/mcp', '/d', { webSearch: true }), {
    args: ['-e', '/d/extra-panel.ts'],
    files: [{ path: '/d/extra-panel.ts', content: 'const base = http://u/mcp' }],
  })
})
