import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { CLIS, getCli, type CliDefinition } from '../shared/clis.ts'
import { libraryName, type LibraryCli, type LibraryFile, type LibraryItem } from '../shared/library.ts'
import { t } from '../shared/i18n.ts'
import { expandHome } from './cli-extras.ts'
import { readCommand, scanCommands } from './slash.ts'
import { installBundled, listBundled } from './bundled-skills.ts'
import { getSettings } from './settings.ts'
import { cliSettings } from '../shared/settings.ts'

/**
 * Skills / 命令库：管各 CLI 用户目录下的 Skill 和自定义命令（项目里的归项目管）。
 * 目录来自 CLI 定义；Codex 的 Skill 由 app-server 列出，没写目录，这里用它读取的 $CODEX_HOME/skills。
 */

type Kind = 'skill' | 'command'

const skillRoot = (d: CliDefinition) => d.skills.user[0] ?? d.rpc?.skillsDir ?? ''

const roots = (d: CliDefinition) => ({
  skill: skillRoot(d) && expandHome(skillRoot(d)),
  command: d.commands.user[0] ? expandHome(d.commands.user[0]) : '',
})

/** 只处理启用的 CLI：停用的不在技能库、复制目标这些地方出现 */
async function activeClis() {
  const settings = await getSettings()
  return CLIS.filter((d) => cliSettings(settings, d.id).enabled)
}

export async function libraryClis(): Promise<LibraryCli[]> {
  return (await activeClis()).flatMap((d) => {
    const r = roots(d)
    return r.skill || r.command
      ? [{ id: d.id, name: d.name, skillDir: r.skill, commandDir: r.command, commandFormat: d.commands.format }]
      : []
  })
}

/** 要操作的目录：名字合法，并且落在 CLI 的用户目录里 */
function target(cli: string, kind: Kind, name: string) {
  const d = getCli(cli)
  const root = d && roots(d)[kind]
  if (!d || !root)
    throw new Error(t('这个 CLI 没有用户级的{kind}目录', { kind: kind === 'skill' ? 'Skill' : t('命令') }))
  if (!libraryName(kind, name)) throw new Error(t('名字只能用字母、数字、. _ -'))
  const sub = kind === 'skill' ? name : name.split(':').join(path.sep) + `.${d.commands.format}`
  const p = path.join(root, sub)
  if (path.relative(root, p).startsWith('..')) throw new Error(t('名字不对'))
  return { d, root, path: p, file: kind === 'skill' ? path.join(p, 'SKILL.md') : p }
}

