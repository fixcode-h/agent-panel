import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import type { CliPackages } from '../../shared/cli-spec.ts'
import { getCli } from '../../shared/clis.ts'
import { t } from '../../shared/i18n.ts'
import { builtinState, resourceState, setBuiltin, setResource } from '../../shared/package-config.ts'
import { expandHome } from '../cli/extras.ts'
import { readConfig } from '../cli/config-settings.ts'
import { writeCliConfigJson } from '../cli/config-write.ts'
import { packageDir, readManifest } from './dirs.ts'

/**
 * 插件的细项开关（ADR 0050 第四期）：包里按类型开关资源、CLI 自带扩展的开关。都只改配置文件里相关的那一项，
 * 文件读不出来（手写坏了）时不写。规则和纯函数在 shared/package-config.ts
 */

type Spec = CliPackages

/** 这个包里有哪些类型的资源：manifest 里写了非空列表，或者有同名目录 */
export async function packageTypes(spec: Spec, dir: string): Promise<string[]> {
  const r = spec.resources
  if (!r || !dir) return []
  const own = (await readManifest(dir))?.[r.manifestKey]
  return Object.keys(r.types).filter((type) => {
    const v = own && typeof own === 'object' ? own[type] : undefined
    if (Array.isArray(v)) return v.length > 0
    return existsSync(path.join(dir, type))
  })
}

const need = (id: string) => {
  const def = getCli(id)
  if (!def?.packages) throw new Error(t('这个 Agent 不支持插件'))
  return def as typeof def & { packages: Spec }
}

async function load(file: string) {
  const r = await readConfig(file)
  if (!r.ok) throw new Error(r.error)
  return r.data
}

export function packageConfigApi() {
  const app = new Hono()
  // 一个包里各类资源：有哪些、现在开没开
  app.get('/:id/packages/resources', async (c) => {
    try {
      const def = need(c.req.param('id'))
      const spec = def.packages
      const source = c.req.query('source') ?? ''
      const data = await load(expandHome(spec.file))
      const list: unknown[] = Array.isArray(data[spec.key]) ? (data[spec.key] as unknown[]) : []
      const entry = list.find((e) => (typeof e === 'string' ? e : (e as { source?: string } | null)?.source) === source)
      if (entry === undefined) return c.json({ error: t('没有装这个插件') }, 404)
      // 相对路径的来源按配置文件所在目录算（和 listPackages 一样）
      const target = /^\.\.?([/\\]|$)/.test(source) ? path.resolve(path.dirname(expandHome(spec.file)), source) : source
      const types = await packageTypes(spec, packageDir(spec, { source, target }))
      const on = resourceState(entry, types)
      return c.json(types.map((type) => ({ type, label: spec.resources!.types[type], on: on[type] })))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  app.put('/:id/packages/resources', async (c) => {
    try {
      const def = need(c.req.param('id'))
      const spec = def.packages
      const b = (await c.req.json().catch(() => ({}))) as { source?: string; type?: string; on?: boolean }
      if (!spec.resources || !b.type || !(b.type in spec.resources.types)) return c.json({ error: t('值不对') }, 400)
      const file = expandHome(spec.file)
      const data = await load(file)
      const list: unknown[] = Array.isArray(data[spec.key]) ? (data[spec.key] as unknown[]) : []
      if (!setResource(list, String(b.source ?? ''), b.type, !!b.on)) return c.json({ error: t('没有装这个插件') }, 404)
      data[spec.key] = list
      await writeCliConfigJson(file, data)
      return c.json({ ok: true })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  // CLI 自带扩展的开关
  app.get('/:id/builtins', async (c) => {
    try {
      const spec = need(c.req.param('id')).packages
      if (!spec.builtins) return c.json({})
      const data = await load(expandHome(spec.file))
      return c.json(builtinState(data[spec.builtins.key], spec.builtins))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  app.put('/:id/builtins', async (c) => {
    try {
      const spec = need(c.req.param('id')).packages
      const b = (await c.req.json().catch(() => ({}))) as { id?: string; on?: boolean }
      if (!spec.builtins?.items.some((x) => x.id === b.id)) return c.json({ error: t('值不对') }, 400)
      const file = expandHome(spec.file)
      const data = await load(file)
      data[spec.builtins.key] = setBuiltin(data[spec.builtins.key], spec.builtins, b.id!, !!b.on)
      await mkdir(path.dirname(file), { recursive: true })
      await writeCliConfigJson(file, data)
      return c.json(builtinState(data[spec.builtins.key], spec.builtins))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  return app
}
