import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 语言设成「自动」时，页面回报浏览器识别出的语言（browserLang），服务端按它定交给 Agent 的回复语言；
// 设置页保存时不带这个字段，不能把它冲掉，否则又退回系统 locale（这里的系统语言是英文，冲掉就会变成英文）
const dir = mkdtempSync(path.join(tmpdir(), 'agent-panel-settings-browser-lang-'))
process.env.AGENT_PANEL_DATA = dir
process.env.LANG = 'en_US.UTF-8'

const { getSettings, saveSettings } = await import('./settings.ts')
const { getLang } = await import('../shared/i18n.ts')
const { replyLang } = await import('../shared/prompt-lang.ts')

test('自动语言：回报的浏览器语言写进设置并生效，设置页保存不带它时沿用', async () => {
  const s = await getSettings()
  assert.equal(s.language, 'auto')
  await saveSettings({ ...s, browserLang: 'zh' })
  assert.equal(getLang(), 'zh')
  assert.equal(replyLang(), 'zh', '交给 Agent 的是识别出的中文，不是「自动」')
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')).browserLang, 'zh')

  const { browserLang: _drop, ...fromSettingsPage } = await getSettings()
  const saved = await saveSettings({ ...fromSettingsPage, userName: '小明' })
  assert.equal(saved.browserLang, 'zh')
  assert.equal(replyLang(), 'zh')
})