export async function listLibrary(kind: Kind): Promise<LibraryItem[]> {
  const out: LibraryItem[] = []
  for (const d of await activeClis()) {
    const root = roots(d)[kind]
    if (!root || !existsSync(root)) continue
    if (kind === 'skill') {
      for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue
        const file = path.join(root, e.name, 'SKILL.md')
        const text = await readFile(file, 'utf8').catch(() => '')
        if (!text) continue
        const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
        const desc =
          fm
            .match(/^description:\s*(.*)$/m)?.[1]
            ?.trim()
            .replace(/^["']|["']$/g, '') ?? ''
        out.push({ cli: d.id, kind, name: e.name, description: desc, path: file })
      }
    } else {
      for (const c of await scanCommands(root, root, d.commands.format))
        out.push({ cli: d.id, kind, name: c.name, description: c.description, path: c.path })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.cli.localeCompare(b.cli))
}

/** Skill 文件夹里 SKILL.md 以外的文件（两层以内） */
async function extraFiles(dir: string) {
  const out: string[] = []
  const walk = async (rel: string, depth: number) => {
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      const r = path.join(rel, e.name)
      if (e.isDirectory() && depth < 2) await walk(r, depth + 1)
      else if (e.isFile() && r !== 'SKILL.md') out.push(r.replaceAll('\\', '/'))
    }
  }
  await walk('', 0)
  return out.sort()
}

export async function readLibrary(cli: string, kind: Kind, name: string): Promise<LibraryFile> {
  const p = target(cli, kind, name)
  if (!existsSync(p.file)) throw new Error(t('没有这一项'))
  return { content: await readFile(p.file, 'utf8'), files: kind === 'skill' ? await extraFiles(p.path) : [] }
}

export async function writeLibrary(cli: string, kind: Kind, name: string, content: string, create: boolean) {
  const p = target(cli, kind, name)
  if (create && existsSync(p.file)) throw new Error(t('「{name}」已经有了', { name }))
  await mkdir(path.dirname(p.file), { recursive: true })
  await writeFile(p.file, content, 'utf8')
}

export async function deleteLibrary(cli: string, kind: Kind, name: string) {
  const p = target(cli, kind, name)
  if (!existsSync(p.file)) return
  if (kind === 'command') return unlink(p.file)
  // 软链接的 Skill 只删链接，不动链接指向的原文件夹
  return (await lstat(p.path)).isSymbolicLink() ? unlink(p.path) : rm(p.path, { recursive: true })
}

const tomlStr = (v: string) => JSON.stringify(v)
const tomlMulti = (v: string) => `"""\n${v.replaceAll('\\', '\\\\').replaceAll('"""', '""\\"')}\n"""`

/** 命令内容在 md（Claude Code 等）和 toml（Gemini CLI）之间换格式，参数占位符也换成对方的写法 */
export async function convertCommand(from: string, fromFmt: 'md' | 'toml', toFmt: 'md' | 'toml') {
  const text = await readFile(from, 'utf8')
  if (fromFmt === toFmt) return text
  const c = await readCommand(from, fromFmt)
  if (toFmt === 'toml')
    return `${c.description ? `description = ${tomlStr(c.description)}\n` : ''}prompt = ${tomlMulti(c.body.replaceAll('$ARGUMENTS', '{{args}}').trim())}\n`
  const fm = [c.description && `description: ${JSON.stringify(c.description)}`].filter(Boolean)
  return `${fm.length ? `---\n${fm.join('\n')}\n---\n` : ''}${c.body.replaceAll('{{args}}', '$ARGUMENTS').trim()}\n`
}

export async function copyLibrary(cli: string, kind: Kind, name: string, to: string[], overwrite: boolean) {
  const src = target(cli, kind, name)
  if (!existsSync(src.file)) throw new Error(t('没有这一项'))
  const done: string[] = []
  const skipped: string[] = []
  for (const id of to) {
    if (id === cli) continue
    const dst = target(id, kind, name)
    if (existsSync(dst.file) && !overwrite) {
      skipped.push(id)
      continue
    }
    await mkdir(path.dirname(dst.file), { recursive: true })
    if (kind === 'skill') await cp(src.path, dst.path, { recursive: true, dereference: true })
    else await writeFile(dst.file, await convertCommand(src.file, src.d.commands.format, dst.d.commands.format), 'utf8')
    done.push(id)
  }
  return { done, skipped }
}

export function libraryApi() {
  const guard = (fn: (c: any) => Promise<Response>) => async (c: any) => {
    try {
      return await fn(c)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }
  const kindOf = (v: unknown): Kind => (v === 'command' ? 'command' : 'skill')
  return new Hono()
    .get(
      '/',
      guard(async (c) => c.json({ clis: await libraryClis(), items: await listLibrary(kindOf(c.req.query('kind'))) })),
    )
    .get(
      '/file',
      guard(async (c) =>
        c.json(await readLibrary(c.req.query('cli') ?? '', kindOf(c.req.query('kind')), c.req.query('name') ?? '')),
      ),
    )
    .put(
      '/file',
      guard(async (c) => {
        const b = await c.req.json()
        await writeLibrary(b.cli, kindOf(b.kind), b.name, String(b.content ?? ''), !!b.create)
        return c.json({ ok: true })
      }),
    )
    .delete(
      '/file',
      guard(async (c) => {
        await deleteLibrary(c.req.query('cli') ?? '', kindOf(c.req.query('kind')), c.req.query('name') ?? '')
        return c.json({ ok: true })
      }),
    )
    .get(
      '/bundled',
      guard(async (c) => c.json({ items: await listBundled() })),
    )
    .post(
      '/bundled/install',
      guard(async (c) => {
        const b = await c.req.json()
        const names = Array.isArray(b.names) ? b.names.map(String) : []
        const clis = Array.isArray(b.clis) ? b.clis.map(String) : []
        return c.json(await installBundled(names, clis, !!b.overwrite))
      }),
    )
    .post(
      '/copy',
      guard(async (c) => {
        const b = await c.req.json()
        return c.json(await copyLibrary(b.cli, kindOf(b.kind), b.name, b.to ?? [], !!b.overwrite))
      }),
    )
}
