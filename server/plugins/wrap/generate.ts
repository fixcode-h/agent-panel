import { matchesGlob } from '../../../shared/test-steps.ts'
import type { PluginWrap } from '../../../shared/plugins/runtime-schema.ts'
import type { WrapRecipe, WrapStep } from '../../../shared/plugins/wrap/recipe.ts'
import { safeRel, type ZipEntry } from '../zip.ts'
import { frontMatter, type RepoFile } from './detect.ts'
import type { RepoSnapshot } from './fetch.ts'

/**
 * 生成器（ADR 0068）：配方 + 下载下来的仓库 → 标准插件包（plugin.json + 文件）。产物和市场里下载的插件包一模一样，
 * 面板运行时不知道它是包装来的；只多一个清单字段 wrap 记来源和固定的提交。
 * 这里只搬文件、写清单，不执行任何东西；要装依赖的写成安装动作，确认后由 actions.ts 在插件目录里做。
 */

/** 永远不进包的目录 */
const NEVER = /(?:^|\/)(?:\.git|node_modules|\.venv|__pycache__)(?:\/|$)/
/** 许可证和署名文件：原样带上（Apache-2.0 要求保留 NOTICE） */
const LEGAL = /^(?:licen[cs]e|notice|copying)(?:\.[a-z]+)?$/i

export interface Generated {
  /** 写进 plugin.json 的清单（还没经过 parseManifest） */
  manifest: Record<string, unknown>
  /** 包里的文件，相对包根 */
  files: ZipEntry[]
  steps: WrapStep[]
  kinds: PluginWrap['kinds']
  stats: { files: number; bytes: number }
}

const under = (dir: string, p: string) => dir === '.' || p === dir || p.startsWith(`${dir}/`)
const relTo = (dir: string, p: string) => (dir === '.' ? p : p.slice(dir.length + 1))

/** 仓库里某个目录（或单个文件）下要进包的文件；一个都没有说明上游改了结构，停下来 */
function pick(files: RepoFile[], from: string, exclude: string[]) {
  const got = files.filter(
    (f) => under(from, f.path) && !NEVER.test(f.path) && !exclude.some((g) => matchesGlob(f.path, g)),
  )
  if (!got.length) throw new Error(`仓库里找不到 ${from}：上游可能改了结构，配方要跟着改`)
  return got
}

/** 发布的版本号：v3.2.0 → 3.2.0；分支或认不出的标签用提交号 */
export function versionOf(ref: string, commit: string) {
  const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(ref)
  return m ? m[1] : `0.0.0+${commit.slice(0, 7)}`
}

/** README 里的「用法」一节（给命令行工具生成「怎么用」技能），找不到取开头一段 */
function usageOf(readme: string) {
  const lines = readme.split('\n')
  const start = lines.findIndex((l) => /^#{1,3}\s.*(?:usage|用法|使用|getting started|quick ?start)/i.test(l))
  if (start < 0) return lines.slice(0, 60).join('\n')
  const level = /^#+/.exec(lines[start])![0].length
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l))
  return lines.slice(start, end < 0 ? start + 80 : end).join('\n')
}

const KIND_OF: Record<string, PluginWrap['kinds'][number]> = {
  skills: 'skills',
  commands: 'claude-plugin',
  agents: 'claude-plugin',
  mcp: 'mcp',
  path: 'cli',
  services: 'web-app',
  webPages: 'web-app',
}

/** 默认生效范围（设计稿 7.2 第 6 条）：带 MCP、托管进程或 PATH 的按项目，只有技能和环境变量的全局 */
export const defaultActivation = (r: Pick<WrapRecipe, 'mcp' | 'services' | 'path'>) =>
  r.mcp.length || r.services.length || r.path.length ? 'project' : 'global'

