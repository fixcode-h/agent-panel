import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 用户显式把后台命令并发设成 16 以外的值时，读取设置不能按「默认值升级」改掉它，也不该改写文件
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-settings-migrate-keep-'))
process.env.AGENT_PANEL_DATA = dir
mkdirSync(dir, { recursive: true })
const file = path.join(dir, 'settings.json')
const raw = JSON.stringify({ backgroundLimit: 32 })
writeFileSync(file, raw, 'utf8')

const { getSettings } = await import('./settings.ts')

test('后台命令并发：显式设过其他值（32）保持不动，也不改写设置文件', async () => {
  const s = await getSettings()
  assert.equal(s.backgroundLimit, 32, '只有旧默认值 16 才迁移')
  assert.equal(readFileSync(file, 'utf8'), raw, '不需要迁移时不写盘')
})
