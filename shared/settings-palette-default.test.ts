import assert from 'node:assert/strict'
import test from 'node:test'
import { Settings } from './schema.ts'
import { migrateSettingsDefaults } from './settings.ts'

// 默认配色从「Claude」换成「Claude Code」、界面英文字体从 Inter 换成系统字体（defaultsVersion 2），再换成 Maple Mono NL（3）：
// 存着旧默认值的老设置升级一次；已经是版本 2 的设置里再选回 Claude / Inter 不能被改掉，
// 版本 1 里用户显式选的自动压缩 0 也不能因为这次升版被版本 1 的迁移再改一遍

test('新装的设置默认是 Claude Code 配色、Maple Mono NL 配思源黑体', () => {
  const s = Settings.parse({})
  assert.equal(s.appearance.palette, 'code')
  assert.equal(s.appearance.uiFont, 'maple')
  assert.equal(s.appearance.cjkFont, 'noto')
})

test('版本 1 的老设置：Claude 配色和 Inter 升级成新默认，别的配色和自动压缩 0 不动', () => {
  const s = Settings.parse({
    defaultsVersion: 1,
    appearance: { palette: 'claude', uiFont: 'inter' },
    clis: { claude: { autoCompact: 0 } },
  })
  assert.equal(migrateSettingsDefaults(s), true)
  assert.equal(s.appearance.palette, 'code')
  // 版本 2 把 Inter 换成系统字体，版本 3 再把系统字体换成 Maple Mono NL
  assert.equal(s.appearance.uiFont, 'maple')
  assert.equal(s.clis.claude.autoCompact, 0, '版本 1 之后用户选的 0 不再迁移')
  assert.equal(s.defaultsVersion, 4)

  const other = Settings.parse({ defaultsVersion: 1, appearance: { palette: 'ocean', uiFont: 'maple' } })
  migrateSettingsDefaults(other)
  assert.equal(other.appearance.palette, 'ocean', '显式选过的其他配色不动')
  assert.equal(other.appearance.uiFont, 'maple')
})

test('升过版本之后再选回 Claude 配色和 Inter，不会被改掉', () => {
  const s = Settings.parse({ defaultsVersion: 4, appearance: { palette: 'claude', uiFont: 'inter' } })
  assert.equal(migrateSettingsDefaults(s), false)
  assert.equal(s.appearance.palette, 'claude')
  assert.equal(s.appearance.uiFont, 'inter')
})

// 默认字体换成 Maple Mono NL 配思源黑体（defaultsVersion 3）
test('版本 2 的老设置：系统字体升级成 Maple Mono NL 和思源黑体，字距跟着换成 Maple 的默认值', () => {
  const s = Settings.parse({
    defaultsVersion: 2,
    appearance: { uiFont: 'system', cjkFont: 'system', letterSpacing: 0, wordSpacing: 0 },
  })
  assert.equal(migrateSettingsDefaults(s), true)
  assert.equal(s.appearance.uiFont, 'maple')
  assert.equal(s.appearance.cjkFont, 'noto')
  assert.equal(s.appearance.letterSpacing, -0.02)
  assert.equal(s.appearance.wordSpacing, -0.2)
  assert.equal(s.defaultsVersion, 4)
})

test('版本 2 里显式选的其他字体和调过的字距不动', () => {
  const s = Settings.parse({
    defaultsVersion: 2,
    appearance: { uiFont: 'inter', cjkFont: 'system', letterSpacing: 0.01, wordSpacing: 0 },
  })
  migrateSettingsDefaults(s)
  assert.equal(s.appearance.uiFont, 'inter')
  assert.equal(s.appearance.letterSpacing, 0.01)
  assert.equal(s.appearance.wordSpacing, 0)
  // 中文字体没有「显式选系统字体」和「旧默认值」之分，按旧默认值升一次
  assert.equal(s.appearance.cjkFont, 'noto')

  const sys = Settings.parse({ defaultsVersion: 2, appearance: { uiFont: 'system', letterSpacing: 0.03 } })
  migrateSettingsDefaults(sys)
  assert.equal(sys.appearance.letterSpacing, 0.03, '调过的字间距不动')
})

test('升过版本 3 之后再选回系统字体，不会被改掉', () => {
  const s = Settings.parse({ defaultsVersion: 4, appearance: { uiFont: 'system', cjkFont: 'system' } })
  assert.equal(migrateSettingsDefaults(s), false)
  assert.equal(s.appearance.uiFont, 'system')
  assert.equal(s.appearance.cjkFont, 'system')
})

// 正文行高默认值 1.75 → 1.65（defaultsVersion 4）
test('版本 3 的老设置：行高还是旧默认 1.75 的升到 1.65，调过的不动', () => {
  const s = Settings.parse({ defaultsVersion: 3, appearance: { lineHeight: 1.75 } })
  assert.equal(migrateSettingsDefaults(s), true)
  assert.equal(s.appearance.lineHeight, 1.65)
  assert.equal(s.defaultsVersion, 4)

  const custom = Settings.parse({ defaultsVersion: 3, appearance: { lineHeight: 1.9 } })
  migrateSettingsDefaults(custom)
  assert.equal(custom.appearance.lineHeight, 1.9)

  assert.equal(Settings.parse({}).appearance.lineHeight, 1.65, '新装的默认就是 1.65')
})

test('升过版本 4 之后再调回 1.75，不会被改掉', () => {
  const s = Settings.parse({ defaultsVersion: 4, appearance: { lineHeight: 1.75 } })
  assert.equal(migrateSettingsDefaults(s), false)
  assert.equal(s.appearance.lineHeight, 1.75)
})
