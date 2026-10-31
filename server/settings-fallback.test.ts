import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 数据目录换成临时的；文件是合法 JSON，但字段不合法（负的超时时间），
// 旧代码会让所有依赖设置的接口一直 500
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-settings-'))
process.env.AGENT_PANEL_DATA = dir
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ stepTimeoutMinutes: -1 }), 'utf8')

const { getSettings } = await import('./settings.ts')

test('设置字段不合法：备份到 broken/，按默认设置继续跑', async () => {
  const s = await getSettings()
  assert.equal(s.stepTimeoutMinutes, 0, '回退到默认设置')

  const broken = path.join(dir, 'broken')
  assert.ok(existsSync(broken), '备份目录存在')
  assert.ok(
    readdirSync(broken).some((f) => f.startsWith('settings.json.broken-')),
    '原文件已备份',
  )
  assert.equal(existsSync(path.join(dir, 'settings.json')), false, '坏文件移走后不会一直触发失败')
})
