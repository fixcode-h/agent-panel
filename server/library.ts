import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { CLIS, getCli, type CliDefinition } from '../shared/clis.ts'
import {
  LIBRARY_DIR_MAX_DELETE_ENTRIES,
  LIBRARY_FILE_MAX_BYTES,
  LIBRARY_FILE_MAX_KIB,
  LIBRARY_TREE_EXCLUDE_DIRS,
  LIBRARY_TREE_EXCLUDE_FILES,
  LIBRARY_TREE_MAX_ENTRIES,
  libraryEntryPath,
  libraryName,
  type LibraryCli,
  type LibraryEntry,
  type LibraryEntryContent,
  type LibraryFile,
  type LibraryItem,
  type LibraryTree,
  type LibraryWriteResult,
} from '../shared/library.ts'
import { t } from '../shared/i18n.ts'
import { expandHome } from './cli-extras.ts'
import { clearSlashCache, panelCommandDir, readCommand, scanCommands } from './slash.ts'
import { ALL_AGENTS } from '../shared/commands.ts'
import { installBundled, listBundled, readBundledEntry } from './bundled-skills.ts'
import { getSettings } from './settings.ts'
import { cliSettings } from '../shared/settings.ts'

/**
 * Skills / 命令库：管各 CLI 用户目录下的 Skill 和自定义命令（项目里的归项目管）。
 * 目录来自 CLI 定义；Codex 的 Skill 由 app-server 列出，没写目录，这里用它读取的 $CODEX_HOME/skills。
 * 命令另有一个「所有 Agent」（ALL_AGENTS）：放在面板的数据目录里，由面板展开，每个 CLI 都能用。
 */

type Kind = 'skill' | 'command'

/** 库里的一个位置：一个 CLI 的用户目录，或「所有 Agent」共用的命令目录 */
interface Home {
  id: string
  name: string
  skill: string
  command: string
  format: 'md' | 'toml'
}

const skillRoot = (d: CliDefinition) => d.skills.user[0] ?? d.rpc?.skillsDir ?? ''

const cliHome = (d: CliDefinition): Home => ({
  id: d.id,
  name: d.name,
  skill: skillRoot(d) && expandHome(skillRoot(d)),
  command: d.commands.user[0] ? expandHome(d.commands.user[0]) : '',
  format: d.commands.format,
})

const allAgentsHome = (): Home => ({
  id: ALL_AGENTS,
  name: t('所有 Agent'),
  skill: '',
  command: panelCommandDir(),
  format: 'md',
})

const homeOf = (cli: string) => (cli === ALL_AGENTS ? allAgentsHome() : getCli(cli) && cliHome(getCli(cli)!))

/** 只处理启用的 CLI：停用的不在技能库、复制目标这些地方出现 */
async function activeClis() {
  const settings = await getSettings()
  return CLIS.filter((d) => cliSettings(settings, d.id).enabled)
}

/** 库里的位置：「所有 Agent」排第一 */
async function homes() {
  return [allAgentsHome(), ...(await activeClis()).map(cliHome)]
}

export async function libraryClis(): Promise<LibraryCli[]> {
  return (await homes()).flatMap((h) =>
    h.skill || h.command
      ? [{ id: h.id, name: h.name, skillDir: h.skill, commandDir: h.command, commandFormat: h.format }]
      : [],
  )
}

/** 要操作的目录：名字合法，并且落在 CLI 的用户目录里 */
function target(cli: string, kind: Kind, name: string) {
  const d = homeOf(cli)
  const root = d && d[kind]
  if (!d || !root)
    throw new Error(t('这个 Agent 没有用户级的{kind}目录', { kind: kind === 'skill' ? 'Skill' : t('命令') }))
  if (!libraryName(kind, name)) throw new Error(t('名字只能用字母、数字、. _ -'))
  const sub = kind === 'skill' ? name : name.split(':').join(path.sep) + `.${d.format}`
  const p = path.join(root, sub)
  if (path.relative(root, p).startsWith('..')) throw new Error(t('名字不对'))
  return { d, root, path: p, file: kind === 'skill' ? path.join(p, 'SKILL.md') : p }
}

