import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ignoreKey, scanMcpServer, type ConfigFinding } from '../../../shared/config-scan/index.ts'
import { scanWrapFiles } from '../../../shared/config-scan/wrap-rules.ts'
import type { WrapInfo, WrapPreview, WrapPreviewInput } from '../../../shared/api-contract/plugin-wrap.ts'
import { WrapRecipe, recipeFile, type WrapRecipeInput } from '../../../shared/plugins/wrap/recipe.ts'
import { installedList } from '../manager.ts'
import { currentMarketRepo } from '../market-cache.ts'
import { stash } from '../install-pending.ts'
import { parseManifest, type Installed } from '../store.ts'
import { runActions } from './actions.ts'
import { buildRecipe, defaultPicks, detect, type Detected } from './detect.ts'
import { fetchRepo, parseWrapUrl, readCommunityRecipe, type RepoSnapshot } from './fetch.ts'
import { defaultActivation, generate } from './generate.ts'

/**
 * 包装预览（ADR 0068，设计稿第 3、8 节）：取仓库 → 配方（社区配方 > 识别器；AI 给的直接用）→ 生成插件包 →
 * 扫描 → 记成等确认的安装。确认后在临时目录里跑白名单安装动作，再换上去（install-pending + writePackage）。
 * 包里另存两份记录给以后更新比对：wrap-recipe.json（这次用的配方）、wrap-scan.json（这次的扫描发现）。
 */

const RECIPE_RECORD = 'wrap-recipe.json'
const SCAN_RECORD = 'wrap-scan.json'

/** 已经装着的、包的是这个仓库的插件 */
const installedFor = (repo: string) =>
  installedList().find((p) => p.manifest.wrap?.repo.toLowerCase() === repo.toLowerCase())

async function readRecord<T>(p: Installed | undefined, file: string): Promise<T | undefined> {
  if (!p) return undefined
  try {
    return JSON.parse(await readFile(path.join(p.dir, file), 'utf8')) as T
  } catch {
    return undefined
  }
}

/** 仓库名 → 插件 id 和显示名：archify → archify / Archify */
function naming(repo: string) {
  const name = repo.split('/')[1]
  const id =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^[^a-z]+/, '')
      .slice(0, 40) || 'wrapped'
  const title = name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return { id, title }
}

/** 候选是不是被配方用上了（按配方包装时预览里打勾的依据） */
function covered(d: Detected, r: WrapRecipe) {
  const f = d.fragment
  return (
    !!f.skills?.some((s) => r.skills.some((x) => x.from === s.from)) ||
    !!f.mcp?.some((m) => r.mcp.some((x) => x.name === m.name)) ||
    (!!f.commands?.length && r.commands.length > 0) ||
    (!!f.agents?.length && r.agents.length > 0) ||
    !!f.copy?.some((c) => r.copy.includes(c)) ||
    !!f.path?.some((p) => r.path.includes(p)) ||
    (d.key.startsWith('cli-in-skill:') && r.skills.some((s) => d.key.endsWith(`:${s.from}`)))
  )
}

/** 一个包装插件要的「权限」：更新时多出来的就是权限变化 */
function permissions(r: WrapRecipe): string[] {
  return [
    ...r.mcp.map((m) => `外部 MCP 服务 ${m.name}：${[m.command || m.url, ...m.args].join(' ')}`),
    ...r.services.map((s) => `托管进程 ${s.id}：${[s.command, ...s.args].join(' ')}`),
    ...Object.keys(r.env).map((k) => `环境变量 ${k}`),
    ...r.path.map((d) => `PATH 前置 ${d}`),
    ...r.install
      .filter((a) => a.kind === 'npm-run')
      .map((a) => `运行上游构建脚本 npm run ${a.kind === 'npm-run' ? a.script : ''}`),
  ]
}

interface Chosen {
  recipe?: WrapRecipe
  origin: WrapInfo['origin']
  trust: WrapInfo['trust']
  file?: string
}

/** 配方从哪来：AI 给的 > 更新时沿用装着的 > 插件市场的社区配方 > 识别器（返回空 recipe） */
async function chooseRecipe(repo: string, input: WrapPreviewInput, cur: Installed | undefined): Promise<Chosen> {
  if (input.recipe) return { recipe: input.recipe, origin: 'ai', trust: 'any' }
  if (input.update && cur) {
    const kept = WrapRecipe.safeParse(await readRecord(cur, RECIPE_RECORD))
    const w = cur.manifest.wrap!
    // 社区配方的插件更新时重读市场里的最新配方：配方跟着上游改了结构
    if (w.recipe) {
      const fresh = await readCommunityRecipe(await currentMarketRepo(), repo)
      if (fresh)
        return {
          recipe: { ...fresh, activation: cur.manifest.activation },
          origin: 'recipe',
          trust: 'community',
          file: w.recipe,
        }
    }
    if (kept.success) return { recipe: kept.data, origin: w.trust === 'any' ? 'detect' : 'recipe', trust: w.trust }
  }
  const community = await readCommunityRecipe(await currentMarketRepo(), repo)
  if (community) return { recipe: community, origin: 'recipe', trust: 'community', file: recipeFile(repo) }
  return { origin: 'detect', trust: 'any' }
}

