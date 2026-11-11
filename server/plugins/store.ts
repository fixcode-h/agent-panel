import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BUILTIN_AGENTS } from '../../shared/builtin/agents.ts'
import { BUILTIN_WORKFLOWS } from '../../shared/builtin/workflows.ts'
import { extendDict } from '../../shared/i18n.ts'
import {
  PLUGIN_API,
  PluginManifest,
  PluginSource,
  type PluginManifest as Manifest,
} from '../../shared/plugins/types.ts'
import { hostModulesError, missingHostModules } from '../../shared/plugins/host-modules-check.ts'
import { DATA_DIR } from '../store.ts'
import { safeRel, type ZipEntry } from './zip.ts'

/**
 * 本机装着的插件（ADR 0059）：数据目录 plugins/<id>/ 是插件包（plugin.json 在根上），
 * 安装记录（从哪装的、什么时候）写在包里的 .install.json。开发时可以「链接」一个本机目录：
 * plugins/<id>.link.json 记着目录，不复制，改了重新加载就生效。插件自己的数据放 plugin-data/<id>/，删除时一起删。
 */
export const PLUGINS_DIR = path.join(DATA_DIR, 'plugins')
export const pluginDataDir = (id: string) => path.join(DATA_DIR, 'plugin-data', id)
const RECORD = '.install.json'
const linkFile = (id: string) => path.join(PLUGINS_DIR, `${id}.link.json`)
/**
 * 升级前的那一版（插件框架改进 B4）：plugins/.prev/<id>/，新版本有问题时「退回上一版」换回来。
 * 目录名带点，listInstalled 不会把它当成插件
 */
const prevDir = (id: string) => path.join(PLUGINS_DIR, '.prev', id)

export interface Installed {
  manifest: Manifest
  dir: string
  source: PluginSource
  installedAt: string
  /** 包里的技能名（skills/<分类>/<名字>/SKILL.md） */
  skills: string[]
  /** 这一版是从哪个版本升级来的（覆盖安装时记下），新装、链接的目录为空 */
  previousVersion: string
  /** 能退回的上一版的版本号（plugins/.prev/<id>/ 在），没有为空 */
  rollback: string
}

/** 上一版的版本号：目录在、清单读得出来才算能退回 */
async function prevVersion(id: string) {
  const raw = await readFile(path.join(prevDir(id), 'plugin.json'), 'utf8').catch(() => '')
  try {
    return raw ? String(JSON.parse(raw).version ?? '') : ''
  } catch {
    return ''
  }
}

/** 包里的技能名 */
async function skillNames(dir: string) {
  const out: string[] = []
  for (const cat of await readdir(path.join(dir, 'skills'), { withFileTypes: true }).catch(() => [])) {
    if (!cat.isDirectory()) continue
    for (const s of await readdir(path.join(dir, 'skills', cat.name), { withFileTypes: true }).catch(() => []))
      if (s.isDirectory() && existsSync(path.join(dir, 'skills', cat.name, s.name, 'SKILL.md'))) out.push(s.name)
  }
  return out
}

/** 和插件接口的固定路径（/api/plugins/market 等）撞名的 id */
const RESERVED = ['market', 'install', 'mcp', 'core', 'panel']

/** 清单校验：格式、接口版本、和核心内置模板的 key 撞没撞（插件的副本按 builtin:<key> 认，撞了会互相覆盖） */
export function parseManifest(raw: unknown): Manifest {
  const p = PluginManifest.safeParse(raw)
  if (!p.success)
    throw new Error(`plugin.json 格式不对：${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`)
  const m = p.data as unknown as Manifest
  if (RESERVED.includes(m.id)) throw new Error(`插件 id 不能用 ${m.id}`)
  if (m.api > PLUGIN_API) throw new Error(`插件要求更新的面板（插件接口 ${m.api}，当前 ${PLUGIN_API}），请先升级面板`)
  const missing = hostModulesError(missingHostModules(m))
  if (missing) throw new Error(missing)
  const agentHit = m.agents.find((a) => BUILTIN_AGENTS.some((b) => b.key === a.key))
  if (agentHit) throw new Error(`插件的角色 key「${agentHit.key}」和面板内置角色重名`)
  const wfHit = m.workflows.find((w) => BUILTIN_WORKFLOWS.some((b) => b.key === w.key))
  if (wfHit) throw new Error(`插件的工作流 key「${wfHit.key}」和面板内置工作流重名`)
  for (const f of [m.server, m.web, m.css]) if (f && !safeRel(f)) throw new Error(`入口路径不对：${f}`)
  // 钩子脚本、命令文件也只能在包里（插件接口 3）
  for (const f of [...m.hooks.map((h) => h.script), ...m.commands.map((c) => c.file)])
    if (f && !safeRel(f)) throw new Error(`包里的文件路径不对：${f}`)
  return m
}

async function readPackage(dir: string): Promise<Manifest> {
  const raw = JSON.parse(await readFile(path.join(dir, 'plugin.json'), 'utf8'))
  const m = parseManifest(raw)
  // 英文词典：界面文案按中文原文查，包里没有的退回中文
  const en = await readFile(path.join(dir, 'locales', 'en.json'), 'utf8').catch(() => '')
  if (en) extendDict('en', JSON.parse(en))
  return m
}