export async function listLibrary(kind: Kind): Promise<LibraryItem[]> {
  const out: LibraryItem[] = []
  for (const d of await homes()) {
    const root = d[kind]
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
      for (const c of await scanCommands(root, root, d.format))
        out.push({ cli: d.id, kind, name: c.name, description: c.description, path: c.path })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.cli.localeCompare(b.cli))
}

/**
 * Skill 文件夹里的文件树：目录在前、按名字排的扁平列表（路径排序天然把父目录排在子项前面）。
 * 跳过 LIBRARY_TREE_EXCLUDE 里的目录和文件；超过 LIBRARY_TREE_MAX_ENTRIES 就截断并标 truncated。
 * 项目技能（server/project-skills.ts）也用它
 */
export async function extraFiles(dir: string): Promise<LibraryTree> {
  const entries: LibraryEntry[] = []
  let truncated = false
  // 广度优先：浅层先列，截断时留下的就是浅层，前端画出来的树不会缺父级
  const queue: string[] = ['']
  const isDirEntry = (e: { isDirectory: () => boolean; isSymbolicLink: () => boolean }) =>
    e.isDirectory() && !e.isSymbolicLink()
  while (queue.length && !truncated) {
    const rel = queue.shift()!
    const list = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
    // 同一层目录在前、再按名字排（前端展开时目录先出现）
    list.sort((a, b) => Number(isDirEntry(b)) - Number(isDirEntry(a)) || a.name.localeCompare(b.name))
    for (const e of list) {
      // 排除清单只看目录：`logs` 这种名字当目录时跳过，但当文件列出来（技能里可能真放了叫 logs 的文本）
      const isDir = isDirEntry(e)
      if (LIBRARY_TREE_EXCLUDE_DIRS.includes(e.name) && isDir) continue
      if (!isDir && LIBRARY_TREE_EXCLUDE_FILES.includes(e.name)) continue
      const r = (rel ? `${rel}/` : '') + e.name
      // 主文件不进树：它单独用 content 返回（大小写无关，不区分大小写的文件系统上 skill.md 也是它）
      if (r.toLowerCase() === 'skill.md' && !isDir) continue
      // 软链接一律当文件列出，不跟进去（可能是链到目录外的图目录，跟进去会扫到别人的文件）
      if (entries.length >= LIBRARY_TREE_MAX_ENTRIES) {
        truncated = true
        break
      }
      if (isDir) {
        entries.push({ path: r, type: 'dir' })
        queue.push(r)
      } else if (e.isSymbolicLink()) {
        // 软链接单独标一类：前端知道它不能编辑，也不会把它当普通文件去读内容
        entries.push({ path: r, type: 'link' })
      } else {
        const s = await stat(path.join(dir, r)).catch(() => null)
        entries.push({ path: r, type: 'file', size: s?.size ?? 0 })
      }
    }
  }
  return truncated ? { entries, truncated } : { entries }
}

export async function readLibrary(cli: string, kind: Kind, name: string): Promise<LibraryFile> {
  const p = target(cli, kind, name)
  if (!existsSync(p.file)) throw new Error(t('没有这一项'))
  const tree = kind === 'skill' ? await extraFiles(p.path) : undefined
  return {
    content: await readFile(p.file, 'utf8'),
    // files 保持旧语义：树里所有文件的路径（扁平），命令没有附带文件
    files: (tree?.entries ?? []).filter((e) => e.type === 'file').map((e) => e.path),
    ...(tree ? { tree } : {}),
  }
}

