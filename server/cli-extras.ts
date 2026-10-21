import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { CliLimits, CliSkill } from '../shared/schema.ts'
import { cliSettings } from '../shared/settings.ts'
import { getSettings } from './settings.ts'
import { codexLimits } from './exec/parsers.ts'
import { childEnv } from './exec/process.ts'
import { rpcQuery } from './exec/rpc/query.ts'
import { getCli } from '../shared/clis.ts'
import { RpcSpec } from '../shared/cli-spec.ts'
import { t } from '../shared/i18n.ts'

/**
 * CLI 的附加信息：账号额度、加载的 Skill。
 * 额度在执行中由 CLI 推送（Codex 的 account/rateLimits/updated、Claude Code 的 rate_limit_event），
 * 记在内存里；Codex 还能主动查（account/rateLimits/read），Claude Code 只有跑过一次才知道。
 */
const limits = new Map<string, CliLimits>()

export function setLimits(cli: string, l: CliLimits) {
  // 推送可能只带一部分窗口：和上次的合并，没带的窗口保留
  const prev = limits.get(cli)
  const windows = [...l.windows]
  for (const w of prev?.windows ?? []) if (!windows.some((x) => x.id === w.id)) windows.push(w)
  limits.set(cli, { ...prev, ...l, windows, plan: l.plan ?? prev?.plan })
}

/** 额度：能主动查的每次都去查一遍最新的；其他 CLI 给最近一次执行时收到的 */
export async function getLimits(cli: string): Promise<CliLimits | null> {
  const def = getCli(cli)
  if (def?.rpc?.limitsQuery) {
    const rpc = RpcSpec.parse(def.rpc)
    const s = cliSettings(await getSettings(), cli)
    const r = await rpcQuery({
      command: s.command,
      args: rpc.queryArgs,
      cwd: homedir(),
      env: childEnv(s.env),
      handshake: rpc.handshake,
      jsonrpc: rpc.jsonrpc,
      requests: [{ method: 'account/rateLimits/read', params: {} }],
    })
    const l = codexLimits(r[0]?.result?.rateLimits)
    if (l) setLimits(cli, l)
  }
  return limits.get(cli) ?? null
}

/** 配置里的目录：~ 是用户目录，${ENV:-默认值} 先取环境变量 */
export function expandHome(dir: string) {
  const d = dir.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, k: string, def = '') => process.env[k] || def)
  return d === '~' || d.startsWith('~/') ? path.join(homedir(), d.slice(1)) : path.resolve(d)
}

/** Skill 的元数据在 SKILL.md 开头的 front matter 里（name、description） */
async function readSkill(file: string, scope: string): Promise<CliSkill | null> {
  const text = await readFile(file, 'utf8').catch(() => '')
  if (!text) return null
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  const field = (k: string) =>
    fm
      .match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? ''
  return {
    name: field('name') || path.basename(path.dirname(file)),
    description: field('description'),
    scope,
    path: file,
    enabled: true,
  }
}

/** 一个目录下每个子目录一个 Skill（子目录里有 SKILL.md） */
async function scanDir(dir: string, scope: string): Promise<CliSkill[]> {
  if (!existsSync(dir)) return []
  const out: CliSkill[] = []
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => []))
    if (d.isDirectory() || d.isSymbolicLink()) {
      const s = await readSkill(path.join(dir, d.name, 'SKILL.md'), scope)
      if (s) out.push(s)
    }
  return out
}

/** Claude Code 装的插件里带的 Skill：~/.claude/plugins/ 下各插件的 skills 目录 */
async function claudePluginSkills(): Promise<CliSkill[]> {
  const root = path.join(homedir(), '.claude', 'plugins')
  const out: CliSkill[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > 5) return
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue
      const p = path.join(dir, d.name)
      if (d.name === 'skills') out.push(...(await scanDir(p, 'plugin')))
      else if (d.name !== 'node_modules' && !d.name.startsWith('.')) await walk(p, depth + 1)
    }
  }
  await walk(root, 0)
  return out
}

/** 用户目录下 .agents/skills 里共用的 Skill（面板自带的 Skill 也装在这里），不是哪个 CLI 自己的 */
export function isSharedSkill(s: CliSkill) {
  if (!s.path) return false
  const shared = path.join(homedir(), '.agents') + path.sep
  const p = path.resolve(s.path)
  return process.platform === 'win32' ? p.toLowerCase().startsWith(shared.toLowerCase()) : p.startsWith(shared)
}

/**
 * CLI 能用的 Skill：Codex 用 skills/list（含系统自带和插件的）；Claude Code 和 Command Code 读 Skill 目录
 * （用户目录下的、项目目录下的，Claude Code 另外读插件里的）。cwd 为空时只列用户级的。
 */
export async function listSkills(cli: string, cwd: string): Promise<CliSkill[]> {
  // 按 Skill 所在的目录分组：.agents 下共用的和 CLI 自己目录下的分开列
  const home = homedir()
  const source = (s: CliSkill): CliSkill => {
    if (s.scope === 'plugin' || !s.path) return s
    const dir = path.dirname(path.dirname(s.path))
    const rel = (base: string, prefix: string) =>
      dir === base || dir.startsWith(base + path.sep) ? prefix + dir.slice(base.length).replaceAll('\\', '/') : ''
    return { ...s, source: (cwd && rel(cwd, '.')) || rel(home, '~') || dir }
  }
  return (await rawSkills(cli, cwd)).map(source)
}

async function rawSkills(cli: string, cwd: string): Promise<CliSkill[]> {
  const def = getCli(cli)
  if (!def) throw new Error(t('未知的 CLI：{cli}', { cli }))
  if (def.rpc?.skillsQuery) {
    const rpc = RpcSpec.parse(def.rpc)
    const s = cliSettings(await getSettings(), cli)
    const r = await rpcQuery({
      command: s.command,
      args: rpc.queryArgs,
      cwd: cwd || homedir(),
      env: childEnv(s.env),
      handshake: rpc.handshake,
      jsonrpc: rpc.jsonrpc,
      requests: [{ method: 'skills/list', params: cwd ? { cwds: [cwd] } : {} }],
    })
    if (r[0]?.error) throw new Error(String(r[0].error.message ?? t('执行失败')))
    const seen = new Set<string>()
    return (r[0]?.result?.data ?? [])
      .flatMap((e: any) => e.skills ?? [])
      .filter((x: any) => x?.name && !seen.has(x.path) && seen.add(x.path))
      .map((x: any) => ({
        name: String(x.name),
        description: String(x.interface?.shortDescription ?? x.shortDescription ?? x.description ?? ''),
        scope: String(x.scope ?? ''),
        path: String(x.path ?? ''),
        enabled: x.enabled !== false,
      }))
  }
  // 定义里写的 Skill 目录：用户级的（~ 开头）和项目里的
  const dirs: [string, string][] = [
    ...def.skills.user.map((d): [string, string] => [expandHome(d), 'user']),
    ...(cwd ? def.skills.repo.map((d): [string, string] => [path.join(cwd, d), 'repo']) : []),
  ]
  const found = (await Promise.all(dirs.map(([d, scope]) => scanDir(d, scope)))).flat()
  // Claude Code 装的插件里也带 Skill
  if (def.rpc?.pluginSkills) found.push(...(await claudePluginSkills()))
  return found.sort(
    (a, b) => a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name),
  )
}
