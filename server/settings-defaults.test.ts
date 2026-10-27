import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 自动压缩的默认值从「按 Agent 自己的规则」（0）改成 70%：老设置里存着的 0 是旧默认值，读出来迁移成 70 并写回；
// 显式设过其他比例的保持不动。0 本身也是界面上的选项，所以迁移只按 defaultsVersion 做一次，
// 用户之后选回 0 不会被再改掉（见 shared/schema.ts 的 SETTINGS_DEFAULTS_VERSION）
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-settings-defaults-'))
process.env.AGENT_PANEL_DATA = dir
mkdirSync(dir, { recursive: true })
const file = path.join(dir, 'settings.json')
writeFileSync(file, JSON.stringify({ clis: { claude: { autoCompact: 0 }, codex: { autoCompact: 50 } } }), 'utf8')

const { AUTO_COMPACT_DEFAULT, CliSettings, SETTINGS_DEFAULTS_VERSION } = await import('../shared/schema.ts')
const { getSettings, saveSettings } = await import('./settings.ts')

test('没存过这一项时，自动压缩按新默认值 70%', () => {
  assert.equal(CliSettings.parse({}).autoCompact, 70)
})

test('自动压缩：旧默认值 0 迁移成 70，显式设过的 50 保持不动，写回带上迁移版本', async () => {
  const s = await getSettings()
  assert.equal(s.clis.claude.autoCompact, AUTO_COMPACT_DEFAULT, '旧默认值按默认值升级')
  assert.equal(s.clis.codex.autoCompact, 50, '显式设过的比例不迁移')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.clis.claude.autoCompact, AUTO_COMPACT_DEFAULT, '迁移写回设置文件')
  assert.equal(saved.defaultsVersion, SETTINGS_DEFAULTS_VERSION, '迁移过的设置记下版本，下次启动不再迁移')
})

test('迁移之后用户选回「按 Agent 自己的规则」不会被改回 70', async () => {
  const s = await getSettings()
  await saveSettings({
    ...s,
    clis: { ...s.clis, claude: { ...s.clis.claude, autoCompact: 0 } },
  })
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.clis.claude.autoCompact, 0, '用户显式选的 0 原样存下')
  assert.equal(saved.defaultsVersion, SETTINGS_DEFAULTS_VERSION, '保存设置时也记下当前版本')
})
