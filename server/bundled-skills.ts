import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { frontField, type BundledSkill } from '../shared/library.ts'
import { t } from '../shared/i18n.ts'
import { expandHome } from './cli-extras.ts'
import { log } from './log.ts'

/**
 * 面板自带的 Skill：仓库里的 skills/<分类>/<名字>/。
 * 统一装到用户目录 ~/.agents/skills（<目录>/<名字>/SKILL.md），各 CLI 共用这一份；分类只用于面板里展示。
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

/** 自带 Skill 统一装到用户目录，各 CLI 共用这一份 */
const sharedRoot = () => expandHome('~/.agents/skills')

/**
 * 已经下线的自带 Skill：目录名 → 旧版每个文件的 sha256。
 * 内容并入 project-vcs 之后，旧副本留着会让 CLI 同时看到两个入口，所以要清掉；
 * 但只删「和当初装进去的完全一致」的，用户改过或自己加过文件的保留（那是用户的内容，不是我们的）。
 */
export const RETIRED_BUNDLED: Record<string, Record<string, string>> = {
  // 并入了 project-vcs 的 SKILL.md
  'project-workflow': { 'SKILL.md': '655553a35f95821c6d41f40f16b109498815e8970da7f1650264bed3346263c8' },
  // 并入了 project-vcs 的 git.md
  'git-workflow': { 'SKILL.md': 'fa0f1af17e25d6d73019ebb78502769c51d9c10a1972ac461c73ef4ff76049bf' },
  // 并入了 project-vcs 的 p4.md 和 templates/task.p4change.md
  'p4-workflow': {
    'SKILL.md': '219b4d0fd8865eb8090937c8da7d7a9fbd04495047ad23c8d07f8b9168f71bab',
    'templates/task.p4change.md': 'a41e477fb24cda426533c1cd14d267f99a7a7f42fb926286a67c0b328146ed26',
  },
  // 下面两个是部署到「分类/名字」目录的（设置 → 部署）。UE 编译改由父对话申请执行，资源锁和编译排队交给面板
  'ue/ue-multi-agent-coordination': {
    'SKILL.md': '12cfcf5a1f554b11e11ebd37de04befee5c3dd7895f8f74ada486c694c70585e',
  },
  // .luac 只由项目测试步骤里的编译生成，不再单独带一份编译技能
  'ue/lua-luac-compiler': {
    'SKILL.md': '5ff4623b346db832f5142bb4534321c8ce6548f4686db0569e62f6e965732c49',
    'scripts/check_lua_syntax.py': '23376e1d476162a1ad8bed2c4c2814dda03e98fc317c927489d85e9a91a22acc',
  },
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

/**
 * 清掉下线的自带 Skill 的旧副本，返回删掉的目录名。
 * 判定不看目录名就删：目录里每个文件都要和记录的旧版一致、且没有多出来的文件，才认定是当初装进去的那份。
 */
export async function retireBundled(root = sharedRoot(), retired = RETIRED_BUNDLED) {
  const removed: string[] = []
  for (const [name, files] of Object.entries(retired)) {
    const dir = path.join(root, name)
    if (!existsSync(path.join(dir, 'SKILL.md'))) continue
    const found = await readTree(dir)
    const same = found.length === Object.keys(files).length && found.every(([rel, buf]) => files[rel] === sha256(buf))
    if (!same) {
      log.info('skills', `保留改过的已下线 Skill：${name}`)
      continue
    }
    await rm(dir, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

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
  const root = sharedRoot()
  const out: BundledSkill[] = []
  for (const e of await entries()) {
    const text = e.files.get('SKILL.md')!.toString('utf8')
    out.push({
      name: e.name,
      category: e.category,
      description: frontField(text, 'description'),
      files: e.files.size - 1,
      status: { shared: await statusIn(e, root) },
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

/** 装到用户共享目录；已经装了的只有 overwrite 时才覆盖（用户可能改过）。clis 只为接口兼容保留 */
export async function installBundled(names: string[], _clis: string[], overwrite: boolean) {
  const all = await entries()
  const root = sharedRoot()
  const done: string[] = []
  const skipped: string[] = []
  for (const name of names) {
    const e = all.find((x) => x.name === name)
    if (!e) throw new Error(t('没有自带的 Skill「{name}」', { name }))
    const s = await statusIn(e, root)
    if (s === 'same' || (s === 'changed' && !overwrite)) {
      skipped.push(name)
      continue
    }
    await writeSkill(e, root)
    done.push(name)
  }
  return { done, skipped }
}

/**
 * 执行前补齐 Agent 要用的自带 Skill：统一装到 ~/.agents/skills，已有的不动。
 * 失败只记日志，不影响执行（CLI 找不到 Skill 时会按自己的方式做）。
 */
export async function ensureBundled(names: string[]) {
  try {
    const root = sharedRoot()
    // 先清下线的旧技能：它们的内容已经并进 project-vcs，留着会让 CLI 看到两个入口
    await retireBundled(root)
    if (!names.length) return []
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
