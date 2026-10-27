import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CliSkill, SlashCommand } from '../shared/schema.ts'
import { expandHome, listSkills } from './cli-extras.ts'
import { getCli } from '../shared/clis.ts'
import { builtinPrompt, fillCommand } from '../shared/commands.ts'
import { t } from '../shared/i18n.ts'
import { DATA_DIR } from './store.ts'

/**
 * 输入框里的「/」命令：列出 CLI 自己带的命令和 Skill、「所有 Agent」共用的命令，发出去之前按 CLI 展开。
 * 会话里认识「/命令」的 CLI（定义里 slash 为 true，例如 Claude Code）自己的命令原样发过去；其他的由面板
 * 把命令文件的内容、Skill 的说明展开成普通的要求再发。命令和 Skill 的目录写在 CLI 的定义里。
 * 「所有 Agent」的命令和内置命令（shared/commands.ts）对哪个 CLI 都由面板展开，所以每个 Agent 都能用。
 */

interface Found extends SlashCommand {
  path: string
  /** 「所有 Agent」共用的命令（数据目录的 commands/，md 格式） */
  panel?: boolean
}

/** 「所有 Agent」共用的命令放在数据目录里，不属于哪个 CLI */
export const panelCommandDir = () => path.join(DATA_DIR, 'commands')

/** front matter 里的一个字段 */
const field = (fm: string, k: string) =>
  fm
    .match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, '') ?? ''

const splitFrontMatter = (text: string) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  return { fm: m?.[1] ?? '', body: m ? text.slice(m[0].length) : text }
}

/** TOML 里的一个字符串字段（命令文件只用到 description、prompt 两个） */
function tomlString(text: string, key: string) {
  const unescape = (v: string) => v.replace(/\\(["\\nt])/g, (_, c: string) => ({ n: '\n', t: '\t' })[c] ?? c)
  const multi = new RegExp(`^${key}\\s*=\\s*("""|''')\\r?\\n?([\\s\\S]*?)\\1`, 'm').exec(text)
  if (multi) return multi[1] === '"""' ? unescape(multi[2]) : multi[2]
  const basic = new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(text)
  if (basic) return unescape(basic[1])
  return new RegExp(`^${key}\\s*=\\s*'([^']*)'`, 'm').exec(text)?.[1] ?? ''
}

/** 命令文件的说明、参数提示和正文 */
export async function readCommand(file: string, format: 'md' | 'toml') {
  const text = await readFile(file, 'utf8').catch(() => '')
  if (format === 'toml') {
    const body = tomlString(text, 'prompt')
    return { description: tomlString(text, 'description'), hint: '', body }
  }
  const { fm, body } = splitFrontMatter(text)
  return { description: field(fm, 'description'), hint: field(fm, 'argument-hint'), body }
}

/** 一个目录下的命令文件；子目录里的叫「子目录:名字」（和 Claude Code 一样） */
export async function scanCommands(
  dir: string,
  source: string,
  format: 'md' | 'toml',
  prefix = '',
  depth = 0,
): Promise<Found[]> {
  if (!existsSync(dir) || depth > 3) return []
  const ext = `.${format}`
  const out: Found[] = []
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...(await scanCommands(p, source, format, `${prefix}${d.name}:`, depth + 1)))
    else if (d.name.endsWith(ext)) {
      const c = await readCommand(p, format)
      out.push({
        name: prefix + d.name.slice(0, -ext.length),
        description:
          c.description ||
          c.body
            .trim()
            .split('\n')[0]
            ?.replace(/^#+\s*/, '')
            .slice(0, 120) ||
          '',
        kind: 'command',
        source,
        hint: c.hint || undefined,
        path: p,
      })
    }
  }
  return out
}

/** 定义里写的命令目录：用户级的和项目里的 */
async function rawCommands(cli: string, cwd: string): Promise<Found[]> {
  const def = getCli(cli)
  if (!def) return []
  const { user, repo, format, prefix } = def.commands
  const lists = await Promise.all([
    ...user.map((d) => scanCommands(expandHome(d), d, format)),
    ...(cwd ? repo.map((d) => scanCommands(path.join(cwd, d), `./${d}`, format)) : []),
  ])
  return lists.flat().map((c) => ({ ...c, name: prefix + c.name }))
}

// Codex 列 Skill 要起一次 app-server：短时间内的重复查询用缓存
const cache = new Map<string, { at: number; list: Promise<Found[]> }>()

async function all(cli: string, cwd: string): Promise<Found[]> {
  const key = `${cli}\n${cwd}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 30_000) return hit.list
  const list = (async () => {
    const skills: CliSkill[] = await listSkills(cli, cwd).catch(() => [])
    const cmds = await rawCommands(cli, cwd)
    const seen = new Set(cmds.map((c) => c.name))
    // 共用的命令排在 CLI 自己的后面：同名时以 CLI 自己的为准
    const panel = (await scanCommands(panelCommandDir(), t('所有 Agent'), 'md')).filter(
      (c) => !seen.has(c.name) && seen.add(c.name),
    )
    return [
      ...cmds,
      ...panel.map((c) => ({ ...c, panel: true })),
      ...skills
        .filter((s) => s.enabled && !seen.has(s.name) && seen.add(s.name))
        .map(
          (s): Found => ({
            name: s.name,
            description: s.description,
            kind: 'skill',
            source: s.source || s.scope,
            path: s.path,
          }),
        ),
    ]
  })()
  cache.set(key, { at: Date.now(), list })
  list.catch(() => cache.delete(key))
  return list
}

/** 共用命令改过之后，「/」菜单和展开马上用新的 */
export const clearSlashCache = () => cache.clear()

/** 页面列「/」菜单用：不带本机路径 */
export async function listCommands(cli: string, cwd: string): Promise<SlashCommand[]> {
  return (await all(cli, cwd)).map(({ path: _p, panel: _x, ...c }) => c)
}

/**
 * 发给 CLI 之前展开「/命令 参数」。native：CLI 自己认识这些命令（Claude Code、而且是会话开头的原样文字）。
 * 顺序：CLI 自己的命令和 Skill →「所有 Agent」的命令 → 面板的内置命令；都不是的「/xxx」原样发出，当普通文字。
 */
export async function expandSlash(text: string, cli: string, cwd: string, native: boolean): Promise<string> {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return text
  const [, name, rest = ''] = m
  const args = rest.trim()
  if (native && getCli(cli)?.nativeCommands?.includes(name)) return text
  const c = (await all(cli, cwd).catch(() => [])).find((x) => x.name === name)
  if (!c) return builtinPrompt(name, args) || text
  if (native && !c.panel) return text
  if (c.kind === 'skill') {
    // 说明直接放进要求里：Skill 多在工作目录外，CLI 不一定有权限去读；目录也告诉它，里面的脚本、参考文件需要时再读
    const { body } = splitFrontMatter(await readFile(c.path, 'utf8').catch(() => ''))
    return [
      `请按 Skill「${c.name}」的说明完成${args ? '下面的要求' : '它描述的工作'}。`,
      `## Skill「${c.name}」（目录 ${path.dirname(c.path)}）\n${body.trim() || c.description}`,
      ...(args ? [`## 要求\n${args}`] : []),
    ].join('\n\n')
  }
  const format = c.panel ? 'md' : (getCli(cli)?.commands.format ?? 'md')
  const { body } = await readCommand(c.path, format)
  if (!body.trim()) return text
  return fillCommand(body, args)
}