/** Skill 目录（真实路径）；软链接的 Skill 用链接指向的目录——附件的读写要落到原文件夹上 */
async function skillRootOf(dir: string) {
  return (await realpath(dir).catch(() => dir)) || dir
}

/**
 * 把一个附件路径解成磁盘上的真实路径，并保证**它所在的目录**没跑出 Skill 目录。
 *
 * 两道关：先按 shared 里的规则挡掉 `..`、绝对路径、盘符（libraryEntryPath），
 * 再把**父目录** realpath 住，确认它仍在 Skill 目录下——目录链上有一段是指到外面的软链接时
 * （`link/secret.txt`），字符串上完全合法，只有看真实路径才拦得住。
 *
 * 只校验父目录、不校验最后一段本身：最后一段如果是个软链接，读和删都只碰链接本身（不跟终点），
 * 是安全的；要跟终点操作的是写，由 writeLibraryEntry 单独拒绝。把最后一段也一起 realpath，
 * 会让「树里列出来的链接」一读就报路径不合法。
 */
async function entryOf(cli: string, kind: Kind, name: string, raw: string) {
  const p = target(cli, kind, name)
  if (kind !== 'skill') throw new Error(t('只有 Skill 能带附件'))
  if (!existsSync(p.path)) throw new Error(t('没有这一项'))
  const rel = libraryEntryPath(raw)
  // 大小写无关：Windows NTFS、macOS 默认的文件系统不区分大小写，`skill.md` 打开的就是 SKILL.md，
  // 只比大写会让人从附件接口覆盖或删掉主文件
  if (rel.toLowerCase() === 'skill.md') throw new Error(t('SKILL.md 用主文件的内容读写'))
  const root = await skillRootOf(p.path)
  const full = path.join(root, rel.split('/').join(path.sep))
  // 父目录可能还不存在（新建子目录里的文件），退到最近一个存在的祖先再校验
  const parent = path.dirname(full)
  const probe = await nearestExisting(parent)
  // realpath 失败就拒绝：断链的软链接 lstat 拿得到、realpath 到不了目标，
  // 回退成字符串路径就等于把「穿过它写到别处」放过去
  const real = await realpath(probe).catch(() => null)
  if (!real || !insideDir(root, real) || !insideDir(root, probe))
    throw new Error(t('路径只能填 Skill 目录里的相对路径'))
  return { rel, full }
}

/** 从下向上第一个存在的路径（找不到就返回它自己）；用 lstat 不用 existsSync：后者跟随软链接，断链时报不存在 */
async function nearestExisting(full: string): Promise<string> {
  let p = full
  for (;;) {
    if (await lstat(p).catch(() => null)) return p
    const up = path.dirname(p)
    if (up === p) return p
    p = up
  }
}