function describeSteps(r: WrapRecipe, copied: string[], stats: Generated['stats']): WrapStep[] {
  const steps: WrapStep[] = []
  const mb =
    stats.bytes >= 1024 * 1024 ? `${(stats.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(stats.bytes / 1024)} KB`
  if (copied.length)
    steps.push({
      icon: 'copy',
      text: `把 ${copied.join('、')} 复制进插件包：${mb}，${stats.files} 个文件${r.install.length ? '' : '；不运行任何安装脚本'}`,
    })
  for (const a of r.install)
    steps.push(
      a.kind === 'npm-ci'
        ? {
            icon: 'install',
            text: `在插件目录里装 ${a.dir === '.' ? '' : `${a.dir} 的`}依赖：npm ci --ignore-scripts（不跑上游的安装脚本）`,
          }
        : a.kind === 'npm-package'
          ? { icon: 'install', text: `装 npm 上发布的 ${a.package}@${a.version} 到插件目录（--ignore-scripts）` }
          : a.kind === 'uv-tool'
            ? { icon: 'install', text: `用 uv 把 ${a.package}==${a.version} 装进插件目录` }
            : a.kind === 'release-asset'
              ? { icon: 'install', text: `下载 Release ${a.tag} 的 ${a.asset}，核对 sha256 后放进 ${a.to}/` }
              : {
                  icon: 'run',
                  advanced: true,
                  text: `运行上游的构建脚本：npm run ${a.script}（会以你的权限运行上游代码）`,
                },
    )
  for (const [k, v] of Object.entries(r.env)) {
    const cfg = /^\{config\.([\w-]+)\}$/.exec(v)?.[1]
    const label = r.settings.find((s) => s.key === cfg)?.label
    steps.push({
      icon: 'env',
      text: label ? `插件参数「${label}」交给 Agent 的环境变量 ${k}` : `给 Agent 设 ${k}=${v}`,
    })
  }
  for (const d of r.path)
    steps.push({ icon: 'path', text: `Agent 的命令行里能直接用 ${d}/ 里的命令（PATH 前置，只在生效的对话里）` })
  for (const m of r.mcp)
    steps.push({
      icon: 'mcp',
      text: `给 Agent 挂外部 MCP 服务 ${m.name}：${[m.command || m.url, ...m.args].join(' ')}`,
    })
  for (const s of r.services)
    steps.push({
      icon: 'service',
      text: `由面板起停 ${[s.command, ...s.args].join(' ')}（只绑 127.0.0.1${s.stopAfterIdleMin ? `，没人看 ${s.stopAfterIdleMin} 分钟后停` : ''}）`,
    })
  for (const p of r.webPages)
    steps.push({ icon: 'web', text: `在面板里出一页「${p.label}」，在沙箱里打开，碰不到面板` })
  return steps
}

/**
 * 按配方生成插件包。trust：配方来自插件市场（community）还是识别器 / AI（any）
 */
