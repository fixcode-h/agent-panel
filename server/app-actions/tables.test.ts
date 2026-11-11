/**
 * Agent 的表格动作：经表格页同一套接口查行、按主键改格子、末尾加行；结构检查不过时不写。
 * 用真实的 /tables 接口和临时目录里的 CSV（数据目录也指到临时目录，备份写在那里）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.AGENT_PANEL_DATA = mkdtempSync(path.join(tmpdir(), 'agent-panel-table-actions-data-'))
const { Hono } = await import('hono')
const { tablesApi } = await import('../tables/routes.ts')
const { runAppAction, setActionHost } = await import('./index.ts')
const { callApi } = await import('./registry.ts')

const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-table-actions-'))
mkdirSync(path.join(dir, 'Config'))
const file = path.join(dir, 'Config', 'Item.csv')
writeFileSync(file, 'uint32,string,Quality\nID,Name,Q\n1,木剑,Common\n2,铁剑,Rare\n')
mkdirSync(path.join(dir, '.agentpanel', 'tables'), { recursive: true })
writeFileSync(
  path.join(dir, '.agentpanel', 'tables', 'enums.json'),
  JSON.stringify({ Quality: { values: [{ name: 'Common' }, { name: 'Rare' }] } }),
)
const project = { id: 'p1', name: 'g', path: dir, tables: { dirs: ['Config'] } }
const app = new Hono().route('/api/tables', tablesApi({ projects: { get: async () => project as never } }))
setActionHost({ api: (m, p, b) => callApi((r) => app.fetch(r), m, p, b), ui: () => 0 })
const caller = { taskId: 't', projectId: 'p1', parentTaskId: '' }

test('查：按字段名返回行和主键字段', async () => {
  const r = await runAppAction('table.query', { path: 'Config/Item.csv', where: { Q: 'Rare' } }, caller)
  assert.ok(r.ok)
  const v = r.result as { key: string; rows: { row: number; values: Record<string, string> }[] }
  assert.equal(v.key, 'ID')
  assert.deepEqual(v.rows, [{ row: 4, values: { ID: '2', Name: '铁剑', Q: 'Rare' } }])
})

test('改：枚举值不对时不写；对了按主键写进去，文件其它内容不变', async () => {
  const bad = await runAppAction(
    'table.edit',
    { path: 'Config/Item.csv', set: [{ key: '1', values: { Q: 'Epic' } }] },
    caller,
  )
  assert.equal(bad.ok, false)
  assert.match((bad as { error: string }).error, /不符合表格结构[\s\S]*Epic/)
  assert.match(readFileSync(file, 'utf8'), /1,木剑,Common/)
  const ok = await runAppAction(
    'table.edit',
    {
      path: 'Config/Item.csv',
      set: [{ key: '1', values: { Q: 'Rare' } }],
      add: [{ ID: '3', Name: '木盾', Q: 'Common' }],
    },
    caller,
  )
  assert.ok(ok.ok, JSON.stringify(ok))
  assert.equal(
    readFileSync(file, 'utf8'),
    'uint32,string,Quality\nID,Name,Q\n1,木剑,Rare\n2,铁剑,Rare\n3,木盾,Common\n',
  )
})