/** p 是否在 dir 里面（含 dir 本身）；用 path.relative 判，比字符串前缀可靠（`/a/bc` 不算在 `/a/b` 里） */
function insideDir(dir: string, p: string) {
  const rel = path.relative(dir, p)
  if (!rel || rel === '.') return true
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 内容太大就报错：读写走同一个上限和同一句文案，改一处两边都变 */
function checkSize(bytes: number) {
  if (bytes > LIBRARY_FILE_MAX_BYTES) throw new Error(t('文件太大，最多 {kb} KB', { kb: LIBRARY_FILE_MAX_KIB }))
}

/** 读一个附件：二进制不返回内容，超限直接报错 */
export async function readLibraryEntry(
  cli: string,
  kind: Kind,
  name: string,
  raw: string,
): Promise<LibraryEntryContent> {
  const e = await entryOf(cli, kind, name, raw)
  // 用 lstat：要看出「这个位置本身是个软链接」。链接一律不给内容（不管链到目录内部还是外面），
  // 标上 link 让界面显示成不可编辑，而不是把目标文件的内容当场读出来、改的时候又被拒
  const info = await lstat(e.full).catch(() => null)
  if (!info) return { path: e.rel, exists: false, content: '', size: 0 }
  if (info.isSymbolicLink()) return { path: e.rel, exists: true, link: true, content: '', size: 0 }
  // 目录不是可编辑的附件：给 exists + 0 大小，不把目录的元数据大小当成文件大小交给前端
  if (info.isDirectory()) return { path: e.rel, exists: true, binary: true, content: '', size: 0 }
  // 设备文件这类既不是文件也不是目录的东西
  if (!info.isFile()) return { path: e.rel, exists: true, binary: true, content: '', size: 0 }
  checkSize(info.size)
  const buf = await readFile(e.full)
  const mtime = info.mtime.toISOString()
  // 二进制靠「有 \0 字节」判定（和 server/files.ts 的 readInDir 一致）：大多数图片、压缩包、可执行文件都带 \0，
  // 比按扩展名白名单稳（无扩展名的文本不会误判成二进制），也不依赖 UTF-8 解码是否报错
  // （非法 UTF-8 会被静默替换成 U+FFFD，根本判断不出来）
  if (buf.includes(0)) return { path: e.rel, exists: true, binary: true, content: '', size: info.size, mtime }
  return { path: e.rel, exists: true, content: buf.toString('utf8'), size: info.size, mtime }
}

/** 写一个附件（新建或覆盖）：目录不存在就建，内容超过上限就报错 */
export async function writeLibraryEntry(
  cli: string,
  kind: Kind,
  name: string,
  raw: string,
  content: string,
): Promise<LibraryWriteResult> {
  const e = await entryOf(cli, kind, name, raw)
  // 用 lstat：stat 会跟随链接，看不出「这个位置本身就是个软链接」。写的时候 OS 会把链接解开，
  // 跟着链到别处去写；entryOf 已经拦了链到外面的路径，这里对任何链接都说清原因（不说成「路径不合法」）。
  // 先判链接和目录、再做大小检查：一个超限的链接该说「这是链接」，不是让人去删内容
  const info = await lstat(e.full).catch(() => null)
  if (info?.isSymbolicLink()) throw new Error(t('这是个链接，不能直接改内容'))
  if (info?.isDirectory()) throw new Error(t('这个是目录，不能当文件写'))
  const bytes = Buffer.byteLength(content, 'utf8')
  checkSize(bytes)
  await mkdir(path.dirname(e.full), { recursive: true })
  await writeFile(e.full, content, 'utf8')
  clearSlashCache()
  return { path: e.rel, bytes }
}

/** 文件或目录的条目数（目录本身也算一项），超过上限就停 */
async function countEntries(full: string, limit: number): Promise<number> {
  let n = 1
  const walk = async (p: string) => {
    for (const e of await readdir(p, { withFileTypes: true }).catch(() => [])) {
      if (n > limit) return
      n++
      // 软链接不跟进去：链到外面的大目录时不能算它的内容，也不能顺着它删
      if (e.isDirectory() && !e.isSymbolicLink()) await walk(path.join(p, e.name))
    }
  }
  const s = await lstat(full).catch(() => null)
  if (s?.isDirectory() && !s.isSymbolicLink()) await walk(full)
  return n
}

/** 删一个附件；目录递归删，但条目太多时拒绝（避免一次删掉整个技能） */
export async function deleteLibraryEntry(cli: string, kind: Kind, name: string, raw: string) {
  const e = await entryOf(cli, kind, name, raw)
  const info = await lstat(e.full).catch(() => null)
  if (!info) return { path: e.rel, deleted: false }
  if (info.isSymbolicLink()) {
    // 链接（文件链接、目录链接、junction）都走 rm：Node 的 rm 对链接只删链接本身、不跟进目标，
    // 而且 Windows 上删目录重解析点不能走 unlink（DeleteFile 会报 EPERM），必须让 rmdir 系来删
    await rm(e.full, { recursive: true })
  } else if (info.isDirectory()) {
    const n = await countEntries(e.full, LIBRARY_DIR_MAX_DELETE_ENTRIES)
    if (n > LIBRARY_DIR_MAX_DELETE_ENTRIES)
      throw new Error(t('这个目录里有 {n} 项以上，不能一次删，先清掉里面的文件', { n: LIBRARY_DIR_MAX_DELETE_ENTRIES }))
    await rm(e.full, { recursive: true })
  } else {
    await unlink(e.full)
  }
  clearSlashCache()
  return { path: e.rel, deleted: true }
}

/** 改名 / 移动一个附件：目标已存在时默认报错，overwrite 才覆盖；目录不能盖到已存在的目录上 */
export async function renameLibraryEntry(
  cli: string,
  kind: Kind,
  name: string,
  from: string,
  to: string,
  overwrite: boolean,
) {
  const src = await entryOf(cli, kind, name, from)
  const dst = await entryOf(cli, kind, name, to)
  const si = await lstat(src.full).catch(() => null)
  if (!si) throw new Error(t('没有这一项'))
  if (await sameFile(src.full, dst.full)) {
    // 源和目标指向同一个文件，下面覆盖分支会把源文件自己删掉。
    // 大小写完全一样就是同一个路径，不用改；只差大小写时走「先改到临时名、再改到目标」，真把名字改过去
    if (src.full === dst.full) return { from: src.rel, to: dst.rel }
    await mkdir(path.dirname(dst.full), { recursive: true })
    const tmp = `${src.full}.renaming-${process.pid}`
    await rename(src.full, tmp)
    try {
      await rename(tmp, dst.full)
    } catch (e) {
      // 第二步没成（Windows 上目标被占用很常见）：把名字改回去，别让用户原本的文件凭空消失
      const restored = await rename(tmp, src.full).then(
        () => true,
        () => false,
      )
      if (!restored) throw new Error(t('改名失败，原内容留在 {name}', { name: path.basename(tmp) }))
      throw e
    }
    clearSlashCache()
    return { from: src.rel, to: dst.rel }
  }
  // 不许把目录移到它自己里面（要先于下面删目标那一步，否则 "d1 → d1/sub" 会先把 d1/sub 所在目录建出来）
  if (si.isDirectory() && insideDir(src.full, dst.full)) throw new Error(t('不能把目录移到它自己里面'))
  const di = await lstat(dst.full).catch(() => null)
  if (di) {
    if (!overwrite) throw new Error(t('「{name}」已经有了', { name: dst.rel }))
    // 目录不许并进已存在的目录：合并进去后就分不出哪些是刚移过来的
    if (di.isDirectory() && !di.isSymbolicLink()) throw new Error(t('「{name}」是个目录，不能覆盖', { name: dst.rel }))
  }
  await mkdir(path.dirname(dst.full), { recursive: true })
  await replaceFile(src.full, dst.full, !!di)
  clearSlashCache()
  return { from: src.rel, to: dst.rel }
}

/**
 * 两个路径是不是同一个文件：比真实文件身份（dev + ino），不按字符串小写归一。
 * 小写归一会把区分大小写的文件系统（Linux）上「Notes.md → notes.md」这种合法改名当成同一个文件、
 * 直接返回成功而什么都没做；任何一侧不存在（ENOENT）就不算同一个
 */
async function sameFile(a: string, b: string) {
  const [x, y] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)])
  return !!x && !!y && x.dev === y.dev && x.ino === y.ino
}

