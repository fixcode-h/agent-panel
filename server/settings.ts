import { CliSettings, Settings } from '../shared/schema.ts'
import { CLIS } from '../shared/clis.ts'
import { defaultSettings } from '../shared/settings.ts'

import { dataPath, onReset, readJson, writeJsonAtomic } from './store.ts'
import { applyServerLang } from './lang.ts'

const FILE = dataPath('settings.json')
let cache: Settings | null = null
onReset(() => (cache = null))

export async function getSettings(): Promise<Settings> {
  if (cache) return cache
  const raw = await readJson(FILE)
  cache = raw === undefined ? freshSettings() : Settings.parse(raw)
  return cache
}

/**
 * 新装（还没有设置文件）时的设置：所有 CLI 都先不启用，由用户在设置里自己打开要用的。
 * 只写进新装的设置里，已有设置文件里没写 enabled 的 CLI 仍按启用处理，升级上来的用户不受影响
 */
function freshSettings(): Settings {
  const s = defaultSettings()
  return { ...s, clis: Object.fromEntries(CLIS.map((c) => [c.id, CliSettings.parse({ enabled: false })])) }
}

let writing: Promise<void> = Promise.resolve()

/** 连续保存时串行写，后一次总是覆盖前一次 */
export async function saveSettings(s: Settings) {
  cache = s
  applyServerLang(s.language)
  const next = writing.catch(() => {}).then(() => writeJsonAtomic(FILE, s))
  writing = next
  await next
  return s
}
