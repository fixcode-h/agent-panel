import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { getAt, readValue, setAt, writeValue, type ConfigValue } from '../shared/cli-config-settings.ts'
import { getCli } from '../shared/clis.ts'
import { t } from '../shared/i18n.ts'
import { expandHome } from './cli-extras.ts'
import { writeCliConfigJson } from './cli-config-write.ts'

/**
 * CLI 自己配置文件里的设置项（ADR 0050）：读的时候列出每项现在的值（没写过的不列，界面显示「跟随」）；
 * 改一项只动这一个键，别的键原样保留。文件在但读不出来（手写坏了）时不写，免得把用户别的设置冲掉
 */

type Read = { ok: true; data: Record<string, unknown> } | { ok: false; error: string }

export async function readConfig(file: string): Promise<Read> {
  if (!existsSync(file)) return { ok: true, data: {} }
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (data && typeof data === 'object' && !Array.isArray(data)) return { ok: true, data }
    return { ok: false, error: t('{file} 不是 JSON 对象', { file }) }
  } catch (e) {
    return { ok: false, error: t('{file} 读不出来：{error}', { file, error: (e as Error).message }) }
  }
}

/** 每项现在的值：id → 值（界面单位）；文件读不出来时带上原因 */
export async function readConfigSettings(cli: string) {
  const def = getCli(cli)
  const values: Record<string, ConfigValue> = {}
  const errors: string[] = []
  const cache = new Map<string, Read>()
  for (const s of def?.configSettings ?? []) {
    const file = expandHome(s.file)
    if (!cache.has(file)) cache.set(file, await readConfig(file))
    const r = cache.get(file)!
    if (!r.ok) {
      if (!errors.includes(r.error)) errors.push(r.error)
      continue
    }
    const v = readValue(s, getAt(r.data, s.at))
    if (v !== undefined) values[s.id] = v
  }
  return { values, error: errors.join('\n') }
}

/** 改一项；value 为 null 是恢复默认（删掉这个键） */
export async function writeConfigSetting(cli: string, id: string, value: unknown) {
  const s = getCli(cli)?.configSettings?.find((x) => x.id === id)
  if (!s) throw new Error(t('没有这个设置项'))
  const file = expandHome(s.file)
  const r = await readConfig(file)
  if (!r.ok) throw new Error(r.error)
  let raw: unknown
  if (value !== null) {
    const w = writeValue(s, value)
    if ('error' in w)
      throw new Error(
        w.error === 'range'
          ? t('要在 {min} 到 {max} 之间', { min: String(s.min ?? ''), max: String(s.max ?? '') })
          : t('值不对'),
      )
    raw = w.value
  }
  if (!setAt(r.data, s.at, raw))
    throw new Error(t('{file} 里 {at} 的上一级不是对象，没有改', { file: path.basename(file), at: s.at }))
  await mkdir(path.dirname(file), { recursive: true })
  await writeCliConfigJson(file, r.data)
}

export function configSettingsApi() {
  const app = new Hono()
  app.get('/:id/config', async (c) => c.json(await readConfigSettings(c.req.param('id'))))
  app.put('/:id/config', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { id?: string; value?: unknown }
    try {
      await writeConfigSetting(c.req.param('id'), String(b.id ?? ''), b.value ?? null)
      return c.json(await readConfigSettings(c.req.param('id')))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  return app
}