/**
 * 把 src 挪到 dst，dst 已存在时先挪到临时名留底，挪成功再删。
 * 不先删 dst 再 rename：rename / mkdir 任一步失败（Windows 上目标被占用很常见）就没人能恢复 dst 以前的 内容了
 */
async function replaceFile(src: string, dst: string, exists: boolean) {
  const backup = exists ? `${dst}.old-${process.pid}-${Date.now()}` : ''
  if (backup) await rename(dst, backup)
  try {
    await rename(src, dst)
  } catch (e) {
    // 没挪成：把留底的改回去，不把旧内容留在 .old-* 里
    const restored = backup
      ? await rename(backup, dst).then(
          () => true,
          () => false,
        )
      : true
    // 连回滚都失败时，把留底文件名告诉用户：内容还在磁盘上，能自己找回来，不说成「文件丢了」
    if (!restored) throw new Error(t('改名失败，原内容留在 {name}', { name: path.basename(backup) }))
    throw e
  }
  if (backup) await unlink(backup).catch(() => {})
}

export async function writeLibrary(cli: string, kind: Kind, name: string, content: string, create: boolean) {
  const p = target(cli, kind, name)
  if (create && existsSync(p.file)) throw new Error(t('「{name}」已经有了', { name }))
  await mkdir(path.dirname(p.file), { recursive: true })
  await writeFile(p.file, content, 'utf8')
  clearSlashCache()
}

