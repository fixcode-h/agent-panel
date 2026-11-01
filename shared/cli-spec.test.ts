/**
 * MCP 配置模板的占位符填充：内建地址、定义里的 vars，以及不能被误伤的部分（未知占位符、`${...}` 插值）；
 * 以及 Claude Code、Codex 从 JSON 配置编出来的启动参数。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CliSpec, McpSpec, mcpConfig, mcpExtras, packageIdentity } from './cli-spec.ts'
import { getCli, type BuildOptions } from './clis.ts'

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
        option: 'extra',
        args: ['-e', '{dir}/extra-{name}.ts'],
        files: { '{dir}/extra-{name}.ts': 'const base = {url}' },
      },
    ],
  })
  // 没传 options（例如 UI 设计那一轮）当关着：不加参数，也不写文件
  assert.deepEqual(mcpExtras(s, 'panel', 'http://u/mcp', '/d'), { args: [], files: [] })
  assert.deepEqual(mcpExtras(s, 'panel', 'http://u/mcp', '/d', { extra: false }), { args: [], files: [] })
  assert.deepEqual(mcpExtras(s, 'panel', 'http://u/mcp', '/d', { extra: true }), {
    args: ['-e', '/d/extra-panel.ts'],
    files: [{ path: '/d/extra-panel.ts', content: 'const base = http://u/mcp' }],
  })
})

test('Claude Code、Codex 的配置：权限映射、只留配置类额外参数、分叉截点、角色说明按是否写成文件选参数', () => {
  const o = (x: Partial<BuildOptions>): BuildOptions => ({ model: '', permission: '', extraArgs: [], ...x })
  const codex = getCli('codex')!
  const c = codex.buildArgs(
    o({ permission: 'danger-full-access', systemPrompt: '说明', extraArgs: ['--foo', 'x', '-c', 'k=v', '--enable=f'] }),
  )
  assert.ok(c.includes('sandbox_mode="danger-full-access"') && c.includes('approval_policy="never"'))
  // app-server 只认配置类参数：设置里按 codex exec 写的其他参数丢掉；角色说明走协议，不加参数
  assert.deepEqual(c.slice(-3), ['-c', 'k=v', '--enable=f'])
  assert.ok(!c.includes('--foo') && !c.includes('说明'))
  assert.ok(codex.buildArgs(o({})).includes('sandbox_mode="workspace-write"'))
  assert.ok(codex.buildArgs(o({ permission: 'read-only' })).includes('approval_policy="on-request"'))

  const claude = getCli('claude')!
  const a = claude.buildArgs(
    o({ resume: 's1', fork: { end: 'u9' }, systemPrompt: '/tmp/p.md', systemPromptFile: true }),
  )
  assert.deepEqual(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 5), [
    '--resume',
    's1',
    '--fork-session',
    '--resume-session-at',
    'u9',
  ])
  assert.ok(a.includes('--append-system-prompt-file') && !a.includes('--append-system-prompt'))
  const b = claude.buildArgs(o({ systemPrompt: '短说明', permission: 'bypassPermissions', noEdit: true }))
  assert.equal(b[b.indexOf('--append-system-prompt') + 1], '短说明')
  // 跳过确认时也要保留提问通道；还没开独立分支时连改文件的工具一起关掉
  assert.ok(b.includes('--dangerously-skip-permissions') && b.includes('--permission-prompt-tool'))
  const noEdit = b[b.indexOf('--disallowedTools') + 1].split(',')
  for (const x of ['Task', 'Agent', 'Monitor', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
    assert.ok(noEdit.includes(x), x)
  // 和面板机制重复的内置工具不管哪种对话都关；编辑 ipynb、只读规划要退出时用的工具留着
  const d = claude.buildArgs(o({}))
  const off = d[d.indexOf('--disallowedTools') + 1].split(',')
  for (const x of [
    'Workflow',
    'SendMessage',
    'EnterWorktree',
    'EnterPlanMode',
    'CronCreate',
    'ScheduleWakeup',
    'ReportFindings',
  ])
    assert.ok(off.includes(x) && noEdit.includes(x), x)
  for (const x of ['NotebookEdit', 'Edit', 'ExitPlanMode', 'AskUserQuestion', 'ToolSearch'])
    assert.ok(!off.includes(x), x)
  // 面板不自己做联网搜索：Claude Code 自带的搜索、打开网页不管哪种对话都得留着
  for (const x of ['WebSearch', 'WebFetch']) assert.ok(!off.includes(x) && !noEdit.includes(x), x)
})

test('插件来源去掉版本号再比：装的是带版本的、带 ref 的，也认得是推荐里的那一个', () => {
  assert.equal(packageIdentity('npm:pi-web-access@0.46.0'), 'npm:pi-web-access')
  assert.equal(packageIdentity('npm:pi-web-access'), 'npm:pi-web-access')
  // 作用域包名自己带 @，只去掉名字后面的版本
  assert.equal(packageIdentity('npm:@narumitw/pi-lsp@^0.49'), 'npm:@narumitw/pi-lsp')
  assert.equal(packageIdentity('npm:@narumitw/pi-lsp'), 'npm:@narumitw/pi-lsp')
  assert.equal(packageIdentity('git:github.com/x/y@v1'), 'git:github.com/x/y')
  assert.equal(packageIdentity('https://github.com/x/y.git'), 'git:github.com/x/y')
  assert.notEqual(packageIdentity('npm:pi-web-search'), packageIdentity('npm:pi-web-access'))
  // 本机目录原样比
  assert.equal(packageIdentity('../local-pkg'), '../local-pkg')
})

test('推荐的插件：Pi 第一项是联网搜索插件；每个 CLI 推荐里的文案都有英文', () => {
  const pi = getCli('pi')!
  assert.equal(pi.packages?.recommended[0]?.source, 'npm:pi-web-access', '面板不自己做联网搜索，Pi 靠插件联网')
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clis')
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const spec = CliSpec.parse(JSON.parse(readFileSync(path.join(dir, f), 'utf8')))
    const en = spec.i18n.en ?? {}
    for (const r of spec.packages?.recommended ?? []) {
      assert.match(r.source, /^(npm|git):/, `${f}：推荐的 ${r.source} 要写 npm: 或 git: 来源`)
      for (const text of [r.name, r.desc, r.note].filter(Boolean)) assert.ok(en[text], `${f}：「${text}」没有英文`)
    }
  }
})
