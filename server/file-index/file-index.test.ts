import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 落盘目录换成临时目录：要在 import 存储模块之前设好
const data = mkdtempSync(path.join(tmpdir(), 'fi-data-'))
process.env.AGENT_PANEL_DATA = data
const root = mkdtempSync(path.join(tmpdir(), 'fi-proj-'))
const put = (rel: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), '')
}
for (const f of [
  'README.md',
  'Source/Game/Player.cpp',
  'Source/Game/Player.h',
  'Saved/Logs/Game.log',
  'Content/UI/WBP_Main.uasset',
])
  put(f)

const { initFileIndex, projectIndex, statusOf, touchFiles, closeAll } = await import('./registry.ts')
const { fileIndexRun } = await import('./agent-tool.ts')
const { listIndexFiles } = await import('./store.ts')

const project = { id: 'p1', name: '测试', path: root, searchExclude: ['Saved'] } as never
const pushes: string[] = []
let askDelay = 0
const slow = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), askDelay))
initFileIndex({
  getProject: async (id) => (id === 'p1' ? project : undefined),
  listProjects: async () => [project],
  docRoot: () => slow(undefined),
  pluginRoots: () => slow([]),
  push: (id, s) => pushes.push(`${id}:${s.state}`),
})

after(() => {
  closeAll()
  rmSync(root, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

test('第一次用时建好：排除目录不收，按名字找、按文件夹取', async () => {
  const idx = (await projectIndex('p1'))!
  assert.ok(await idx.ready(10_000))
  assert.deepEqual(
    idx.find('player').map((h) => h.path),
    ['Source/Game/Player.h', 'Source/Game/Player.cpp'],
  )
  assert.equal(idx.find('game.log').length, 0, 'Saved 是排除目录')
  assert.deepEqual(await idx.list('Content/UI'), { files: ['Content/UI/WBP_Main.uasset'], dirs: [] })
  const s = (await statusOf('p1'))!
  assert.equal(s.state, 'ready')
  assert.equal(s.files, 4)
})

test('面板写了文件：touch 返回时已经能查到；外面删的文件 refresh 后没了', async () => {
  const idx = (await projectIndex('p1'))!
  put('Source/Game/Enemy.cpp')
  await touchFiles([path.join(root, 'Source/Game/Enemy.cpp')], 'panel')
  assert.deepEqual(
    idx.find('enemy').map((h) => h.path),
    ['Source/Game/Enemy.cpp'],
  )
  rmSync(path.join(root, 'Source/Game/Player.h'))
  // 目录修改时间的精度：同一毫秒内改两次时核对可能看不出来，等一下再删
  const r = await idx.refresh('Source')
  assert.ok(r.checked >= 1)
  assert.deepEqual(
    idx.find('player').map((h) => h.path),
    ['Source/Game/Player.cpp'],
  )
})

test('file_index 工具：找到的给相对路径，没找到时说明排除目录', async () => {
  const run = fileIndexRun({ projectId: 'p1', projectPath: root, workDir: root, exclude: ['Saved'] })
  const hit = await run({ action: 'find', query: 'wbp' })
  assert.match(hit.text, /Content\/UI\/WBP_Main\.uasset/)
  const miss = await run({ action: 'find', query: 'game.log' })
  assert.match(miss.text, /没找到/)
  assert.match(miss.text, /Saved/)
  const ls = await run({ action: 'list', dir: 'Source/Game' })
  assert.match(ls.text, /Source\/Game\/Enemy\.cpp/)
  const bad = await run({ action: 'list', dir: 'Saved' })
  assert.ok(bad.error)
})

test('file_index：没找到时先按目录核对再查，面板外刚生成的文件也能找到', async () => {
  const run = fileIndexRun({ projectId: 'p1', projectPath: root, workDir: root, exclude: ['Saved'] })
  put('Content/UI/WBP_Shop.uasset')
  const r = await run({ action: 'find', query: 'wbp_shop' })
  assert.match(r.text, /WBP_Shop\.uasset/)
  assert.match(r.text, /已按目录核对一遍/)
})

test('文档根、插件目录问得慢（P4 项目）：只在第一次等，之后的查询不再现问', async () => {
  closeAll()
  askDelay = 1500
  const t0 = Date.now()
  await projectIndex('p1')
  assert.ok(Date.now() - t0 >= 1400, '第一次要问')
  const run = fileIndexRun({ projectId: 'p1', projectPath: root, workDir: root, exclude: ['Saved'] })
  const t1 = Date.now()
  const hit = await run({ action: 'find', query: 'enemy' })
  assert.match(hit.text, /Enemy\.cpp/)
  assert.ok(Date.now() - t1 < 1000, `查一次用了 ${Date.now() - t1}ms`)
  askDelay = 0
})

test('落盘：关掉后重新打开从盘上读回，不用重建', async () => {
  const idx = (await projectIndex('p1'))!
  await idx.rebuild()
  closeAll()
  assert.equal((await listIndexFiles()).length, 1)
  const again = (await projectIndex('p1'))!
  assert.ok(await again.ready(10_000))
  assert.deepEqual(
    again.find('enemy').map((h) => h.path),
    ['Source/Game/Enemy.cpp'],
  )
})
