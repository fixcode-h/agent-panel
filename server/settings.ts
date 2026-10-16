import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Settings } from '../shared/schema.ts'
import { defaultSettings } from '../shared/settings.ts'

const DATA_DIR = process.env.AGENT_PANEL_DATA ?? path.resolve('data')
const FILE = path.join(DATA_DIR, 'settings.json')
let cache: Settings | null = null

export async function getSettings(): Promise<Settings> {
  if (cache) return cache
  try {
    cache = Settings.parse(JSON.parse(await readFile(FILE, 'utf8')))
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
    cache = defaultSettings()
  }
  return cache
}

export async function saveSettings(s: Settings) {
  cache = s
  await mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(s, null, 2), 'utf8')
  await rename(tmp, FILE)
  return s
}
