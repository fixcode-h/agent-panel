import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CLIS, getCli, type CliDefinition } from '../shared/clis.ts'
import { frontField, type BundledSkill } from '../shared/library.ts'
import { t } from '../shared/i18n.ts'
import { expandHome } from './cli-extras.ts'
import { log } from './log.ts'

/**
 * 面板自带的 Skill：仓库里的 skills/<分类>/<名字>/。
 * 装到 CLI 时按名字平铺在用户 Skill 目录下（<目录>/<名字>/SKILL.md），各 CLI 都认这种结构；分类只用于面板里展示。
 * 出包时整个目录由 esbuild 写进 server.mjs（同浏览器扩展：旧版的「版本更新」不会复制新目录）。
 */
declare const __BUNDLED_SKILLS__: Record<string, string> | undefined
const EMBEDDED = typeof __BUNDLED_SKILLS__ === 'object' ? __BUNDLED_SKILLS__ : undefined
const SOURCE = path.resolve(import.meta.dirname, '..', 'skills')

export interface Entry {
  name: string
  category: string
  /** 相对技能目录的路径 → 内容 */
  files: Map<string, Buffer>
}

let cache: Promise<Entry[]> | null = null

async function readTree(dir: string, rel = ''): Promise<[string, Buffer][]> {
  const out: [string, Buffer][] = []
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await readTree(dir, r)))
    else if (e.isFile()) out.push([r, await readFile(path.join(dir, r))])
  }
  return out
}

/** 所有自带 Skill 的文件：出包后用写进来的，开发时直接读仓库目录（改了马上生效，所以不缓存） */
export async function entries(): Promise<Entry[]> {
  const load = async () => {
    const all: [string, Buffer][] = EMBEDDED
      ? Object.entries(EMBEDDED).map(([k, v]) => [k, Buffer.from(v, 'base64')])
      : existsSync(SOURCE)
        ? await readTree(SOURCE)
        : []
    const map = new Map<string, Entry>()
    for (const [rel, buf] of all) {
      const [category, name, ...rest] = rel.split('/')
      if (!name || !rest.length) continue
      const key = `${category}/${name}`
      const e = map.get(key) ?? { name, category, files: new Map() }
      e.files.set(rest.join('/'), buf)
      map.set(key, e)
    }
    return [...map.values()].filter((e) => e.files.has('SKILL.md'))
  }
  if (!EMBEDDED) return load()
  return (cache ??= load())
}

/** CLI 装 Skill 的用户目录（第一个） */
function skillRoot(d: CliDefinition) {
  const dir = d.skills.user[0] ?? d.rpc?.skillsDir ?? ''
  return dir ? expandHome(dir) : ''
}

const bundledClis = () => CLIS.filter((d) => skillRoot(d))

export async function statusIn(e: Entry, root: string): Promise<BundledSkill['status'][string]> {
  const dir = path.join(root, e.name)
  if (!existsSync(path.join(dir, 'SKILL.md'))) return 'missing'
  for (const [rel, buf] of e.files) {
    const cur = await readFile(path.join(dir, rel)).catch(() => null)
    if (!cur || !cur.equals(buf)) return 'changed'
  }
  return 'same'
}

export async function listBundled(): Promise<BundledSkill[]> {
  const clis = bundledClis()
  const out: BundledSkill[] = []
  for (const e of await entries()) {
    const text = e.files.get('SKILL.md')!.toString('utf8')
    const status: BundledSkill['status'] = {}
    for (const d of clis) status[d.id] = await statusIn(e, skillRoot(d))
    out.push({
      name: e.name,
      category: e.category,
      description: frontField(text, 'description'),
      files: e.files.size - 1,
      status,
    })
  }
  return out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
}

export async function writeSkill(e: Entry, root: string) {
  const dir = path.join(root, e.name)
  for (const [rel, buf] of e.files) {
    const file = path.join(dir, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, buf)
    // 脚本要能直接执行（出包后文件权限丢了，按扩展名补上）
    if (/\.(sh|py|cjs|mjs)$/.test(rel)) await chmod(file, 0o755).catch(() => {})
  }
}

/** 装进指定的 CLI；已经装了的只有 overwrite 时才覆盖（用户可能改过） */
export async function installBundled(names: string[], clis: string[], overwrite: boolean) {
  const all = await entries()
  const done: string[] = []
  const skipped: string[] = []
  for (const id of clis) {
    const d = getCli(id)
    const root = d && skillRoot(d)
    if (!root) throw new Error(t('这个 CLI 没有用户级的{kind}目录', { kind: 'Skill' }))
    for (const name of names) {
      const e = all.find((x) => x.name === name)
      if (!e) throw new Error(t('没有自带的 Skill「{name}」', { name }))
      const s = await statusIn(e, root)
      if (s === 'same' || (s === 'changed' && !overwrite)) {
        skipped.push(`${id}/${name}`)
        continue
      }
      await writeSkill(e, root)
      done.push(`${id}/${name}`)
    }
  }
  return { done, skipped }
}

/**
 * 执行前补齐 Agent 要用的自带 Skill：CLI 里没有的装上，已有的不动。
 * 失败只记日志，不影响执行（CLI 找不到 Skill 时会按自己的方式做）。
 */
export async function ensureBundled(cliId: string, names: string[]) {
  if (!names.length) return []
  const d = getCli(cliId)
  const root = d && skillRoot(d)
  if (!root) return []
  try {
    const all = await entries()
    const added: string[] = []
    for (const name of names) {
      const e = all.find((x) => x.name === name)
      if (!e || existsSync(path.join(root, name, 'SKILL.md'))) continue
      await writeSkill(e, root)
      added.push(name)
    }
    return added
  } catch (err) {
    log.warn('skills', `补齐自带 Skill 失败：${(err as Error).message}`)
    return []
  }
}