/** 列出装着的插件；读不出来的（目录坏了、清单不对）放进 broken，插件页上提示可以删 */
export async function listInstalled() {
  const ok: Installed[] = []
  const broken: { id: string; error: string }[] = []
  const names = await readdir(PLUGINS_DIR, { withFileTypes: true }).catch(() => [])
  for (const e of names) {
    let dir = ''
    let rec: { source: PluginSource; installedAt: string; previousVersion?: string }
    let id = e.name
    try {
      if (e.isFile() && e.name.endsWith('.link.json')) {
        id = e.name.slice(0, -'.link.json'.length)
        const link = JSON.parse(await readFile(path.join(PLUGINS_DIR, e.name), 'utf8'))
        dir = String(link.dir)
        rec = { source: PluginSource.parse(link.source), installedAt: String(link.installedAt) }
      } else if (e.isDirectory() && !e.name.includes('.')) {
        dir = path.join(PLUGINS_DIR, e.name)
        const r = JSON.parse(await readFile(path.join(dir, RECORD), 'utf8').catch(() => '{}'))
        rec = {
          source: PluginSource.safeParse(r.source).data ?? { kind: 'dir', ref: dir },
          installedAt: String(r.installedAt ?? ''),
          previousVersion: typeof r.previousVersion === 'string' ? r.previousVersion : '',
        }
      } else continue
      const manifest = await readPackage(dir)
      if (manifest.id !== id) throw new Error(`目录名 ${id} 和插件 id ${manifest.id} 不一致`)
      ok.push({
        manifest,
        dir,
        ...rec,
        previousVersion: rec.previousVersion ?? '',
        rollback: e.isDirectory() ? await prevVersion(id) : '',
        skills: await skillNames(dir),
      })
    } catch (err) {
      broken.push({ id, error: (err as Error).message })
    }
  }
  return { ok, broken }
}

/** 从一组文件（zip 解出来的）里找插件包的根：指定的子目录、根目录，或者唯一的顶层目录（GitHub 源码包都包一层） */
export function packageRoot(files: ZipEntry[], sub = '') {
  const has = (prefix: string) => files.some((f) => f.name === `${prefix}plugin.json`)
  const clean = sub.replace(/^\/+|\/+$/g, '')
  const tops = [...new Set(files.map((f) => f.name.split('/')[0]))]
  const cands = clean
    ? [`${clean}/`, ...(tops.length === 1 ? [`${tops[0]}/${clean}/`] : [])]
    : ['', ...(tops.length === 1 ? [`${tops[0]}/`] : [])]
  const root = cands.find(has)
  if (root === undefined) throw new Error(clean ? `${clean} 下没有 plugin.json` : '包里没有 plugin.json')
  return root
}

/** 已装的那一版的版本号（覆盖安装时记成新版本的 previousVersion） */
async function currentVersion(dir: string) {
  return String(JSON.parse(await readFile(path.join(dir, 'plugin.json'), 'utf8').catch(() => '{}')).version ?? '')
}

/**
 * 把包里的文件写进 plugins/<id>/：先写临时目录再换掉旧的，中途失败不留半个插件。
 * 旧的那一版不删，挪到 plugins/.prev/<id>/ 留着退回用（只留一版）
 */
export async function writePackage(id: string, files: ZipEntry[], root: string, source: PluginSource) {
  const dest = path.join(PLUGINS_DIR, id)
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`
  await rm(tmp, { recursive: true, force: true })
  for (const f of files) {
    if (!f.name.startsWith(root)) continue
    const rel = f.name.slice(root.length)
    if (!rel || !safeRel(rel)) continue
    const full = path.join(tmp, ...rel.split('/'))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, f.data)
  }
  const previousVersion = existsSync(dest) ? await currentVersion(dest).catch(() => '') : ''
  await writeFile(
    path.join(tmp, RECORD),
    JSON.stringify({ source, installedAt: new Date().toISOString(), previousVersion }, null, 2),
  )
  if (existsSync(dest)) {
    await rm(prevDir(id), { recursive: true, force: true })
    await mkdir(path.dirname(prevDir(id)), { recursive: true })
    await rename(dest, prevDir(id))
  }
  await rename(tmp, dest)
  await rm(linkFile(id), { force: true })
}

/**
 * 退回上一版（插件框架改进 B4）：现在这版和 plugins/.prev/<id>/ 对换，所以退回后还能再「退回」到刚才那版。
 * 安装时间换成现在：服务端入口、网页入口按安装时间区分模块地址，不换会拿到缓存里的新版本
 */
export async function rollbackPackage(id: string) {
  const dest = path.join(PLUGINS_DIR, id)
  const prev = prevDir(id)
  if (!existsSync(path.join(prev, 'plugin.json'))) throw new Error('没有可以退回的上一版')
  const swap = `${dest}.swap-${process.pid}-${Date.now()}`
  await rename(dest, swap)
  await rename(prev, dest)
  await rename(swap, prev)
  const rec = JSON.parse(await readFile(path.join(dest, RECORD), 'utf8').catch(() => '{}'))
  await writeFile(
    path.join(dest, RECORD),
    JSON.stringify(
      { ...rec, installedAt: new Date().toISOString(), previousVersion: await currentVersion(prev).catch(() => '') },
      null,
      2,
    ),
  )
}

/** 链接本机目录（开发用）：不复制，记下目录 */
export async function linkPackage(id: string, dir: string) {
  await mkdir(PLUGINS_DIR, { recursive: true })
  await rm(path.join(PLUGINS_DIR, id), { recursive: true, force: true })
  await writeFile(
    linkFile(id),
    JSON.stringify({ dir, source: { kind: 'dir', ref: dir }, installedAt: new Date().toISOString() }, null, 2),
  )
}

/** 删掉包和插件自己的数据 */
export async function removePackage(id: string) {
  await rm(path.join(PLUGINS_DIR, id), { recursive: true, force: true })
  await rm(prevDir(id), { recursive: true, force: true })
  await rm(linkFile(id), { force: true })
  await rm(pluginDataDir(id), { recursive: true, force: true })
}