export async function deleteLibrary(cli: string, kind: Kind, name: string) {
  const p = target(cli, kind, name)
  if (!existsSync(p.file)) return
  clearSlashCache()
  if (kind === 'command') return unlink(p.file)
  // 软链接的 Skill 只删链接，不动链接指向的原文件夹
  return (await lstat(p.path)).isSymbolicLink() ? unlink(p.path) : rm(p.path, { recursive: true })
}

const tomlStr = (v: string) => JSON.stringify(v)
const tomlMulti = (v: string) => `"""\n${v.replaceAll('\\', '\\\\').replaceAll('"""', '""\\"')}\n"""`

/** 命令内容在 md（Claude Code 等）和 toml 之间换格式，参数占位符也换成对方的写法 */
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
    else await writeFile(dst.file, await convertCommand(src.file, src.d.format, dst.d.format), 'utf8')
    done.push(id)
  }
  clearSlashCache()
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
  return (
    new Hono()
      .get(
        '/',
        guard(async (c) =>
          c.json({ clis: await libraryClis(), items: await listLibrary(kindOf(c.req.query('kind'))) }),
        ),
      )
      .get(
        '/file',
        guard(async (c) =>
          c.json(await readLibrary(c.req.query('cli') ?? '', kindOf(c.req.query('kind')), c.req.query('name') ?? '')),
        ),
      )
      // 单个附件：路径都走 ?path= 和 body，不用 `..` 拼 URL
      .get(
        '/entry',
        guard(async (c) =>
          c.json(
            await readLibraryEntry(
              c.req.query('cli') ?? '',
              kindOf(c.req.query('kind')),
              c.req.query('name') ?? '',
              c.req.query('path') ?? '',
            ),
          ),
        ),
      )
      .put(
        '/entry',
        guard(async (c) => {
          const b = await c.req.json()
          return c.json(
            await writeLibraryEntry(b.cli, kindOf(b.kind), b.name, String(b.path ?? ''), String(b.content ?? '')),
          )
        }),
      )
      .delete(
        '/entry',
        guard(async (c) => {
          const q = (k: string) => c.req.query(k) ?? ''
          return c.json(await deleteLibraryEntry(q('cli'), kindOf(q('kind')), q('name'), q('path')))
        }),
      )
      .post(
        '/entry/rename',
        guard(async (c) => {
          const b = await c.req.json()
          return c.json(
            await renameLibraryEntry(
              b.cli,
              kindOf(b.kind),
              b.name,
              String(b.from ?? ''),
              String(b.to ?? ''),
              !!b.overwrite,
            ),
          )
        }),
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
      // 自带 Skill 的文件内容（只读）：详情页看 SKILL.md 和附件都走这里，path 为空表示主文件
      .get(
        '/bundled/entry',
        guard(async (c) => c.json(await readBundledEntry(c.req.query('name') ?? '', c.req.query('path') ?? ''))),
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
  )
}
