/**
 * 插件带的钩子、「/」命令接进面板（插件接口 3）：装一个本机目录插件，打开后钩子在对话里触发、
 * 命令出现在「/」菜单并由面板展开；关掉插件后都撤掉。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-plugin-contrib-'))
process.env.AGENT_PANEL_DATA = dir

const pkg = path.join(dir, 'plugins', 'demo')
mkdirSync(path.join(pkg, 'hooks'), { recursive: true })
mkdirSync(path.join(pkg, 'commands'), { recursive: true })
writeFileSync(
  path.join(pkg, 'plugin.json'),
  JSON.stringify({
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    api: 3,
    server: 'server.mjs',
    hooks: [
      { id: 'compile', name: '写后编译', event: 'tool.after', match: { tool: 'edit', path: '**/*.uasset' } },
      {
        id: 'lock',
        name: '锁文件',
        event: 'tool.before',
        match: { tool: 'edit', path: '*.lock' },
        script: 'hooks/lock.mjs',
      },
    ],
    commands: [{ name: 'demo-check', description: '检查一下', file: 'commands/check.md' }],
  }),
)
writeFileSync(path.join(pkg, '.install.json'), JSON.stringify({ source: { kind: 'dir', ref: pkg }, installedAt: 'x' }))
// 服务端入口的 hook()：写了蓝图就把「编译」的结果补给模型
writeFileSync(
  path.join(pkg, 'server.mjs'),
  `export default () => ({ hook: (id, input) => id === 'compile' ? { context: '编译出错：' + input.tool.input.file_path } : undefined })`,
)
writeFileSync(
  path.join(pkg, 'hooks', 'lock.mjs'),
  `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{process.stdout.write(JSON.stringify({deny:true,reason:'锁文件不能手改'}))})`,
)
writeFileSync(path.join(pkg, 'commands', 'check.md'), '---\ndescription: 检查\n---\n把 $ARGUMENTS 检查一遍')

const { setLang } = await import('../../shared/i18n.ts')
const { Task, ProjectInput } = await import('../../shared/schema.ts')
const { hookOptions } = await import('../hooks/dispatch.ts')
const { resetHooksCache, setBuiltin } = await import('../hooks/store.ts')
const { initPlugins, updatePlugin } = await import('./manager.ts')
const { listCommands, expandSlash } = await import('../slash.ts')
const { stopPlugin } = await import('./runtime.ts')

setLang('zh')
const listed = await import('./store.ts').then((m) => m.listInstalled())
assert.equal(listed.broken.length, 0, JSON.stringify(listed.broken))

await initPlugins({
  state: async () => ({ agents: [], workflows: [], categories: [], tags: [] }),
  projects: async () => [],
  categories: async () => [],
  ops: {} as never,
  deleteAgent: async () => undefined,
  deleteWorkflow: async () => undefined,
})

const project = { ...ProjectInput.parse({ name: 'p', path: dir }), id: 'p1' } as never
const at = '2026-11-11T00:00:00.000Z'
const ctx = () => ({
  task: Task.parse({
    id: 't1',
    projectId: 'p1',
    title: 't',
    mode: 'chat',
    status: 'running',
    createdAt: at,
    updatedAt: at,
  }) as never,
  project,
  agent: { id: 'a1', name: '执行', origin: '' },
  agents: [],
  cliId: 'claude',
  cwd: dir,
  call: { agentId: 'a1', prompt: '', sessionKey: 'a1', orch: { helper: false, coordinator: false } } as never,
  mark: () => {},
})
const edit = (file: string) => ({
  tool: { kind: 'edit' as const, name: 'Edit', input: { file_path: file }, path: file, paths: [file] },
})

test('插件关着：没有它的钩子和命令', async () => {
  resetHooksCache()
  const o = await hookOptions(ctx())
  assert.ok(
    !o.hookEvents?.includes('tool.after') || !(await o.onHook!('tool.after', edit(path.join(dir, 'A.uasset')))).context,
  )
  assert.ok(!(await listCommands('claude', '')).some((c) => c.name === 'demo-check'))
})

test('插件打开：服务端 hook() 和包里的脚本都在对话里触发，命令进「/」菜单并由面板展开', async () => {
  await updatePlugin('demo', { enabled: true })
  resetHooksCache()
  const o = await hookOptions(ctx())
  assert.ok(o.hookEvents?.includes('tool.after'))
  assert.ok(o.hookTools?.['tool.after']?.includes('edit'))
  const after = await o.onHook!('tool.after', edit(path.join(dir, 'Content', 'BP.uasset')))
  assert.match(after.context ?? '', /编译出错：.*BP\.uasset/)
  // 路径对不上的不跑
  assert.ok(!(await o.onHook!('tool.after', edit(path.join(dir, 'a.ts')))).context)
  const before = await o.onHook!('tool.before', edit(path.join(dir, 'yarn.lock')))
  assert.equal(before.deny, true)
  assert.match(before.reason ?? '', /锁文件不能手改/)

  const cmd = (await listCommands('claude', '')).find((c) => c.name === 'demo-check')
  assert.ok(cmd)
  assert.match(cmd.source ?? '', /Demo/)
  // Claude Code 自己认「/命令」，但插件命令只有面板认识：照样由面板展开
  assert.equal(await expandSlash('/demo-check 登录页', 'claude', '', true), '把 登录页 检查一遍')
})

test('设置里单独关掉一个插件钩子，只撤这一个', async () => {
  await setBuiltin('plugin:demo:compile', false, true)
  const o = await hookOptions(ctx())
  assert.ok(!(await o.onHook!('tool.after', edit(path.join(dir, 'BP.uasset')))).context)
  assert.equal((await o.onHook!('tool.before', edit(path.join(dir, 'yarn.lock')))).deny, true)
  await setBuiltin('plugin:demo:compile', true, true)
})

test('插件关掉：钩子和命令一起撤掉', async () => {
  await updatePlugin('demo', { enabled: false })
  resetHooksCache()
  const o = await hookOptions(ctx())
  if (o.onHook) {
    assert.ok(!(await o.onHook('tool.after', edit(path.join(dir, 'BP.uasset')))).context)
    assert.ok(!(await o.onHook('tool.before', edit(path.join(dir, 'yarn.lock')))).deny)
  }
  assert.ok(!(await listCommands('claude', '')).some((c) => c.name === 'demo-check'))
  await stopPlugin('demo')
})
