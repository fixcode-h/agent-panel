import { mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { CliSettings, SETTINGS_DEFAULTS_VERSION, Settings } from '../shared/schema.ts'
import { CLIS } from '../shared/clis.ts'
import { defaultSettings, migrateSettingsDefaults } from '../shared/settings.ts'

import { CACHE_DIR, dataPath, onReset, readJson, writeJsonAtomic } from './store.ts'
import { applyServerLang } from './lang.ts'
import { setApiLimits } from './api-slots.ts'

const FILE = dataPath('settings.json')
let cache: Settings | null = null
onReset(() => (cache = null))

export async function getSettings(): Promise<Settings> {
  if (cache) return cache
  const raw = await readJson(FILE)
  if (raw === undefined) {
    cache = freshSettings()
    return cache
  }
  const parsed = Settings.safeParse(raw)
  if (parsed.success) {
    const s = parsed.data
    // 旧设置里各项旧默认值的升级（与演示后端共用同一份迁移，见 shared/settings.ts）
    const dirty = migrateSettingsDefaults(s)
    // 写回只是把迁移落到文件，失败（只读目录、磁盘满）不能连累读取设置：内存里已经按新值用，
    // 下次启动还会再试一次，幂等
    if (dirty) {
      await writeJsonAtomic(FILE, s, false, 0o600).catch((e) =>
        console.warn(`设置项的默认值没能写回设置文件，按新默认值继续运行：${(e as Error).message}`),
      )
    }
    cache = s
    setApiLimits(s.apis)
    return cache
  }
  // JSON 没坏但字段不合法（手动改错、旧版本留下的值）：不能让每个依赖设置的接口都一直 500。
  // 备份原文件，按默认设置继续跑，用户可以从备份里找回原来填的内容
  const backup = path.join(CACHE_DIR, 'broken', `${path.basename(FILE)}.broken-${Date.now()}`)
  await mkdir(path.dirname(backup), { recursive: true }).catch(() => {})
  await rename(FILE, backup).catch(() => {})
  console.error(`设置文件内容不合法，已备份为 ${backup}，按默认设置处理：${parsed.error.message}`)
  cache = freshSettings()
  return cache
}

/**
 * 新装（还没有设置文件）时的设置：所有 CLI 都先不启用，由用户在设置里自己打开要用的。
 * 只写进新装的设置里，已有设置文件里没写 enabled 的 CLI 仍按启用处理，升级上来的用户不受影响
 */
function freshSettings(): Settings {
  const s = defaultSettings()
  return {
    ...s,
    defaultsVersion: SETTINGS_DEFAULTS_VERSION,
    clis: Object.fromEntries(CLIS.map((c) => [c.id, CliSettings.parse({ enabled: false })])),
  }
}

let writing: Promise<void> = Promise.resolve()

/** 连续保存时串行写，后一次总是覆盖前一次 */
export async function saveSettings(s: Settings) {
  // 用户保存过一次就视为已按新版默认值迁移：之后显式选回旧默认值（例如自动压缩的「按 Agent 自己的规则」）
  // 不会再被 getSettings 的迁移改掉
  s.defaultsVersion = SETTINGS_DEFAULTS_VERSION
  cache = s
  applyServerLang(s.language)
  // 并发上限调大或改成不限制：排着的对话和子任务马上放进去，不用等别人释放
  setApiLimits(s.apis)
  // 里面有 apis[].apiKey 和 clis[].env，只让当前用户读写
  const next = writing.catch(() => {}).then(() => writeJsonAtomic(FILE, s, false, 0o600))
  writing = next
  await next
  return s
}
