import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { CliSkill, SlashCommand } from '../shared/schema.ts'
import { listSkills } from './cli-extras.ts'

/**
 * 输入框里的「/」命令：列出 CLI 自己带的命令和 Skill，发出去之前按 CLI 展开。
 * Claude Code 在会话里认识「/命令」和「/Skill」，原样发过去；Codex（app-server）和 Command Code 不认，
 * 面板把命令文件的内容、Skill 的路径展开成普通的要求再发。
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

/** 一个目录下的 .md 命令文件；子目录里的叫「子目录:名字」（和 Claude Code 一样） */
async function scanCommands(dir: string, source: string, prefix = '', depth = 0): Promise<Found[]> {
  if (!existsSync(dir) || depth > 3) return []
  const out: Found[] = []
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...(await scanCommands(p, source, `${prefix}${d.name}:`, depth + 1)))
    else if (d.name.endsWith('.md')) {
      const { fm, body } = splitFrontMatter(await readFile(p, 'utf8').catch(() => ''))
      out.push({
        name: prefix + d.name.slice(0, -3),
        description:
          field(fm, 'description') ||
          body
            .trim()
            .split('\n')[0]
            ?.replace(/^#+\s*/, '')
            .slice(0, 120) ||
          '',
        kind: 'command',
        source,
        hint: field(fm, 'argument-hint') || undefined,
        path: p,
      })
    }
  }
  return out
}

async function rawCommands(cli: string, cwd: string): Promise<Found[]> {
  const home = homedir()
  if (cli === 'claude')
    return [
      ...(await scanCommands(path.join(home, '.claude', 'commands'), '~/.claude/commands')),
      ...(cwd ? await scanCommands(path.join(cwd, '.claude', 'commands'), './.claude/commands') : []),
    ]
  if (cli === 'codex') {
    // Codex 的自定义提示在 $CODEX_HOME/prompts，界面里用「/prompts:名字」调用
    const dir = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'prompts')
    return (await scanCommands(dir, '~/.codex/prompts')).map((c) => ({ ...c, name: `prompts:${c.name}` }))
  }
  return []
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
  const { body } = splitFrontMatter(await readFile(c.path, 'utf8').catch(() => ''))
  if (!body.trim()) return text
  // 和 Claude Code 的命令文件一样：$ARGUMENTS 换成全部参数，$1、$2… 换成按空格分开的参数
  const parts = args.split(/\s+/).filter(Boolean)
  const used = /\$ARGUMENTS|\$\d/.test(body)
  const out = body.replaceAll('$ARGUMENTS', args).replace(/\$(\d)/g, (_, i: string) => parts[Number(i) - 1] ?? '')
  return used || !args ? out.trim() : `${out.trim()}\n\n${args}`
}
