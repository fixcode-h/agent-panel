import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 老设置里存着后台命令并发的旧默认值 16：读出来按「默认值升级」改成 64 并写回；
// childConcurrency 是已经去掉的子对话并发上限，读到时忽略，不能让设置解析失败
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-settings-migrate-'))
process.env.AGENT_PANEL_DATA = dir
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ backgroundLimit: 16, childConcurrency: 5 }), 'utf8')

const { getSettings } = await import('./settings.ts')

test('后台命令并发：旧默认值 16 迁移成 64，已删掉的 childConcurrency 忽略', async () => {
  const s = await getSettings()
  assert.equal(s.backgroundLimit, 64, '旧默认值按默认值升级')
  assert.ok(!('childConcurrency' in s), '已去掉的子对话并发设置读到时忽略')
  const saved = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  assert.equal(saved.backgroundLimit, 64, '迁移写回设置文件，下次启动就是新默认值')
  assert.equal(saved.childConcurrency, undefined, '写回时不再保留已经删掉的字段')
})
