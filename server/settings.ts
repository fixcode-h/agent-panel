import { Settings } from '../shared/schema.ts'
import { defaultSettings } from '../shared/settings.ts'

import { dataPath, onReset, readJson, writeJsonAtomic } from './store.ts'
import { applyServerLang } from './lang.ts'

const FILE = dataPath('settings.json')
let cache: Settings | null = null
onReset(() => (cache = null))

export async function getSettings(): Promise<Settings> {
  if (cache) return cache
  const raw = await readJson(FILE)
  cache = raw === undefined ? defaultSettings() : Settings.parse(raw)
  return cache
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
