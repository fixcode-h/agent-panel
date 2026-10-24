import { mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { CliSettings, Settings } from '../shared/schema.ts'
import { CLIS } from '../shared/clis.ts'
import { defaultSettings } from '../shared/settings.ts'

import { CACHE_DIR, dataPath, onReset, readJson, writeJsonAtomic } from './store.ts'
import { applyServerLang } from './lang.ts'

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
    // 后台命令的并发默认值从 16 提到 64：老设置里存着的正好是旧默认值，按「默认值升级」改掉，
    // 否则这次改动对老用户没有效果。显式设过其他值的保持不动
    if (s.backgroundLimit === 16) {
      s.backgroundLimit = 64
      // 写回只是把迁移落到文件，失败（只读目录、磁盘满）不能连累读取设置：内存里已经按 64 用，
      // 下次启动还会再试一次，幂等
      await writeJsonAtomic(FILE, s, false, 0o600).catch((e) =>
        console.warn(`后台命令并发的默认值没能写回设置文件，按 64 继续运行：${(e as Error).message}`),
      )
    }
    cache = s
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
  return { ...s, clis: Object.fromEntries(CLIS.map((c) => [c.id, CliSettings.parse({ enabled: false })])) }
}

let writing: Promise<void> = Promise.resolve()

/** 连续保存时串行写，后一次总是覆盖前一次 */
export async function saveSettings(s: Settings) {
  cache = s
  applyServerLang(s.language)
  // 里面有 apis[].apiKey 和 clis[].env，只让当前用户读写
  const next = writing.catch(() => {}).then(() => writeJsonAtomic(FILE, s, false, 0o600))
  writing = next
  await next
  return s
}
