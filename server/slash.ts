import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CliSkill, SlashCommand } from '../shared/schema.ts'
import { expandHome, listSkills } from './cli-extras.ts'
import { getCli } from '../shared/clis.ts'

/**
 * 输入框里的「/」命令：列出 CLI 自己带的命令和 Skill，发出去之前按 CLI 展开。
 * 会话里认识「/命令」的 CLI（定义里 slash 为 true，例如 Claude Code）原样发过去；其他的由面板
 * 把命令文件的内容、Skill 的说明展开成普通的要求再发。命令和 Skill 的目录写在 CLI 的定义里。
 */

interface Found extends SlashCommand {
  path: string
}

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

/** TOML 里的一个字符串字段（Gemini CLI 的命令文件只用到 description、prompt 两个） */
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

/** 一个目录下的命令文件；子目录里的叫「子目录:名字」（和 Claude Code、Gemini CLI 一样） */
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
    return [
      ...cmds,
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

/** 页面列「/」菜单用：不带本机路径 */
export async function listCommands(cli: string, cwd: string): Promise<SlashCommand[]> {
  return (await all(cli, cwd)).map(({ path: _p, ...c }) => c)
}

/** /init：Claude Code 自己有；其他 CLI 按同样的意思写一份 AGENTS.md */
const INIT_PROMPT =
  '请分析这个项目，在项目根目录写一份 AGENTS.md（已经有了就改进它），写给以后在这个项目里工作的编码 Agent 看：' +
  '项目是做什么的、目录结构、常用的构建 / 测试 / 检查命令、代码风格和约定、容易出错需要注意的地方。内容简洁准确，不要编造项目里没有的东西。'

/**
 * 发给 CLI 之前展开「/命令 参数」。native：CLI 自己认识这些命令（Claude Code、而且是会话开头的原样文字）。
 * 不认识的「/xxx」原样发出，当普通文字。
 */
export async function expandSlash(text: string, cli: string, cwd: string, native: boolean): Promise<string> {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return text
  const [, name, rest = ''] = m
  const args = rest.trim()
  if (name === 'init') return native ? text : INIT_PROMPT + (args ? `\n\n补充要求：${args}` : '')
  if (native) return text
  const c = (await all(cli, cwd).catch(() => [])).find((x) => x.name === name)
  if (!c) return text
  if (c.kind === 'skill') {
    // 说明直接放进要求里：Skill 多在工作目录外，CLI 不一定有权限去读；目录也告诉它，里面的脚本、参考文件需要时再读
    const { body } = splitFrontMatter(await readFile(c.path, 'utf8').catch(() => ''))
    return [
      `请按 Skill「${c.name}」的说明完成${args ? '下面的要求' : '它描述的工作'}。`,
      `## Skill「${c.name}」（目录 ${path.dirname(c.path)}）\n${body.trim() || c.description}`,
      ...(args ? [`## 要求\n${args}`] : []),
    ].join('\n\n')
  }
  const format = getCli(cli)?.commands.format ?? 'md'
  const { body } = await readCommand(c.path, format)
  if (!body.trim()) return text
  // Gemini CLI 的命令用 {{args}}；Claude Code 的用 $ARGUMENTS 和 $1、$2…（按空格分开的参数）
  const parts = args.split(/\s+/).filter(Boolean)
  const used = /\$ARGUMENTS|\$\d|\{\{args\}\}/.test(body)
  const out = body
    .replaceAll('{{args}}', args)
    .replaceAll('$ARGUMENTS', args)
    .replace(/\$(\d)/g, (_, i: string) => parts[Number(i) - 1] ?? '')
  return used || !args ? out.trim() : `${out.trim()}\n\n${args}`
}
