// 插件用的自建工具入口（server/custom-tools/host.ts）：只列项目工具；起工具时按参数展开、进程输出由调用方接；参数不对、工具不在直接报错
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'ctool-host-'))
const { initProjectData } = await import('../project-data/index.ts')
const { projectTools, spawnProjectTool } = await import('./host.ts')
const { GLOBAL_TOOLS_DIR } = await import('./store.ts')

const tool = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, name: `工具 ${id}`, run: { command: 'echo {{filelist}}' }, ...extra })

test('列项目工具（不含全局的），起工具时按参数展开并交回进程', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ctool-host-proj-'))
  initProjectData({
    getProject: async (id) => (id === 'p1' ? ({ id, path: dir } as never) : undefined),
    docRoot: async () => undefined,
  })
  const tools = path.join(dir, 'docs', 'AgentPanel', 'Tools')
  mkdirSync(tools, { recursive: true })
  writeFileSync(
    path.join(tools, 'lua-inc.json'),
    tool('lua-inc', {
      params: [{ name: 'filelist', type: 'path', required: true }],
      output: { errorPattern: '(?<file>\\S+):(?<line>\\d+): (?<msg>.*)' },
    }),
  )
  writeFileSync(path.join(tools, 'broken.json'), '{')
  mkdirSync(GLOBAL_TOOLS_DIR, { recursive: true })
  writeFileSync(path.join(GLOBAL_TOOLS_DIR, 'only-here.json'), tool('only-here'))

  const r = await projectTools('p1')
  assert.deepEqual(
    r.tools.map((x) => x.id),
    ['lua-inc'],
  )
  assert.equal(r.tools[0].params[0].name, 'filelist')
  assert.match(r.tools[0].errorPattern ?? '', /<msg>/)
  assert.equal(r.broken.length, 1)

  const s = await spawnProjectTool('p1', 'lua-inc', { filelist: 'Saved/list.txt' }, { source: 'test', title: 't' })
  assert.match(s.line, /Saved\/list\.txt/)
  let out = ''
  s.child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
  const code = await new Promise((res) => s.child.on('close', res))
  assert.equal(code, 0)
  assert.match(out, /Saved\/list\.txt/)

  await assert.rejects(spawnProjectTool('p1', 'lua-inc', {}, { source: 'test', title: 't' }), /缺参数 filelist/)
  await assert.rejects(spawnProjectTool('p1', 'only-here', {}, { source: 'test', title: 't' }), /没有 id 为 only-here/)
})
