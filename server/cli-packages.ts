import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { npmName, type InstalledPackage } from '../shared/cli-spec.ts'
import { getCli, type CliDefinition } from '../shared/clis.ts'
import { t } from '../shared/i18n.ts'
import { cliSettings } from '../shared/settings.ts'
import { expandHome } from './cli-extras.ts'
import { capture, childEnv } from './exec/process.ts'
import { getSettings } from './settings.ts'
import { galleryApi } from './cli-gallery.ts'
import { configSettingsApi } from './cli-config-settings.ts'

/**
 * CLI 自己的插件（扩展包，定义里的 packages）：列表直接读 CLI 的配置文件，装、删、更新跑 CLI 自己的命令，
 * 面板不另存一份，在终端里装的也能看到。
 */

type Def = CliDefinition & { packages: NonNullable<CliDefinition['packages']> }

export async function listPackages(def: Def): Promise<InstalledPackage[]> {
  const file = expandHome(def.packages.file)
  let data: any
  try {
    data = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // 没有配置文件就是一个都没装；文件坏了也按没装显示，CLI 自己会报这个错
    return []
  }
  const list: unknown[] = Array.isArray(data?.[def.packages.key]) ? data[def.packages.key] : []
  const out = list.flatMap((x) => {
    const source = typeof x === 'string' ? x : typeof (x as any)?.source === 'string' ? (x as any).source : ''
    if (!source) return []
    // 相对路径是相对配置文件写的，命令按自己的工作目录解析，要换成绝对路径才对得上
    const target = /^\.\.?([/\\]|$)/.test(source) ? path.resolve(path.dirname(file), source) : source
    return [{ source, target } as InstalledPackage]
  })
  // npm 来源的包读装着的版本（ADR 0050）：用来和 npm 上的最新版比；读不到（还没装完、装在别处）就不写
  const root = def.packages.npmRoot && expandHome(def.packages.npmRoot)
  if (root)
    await Promise.all(
      out.map(async (p) => {
        const name = npmName(p.source)
        if (!name) return
        const v = await readFile(path.join(root, name, 'package.json'), 'utf8')
          .then((t) => JSON.parse(t)?.version)
          .catch(() => undefined)
        if (typeof v === 'string' && v) p.version = v
      }),
    )
  return out
}

/**
 * 装、删、更新时交给命令的环境变量：CLI 平时的（含设置开关带的）在前，定义里装包专用的排在最后盖过它们。
 * Pi 的「离线运行」默认开着、带 PI_OFFLINE=1，pi update 在离线模式下什么都不做还照样退出码 0，
 * 用户点了「更新」看到成功、其实没更新
 */
export function packageCommandEnv(def: Def, env: { key: string; value: string }[]) {
  return [...env, ...Object.entries(def.packages.env).map(([key, value]) => ({ key, value }))]
}

export function packagesApi() {
  const app = new Hono()
  // 插件市场和已装包的最新版本（ADR 0050）
  app.route('/', galleryApi())
  // CLI 自己配置文件里的设置项（ADR 0050）
  app.route('/', configSettingsApi())
  const need = (id: string) => {
    const def = getCli(id)
    if (!def?.packages) throw new Error(t('这个 Agent 不支持插件'))
    return def as Def
  }
  app.get('/:id/packages', async (c) => {
    try {
      return c.json(await listPackages(need(c.req.param('id'))))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  // 装、删、更新：等命令跑完再回，失败时把输出交给页面显示
  app.post('/:id/packages', async (c) => {
    let def: Def
    try {
      def = need(c.req.param('id'))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    const body = (await c.req.json().catch(() => ({}))) as { action?: string; source?: string }
    const source = String(body.source ?? '').trim()
    const p = def.packages
    const args = { install: p.install, remove: p.remove, update: p.update, updateAll: p.updateAll }[
      body.action as 'install'
    ]
    if (!args) return c.json({ error: t('不支持这个操作') }, 400)
    if (args.some((a) => a.includes('{source}')) && !source) return c.json({ error: t('先填包的来源') }, 400)
    const cs = cliSettings(await getSettings(), def.id)
    const r = await capture(
      cs.command,
      args.map((a) => a.replaceAll('{source}', source)),
      homedir(),
      childEnv(packageCommandEnv(def, cs.env)),
      // npm、git 装包可能很久
      10 * 60_000,
    )
    const output = [r.stdout, r.stderr]
      .filter((x) => x.trim())
      .join('\n')
      .trim()
    const ok = r.code === 0 && !r.spawnError
    return c.json({
      ok,
      output: ok
        ? output
        : r.spawnError ||
          (r.killed === 'timeout' ? t('命令超过 10 分钟没结束，已停止') : '') ||
          output ||
          t('命令失败（退出码 {code}）', { code: String(r.code) }),
      packages: await listPackages(def),
    })
  })
  return app
}
