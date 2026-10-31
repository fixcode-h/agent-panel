import assert from 'node:assert/strict'
import test from 'node:test'
import { Settings } from './schema.ts'
import { migrateSettingsDefaults } from './settings.ts'

// 默认配色从「Claude」换成「Claude Code」、界面英文字体从 Inter 换成系统字体（defaultsVersion 2）：
// 存着旧默认值的老设置升级一次；已经是版本 2 的设置里再选回 Claude / Inter 不能被改掉，
// 版本 1 里用户显式选的自动压缩 0 也不能因为这次升版被版本 1 的迁移再改一遍

test('新装的设置默认是 Claude Code 配色和系统字体', () => {
  const s = Settings.parse({})
  assert.equal(s.appearance.palette, 'code')
  assert.equal(s.appearance.uiFont, 'system')
})

test('版本 1 的老设置：Claude 配色和 Inter 升级成新默认，别的配色和自动压缩 0 不动', () => {
  const s = Settings.parse({
    defaultsVersion: 1,
    appearance: { palette: 'claude', uiFont: 'inter' },
    clis: { claude: { autoCompact: 0 } },
  })
  assert.equal(migrateSettingsDefaults(s), true)
  assert.equal(s.appearance.palette, 'code')
  assert.equal(s.appearance.uiFont, 'system')
  assert.equal(s.clis.claude.autoCompact, 0, '版本 1 之后用户选的 0 不再迁移')
  assert.equal(s.defaultsVersion, 2)

  const other = Settings.parse({ defaultsVersion: 1, appearance: { palette: 'ocean', uiFont: 'maple' } })
  migrateSettingsDefaults(other)
  assert.equal(other.appearance.palette, 'ocean', '显式选过的其他配色不动')
  assert.equal(other.appearance.uiFont, 'maple')
})

test('升过版本之后再选回 Claude 配色和 Inter，不会被改掉', () => {
  const s = Settings.parse({ defaultsVersion: 2, appearance: { palette: 'claude', uiFont: 'inter' } })
  assert.equal(migrateSettingsDefaults(s), false)
  assert.equal(s.appearance.palette, 'claude')
  assert.equal(s.appearance.uiFont, 'inter')
})