/** 识别器出的配方：按勾选合并片段。一项都没勾上返回 undefined（认不出来） */
function detectedRecipe(snap: RepoSnapshot, list: Detected[], picks: string[]) {
  const { id, title } = naming(snap.repo)
  const base: WrapRecipeInput = {
    repo: snap.repo,
    id,
    name: title,
    description: snap.description.slice(0, 500),
    track: snap.release ? 'release' : 'branch',
  }
  const merged = buildRecipe(base, list, picks)
  const r = WrapRecipe.parse(merged)
  const empty =
    !r.skills.length &&
    !r.commands.length &&
    !r.agents.length &&
    !r.mcp.length &&
    !r.path.length &&
    !r.services.length &&
    !r.webPages.length
  return empty ? undefined : r
}

/** 和装着的那一版比：多出来的权限、多出来的中高级发现 */
async function updateDiff(cur: Installed, recipe: WrapRecipe, scan: ConfigFinding[]) {
  const old = WrapRecipe.safeParse(await readRecord(cur, RECIPE_RECORD))
  const before = new Set(old.success ? permissions(old.data) : [])
  const permChanges = permissions(recipe).filter((p) => !before.has(p))
  const seen = new Set((await readRecord<{ keys?: string[] }>(cur, SCAN_RECORD))?.keys ?? [])
  const newFindings = scan.filter((f) => !seen.has(ignoreKey(f)))
  return {
    from: cur.manifest.version,
    permChanges,
    newFindings,
    blocked: permChanges.length > 0 || newFindings.some((f) => f.level !== 'low'),
  }
}

export async function wrapPreview(input: WrapPreviewInput): Promise<WrapPreview> {
  const { repo, ref } = parseWrapUrl(input.url)
  const cur = installedFor(repo)
  if (input.update && !cur) throw new Error(`没有装 ${repo} 包装的插件`)
  const chosen = await chooseRecipe(repo, input, cur)
  const w = cur?.manifest.wrap
  const snap = await fetchRepo({
    repo,
    ref: ref ?? (input.update && w?.track !== 'release' ? w?.ref : undefined),
    track: chosen.recipe?.track,
  })
  const list = detect(snap.files, repo.split('/')[1], snap.release)
  const picks = chosen.recipe
    ? list.filter((d) => covered(d, chosen.recipe!)).map((d) => d.key)
    : (input.picks ?? defaultPicks(list))
  const recipe0 = chosen.recipe ?? detectedRecipe(snap, list, picks)
  const info: WrapInfo = {
    repo,
    ref: snap.ref,
    commit: snap.commit,
    date: snap.date,
    license: snap.license,
    description: snap.description,
    origin: chosen.origin,
    ...(chosen.file && { recipeFile: chosen.file }),
    trust: chosen.trust,
    candidates: list.map(({ fragment: _f, ...c }) => c),
    picks,
    editable: chosen.origin === 'detect',
    unrecognized: !recipe0,
    steps: [],
    stats: { files: 0, bytes: 0 },
    activation: 'global',
    suggested: 'global',
  }
  if (!recipe0) return { token: '', scan: [], hasCode: false, installed: null, wrap: info }

  const recipe: WrapRecipe = {
    ...recipe0,
    // 更新时沿用插件 id，免得上游改名后装成第二个插件
    ...(cur && { id: cur.manifest.id }),
    activation: input.activation ?? recipe0.activation ?? (cur ? cur.manifest.activation : undefined),
  }
  const gen = generate(recipe, snap, { trust: chosen.trust, recipeFile: chosen.file })
  const manifest = parseManifest(gen.manifest)
  const extra = [
    ...scanWrapFiles(gen.files.map((f) => ({ path: f.name, data: f.data }))),
    ...recipe.mcp.flatMap((m) => scanMcpServer(`plugin.json#${m.name}`, m)),
  ]
  // 预览时扫出来的全部发现（含用户点过「没问题」之前的），确认后记进包里，下次更新只列新增的
  let seen: string[] = []
  const prepare = async (dir: string) => {
    await runActions(dir, repo, recipe.install)
    await writeFile(path.join(dir, RECIPE_RECORD), JSON.stringify(recipe, null, 2))
    await writeFile(path.join(dir, SCAN_RECORD), JSON.stringify({ keys: seen }, null, 2))
  }
  const base = await stash(
    { manifest, source: { kind: 'github', ref: repo, tag: snap.ref }, files: gen.files, root: '', prepare },
    extra,
  )
  seen = base.scan.map((f) => ignoreKey(f))
  return {
    ...base,
    // 带 MCP、托管进程、命令行工具或要跑安装动作的，都会在本机运行上游代码
    hasCode:
      base.hasCode || !!(recipe.mcp.length || recipe.services.length || recipe.path.length || recipe.install.length),
    wrap: {
      ...info,
      steps: gen.steps,
      stats: gen.stats,
      activation: manifest.activation,
      suggested: defaultActivation(recipe),
      recipe,
      ...(input.update && cur && { update: await updateDiff(cur, recipe, base.scan) }),
    },
  }
}
