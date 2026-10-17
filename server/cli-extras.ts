import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { CliLimits, CliSkill } from '../shared/schema.ts'
import { cliSettings } from '../shared/settings.ts'
import { getSettings } from './settings.ts'
import { codexLimits } from './exec/parsers.ts'
import { childEnv, runProcess } from './exec/process.ts'
import { getCli } from '../shared/clis.ts'
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

/** 额度：Codex 每次都去查一遍最新的；其他 CLI 给最近一次执行时收到的 */
export async function getLimits(cli: string): Promise<CliLimits | null> {
  if (cli === 'codex') {
    const s = cliSettings(await getSettings(), cli)
    const r = await codexRpc(s.command, childEnv(s.env), homedir(), [{ method: 'account/rateLimits/read', params: {} }])
    const l = codexLimits(r[0]?.rateLimits)
    if (l) setLimits(cli, l)
  }
  return limits.get(cli) ?? null
}

/** 起一个 codex app-server，按顺序发几个请求，全部回来后停掉；回答出错的位置是 undefined */
async function codexRpc(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  reqs: { method: string; params: object }[],
) {
  const ac = new AbortController()
  const out: any[] = []
  let got = 0
  let error = ''
  const line = (o: object) => JSON.stringify(o) + '\n'
  const r = await runProcess({
    command,
    args: ['app-server'],
    cwd,
    env,
    signal: ac.signal,
    timeoutMs: 20_000,
    keepStdinOpen: true,
    stdin:
      line({ id: 0, method: 'initialize', params: { clientInfo: { name: 'agent-panel', version: '1' } } }) +
      line({ method: 'initialized' }) +
      reqs.map((q, i) => line({ id: i + 1, ...q })).join(''),
    onLine: (l) => {
      let m: any
      try {
        m = JSON.parse(l)
      } catch {
        return
      }
      if (typeof m.id !== 'number' || m.id < 1 || m.method) return
      out[m.id - 1] = m.error ? undefined : m.result
      if (m.error) error = String(m.error.message ?? '')
      if (++got >= reqs.length) ac.abort()
    },
  })
  if (got < reqs.length) {
    if (r.spawnError) throw new Error(r.spawnError)
    throw new Error(error || r.stderr.trim().split('\n').at(-1) || t('Codex 没有返回'))
  }
  return out
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

/**
 * CLI 能用的 Skill：Codex 用 skills/list（含系统自带和插件的）；Claude Code 和 Command Code 读 Skill 目录
 * （用户目录下的、项目目录下的，Claude Code 另外读插件里的）。cwd 为空时只列用户级的。
 */
export async function listSkills(cli: string, cwd: string): Promise<CliSkill[]> {
  const def = getCli(cli)
  if (!def) throw new Error(t('未知的 CLI：{cli}', { cli }))
  if (cli === 'codex') {
    const s = cliSettings(await getSettings(), cli)
    const r = await codexRpc(s.command, childEnv(s.env), cwd || homedir(), [
      { method: 'skills/list', params: cwd ? { cwds: [cwd] } : {} },
    ])
    const seen = new Set<string>()
    return (r[0]?.data ?? [])
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
  const home = homedir()
  const dirs: [string, string][] =
    cli === 'claude'
      ? [
          [path.join(home, '.claude', 'skills'), 'user'],
          ...(cwd ? [[path.join(cwd, '.claude', 'skills'), 'repo'] as [string, string]] : []),
        ]
      : [
          [path.join(home, '.commandcode', 'skills'), 'user'],
          [path.join(home, '.agents', 'skills'), 'user'],
          ...(cwd
            ? ([
                [path.join(cwd, '.commandcode', 'skills'), 'repo'],
                [path.join(cwd, '.agents', 'skills'), 'repo'],
              ] as [string, string][])
            : []),
        ]
  const found = (await Promise.all(dirs.map(([d, scope]) => scanDir(d, scope)))).flat()
  if (cli === 'claude') found.push(...(await claudePluginSkills()))
  return found.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name))
}
