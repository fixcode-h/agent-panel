// 按项目存数据的统一入口（server/project-data/index.ts）：共享目录在文档根/AgentPanel/<名字>，本机目录在数据目录，名字不许跳出目录，写入是原子的
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'pdata-'))
const { initProjectData, projectData } = await import('./index.ts')

test('shared 跟文档根走，没有文档根退回项目 docs；local 在数据目录；名字不合法直接拒绝；write 原子写入', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdata-proj-'))
  let root: string | undefined = path.join(dir, 'ProjectDoc', 'docs')
  initProjectData({
    getProject: async (id) => (id === 'p1' ? ({ id, path: dir } as never) : undefined),
    docRoot: async () => root,
  })
  const d = await projectData('p1', 'Tables')
  assert.equal(d.shared, path.join(dir, 'ProjectDoc', 'docs', 'AgentPanel', 'Tables'))
  assert.ok(d.local.startsWith(process.env.AGENT_PANEL_DATA!))
  root = undefined
  assert.equal((await projectData('p1', 'UE')).shared, path.join(dir, 'docs', 'AgentPanel', 'UE'))
  await assert.rejects(projectData('p1', '../x'), /不合法/)
  await assert.rejects(projectData('nope', 'UE'), /没有这个项目/)
  const f = path.join(d.local, 'a.json')
  await d.write(f, { a: 1 })
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { a: 1 })
  assert.deepEqual(readdirSync(d.local), ['a.json'], '没有留下临时文件')
})