export function generate(
  r: WrapRecipe,
  snap: Pick<RepoSnapshot, 'repo' | 'commit' | 'ref' | 'license' | 'description' | 'files'>,
  opts: { trust: PluginWrap['trust']; recipeFile?: string },
): Generated {
  const out = new Map<string, Buffer>()
  const put = (rel: string, data: Buffer) => {
    if (!safeRel(rel)) throw new Error(`包里的路径不对：${rel}`)
    out.set(rel, data)
  }
  const copied: string[] = []
  const skillGuide: Record<string, string> = {}
  for (const s of r.skills) {
    const got = pick(snap.files, s.from, r.exclude)
    const md = got.find((f) => f.path === (s.from === '.' ? 'SKILL.md' : `${s.from}/SKILL.md`))
    if (!md) throw new Error(`${s.from} 下没有 SKILL.md`)
    for (const f of got) put(`skills/${s.category}/${s.name}/${relTo(s.from, f.path)}`, f.data)
    skillGuide[s.name] = frontMatter(md.data.toString('utf8'), 'description')
    copied.push(`${s.from === '.' ? '仓库根' : s.from}/`)
  }
  const commands = r.commands.map((c) => {
    const f = pick(snap.files, c.from, [])[0]
    put(`commands/${c.name}.md`, f.data)
    const md = f.data.toString('utf8')
    return {
      name: c.name,
      description: frontMatter(md, 'description').slice(0, 200),
      ...(frontMatter(md, 'argument-hint') && { hint: frontMatter(md, 'argument-hint').slice(0, 120) }),
      file: `commands/${c.name}.md`,
    }
  })
  const agents = r.agents.map((a) => {
    const md = pick(snap.files, a.from, [])[0].data.toString('utf8')
    const body = md.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
    const key = `wrap-${r.id}-${a.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 60)
    return { key, category: 'wrapped', agent: { name: a.name, instructions: body } }
  })
  for (const c of r.copy) {
    for (const f of pick(snap.files, c, r.exclude)) put(f.path, f.data)
    copied.push(c === '.' ? '整个仓库' : `${c}/`)
  }
  for (const f of snap.files) if (!f.path.includes('/') && LEGAL.test(f.path)) put(f.path, f.data)
  // 发布的 npm 命令行：生成一个只依赖它的 package.json，确认后在 cli/ 里装
  for (const a of r.install)
    if (a.kind === 'npm-package')
      put(
        'cli/package.json',
        Buffer.from(
          JSON.stringify({ name: `wrap-${r.id}`, private: true, dependencies: { [a.package]: a.version } }, null, 2),
        ),
      )
  // 命令行工具没有自己的技能：生成一份「怎么用」，内容取 README 的用法段
  const hasCli = r.path.length > 0
  if (hasCli && !r.skills.length) {
    const readme = snap.files.find((f) => /^readme(?:\.md)?$/i.test(f.path))?.data.toString('utf8') ?? ''
    const desc = (r.description || snap.description || r.name).replace(/\s+/g, ' ').slice(0, 300)
    put(
      `skills/wrapped/${r.id}/SKILL.md`,
      Buffer.from(
        `---\nname: ${r.id}\ndescription: ${JSON.stringify(`${desc}（命令行工具 ${r.name}，已在 PATH 里）`)}\n---\n\n# ${r.name}\n\n上游：https://github.com/${snap.repo}\n\n${usageOf(readme)}\n`,
      ),
    )
    skillGuide[r.id] = desc
  }

  const kinds = new Set<PluginWrap['kinds'][number]>()
  for (const [k, kind] of Object.entries(KIND_OF)) if ((r[k as keyof WrapRecipe] as unknown[]).length) kinds.add(kind)
  if (r.install.some((a) => a.kind !== 'npm-ci') || hasCli) kinds.add('cli')
  const files = [...out].map(([name, data]) => ({ name, data }))
  const stats = { files: files.length, bytes: files.reduce((n, f) => n + f.data.length, 0) }
  const env: Record<string, unknown> = { ...r.env, ...(r.path.length && { PATH: { prepend: r.path } }) }
  const manifest = {
    id: r.id,
    name: r.name,
    version: versionOf(snap.ref, snap.commit),
    icon: r.icon,
    description: r.description || snap.description,
    homepage: `https://github.com/${snap.repo}`,
    ...(snap.license && { license: snap.license }),
    source: { name: snap.repo, url: `https://github.com/${snap.repo}`, version: snap.ref, license: snap.license || '' },
    activation: r.activation ?? defaultActivation(r),
    api: 11,
    settings: r.settings,
    skillGuide,
    agents,
    commands,
    env,
    mcp: r.mcp,
    services: r.services,
    webPages: r.webPages,
    wrap: {
      repo: snap.repo,
      commit: snap.commit,
      track: r.track,
      ...(r.track !== 'release' && { ref: snap.ref }),
      ...(opts.recipeFile && { recipe: opts.recipeFile }),
      kinds: [...kinds],
      trust: opts.trust,
    },
  }
  files.push({ name: 'plugin.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) })
  return { manifest, files, steps: describeSteps(r, copied, stats), kinds: [...kinds], stats }
}
