import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import type { InstalledPackage } from '../../shared/cli-spec.ts'
import { getCli, type CliDefinition } from '../../shared/clis.ts'
import { t } from '../../shared/i18n.ts'
import { cliSettings } from '../../shared/settings.ts'
import { expandHome } from './extras.ts'
import { capture, childEnv } from '../exec/process.ts'
import { getSettings } from '../settings.ts'
import { galleryApi } from './gallery.ts'
import { configSettingsApi } from './config-settings.ts'
import { packageConfigApi } from '../package-config.ts'
import { clearQueriedCommands } from './commands.ts'
import { packageChangelog, packageDir, readManifest } from '../package-dirs.ts'

/**
 * CLI 自己的插件（扩展包，定义里的 packages）：列表直接读 CLI 的配置文件，装、删、更新跑 CLI 自己的命令，
 * 面板不另存一份，在终端里装的也能看到。
 */

type Def = CliDefinition & { packages: NonNullable<CliDefinition['packages']> }

/** file 不给时读用户级的配置；项目级的传项目里的配置文件（见 packages.local） */
export async function listPackages(def: Def, at?: string): Promise<InstalledPackage[]> {
  const file = at ?? expandHome(def.packages.file)
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
  // 读装着的版本（ADR 0050）：用来和 npm 上的最新版比；读不到（还没装完、装在别处）就不写
  await Promise.all(
    out.map(async (p) => {
      const v = (await readManifest(packageDir(def.packages, p)))?.version
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

export function packagesApi(deps: { projectPath: (id: string) => Promise<string> } = { projectPath: async () => '' }) {
  const app = new Hono()
  // 包里的资源开关、CLI 自带扩展的开关（ADR 0050 第四期）
  app.route('/', packageConfigApi())
  // 插件市场和已装包的最新版本（ADR 0050）
  app.route('/', galleryApi())
  // CLI 自己配置文件里的设置项（ADR 0050）
  app.route('/', configSettingsApi())
  const need = (id: string) => {
    const def = getCli(id)
    if (!def?.packages) throw new Error(t('这个 Agent 不支持插件'))
    return def as Def
  }
  // 已装的一个包的更新说明（ADR 0050 第四期）：没有就是 null
  app.get('/:id/packages/changelog', async (c) => {
    try {
      const def = need(c.req.param('id'))
      const p = (await listPackages(def)).find((x) => x.source === c.req.query('source'))
      return c.json(p ? await packageChangelog(def.packages, p) : null)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
  /**
   * 带 projectId 时是这个项目里的插件（packages.local，ADR 0050 第四期）：读项目的配置文件，
   * 装、删在项目目录里跑 CLI 的项目级命令。返回配置文件、工作目录和项目级命令；不支持项目级时报错
   */
  const scope = async (def: Def, projectId: string | undefined) => {
    if (!projectId) return { file: undefined, cwd: homedir(), local: undefined }
    const local = def.packages.local
    if (!local) throw new Error(t('这个 Agent 不支持项目里的插件'))
    const dir = await deps.projectPath(projectId)
    if (!dir) throw new Error(t('项目还没有设置目录'))
    return { file: path.join(dir, local.file), cwd: dir, local }
  }
  app.get('/:id/packages', async (c) => {
    try {
      const def = need(c.req.param('id'))
      return c.json(await listPackages(def, (await scope(def, c.req.query('projectId'))).file))
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
    let where: Awaited<ReturnType<typeof scope>>
    try {
      where = await scope(def, c.req.query('projectId'))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    const actions = where.local
      ? { install: where.local.install, remove: where.local.remove }
      : { install: p.install, remove: p.remove, update: p.update, updateAll: p.updateAll }
    const args = (actions as Record<string, string[] | undefined>)[String(body.action)]
    if (!args) return c.json({ error: t('不支持这个操作') }, 400)
    if (args.some((a) => a.includes('{source}')) && !source) return c.json({ error: t('先填包的来源') }, 400)
    const cs = cliSettings(await getSettings(), def.id)
    const r = await capture(
      cs.command,
      args.map((a) => a.replaceAll('{source}', source)),
      where.cwd,
      childEnv(packageCommandEnv(def, cs.env)),
      // npm、git 装包可能很久
      10 * 60_000,
    )
    const output = [r.stdout, r.stderr]
      .filter((x) => x.trim())
      .join('\n')
      .trim()
    const ok = r.code === 0 && !r.spawnError
    // 装删插件后「/」菜单里插件带的命令跟着变
    if (ok) clearQueriedCommands()
    return c.json({
      ok,
      output: ok
        ? output
        : r.spawnError ||
          (r.killed === 'timeout' ? t('命令超过 10 分钟没结束，已停止') : '') ||
          output ||
          t('命令失败（退出码 {code}）', { code: String(r.code) }),
      packages: await listPackages(def, where.file),
    })
  })
  return app
}
